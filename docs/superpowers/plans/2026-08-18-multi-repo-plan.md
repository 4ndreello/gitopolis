# Multi-repo implementation plan

Spec: `docs/superpowers/specs/2026-08-18-multi-repo-design.md`

Five tasks, sequential. Tasks 1 and 2 touch disjoint files but run one at a time
anyway — the tree is shared with another live Claude session on `main`.

Branch policy: commit on `main`. The working tree is shared with a peer session
that is also on `main`; creating a branch here would move that session's HEAD
under it. Coordinate by message before touching `src/main.js`, and follow the
replayed-blob staging technique in memory if the tree is dirty at commit time.

---

## Task 1 — `src/city.js`: quantized pitch and repo-aware cell allocation

**Files:** `src/city.js`, `test.mjs`

Add:

```js
export const BLOCK_STEPS = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
export function blockStep(n)   // first step >= n; above the table, round up to a multiple of 16
export const BELT = 1;         // cells of green belt between repo rectangles
```

Change `planCity(files)`:

- Each file may carry `repo` and `key`. Use `f.key ?? f.path` as the map key for
  `layout.pos`. Files with no `repo` all belong to one unnamed repo, so the
  single-repo call in `test.mjs` still works.
- District grouping key becomes `repo + "\0" + dirKey(f.path)` so `src` in two
  repos are two districts. Keep `dirKey` itself untouched — it must stay a pure
  function of the path, and prefixing the path before calling it would silently
  cost one level of `DISTRICT_DEPTH`.
- Repos are `[...new Set(repo of each file)].sort()`.
- Per repo: `rcols = ceil(sqrt(nd_r))`, `rrows = ceil(nd_r / rcols)`.
- Meta-grid: `mcols = ceil(sqrt(nRepos))`. Meta-column width is the widest repo
  in it; meta-row height is the tallest. `BELT` cells between meta-columns and
  between meta-rows.
- `dcols = sum(colWidths) + BELT * (mcols - 1)`; same for `drows`. Everything
  downstream (`gw`, `gh`, `roadLines`, `intersections`) keeps its current
  formula.
- District cell: `hash(repoDirKey) % (rcols * rrows)`, linear probing **within
  the repo's local rectangle**, then mapped to a global cell index via the
  repo's origin. Probing must never escape into another repo's rectangle.
- `block = blockStep(maxSize)` instead of `block = maxSize`. Per-district
  `sizeOf` stays exact.
- Return one new field: `repos: [{ name, cx, cy, cols, rows }]` in cell units.

Leftover global cells (belt cells and repo-rectangle slack) must fall through to
the existing park path — do not add a new branch for them.

**Tests to add in `test.mjs`:**

1. Two repos, several districts each: every district's cell is inside its own
   repo's rectangle, and no repo's rectangle overlaps another's.
2. Every belt cell is present in `layout.blocks` with `park: true`.
3. `blockStep` is monotone non-decreasing, idempotent (`blockStep(blockStep(n)) === blockStep(n)`),
   and `blockStep(6) === blockStep(7)`.
4. Cross-repo stability: plan two repos, add one file to repo A, replan — every
   position in repo B is identical.
5. Same-repo stability still holds (the existing sibling assertion).
6. Single-repo `planCity` with no `repo` field still returns a usable layout.
   Existing assertions about *relative* stability must pass unmodified; update
   only assertions about absolute coordinates, which shift because of `blockStep`.

**Done when:** `npm test` passes, `src/city.js` still imports nothing and
mentions no DOM, no three.js and no `window`.

---

## Task 2 — `server.mjs`: subscriptions, per-repo watchers, staggered polls

**Files:** `server.mjs`

Replace the single `active` repo with:

```js
const MAX_REPOS = 4;
const repoState = new Map();  // path -> { repo, watcher, lastPayload, inflight, timer, refs }
const subs = new Map();       // res  -> Set<repoName>
```

- `scan(repo)` takes the repo instead of reading a global. Its returned snapshot
  always carries `repo`.
- `/events` reads `url.searchParams.getAll("repo")`, caps at `MAX_REPOS`, and
  rejects any name not present in the startup `REPOS` list with 400. Names are
  never joined into a path.
- Subscribe/unsubscribe by refcount. First subscriber to a repo opens its
  recursive `fs.watch` (keeping the existing `.git/` and `node_modules/` event
  filter) and starts its poll; the last unsubscriber closes the watcher, clears
  the timer and drops the entry.
- One message carries one repo's full snapshot. `lastPayload` is per repo, so an
  idle repo emits nothing. On connect, send the current snapshot of each
  subscribed repo directly to that client without touching `lastPayload` — the
  existing comment explains why that baseline belongs to every client, not to
  one arrival.
- Broadcast only to clients subscribed to that repo.
- Polling: one `setInterval(700)` per watched repo, started behind
  `setTimeout(index * 175)` so they stagger, plus an `inflight` flag that skips a
  tick while that repo's scan is still running. Per-repo latency stays 700ms.
- `/repos` is unchanged.

**Done when:** `node server.mjs <path>` with one repo behaves exactly as before
(same latency, same dedup); with `?repo=a&repo=b` both stream independently, and
disconnecting a client closes the watchers nobody else wants.

---

## Task 3 — `src/main.js` + `index.html`: composite keys, scoped sweep, picker

**Files:** `src/main.js`, `index.html`

Announce the file and line ranges over SendMessage to the peer session before
starting.

- `files` Map keyed by `repo + "\0" + path`. Every entry carries `repo`, `path`
  and `key`.
- Seeding rule, from the spec — get this right or two repos sharing a filename
  collide:
  - composite key seeds building identity: plot hash, district hash,
    `litAt(key, t)`, and the window pattern (`dirKey` bucket).
  - bare path seeds file type: the facade colour from `extOf(path)`.
- `ingest(snapshot)` handles one repo. **Its deletion sweep must skip entries
  belonging to other repos**, or repo B's first snapshot demolishes repo A.
- `connect(names)` takes an array and opens one `EventSource` with repeated
  `repo=` params. Hash is `#a,b,c`.
- `<select id="repo">` in `index.html:109` becomes `<select multiple>`, sized to
  show four rows. The `change` handler caps the selection at four and reverts a
  fifth pick. `ingest`'s `el.repo.value` write goes away — the snapshot no
  longer names "the" repo.
- Boot curtain: `phase` stays `"wait"` until every subscribed repo has delivered
  a first snapshot. The lift condition in `tick` is unchanged.
- Repo signs: one per entry of `layout.repos`, placed at the near corner of the
  rectangle, reusing `mkSignTex` and the `posts` InstancedMesh in
  `rebuildFurniture` (`main.js:794-866`) at a larger scale, text is the repo name.
- `window.__city()` gains a per-repo breakdown: name, file count, dirty count.

**Do not** change `worldPos`, `fileWorld`'s use of `layout.pos`, `rebuildGround`
or any of the 21 `layout` read sites beyond the key change — the whole point of
the one-city design is that they keep working.

**Done when:** `npm test` passes, `npm run build` succeeds, and two repos
selected in the picker render as two neighbourhoods with a belt between them.

---

## Task 4 — `src/main.js`: instance facades by (pattern, colour)

**Files:** `src/main.js`

`makeBuilding` (`main.js:409-421`) clones one material and adds one `Mesh` per
building. Replace with one `InstancedMesh` per `(pattern, colour)` bucket —
`facadeMats` is already a `[pattern][colour]` grid at `main.js:274-280`, so the
bucket count is bounded by `PATTERNS.length * FACADE.length`, not by file count.

Constraints, both documented in CLAUDE.md and both load-bearing:

- Exclude hidden instances by setting `mesh.count` to the exact live count.
  **Never** `makeScale(0, 0, 0)` — the singular normal matrix makes drivers emit
  garbage triangles. This project has already shipped that bug once.
- Any `hash()`-derived bucket index uses `>>>` or `Math.abs`. A negative index
  yields `undefined`, and `new THREE.Mesh(geo, undefined)` falls back to an
  unlit white `MeshBasicMaterial` instead of throwing.

Scaffolding, cranes, caps, floodlight rigs and beacons stay per-building objects
— they exist only on dirty files and tall towers, and are animated per building.
The peer session's recent commit `f41130f` reworked `makeBuilding`'s crane and
scaffold groups and `disposeBuilding`'s cleanup of the cloned `b.wash` material;
read those first. Do not assume child indices inside the `scaffold` or `crane`
groups — iterate the `off` array, per the note in CLAUDE.md.

**Done when:** `npm run build` succeeds, the city renders identically to before
at one repo, and `window.__city()` reports the same file and dirty counts. Verify
draw-call reduction by counting the facade meshes in the scene, not by eye.

---

## Task 5 — `CLAUDE.md`

**Files:** `CLAUDE.md`

Add a "Multi-repo: four repos, one city" section covering: why one merged
`planCity` instead of four layouts, the repo-rectangle allocation and the belt,
the composite-key seeding rule, `blockStep` and what it fixes, one-repo-per-SSE
message and why it stays idempotent, and the staggered per-repo poll. Amend the
layout section's "Known ceiling" note, which `blockStep` now partly addresses,
and the props section to mention facade instancing.

A peer session also edits `CLAUDE.md`. Merge into the copy on disk rather than
overwriting it.
