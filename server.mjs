// watches git repos and streams their file state to the browser over SSE.
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
const MAX_REPOS = 4;

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

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

async function git(repo, args) {
  const { stdout } = await run("git", args, { cwd: repo.path, maxBuffer: 32 * 1024 * 1024 });
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

async function scan(repo, watching) {
  // -c cached + -o others, --exclude-standard honours .gitignore for free.
  // that one flag is what keeps node_modules from becoming 40k buildings.
  const [listOut, statusOut, branchOut] = await Promise.all([
    git(repo, ["ls-files", "-z", "-c", "-o", "--exclude-standard"]),
    git(repo, ["status", "--porcelain", "-z"]),
    git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);

  const dirty = parseStatus(statusOut);
  const seen = new Set();
  const files = [];
  for (const path of splitZ(listOut)) {
    if (seen.has(path)) continue;
    seen.add(path);
    let st;
    try {
      st = statSync(join(repo.path, path));
    } catch {
      continue; // deleted but still tracked -> no building, which is correct
    }
    if (!st.isFile()) continue;
    files.push({ path, bytes: st.size, mtime: st.mtimeMs, dirty: dirty.has(path) });
  }

  // recursive watch can fail to open; when it does everything falls back to the
  // 700ms poll and the latency floor triples with nothing on screen saying so.
  return { repo: repo.name, branch: branchOut.trim(), watching, files };
}

// ---- clients and watched repos ----
// one message carries one repo's full snapshot. bundling all four into a single
// message would re-send four repos' worth of JSON whenever any one of them
// moved; per-repo messages keep every snapshot idempotent and the wire cost
// proportional to what actually changed.
const repoState = new Map(); // path -> { repo, watcher, lastPayload, inflight, timer, pending, refs }
const subs = new Map();      // res  -> Set<repoName>

// `ms` is deliberately kept out of the dedup baseline. it changes on every
// scan, so folding it into `body` would make the 700ms poll emit a fresh
// payload forever and turn an idle repo into a permanent broadcast.
// the baseline is per repo, so a busy repo never un-quiets its idle neighbours.
function broadcast(st, snapshot, ms) {
  const body = JSON.stringify(snapshot);
  if (body === st.lastPayload) return; // nothing moved, stay quiet
  st.lastPayload = body;
  const frame = `data: ${JSON.stringify({ ...snapshot, ms })}\n\n`;
  for (const [res, names] of subs) if (names.has(st.repo.name)) res.write(frame);
}

async function tick(st) {
  if (st.inflight) return; // a scan slower than the interval must not lap itself
  st.inflight = true;
  const t0 = performance.now();
  try {
    broadcast(st, await scan(st.repo, st.watcher !== null), Math.round(performance.now() - t0));
  } catch (err) {
    console.error(`scan failed (${st.repo.name}):`, err.message);
  } finally {
    st.inflight = false;
  }
}

function schedule(st, delay) {
  clearTimeout(st.pending);
  st.pending = setTimeout(() => { st.pending = null; tick(st); }, delay);
}

// fast path: content edits. .git churn is ignored here and covered by the poll.
function startWatch(st) {
  try {
    st.watcher = watch(st.repo.path, { recursive: true }, (_evt, name) => {
      if (!name) return;
      const p = name.replaceAll("\\", "/");
      if (p.startsWith(".git/") || p === ".git" || p.includes("node_modules/")) return;
      schedule(st, 140);
    });
  } catch (err) {
    console.warn("recursive watch unavailable, polling only:", err.message);
  }
}

// a repo is watched while at least one client wants it; the last leaver takes
// its watcher and timer down, so an unsubscribed repo costs nothing.
// ponytail: refcounted per repo, uncapped in total. MAX_REPOS bounds one
// client's selection, not the process — ten clients on ten different repos
// watch ten repos. cap globally only if that ever happens for real.
function subscribe(repo) {
  const st = repoState.get(repo.path);
  if (st) { st.refs++; return st; }

  const fresh = { repo, watcher: null, lastPayload: null, inflight: false, timer: null, pending: null, refs: 1 };
  repoState.set(repo.path, fresh);
  startWatch(fresh);

  // commits, checkouts and stashes touch refs in .git subdirectories, so no
  // single non-recursive watch catches them reliably — a plain poll does.
  // three git calls on a 51-file repo cost ~10ms, so this is ~1.5% duty.
  // the offset staggers the watched repos instead of firing twelve execFiles
  // in one burst; per-repo latency is still exactly 700ms.
  // ponytail: fixed 700ms poll; make it adaptive if you ever point this at a
  // repo where `git status` takes longer than the interval.
  const offset = (repoState.size - 1) * 175;
  fresh.timer = setTimeout(() => {
    fresh.timer = setInterval(() => tick(fresh), 700);
    tick(fresh);
  }, offset);
  return fresh;
}

function unsubscribe(repo) {
  const st = repoState.get(repo.path);
  if (!st || --st.refs > 0) return;
  st.watcher?.close();
  clearTimeout(st.pending);
  clearTimeout(st.timer); // kills the stagger timeout or the interval, either way
  repoState.delete(repo.path);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/repos") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(REPOS.map(r => r.name)));
    return;
  }

  if (url.pathname === "/events") {
    // names are looked up in the list we already built; they are never joined
    // into a path, which is what keeps this from being a traversal hole.
    // dedup before the cap, not after: four copies of one name would otherwise
    // spend the whole budget and drop the repos behind them without a word.
    const want = [...new Set(url.searchParams.getAll("repo"))];
    const picked = [];
    for (const name of want) {
      const found = REPOS.find(r => r.name === name);
      if (!found) {
        res.writeHead(400).end("unknown repo");
        return;
      }
      if (picked.length < MAX_REPOS) picked.push(found);
    }
    // no `repo` param at all is the old client asking for "the" repo.
    if (!picked.length && REPOS[0]) picked.push(REPOS[0]);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    subs.set(res, new Set(picked.map(r => r.name)));
    const states = picked.map(subscribe);
    req.on("close", () => {
      subs.delete(res);
      for (const r of picked) unsubscribe(r);
    });

    for (const st of states) {
      try {
        // deliberately not touching lastPayload: it is the dedup baseline for
        // every client, and setting it here on behalf of one arrival suppressed
        // the post-switch broadcast to all the others. a duplicate frame to this
        // one client is harmless — snapshots are idempotent.
        const t0 = performance.now();
        const snap = await scan(st.repo, st.watcher !== null);
        res.write(`data: ${JSON.stringify({ ...snap, ms: Math.round(performance.now() - t0) })}\n\n`);
      } catch (err) {
        res.write(`data: ${JSON.stringify({ repo: st.repo.name, error: err.message })}\n\n`);
      }
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
