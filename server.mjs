// watches a git repo and streams its file state to the browser over SSE.
// no ws, no chokidar: node's http + recursive fs.watch cover it.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { watch, statSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const ROOT = resolve(process.argv[2] || ".");
const PORT = Number(process.env.PORT || 4173);
const WEB_ROOT = import.meta.dirname;

// the argument is a root: itself if it is a repo, plus any direct child that
// is one. one level deep only — walking further turns `~/` into a long crawl.
function listRepos(root) {
  const out = [];
  if (existsSync(join(root, ".git"))) out.push({ name: root.split("/").pop(), path: root });
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const p = join(root, e.name);
    if (existsSync(join(p, ".git"))) out.push({ name: e.name, path: p });
  }
  return out;
}

const REPOS = listRepos(ROOT);
let active = REPOS[0] || null;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

async function git(args) {
  const { stdout } = await run("git", args, { cwd: active.path, maxBuffer: 32 * 1024 * 1024 });
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
  if (!active) return { repo: null, branch: "", watching: false, files: [] };
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
      st = statSync(join(active.path, path));
    } catch {
      continue; // deleted but still tracked -> no building, which is correct
    }
    if (!st.isFile()) continue;
    files.push({ path, bytes: st.size, mtime: st.mtimeMs, dirty: dirty.has(path) });
  }

  // recursive watch can fail to open; when it does everything falls back to the
  // 700ms poll and the latency floor triples with nothing on screen saying so.
  return { repo: active.name, branch: branchOut.trim(), watching: watcher !== null, files };
}

// ---- clients ----
const clients = new Set();
let lastPayload = null;

// `ms` is deliberately kept out of the dedup baseline. it changes on every
// scan, so folding it into `body` would make the 700ms poll emit a fresh
// payload forever and turn an idle repo into a permanent broadcast.
function broadcast(snapshot, ms) {
  const body = JSON.stringify(snapshot);
  if (body === lastPayload) return; // nothing moved, stay quiet
  lastPayload = body;
  const frame = `data: ${JSON.stringify({ ...snapshot, ms })}\n\n`;
  for (const res of clients) res.write(frame);
}

let pending = null;
function schedule(delay) {
  if (pending) clearTimeout(pending);
  pending = setTimeout(async () => {
    pending = null;
    const t0 = performance.now();
    try {
      broadcast(await scan(), Math.round(performance.now() - t0));
    } catch (err) {
      console.error("scan failed:", err.message);
    }
  }, delay);
}

// fast path: content edits. .git churn is ignored here and covered by the poll.
let watcher = null;
function startWatch() {
  if (watcher) { watcher.close(); watcher = null; }
  if (!active) return;
  try {
    watcher = watch(active.path, { recursive: true }, (_evt, name) => {
      if (!name) return;
      const p = name.replaceAll("\\", "/");
      if (p.startsWith(".git/") || p === ".git" || p.includes("node_modules/")) return;
      schedule(140);
    });
  } catch (err) {
    console.warn("recursive watch unavailable, polling only:", err.message);
  }
}

// ponytail: one active repo for the whole process. make it per-client only if
// two windows on two different projects ever actually matter.
function setActive(repo) {
  if (!repo || (active && repo.path === active.path)) return;
  active = repo;
  lastPayload = null;   // the next snapshot must go out even if it looks familiar
  startWatch();
  schedule(0);
}

startWatch();

// commits, checkouts and stashes touch refs in .git subdirectories, so no
// single non-recursive watch catches them reliably — a plain poll does.
// three git calls on a 51-file repo cost ~10ms, so this is ~1.5% duty.
// ponytail: fixed 700ms poll; make it adaptive if you ever point this at a
// repo where `git status` takes longer than the interval.
setInterval(() => schedule(0), 700);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/repos") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(REPOS.map(r => r.name)));
    return;
  }

  if (url.pathname === "/events") {
    // the name is looked up in the list we already built; it is never joined
    // into a path, which is what keeps this from being a traversal hole.
    const want = url.searchParams.get("repo");
    if (want) {
      const found = REPOS.find(r => r.name === want);
      if (!found) {
        res.writeHead(400).end("unknown repo");
        return;
      }
      setActive(found);
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    clients.add(res);
    req.on("close", () => clients.delete(res));
    try {
      // deliberately not touching lastPayload: it is the dedup baseline for
      // every client, and setting it here on behalf of one arrival suppressed
      // the post-switch broadcast to all the others. a duplicate frame to this
      // one client is harmless — snapshots are idempotent.
      const t0 = performance.now();
      const snap = await scan();
      res.write(`data: ${JSON.stringify({ ...snap, ms: Math.round(performance.now() - t0) })}\n\n`);
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
    const body = readFileSync(join(WEB_ROOT, file));
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`gitopolis: ${REPOS.length} repo(s) under ${ROOT}`);
  console.log(`open http://localhost:${PORT}`);
});
