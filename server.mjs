// watches a git repo and streams its file state to the browser over SSE.
// no ws, no chokidar: node's http + recursive fs.watch cover it.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { watch, statSync, readFileSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO = resolve(process.argv[2] || ".");
const PORT = Number(process.env.PORT || 4173);
const ROOT = import.meta.dirname;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

async function git(args) {
  const { stdout } = await run("git", args, { cwd: REPO, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

// -z output is NUL-terminated; trailing empty segment is dropped
function splitZ(s) {
  const parts = s.split("\0");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// `git status --porcelain -z`: each entry is "XY path", and a rename/copy is
// followed by a second NUL-separated token holding the old path.
function parseStatus(out) {
  const toks = splitZ(out);
  const dirty = new Set();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.length < 4) continue;
    const code = t.slice(0, 2);
    dirty.add(t.slice(3));
    if (code[0] === "R" || code[0] === "C") i++; // consume the old path
  }
  return dirty;
}

async function scan() {
  // -c cached + -o others, --exclude-standard honours .gitignore for free.
  // that one flag is what keeps node_modules from becoming 40k buildings.
  const [listOut, statusOut, branchOut] = await Promise.all([
    git(["ls-files", "-z", "-c", "-o", "--exclude-standard"]),
    git(["status", "--porcelain", "-z"]),
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);

  const dirty = parseStatus(statusOut);
  const seen = new Set();
  const files = [];
  for (const path of splitZ(listOut)) {
    if (seen.has(path)) continue;
    seen.add(path);
    let st;
    try {
      st = statSync(join(REPO, path));
    } catch {
      continue; // deleted but still tracked -> no building, which is correct
    }
    if (!st.isFile()) continue;
    files.push({ path, bytes: st.size, mtime: st.mtimeMs, dirty: dirty.has(path) });
  }

  return { repo: REPO.split("/").pop(), branch: branchOut.trim(), files };
}

// ---- clients ----
const clients = new Set();
let lastPayload = null;

function broadcast(snapshot) {
  const body = JSON.stringify(snapshot);
  if (body === lastPayload) return; // nothing moved, stay quiet
  lastPayload = body;
  const frame = `data: ${body}\n\n`;
  for (const res of clients) res.write(frame);
}

let pending = null;
function schedule(delay) {
  if (pending) clearTimeout(pending);
  pending = setTimeout(async () => {
    pending = null;
    try {
      broadcast(await scan());
    } catch (err) {
      console.error("scan failed:", err.message);
    }
  }, delay);
}

// fast path: content edits. .git churn is ignored here and covered by the poll.
try {
  watch(REPO, { recursive: true }, (_evt, name) => {
    if (!name) return;
    const p = name.replaceAll("\\", "/");
    if (p.startsWith(".git/") || p === ".git" || p.includes("node_modules/")) return;
    schedule(140);
  });
} catch (err) {
  console.warn("recursive watch unavailable, polling only:", err.message);
}

// commits, checkouts and stashes touch refs in .git subdirectories, so no
// single non-recursive watch catches them reliably — a plain poll does.
// three git calls on a 51-file repo cost ~10ms, so this is ~1.5% duty.
// ponytail: fixed 700ms poll; make it adaptive if you ever point this at a
// repo where `git status` takes longer than the interval.
setInterval(() => schedule(0), 700);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    clients.add(res);
    req.on("close", () => clients.delete(res));
    try {
      const snap = await scan();
      lastPayload = JSON.stringify(snap);
      res.write(`data: ${lastPayload}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    return;
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (file.includes("..")) {
    res.writeHead(400).end("nope");
    return;
  }
  try {
    const body = readFileSync(join(ROOT, file));
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`repo-city watching ${REPO}`);
  console.log(`open http://localhost:${PORT}`);
});
