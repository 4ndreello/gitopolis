# Mundo Vivo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the repo-city PoC into an ambient background world — the day passes on its own (5 real minutes = one full day), the project is picked from the UI, and the window shrinks to a full-bleed canvas with a minimal overlay.

**Architecture:** Every new derivation is a pure function in `src/city.js` (clock, per-building lights, traffic rhythm, weather), driven client-side from `Date.now()`, so nothing is ever persisted. Every new visual goes into `src/main.js` directly beside the system it resembles — rain next to dust, stars next to the sky dome, pedestrians next to traffic. `server.mjs` gains a repo list and a swappable active repo; the SSE snapshot shape is unchanged.

**Tech Stack:** Node 20+ (no deps beyond esbuild + three), three.js r0.185, plain `assert` in `test.mjs`, esbuild bundle.

**Spec:** `docs/superpowers/specs/2026-08-16-mundo-vivo-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/city.js` | Pure derivations only. Gains `DAY_MS`, `dayT`, `dayIndex`, `clockLabel`, `litAt`, `trafficAt`, `weatherAt`. Still imports nothing. |
| `src/main.js` | Scene, buildings, wiring, and now the ambient systems too. Grows to roughly 980 lines, still banner-sectioned. Loses both sliders. |
| `server.mjs` | Git + fs + SSE. Gains `GET /repos` and `?repo=` on `/events`, plus a single swappable active repo. |
| `index.html` | Full-bleed canvas + minimal floating overlay (repo select, branch, clock, status). |
| `test.mjs` | Flat `assert` file. Gains asserts for every new pure function. |

**No new files.** An earlier draft put pedestrians, sky and rain in a `src/life.js`. That was dropped: the three share nothing with each other, and each one's real sibling already lives in `main.js` — rain is a near-clone of the dust system, stars belong under the sky dome, pedestrians belong beside `updateCars`. A module boundary between a system and its twin is how the two drift apart.

**Critical constraint:** `src/city.js` must never import three.js, touch `document`, or touch `window`. `test.mjs` imports it in plain node — that is the only cheap verification path in this project.

---

### Task 0: Make this a git repository

`game-claude/` has no `.git` directory, so every commit step below would fail. This task fixes that first.

- [ ] **Step 1: Confirm there is no repository yet**

Run: `ls -d .git`
Expected: `ls: cannot access '.git': No such file or directory`

If it *does* exist, skip the rest of Task 0 and go to Task 1.

- [ ] **Step 2: Initialise and make the baseline commit**

```bash
git init
git add -A
git commit -m "chore: initial commit of repo-city"
```

- [ ] **Step 3: Verify**

Run: `git log --oneline`
Expected: one commit, `chore: initial commit of repo-city`.

Run: `git status --short`
Expected: empty output (`bundle.js` is gitignored).

---

### Task 1: Clock — pure functions

Five real minutes is one in-game day. `t` is a fraction of the day in `[0, 1)`, where `0` is midnight. The existing `applyTime` keyframes already map that range onto night/dawn/noon/dusk, so no keyframe changes.

**Files:**
- Modify: `src/city.js` (append at end of file)
- Modify: `test.mjs`

- [ ] **Step 1: Write the failing tests**

In `test.mjs`, extend the import on line 4 to:

```js
import { dirKey, floorsOf, planCity, isHouse, DAY_MS, dayT, dayIndex, clockLabel } from "./src/city.js";
```

Then insert this block just above the final `console.log` on line 82:

```js
// --- the in-game clock wraps and never lies about the hour ---
assert.equal(dayT(0), 0, "epoch is midnight");
assert.equal(dayT(DAY_MS / 2), 0.5, "half a day");
assert.equal(dayT(DAY_MS), 0, "the day wraps");
assert.equal(dayT(12345), dayT(12345 + DAY_MS * 7), "same point in every day");
for (const ms of [0, 1, 99999, 300001, 1e12]) {
  assert.ok(dayT(ms) >= 0 && dayT(ms) < 1, `dayT stays in [0,1) for ${ms}`);
}

assert.equal(dayIndex(0), 0);
assert.equal(dayIndex(DAY_MS - 1), 0);
assert.equal(dayIndex(DAY_MS), 1);

assert.equal(clockLabel(0), "00:00");
assert.equal(clockLabel(0.25), "06:00");
assert.equal(clockLabel(0.5), "12:00");
assert.equal(clockLabel(0.9999), "23:59");
assert.notEqual(clockLabel(1), "24:00", "the label never reads 24:00");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `SyntaxError: The requested module './src/city.js' does not provide an export named 'DAY_MS'`

- [ ] **Step 3: Implement**

Append to `src/city.js`:

```js
// ---- clock ----
// five real minutes is one in-game day. derived straight from the wall clock,
// so there is no epoch to store and a reload lands on the same hour.
export const DAY_MS = 300000;

export function dayT(now) {
  return (((now % DAY_MS) + DAY_MS) % DAY_MS) / DAY_MS;
}

export function dayIndex(now) {
  return Math.floor(now / DAY_MS);
}

export function clockLabel(t) {
  const mins = Math.floor(t * 1440) % 1440;
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  return `${h}:${String(mins % 60).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — `ok — all city derivation checks passed`

- [ ] **Step 5: Commit**

```bash
git add src/city.js test.mjs
git commit -m "feat: derive an in-game clock from the wall clock"
```

---

### Task 2: Lights, traffic and weather — pure functions

**Files:**
- Modify: `src/city.js` (append at end of file)
- Modify: `test.mjs`

- [ ] **Step 1: Write the failing tests**

Extend the `./src/city.js` import on line 4 again, adding `litAt, trafficAt, weatherAt`.

Insert above the final `console.log`:

```js
// --- buildings light up on their own schedules, never all at once ---
{
  const paths = Array.from({ length: 200 }, (_, i) => `src/f${i}.js`);
  const litAt23 = paths.filter(p => litAt(p, 23 / 24) === 1);
  assert.ok(litAt23.length > 0, "some buildings are lit at 23:00");
  assert.ok(litAt23.length < paths.length, "and some are not — the skyline is uneven");
  for (const p of paths) {
    assert.equal(litAt(p, 12 / 24), 0, `${p} must be dark at noon`);
    assert.equal(litAt(p, 8 / 24), 0, `${p} must be dark at 08:00`);
  }
}

// --- traffic has a 3am trough and two rush peaks ---
assert.ok(trafficAt(3 / 24) < trafficAt(8 / 24), "3am is deader than the morning rush");
assert.ok(trafficAt(3 / 24) < trafficAt(18 / 24), "3am is deader than the evening rush");
assert.ok(trafficAt(13 / 24) < trafficAt(8 / 24), "midday is calmer than rush hour");
for (const h of [0, 3, 8, 13, 18, 23]) {
  const d = trafficAt(h / 24);
  assert.ok(d >= 0 && d <= 1, `trafficAt stays in [0,1] at ${h}h`);
}

// --- weather is a projection of the day, not a stored roll ---
assert.deepEqual(weatherAt(42), weatherAt(42), "the same in-game day always has the same weather");
assert.ok(weatherAt(42).overcast >= 0 && weatherAt(42).overcast <= 1);
assert.ok(weatherAt(42).rain >= 0 && weatherAt(42).rain <= 1);
{
  let wet = 0;
  for (let d = 0; d < 200; d++) {
    const w = weatherAt(d);
    if (w.rain > 0) {
      wet++;
      assert.ok(w.overcast > 0.7, `day ${d} rains without being overcast`);
    }
  }
  assert.ok(wet > 0 && wet < 120, `rain is occasional, not constant (got ${wet}/200)`);
}
```

The first block replaces an earlier draft's `assert.equal(litAt(p, t), litAt(p, t))`, which compared an expression to itself and proved nothing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `does not provide an export named 'litAt'`

- [ ] **Step 3: Implement**

Append to `src/city.js`:

```js
// ---- ambient rhythms ----
// every building keeps its own schedule, so the city lights up window by
// window instead of the whole skyline flipping on at once.
export function litAt(path, t) {
  const h = hash(path);
  if (rand01(h) < 0.15) return 0;         // some places are simply empty
  const on = 17 + rand01(h + 1) * 3;      // 17:00 .. 20:00
  const off = 21 + rand01(h + 2) * 6;     // 21:00 .. 03:00, wrapping past midnight
  const hour = t * 24;
  const lit = off > 24 ? hour >= on || hour < off - 24 : hour >= on && hour < off;
  return lit ? 1 : 0;
}

// two rush peaks over a daytime plateau, with a dead trough around 3am.
export function trafficAt(t) {
  const hour = t * 24;
  const peak = (centre, width) => Math.exp(-(((hour - centre) / width) ** 2));
  return Math.min(1, 0.05 + 0.35 * peak(13, 5) + 0.6 * peak(8, 1.6) + 0.6 * peak(18, 1.8));
}

// weather is seeded by the in-game day, not sampled and stored, so it stays a
// pure projection: the same day always has the same sky.
export function weatherAt(day) {
  const overcast = rand01(day * 1.7);
  return { overcast, rain: overcast > 0.72 ? (overcast - 0.72) / 0.28 : 0 };
}
```

Measured behaviour, for reference when the numbers get tuned: `trafficAt` gives 0.056 at 3h, 0.779 at 8h, 0.400 at 13h, 0.779 at 18h. About 60% of paths are lit at 23:00. About one in four in-game days is wet.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/city.js test.mjs
git commit -m "feat: add pure light, traffic and weather rhythms"
```

---

### Task 3: Automatic clock and minimal HUD

Both sliders are deleted. The canvas fills the window, a small overlay floats on top, and the clock drives `applyTime` every frame.

**Files:**
- Modify: `index.html`
- Modify: `src/main.js`

- [ ] **Step 1: Replace `index.html` entirely**

```html
<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Repo City</title>
<style>
:root { --ink: #f2f6fa; --ink-2: #cbd7e2; --accent: #ffc76b; --bad: #ff8b7f; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; overflow: hidden; }
body {
  background: #0d141c; color: var(--ink);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px; -webkit-font-smoothing: antialiased;
}
#cv { position: fixed; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; }
#cv:active { cursor: grabbing; }
#hud {
  position: fixed; top: 8px; left: 10px;
  display: flex; align-items: center; gap: 10px;
  pointer-events: none;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
  font-variant-numeric: tabular-nums;
}
#hud .sep { color: var(--ink-2); opacity: 0.5; }
#repo {
  pointer-events: auto;
  background: transparent; border: 0; padding: 0;
  color: var(--ink); font: inherit; font-weight: 600;
  cursor: pointer; outline: none;
}
#repo option { background: #131d27; color: var(--ink); }
#r-branch { color: var(--accent); }
#r-clock { font-weight: 600; }
#r-status { color: var(--bad); }
#r-status[data-ok="1"] { display: none; }
</style>
</head>
<body>
<canvas id="cv"></canvas>
<div id="hud">
<select id="repo"></select>
<span class="sep">·</span>
<span id="r-branch">…</span>
<span class="sep">·</span>
<b id="r-clock">00:00</b>
<span id="r-status" data-ok="0">conectando…</span>
</div>
<script src="bundle.js"></script>
</body>
</html>
```

`#r-status` is hidden while the connection is fine — the overlay only speaks up when something is broken.

- [ ] **Step 2: Extend the `city.js` import in `src/main.js`**

Replace lines 3–6:

```js
import {
  GUT, FLOOR_H, MAX_FLOORS,
  hash, rand01, dirKey, extOf, floorsOf, isHouse, planCity,
} from "./city.js";
```

with:

```js
import {
  GUT, FLOOR_H, MAX_FLOORS,
  hash, rand01, dirKey, extOf, floorsOf, isHouse, planCity,
  dayT, dayIndex, clockLabel, litAt, trafficAt, weatherAt,
} from "./city.js";
```

- [ ] **Step 3: Drop both sliders**

In the "camera framing" section, replace:

```js
const angleEl = document.getElementById("angle");
const timeEl = document.getElementById("time");
```

with:

```js
const CAM_ANGLE = 52;        // degrees above the horizon; drag the scene to change it
let fogFar = 200;            // clear-sky baseline, captured below and scaled by weather
let frozenT = null;          // set by window.__time() to hold a fixed hour
```

Inside `frameCamera`, replace:

```js
  const polar = THREE.MathUtils.degToRad(90 - Number(angleEl.value));
```

with:

```js
  const polar = THREE.MathUtils.degToRad(90 - CAM_ANGLE);
```

Still inside `frameCamera`, replace:

```js
  scene.fog.far = dist * 4.2;
```

with:

```js
  fogFar = dist * 4.2;
  scene.fog.far = fogFar;
```

`fog.far` is written here and nowhere else, which is exactly why Task 9 must assign it rather than scale it in place. Delete this line entirely:

```js
angleEl.addEventListener("input", frameCamera);
```

- [ ] **Step 4: Shrink the HUD helpers and inline `hud`**

Replace the whole `el` object and the `hud` function with:

```js
const el = {
  repo: document.getElementById("repo"),
  branch: document.getElementById("r-branch"),
  clock: document.getElementById("r-clock"),
  status: document.getElementById("r-status"),
};
function setStatus(text, ok) {
  el.status.textContent = text;
  el.status.dataset.ok = ok ? "1" : "0";
}
```

`setStatus` moves up here because the old `hud` function is gone: after the counters left the DOM it was two writes behind a guard, with one real caller. Its body moves into `ingest`. At the end of `ingest`, replace:

```js
  hud(snapshot);
```

with:

```js
  if (snapshot.repo && el.repo.value !== snapshot.repo) el.repo.value = snapshot.repo;
  el.branch.textContent = snapshot.branch || "?";
```

Then delete the now-dangling `setStatus` definition further down the file (the one directly above `const es = new EventSource("/events");`) and delete the orphaned call inside the `layoutDirty` branch of `tick`:

```js
    hud(null);
```

`files`, `districts` and `dirty` counts survive in `window.__city()`.

- [ ] **Step 5: Drive the clock from the loop**

In `tick`, immediately after:

```js
  clock += dt;
```

add:

```js
  const t = frozenT ?? dayT(Date.now());
```

Then replace this pair of lines (quoted together because `applyTime(Number(timeEl.value));` also appears at the bottom of the file, at column 0 — match the two-space indentation and the preceding line):

```js
  updateCars(dt);
  applyTime(Number(timeEl.value));
```

with:

```js
  updateCars(dt);
  applyTime(t);
```

Replace the fps declaration:

```js
const fpsEl = document.getElementById("r-fps");
```

with:

```js
let fps = 0;
```

And replace the half-second block:

```js
  if (fpsAcc > 0.5) {
    fpsEl.textContent = Math.round(fpsN / fpsAcc);
    hud(null);
    fpsAcc = 0; fpsN = 0;
  }
```

with:

```js
  if (fpsAcc > 0.5) {
    fps = Math.round(fpsN / fpsAcc);
    el.clock.textContent = clockLabel(t);
    fpsAcc = 0; fpsN = 0;
  }
```

- [ ] **Step 6: Fix the bootstrap lines at the bottom of the file**

Replace the module-level call (the one at column 0, last three lines of the file):

```js
applyTime(Number(timeEl.value));
frameCamera();
```

with:

```js
frameCamera();
applyTime(dayT(Date.now()));
```

`frameCamera` now runs first because it is what sets `fogFar`.

Replace the whole `window.__city` assignment with:

```js
// local-only inspection hook; the smoke tests read this
window.__city = () => ({
  files: files.size,
  dirty: [...files.values()].filter(f => f.dirty).length,
  growing: [...files.values()].filter(f => f.grown < 1).length,
  dying: [...files.values()].filter(f => f.dying).length,
  cranes: [...buildings.values()].filter(b => b.crane.visible).length,
  minGrown: Math.min(...[...files.values()].map(f => f.grown)),
  dust: dust.length,
  districts: layout.districts,
  fps,
});
// freeze the clock at a fixed hour for screenshots; pass null to resume
window.__time = (t) => { frozenT = t; };
```

- [ ] **Step 7: Build and verify**

Run: `npm run build`
Expected: esbuild finishes with no errors.

Run: `node server.mjs .` and open `http://localhost:4173`.
Expected:
- the canvas fills the whole window, no bar at the top;
- the overlay reads `▾ · <branch> · HH:MM` — **the dropdown is empty on purpose until Task 4 populates it**;
- the clock advances roughly one in-game minute every 0.2 s, and the sky cycles night → day → night inside five minutes;
- `window.__time(0.98)` in the console snaps to night and holds; `window.__time(null)` resumes.

- [ ] **Step 8: Commit**

```bash
git add index.html src/main.js
git commit -m "feat: run the day automatically and shrink the HUD to an overlay"
```

---

### Task 4: Project picker

The command-line argument becomes a root: the directory itself if it is a repo, plus every direct child that is one.

**Files:**
- Modify: `server.mjs`
- Modify: `src/main.js`

- [ ] **Step 1: Rename the existing `ROOT`, then add repo discovery**

`server.mjs:14` already has `const ROOT = import.meta.dirname;`. The new repo root also wants the name `ROOT`, and two `const ROOT` in one module scope is a parse-time `SyntaxError` — so **both edits below must land before running anything.**

First, rename the existing one. Replace:

```js
const ROOT = import.meta.dirname;
```

with:

```js
const WEB_ROOT = import.meta.dirname;
```

and, in the static-file handler near the bottom, replace:

```js
    const body = readFileSync(join(ROOT, file));
```

with:

```js
    const body = readFileSync(join(WEB_ROOT, file));
```

Next, widen the fs import. Replace:

```js
import { watch, statSync, readFileSync } from "node:fs";
```

with:

```js
import { watch, statSync, readFileSync, existsSync, readdirSync } from "node:fs";
```

Finally, replace:

```js
const REPO = resolve(process.argv[2] || ".");
```

with:

```js
const ROOT = resolve(process.argv[2] || ".");

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
```

- [ ] **Step 2: Point git and scan at the active repo**

Replace:

```js
  const { stdout } = await run("git", args, { cwd: REPO, maxBuffer: 32 * 1024 * 1024 });
```

with:

```js
  const { stdout } = await run("git", args, { cwd: active.path, maxBuffer: 32 * 1024 * 1024 });
```

Replace:

```js
async function scan() {
```

with:

```js
async function scan() {
  if (!active) return { repo: null, branch: "", files: [] };
```

This guard is what keeps `git()` from dereferencing a null `active` when the root holds no repos — `scan` is `git`'s only caller.

Replace:

```js
      st = statSync(join(REPO, path));
```

with:

```js
      st = statSync(join(active.path, path));
```

Replace:

```js
  return { repo: REPO.split("/").pop(), branch: branchOut.trim(), files };
```

with:

```js
  return { repo: active.name, branch: branchOut.trim(), files };
```

- [ ] **Step 3: Make the watcher swappable**

Replace the whole block — comment line included, so it does not end up duplicated:

```js
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
```

with:

```js
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
```

- [ ] **Step 4: Add `/repos` and `?repo=` to the HTTP handler**

The handler's first statement is `const url = new URL(req.url, "http://localhost");`. The new branch goes **after** that line — above it, `url` is in its temporal dead zone and every request throws. Replace:

```js
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/events") {
```

with:

```js
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
```

Only names cross the wire — paths never leave the server.

- [ ] **Step 5: Update the startup log**

Replace:

```js
  console.log(`repo-city watching ${REPO}`);
```

with:

```js
  console.log(`repo-city: ${REPOS.length} repo(s) under ${ROOT}`);
```

- [ ] **Step 6: Wire the select in `src/main.js`**

Replace the whole `EventSource` block:

```js
const es = new EventSource("/events");
es.onopen = () => setStatus("ligado", true);
es.onerror = () => setStatus("sem conexão", false);
es.onmessage = (ev) => {
  const snap = JSON.parse(ev.data);
  if (snap.error) { setStatus(snap.error, false); return; }
  setStatus("ligado", true);
  ingest(snap);
};
```

with:

```js
// switching repos does not clear local state on purpose: ingest already marks
// every vanished file as dying, so the old city crumbles while the new one
// rises under scaffolding. the transition comes for free.
let es = null;
function connect(name) {
  if (es) es.close();
  es = new EventSource(name ? `/events?repo=${encodeURIComponent(name)}` : "/events");
  es.onopen = () => setStatus("ligado", true);
  es.onerror = () => setStatus("sem conexão", false);
  es.onmessage = (ev) => {
    const snap = JSON.parse(ev.data);
    if (snap.error) { setStatus(snap.error, false); return; }
    setStatus("ligado", true);
    ingest(snap);
  };
}

fetch("/repos")
  .then(r => r.json())
  .then(names => {
    for (const name of names) {
      const o = document.createElement("option");
      o.value = o.textContent = name;
      el.repo.append(o);
    }
    connect(names[0]);
  })
  .catch(() => connect(null));

el.repo.addEventListener("change", () => connect(el.repo.value));
```

- [ ] **Step 7: Build and verify the happy path**

Run: `npm run build && node server.mjs ..`

(`..` is `~/Desktop/dev`, so the list should hold every project there.)

Expected in the terminal: `repo-city: N repo(s) under /home/andreello/Desktop/dev` with N > 1.

Open `http://localhost:4173`. Expected:
- the dropdown lists every project;
- picking a different one makes the old city crumble while a new one rises;
- the branch name updates to the new project's branch.

- [ ] **Step 8: Verify the traversal guard**

Run: `curl -i "http://localhost:4173/events?repo=../../etc"`
Expected: `HTTP/1.1 400 Bad Request`, body `unknown repo`.

Run: `curl -s http://localhost:4173/repos`
Expected: a JSON array of plain strings. No paths.

- [ ] **Step 9: Commit**

```bash
git add server.mjs src/main.js
git commit -m "feat: pick the project from the overlay instead of the command line"
```

---

### Task 5: Per-building window lights

Today `applyTime` writes one `emissiveIntensity` across shared facade materials, so the whole skyline flips at once. Each building gets its own clone instead. That adds no draw call — there is already one mesh per building — but it does add a material that has to be disposed.

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Clone the facade material per building**

In `makeBuilding`, replace:

```js
  const body = house
    ? new THREE.Mesh(GEO_BOX, houseMats[seed % houseMats.length])
    : new THREE.Mesh(bodyGeo(floors), facadeMats[pat][idx]);
```

with:

```js
  // ponytail: one cloned material per building. clone() shares the textures by
  // reference, so this costs a uniform block each and no extra draw call. if a
  // 2k-file repo ever stutters, instance by (pattern, colour) instead.
  const facade = house ? null : facadeMats[pat][idx].clone();
  const body = house
    ? new THREE.Mesh(GEO_BOX, houseMats[seed % houseMats.length])
    : new THREE.Mesh(bodyGeo(floors), facade);
```

Replace the `cap` construction so the crown lights with its tower:

```js
    cap = new THREE.Mesh(bodyGeo(Math.max(2, Math.round(floors * 0.3))), facadeMats[pat][idx]);
```

with:

```js
    cap = new THREE.Mesh(bodyGeo(Math.max(2, Math.round(floors * 0.3))), facade);
```

In the `b` object literal, replace:

```js
    spin: rand01(seed + 3) * Math.PI * 2,
```

with:

```js
    spin: rand01(seed + 3) * Math.PI * 2,
    facade, lit: 0,
```

- [ ] **Step 2: Dispose the clone**

`disposeBuilding` runs on every floor-count change, not just on delete, so this is the common path during editing — and Task 4 makes a repo switch dispose the whole city at once. Replace:

```js
function disposeBuilding(path) {
  const b = buildings.get(path);
  if (!b) return;
  cityRoot.remove(b.group);
  buildings.delete(path);
}
```

with:

```js
function disposeBuilding(path) {
  const b = buildings.get(path);
  if (!b) return;
  cityRoot.remove(b.group);
  if (b.facade) b.facade.dispose();   // cloned per building, so nothing else holds it
  buildings.delete(path);
}
```

- [ ] **Step 3: Stop `applyTime` from driving every facade**

In `applyTime`, delete:

```js
  const lit = THREE.MathUtils.lerp(a.lit, b.lit, k);
  for (const m of allFacadeMats) m.emissiveIntensity = lit;
```

Delete the now-unused declaration:

```js
const allFacadeMats = facadeMats.flat();
```

And delete the four `lit:` keys from the `DAY` keyframe table — `dawn`, `noon`, `dusk` and `night` each carry one, and nothing reads them any more. Leaving them there would tell the next reader that `applyTime` still drives facades.

- [ ] **Step 4: Ease each building toward its own schedule**

`updateBuilding` has one call site, so the hour and the frame delta are passed in rather than smuggled through module globals. Change the signature:

```js
function updateBuilding(f) {
```

to:

```js
function updateBuilding(f, t, dt) {
```

and add this just before the function's closing brace:

```js
  if (b.facade) {
    // ease rather than snap: a window coming on over a fraction of a second
    // reads as somebody flicking a switch; an instant flip reads as a bug
    const want = litAt(f.path, t) * 0.85;
    b.lit += (want - b.lit) * Math.min(1, dt * 2.5);
    b.facade.emissiveIntensity = b.lit;
  }
```

Update the single call site in `tick`, replacing:

```js
    updateBuilding(f);
```

with:

```js
    updateBuilding(f, t, dt);
```

`t` is already declared at the top of `tick` from Task 3, above the file loop.

- [ ] **Step 5: Report lit buildings from the debug hook**

In `window.__city()`, add:

```js
  lit: [...buildings.values()].filter(b => b.lit > 0.4).length,
```

- [ ] **Step 6: Build and verify**

Run: `npm run build && node server.mjs .`

In the devtools console:

```js
window.__time(0.5);  setTimeout(() => console.log("noon", window.__city().lit), 1500);
window.__time(0.95); setTimeout(() => console.log("23h",  window.__city().lit), 3000);
```

Expected: `noon 0`, and `23h` above zero but below the total building count — roughly 60% of them. Visually the towers should be lit unevenly at `0.95`, with dark gaps between them. Then `window.__time(null)`.

- [ ] **Step 7: Commit**

```bash
git add src/main.js
git commit -m "feat: light each building on its own schedule"
```

---

### Task 6: Traffic rhythm

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Take a density argument in `updateCars`**

Replace the whole function:

```js
function updateCars(dt) {
  if (!cars) return;
  const items = cars.userData.items;
  for (let i = 0; i < items.length; i++) {
```

with:

```js
function updateCars(dt, density) {
  if (!cars) return;
  const items = cars.userData.items;
  // spare instances are hidden with count, never makeScale(0,0,0): a zero scale
  // gives a singular normal matrix and the driver draws garbage triangles
  cars.count = Math.max(0, Math.round(items.length * density));
  const pace = 0.35 + density * 0.9;
  for (let i = 0; i < cars.count; i++) {
```

and, inside the same loop, replace:

```js
    it.t += it.speed * dt;
```

with:

```js
    it.t += it.speed * pace * dt;
```

- [ ] **Step 2: Pass the rhythm in from the loop**

In `tick`, replace:

```js
  updateCars(dt);
```

with:

```js
  updateCars(dt, trafficAt(t));
```

- [ ] **Step 3: Report it from the debug hook**

In `window.__city()`, add:

```js
  cars: cars ? cars.count : 0,
```

- [ ] **Step 4: Build and verify**

Run: `npm run build && node server.mjs .`

In the devtools console:

```js
window.__time(3 / 24);  setTimeout(() => console.log("3am", window.__city().cars), 500);
window.__time(8 / 24);  setTimeout(() => console.log("8am", window.__city().cars), 1500);
```

Expected: 3am clearly smaller than 8am, and no white quads anywhere at 3am — one would mean an instance got hidden by a zero scale instead of by `count`.

- [ ] **Step 5: Commit**

```bash
git add src/main.js
git commit -m "feat: give traffic a time-of-day rhythm"
```

---

### Task 7: Pedestrians

Goes directly below `updateCars` in `src/main.js` — same instancing pattern, same `count` discipline, same section of the file.

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Add the walkers below `updateCars`**

Insert after the closing brace of `updateCars`:

```js
// pedestrians walk the perimeter of each block plate. a walker's position is a
// single number: distance travelled around a square ring.
const GEO_PED = new THREE.BoxGeometry(0.07, 0.18, 0.07);
const pedMat = new THREE.MeshStandardMaterial({ color: 0x2f3540, roughness: 0.9 });
let peds = null;

// returns [x, z, side]; side is which of the four kerbs the walker is on
function ringAt(ring, t) {
  const s = ((t % ring.per) + ring.per) % ring.per;
  const side = Math.floor(s / (ring.half * 2));
  const u = (s % (ring.half * 2)) - ring.half;
  if (side === 0) return [u, -ring.half, 0];
  if (side === 1) return [ring.half, u, 1];
  if (side === 2) return [-u, ring.half, 2];
  return [-ring.half, -u, 3];
}

function rebuildPedestrians() {
  if (peds) { scene.remove(peds); peds = null; }
  // the plate is scaled to size + 0.24, so a ring at size + 0.10 sits on it.
  // anything wider lands on the curb, which is 0.027 lower — and the walkers
  // then visibly hover.
  const rings = layout.blocks.map(blk => {
    const { x, z } = worldPos(blk.bx + (blk.size - 1) / 2, blk.by + (blk.size - 1) / 2);
    const half = (blk.size + 0.10) / 2;
    return { x, z, half, per: half * 8 };
  });
  if (!rings.length) return;

  const max = Math.min(260, rings.length * 8);
  peds = new THREE.InstancedMesh(GEO_PED, pedMat, max);
  peds.castShadow = true;
  peds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  peds.userData.walkers = [];
  for (let i = 0; i < max; i++) {
    const ring = rings[i % rings.length];
    peds.userData.walkers.push({
      ring,
      t: rand01(i * 2.3) * ring.per,
      speed: 0.45 + rand01(i * 5.9) * 0.35,
      dir: i % 2 ? 1 : -1,
    });
  }
  scene.add(peds);
}

const _pm = new THREE.Matrix4();
function updatePedestrians(dt, density) {
  if (!peds) return;
  const w = peds.userData.walkers;
  peds.count = Math.max(0, Math.round(w.length * density));
  for (let i = 0; i < peds.count; i++) {
    const p = w[i];
    p.t += p.speed * p.dir * dt;
    const [ox, oz, side] = ringAt(p.ring, p.t);
    // face along the kerb being walked. side 0 heads +x, 1 heads +z, 2 heads -x,
    // 3 heads -z, which is (1 - side) quarter turns; reversed walkers add half.
    _pm.makeRotationY((1 - side) * Math.PI / 2 + (p.dir > 0 ? 0 : Math.PI));
    _pm.setPosition(p.ring.x + ox, 0.20, p.ring.z + oz);
    peds.setMatrixAt(i, _pm);
  }
  peds.instanceMatrix.needsUpdate = true;
}
```

`0.20` is the plate top (`0.04 + 0.14/2 = 0.11`) plus half a walker's height (`0.09`).

- [ ] **Step 2: Rebuild them with the ground**

At the end of `rebuildGround`, replace:

```js
  rebuildTrees();
  rebuildCars();
```

with:

```js
  rebuildTrees();
  rebuildCars();
  rebuildPedestrians();
```

- [ ] **Step 3: Drive them from the loop**

In `tick`, directly after the `updateCars` line, add:

```js
  // people show up a little before the cars and linger a little later
  updatePedestrians(dt, Math.min(1, trafficAt(t - 0.02) * 1.15));
```

`trafficAt` is a sum of gaussians over `t * 24`, so a slightly negative argument is fine — it needs no wrapping.

- [ ] **Step 4: Report them from the debug hook**

In `window.__city()`, add:

```js
  peds: peds ? peds.count : 0,
```

- [ ] **Step 5: Build and verify**

Run: `npm run build && node server.mjs .`

In the devtools console:

```js
window.__time(8 / 24); setTimeout(() => console.log("8am", window.__city().peds), 800);
window.__time(3 / 24); setTimeout(() => console.log("3am", window.__city().peds), 1600);
```

Expected: 8am well above zero, 3am near zero. Scroll in: small dark figures circle the block edges, standing **on** the plates — not floating above them, not sunk in — and each one faces the direction it is walking, on all four sides of the loop.

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "feat: put pedestrians on the sidewalks"
```

---

### Task 8: Stars and moon

Goes directly below the sky dome block in `src/main.js`, which is the thing they belong to.

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Add the night sky after the sky dome**

Insert immediately after the `scene.add(new THREE.Mesh(new THREE.SphereGeometry(420, 32, 20), …))` block closes:

```js
// ---- night sky ----
// inside the dome (radius 420), fog off so they do not wash out at the horizon
const stars = (() => {
  const N = 700, R = 380;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const a = rand01(i * 1.7) * Math.PI * 2;
    const y = 0.05 + rand01(i * 3.1) * 0.95;        // upper hemisphere only
    const rxz = Math.sqrt(Math.max(0, 1 - y * y));
    pos[i * 3] = Math.cos(a) * rxz * R;
    pos[i * 3 + 1] = y * R;
    pos[i * 3 + 2] = Math.sin(a) * rxz * R;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const m = new THREE.Points(geo, new THREE.PointsMaterial({
    // sizeAttenuation:false makes gl_PointSize device pixels, so it has to be
    // scaled by the same ratio the renderer uses or stars go sub-pixel on hidpi
    size: 1.8 * Math.min(2, window.devicePixelRatio || 1),
    sizeAttenuation: false, color: 0xdfe8f5,
    transparent: true, opacity: 0, depthWrite: false, fog: false,
  }));
  m.frustumCulled = false;
  return m;
})();
const moon = new THREE.Mesh(
  new THREE.SphereGeometry(8, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xe6ecf6, fog: false })
);
moon.visible = false;
scene.add(stars, moon);

function updateNightSky(t, overcast) {
  const night = Math.pow(Math.max(0, Math.cos(t * Math.PI * 2)), 0.7);   // 1 at midnight
  stars.material.opacity = night * (1 - overcast * 0.9);
  stars.visible = stars.material.opacity > 0.01;
  moon.visible = night > 0.05 && overcast < 0.85;
  if (moon.visible) {
    const a = t * Math.PI * 2;
    moon.position.set(Math.sin(a) * 270, 40 + night * 200, -Math.cos(a) * 270);
  }
}
```

- [ ] **Step 2: Drive it from the loop**

In `tick`, directly after `applyTime(t);`, add:

```js
  updateNightSky(t, weatherAt(dayIndex(Date.now())).overcast);
```

Task 9 hoists that `weatherAt` call into a local, since three lines will want it.

- [ ] **Step 3: Build and verify**

Run: `npm run build && node server.mjs .`

In the devtools console: `window.__time(0)`.
Expected: a star field across the upper sky, clearly visible rather than a dust of half-pixels, and a pale moon disc high above. `window.__time(0.5)` — both gone, no leftover dots against the blue.

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -m "feat: add stars and a moon to the night sky"
```

---

### Task 9: Weather — overcast and rain

Rain goes below the dust section, which it resembles. The weather scaling folds **into** `applyTime`, because that function already owns the sun, the hemisphere light and the fog — scaling them from outside would need a comment saying "do not move this line", and a comment like that is where the 3am page comes from.

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Add rain below the dust section**

Insert after `function spawnDust(…) { … }` closes:

```js
// ---- rain ----
// drops recycle forever and never change count, so unlike dust they need no
// per-particle object: the position buffer is the state.
const RAIN_MAX = 1400;
const rainPos = new Float32Array(RAIN_MAX * 3);
const rainVel = new Float32Array(RAIN_MAX);
for (let i = 0; i < RAIN_MAX; i++) {
  rainPos[i * 3 + 1] = -1;                    // below ground, so it recycles on frame one
  rainVel[i] = 9 + rand01(i * 4.1) * 5;
}
let rainSpan = 60;                            // full width of the drop box, set with the ground
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
const rainPoints = new THREE.Points(rainGeo, new THREE.PointsMaterial({
  size: 0.11, color: 0xa8bcca, transparent: true, opacity: 0.5,
  depthWrite: false, fog: false,
}));
rainPoints.frustumCulled = false;
rainPoints.visible = false;
scene.add(rainPoints);

function updateRain(dt, amount) {
  const n = Math.round(RAIN_MAX * Math.min(1, Math.max(0, amount)));
  rainPoints.visible = n > 0;
  if (!n) return;
  for (let i = 0; i < n; i++) {
    const y = rainPos[i * 3 + 1] - rainVel[i] * dt;
    if (y < 0) {
      rainPos[i * 3] = (Math.random() - 0.5) * rainSpan;
      rainPos[i * 3 + 2] = (Math.random() - 0.5) * rainSpan;
      rainPos[i * 3 + 1] = 18 + Math.random() * 10;
    } else {
      rainPos[i * 3 + 1] = y;
    }
  }
  rainGeo.setDrawRange(0, n);
  rainGeo.attributes.position.needsUpdate = true;
}
```

`(Math.random() - 0.5) * rainSpan` spreads drops over `±rainSpan/2`, so `rainSpan` really is the box width.

- [ ] **Step 2: Size the drop box with the city**

In `rebuildGround`, immediately after:

```js
  const far = Math.max(layout.gw, layout.gh) * 4 + 60;
```

add:

```js
  rainSpan = Math.max(40, Math.max(layout.gw, layout.gh) + 12);
```

- [ ] **Step 3: Add a gate so `__toggle("clouds")` still works**

The deck visibility is about to be written every frame, which would make the documented toggle a no-op. Next to the `clouds` array declaration, add:

```js
let cloudsOn = true;   // flipped by window.__toggle("clouds")
```

and in `window.__toggle`, replace:

```js
  if (what === "clouds") for (const c of clouds) c.visible = !c.visible;
```

with:

```js
  if (what === "clouds") cloudsOn = !cloudsOn;
```

- [ ] **Step 4: Fold weather into `applyTime`**

Change the signature:

```js
function applyTime(t) {
```

to:

```js
function applyTime(t, weather) {
```

Replace:

```js
  sun.intensity = THREE.MathUtils.lerp(a.si, b.si, k);
  hemi.intensity = THREE.MathUtils.lerp(a.hemi, b.hemi, k);
  scene.fog.color.copy(lerpStop(a, b, k, "fog"));
```

with:

```js
  // weather scales the clear-sky baseline here, in the one function that owns
  // these values. fog.far in particular is only ever written by frameCamera, so
  // scaling it in place from the loop would decay it to zero within a second.
  sun.intensity = THREE.MathUtils.lerp(a.si, b.si, k) * (1 - weather.rain * 0.55 - weather.overcast * 0.15);
  hemi.intensity = THREE.MathUtils.lerp(a.hemi, b.hemi, k);
  scene.fog.color.copy(lerpStop(a, b, k, "fog"));
  scene.fog.far = fogFar * (1 - weather.rain * 0.35);
```

- [ ] **Step 5: Drive it all from the loop**

In `tick`, replace the two lines from Tasks 3 and 8:

```js
  applyTime(t);
  updateNightSky(t, weatherAt(dayIndex(Date.now())).overcast);
```

with:

```js
  const weather = weatherAt(dayIndex(Date.now()));
  applyTime(t, weather);
  updateNightSky(t, weather.overcast);
  updateRain(dt, weather.rain);
  cloudMat.opacity = 0.62 + weather.overcast * 0.33;
```

In the cloud-drift loop above it, replace:

```js
  for (const c of clouds) {
    c.position.x += c.userData.speed * dt * 2.4;
    if (c.position.x > lim) c.position.x = -lim;
  }
```

with:

```js
  const deck = Math.round(3 + weatherAt(dayIndex(Date.now())).overcast * 5);
  clouds.forEach((c, i) => {
    c.position.x += c.userData.speed * dt * 2.4;
    if (c.position.x > lim) c.position.x = -lim;
    c.visible = cloudsOn && i < deck;
  });
```

Finally, fix the module-level bootstrap call at the bottom of the file. Replace:

```js
applyTime(dayT(Date.now()));
```

with:

```js
applyTime(dayT(Date.now()), weatherAt(dayIndex(Date.now())));
```

- [ ] **Step 6: Build and verify**

Run: `npm run build && node server.mjs .`

To see rain without waiting for a wet day, temporarily change `updateRain(dt, weather.rain)` to `updateRain(dt, 1)`, rebuild, and confirm:
- drops fall over the whole city footprint and vanish at ground level;
- the sun dims and the fog closes in — **and stays put**, rather than swallowing the city within a second;
- the cloud deck is at its thickest;
- `window.__toggle("clouds")` still hides and shows the clouds.

Then revert that one-token edit and rebuild.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. Nothing in Tasks 3–9 touches `planCity`, so the layout assertions must still hold — if they fail, the change is wrong, not the test.

Run: `npm run build`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/main.js
git commit -m "feat: give each in-game day its own weather"
```

---

## Done when

- `node server.mjs ~/Desktop/dev` lists every project in a dropdown, and switching rebuilds the city without a restart.
- The clock in the overlay runs a full 00:00 → 23:59 every five minutes, with no slider anywhere.
- Towers light up one at a time in the evening and go dark at different hours.
- Traffic and pedestrians thin out at 3am and jam at 8am and 18h.
- The night sky has stars and a moon; some in-game days are overcast and about one in four is wet.
- Rain dims the scene without the fog collapsing, and `window.__toggle` still works for every layer it names.
- `npm test` passes, including the existing layout assertions.
- The window shrinks to roughly 600×650 with nothing overlapping or wrapping.
