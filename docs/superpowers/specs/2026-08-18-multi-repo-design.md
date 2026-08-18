# Multi-repo: four repos, one city

Watch up to four repositories at once. Each repo becomes a contiguous
neighbourhood of the same city, separated from its neighbours by a green belt
and named by a sign.

## Why one city and not four

The alternative was four separate `planCity` layouts offset on a 2x2 grid. It
loses on cost: `layout` is a single module-level object in `main.js` read at 21
sites — `worldPos`, `fileWorld`, the ground rebuild, road lines, lamp spacing,
tree spots, car lanes, pedestrian rings, the sun orbit radius, the fog span, the
home framing. Four layouts means an indirection at every one of them.

Merging the repos into one `planCity` call keeps all 21 sites untouched: roads,
parks, traffic, weather and the camera keep working because the layout they read
is still one grid. The whole feature then lands in cell *allocation*, which is
about thirty lines.

## Layout: repos are rectangles of cells

`planCity` today allocates districts across one square grid of `dcols x drows`
cells, placing each district at `hash(dir) % cells` with linear probing. The
change is to constrain each repo's districts to its own rectangle of that grid.

```
                belt
  +----+----+  ~~~~  +----+----+
  | A  | A  |  ~~~~  | B  | B  |     A = gitopolis   B = api
  +----+----+  ~~~~  +----+----+     C = web         D = infra
  | A  |park|  ~~~~  | B  | B  |
  +----+----+  ~~~~  +----+----+     ~~ = belt cells, always parks
   ~~~~~~~~~~  ~~~~  ~~~~~~~~~~
  +----+----+  ~~~~  +----+----+     park = repo rectangle slack,
  | C  | C  |  ~~~~  | D  |park|            already handled today
  +----+----+  ~~~~  +----+----+
```

Derivation, in order:

1. Repos are `[...new Set(files.map(f => f.repo))].sort()`. Sorted, not
   selection-ordered, so the same four repos always produce the same city.
2. Per repo, `nd_r` districts give `rcols_r = ceil(sqrt(nd_r))`,
   `rrows_r = ceil(nd_r / rcols_r)` — the same sizing rule districts already use
   for their own contents.
3. Repos sit on a meta-grid of `mcols = ceil(sqrt(nRepos))` columns. A meta-column
   is as wide as its widest repo; a meta-row is as tall as its tallest.
4. `BELT = 1` cell between meta-columns and between meta-rows.
5. `dcols = sum(colWidths) + BELT * (mcols - 1)`, and likewise for rows. Every
   formula downstream of `dcols`/`drows` — `gw`, `gh`, `roadLines`,
   `intersections` — is unchanged.
6. A district's cell is `hash(repo + "\0" + dir) % (rcols_r * rrows_r)` with
   linear probing **inside the repo's rectangle**, then mapped to the global
   cell index through the repo's origin.

Leftover cells — the belt, and the slack inside a repo rectangle — fall out of
`takenCell` and become parks through the code that already exists. No new
geometry, no new branch in the renderer.

`planCity` returns one new field:

```js
repos: [{ name, cx, cy, cols, rows }]   // cell units, for the sign and the HUD
```

Single-repo behaviour is the same shape as today: one repo, `mcols = 1`, no
belt, one rectangle covering the whole grid.

### Identity keys

Two repos can both contain `src/index.js`. They are different buildings and must
not share a plot, a window schedule or a lit pattern. The rule:

- **Building identity** — plot hash, district hash, `litAt` seed, window pattern
  — is seeded from the composite key `repo + "\0" + path`.
- **File type** — the facade colour, which comes from `extOf(path)` — is seeded
  from the bare path. Two `.rs` files are the same colour in every repo, which
  is the point of colouring by extension.

`planCity` therefore keys `layout.pos` by `f.key ?? f.path`, so the pure
single-repo call in `test.mjs` keeps working unchanged.

### The reflow ceiling gets worse, so quantize the pitch

`block` — the cell pitch — is `max(ceil(sqrt(district size)))` across the whole
city. It is continuous, so the widest district crossing a perfect square — 9
files to 10, say — changes the pitch and slides every coordinate in the city.
CLAUDE.md records this as a known ceiling: invisible during normal editing,
visible on a branch switch.

(CLAUDE.md's own example, "6 files to 7", is not actually a threshold:
`ceil(sqrt(6))` and `ceil(sqrt(7))` are both 3. The ceiling is real, the example
was wrong.)

With four repos it stops being invisible. A district crossing a threshold in
repo A teleports every building in B, C and D — a repo you are not even looking
at reshuffles under an `npm i` somewhere else.

Fix: quantize the pitch to steps.

```js
export const BLOCK_STEPS = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
export function blockStep(n) { /* first step >= n, else round up to a multiple of 16 */ }
```

Only the global pitch quantizes. Each district keeps its exact `sizeOf`, so the
extra space becomes the lawn strip the renderer already paves around `inner`.

This is the "grow the grid in power-of-two steps" fix CLAUDE.md lists as
considered-and-not-done. Multi-repo is what earns it.

## Selection: which four

The `<select id="repo">` in `index.html:109` becomes `<select multiple>` — a
native multi-select, no custom widget, keyboard accessible for free. A `change`
handler caps the selection at four and refuses the fifth.

- URL: `/events?repo=a&repo=b&repo=c` — repeated params, `searchParams.getAll`.
- Hash: `#a,b,c`, so F5 returns to the same four.
- Server caps at four as well. The names are looked up in the `REPOS` list built
  at startup and never joined into a path, which is what keeps this from being a
  traversal hole — the same property the single-repo version has today.

## Server: per-repo watchers, staggered polls, per-repo dedup

`active` (one repo for the whole process) becomes:

```js
const repoState = new Map();  // path -> { repo, watcher, lastPayload, inflight, timer, refs }
const subs = new Map();       // res  -> Set<repoName>
```

A repo is watched while at least one client subscribes to it. The last
unsubscribe closes its watcher and clears its timer, so an unwatched repo costs
nothing.

**Message shape stays one repo per message**, full snapshot:

```js
{ repo, branch, watching, files: [...], ms }
```

This is the load-bearing choice. Sending all four repos in one message would
re-send four repos' worth of JSON every time any one of them changes. One repo
per message keeps every snapshot idempotent — a dropped or duplicated message
still cannot desync the city — while the wire cost stays proportional to what
actually moved. `lastPayload` becomes per repo so an idle repo stays quiet.

**Polling.** Today one `setInterval(700)` scans the single active repo. Four
repos on one timer is a burst of twelve `execFile` calls every 700ms, with no
guard against a slow repo's scan overlapping its own next tick.

Instead each repo gets its own `setInterval(700)`, started behind a
`setTimeout(idx * 175)` so the four are evenly staggered, plus an `inflight`
flag that skips a tick while that repo's previous scan is still running. Per-repo
latency stays exactly 700ms — identical to today — and a single subscribed repo
behaves exactly as it does now.

`scan()` takes the repo as an argument instead of reading a global.

## Client: composite keys and a scoped sweep

- `files` is keyed by `repo + "\0" + path`; each entry carries `repo` and `path`.
- `ingest(snapshot)` handles one repo. Its deletion sweep — the loop that marks
  vanished files `dying` — must only consider entries whose `repo` matches the
  snapshot's, or the arrival of repo B's snapshot would demolish repo A.
- `connect(names)` opens one `EventSource` for the whole set.
- Boot curtain: `phase` stays `"wait"` until every subscribed repo has delivered
  its first snapshot, then becomes `"rise"`. The lift condition (average `grown`
  across non-dying files) is unchanged and already spans all repos.

Nothing about animation state changes. It still lives only in the in-memory
`files` Map, still derived from comparing consecutive snapshots, still never
persisted. Four repos is four independent snapshot streams into one map, which
is exactly what the existing design already tolerates.

## The sign

Each repo gets one sign at the near corner of its rectangle, reusing `mkSignTex`
and the `posts` InstancedMesh that `rebuildFurniture` (`main.js:794-866`)
already builds for district signs — same geometry, same material, larger scale,
text is the repo name. `layout.repos` carries the corner.

The green belt alone reads as leftover space at home distance; the sign is what
names the neighbourhood.

## Performance: the real ceiling is draw calls

Measured, not assumed. `layoutDirty` triggers `rebuildGround()`
(`main.js:624-697`) and its six sub-rebuilders, and almost everything there is
already capped: trees at 1200, lamps at 320, cars at 90, pedestrians at 260.
Those do not grow with repo count. What grows is `layout.blocks` (curbs, plates,
parks), one road `Mesh` per road line, and one `mkSignTex` canvas per named
district — roughly 4x, from a small base.

The thing that grows badly is buildings. `makeBuilding` (`main.js:409-421`)
clones one material per building and adds one `Mesh` per building; there is no
instancing. Fifty-one files is fifty-one draw calls. Four repos of five hundred
files each is two thousand. The code already anticipates this:

> one cloned material per building… if a 2k-file repo ever stutters, instance by
> (pattern, colour) instead.

Multi-repo *is* the 2k-file repo. So:

**Facades are instanced by (pattern, colour).** `facadeMats` is already a
`[pattern][colour]` grid (`main.js:274-280`), so the bucket count is bounded by
`PATTERNS.length * FACADE.length` — around forty `InstancedMesh` objects total,
regardless of file count.

Constraints on that work, both already documented in CLAUDE.md and both
load-bearing:

- Hidden instances must be excluded by setting `mesh.count` to the exact live
  count. Never `makeScale(0, 0, 0)` — its singular normal matrix makes drivers
  emit garbage triangles, which is a real bug this project has already been bitten
  by.
- Any `hash()`-derived bucket index uses `>>>` or `Math.abs`. `hash()` returns
  unsigned 32-bit; a signed shift yields a negative index, and a negative index
  here fails silently as an untextured white mesh rather than throwing.

Scaffolding, cranes, caps and floodlight rigs stay per-building `Mesh` objects.
They only exist on dirty files and tall towers, so their count is small and their
animation is per-building anyway.

**Not doing:** scoping `rebuildGround` to the neighbourhood that changed. It was
in the original plan, but the measurement above shows the caps already bound most
of it, and scoping it requires diffing consecutive layouts to know which
rectangles moved. Revisit if F3 shows a frame-time spike on `layoutDirty` with
four real repos loaded.

**Not doing:** a per-repo file cap. It would keep a monorepo from drowning the
other three neighbourhoods, but the city stops being a faithful projection of the
working tree, which is the invariant the whole design exists to protect.

## Tests

`test.mjs` stays one flat file of `assert` calls, importing `city.js` in plain
node with no DOM.

- A district of repo A never lands in repo B's rectangle.
- Every belt cell is a park.
- `blockStep` is monotone and idempotent, and collapses the pairs the table
  actually collapses (5 and 6; 7 and 8). Note the table contains both 6 and 8,
  so `blockStep(6)` and `blockStep(7)` do *not* collapse — an earlier draft of
  this spec asserted they did, which contradicted its own table.
- **Cross-repo stability:** adding a file to repo A moves no building in repo B.
  This is the multi-repo form of the invariant `test.mjs` already guards — if a
  change makes it fail, the change is wrong, not the test.
- Same-repo stability still holds: adding a file moves no sibling.
- Single-repo `planCity` (files with no `repo`) still produces a valid city.
  Absolute positions shift because of the pitch quantization; the existing
  assertions about *relative* stability must still pass unchanged.

## What is deliberately unchanged

- The city is still a pure projection of the working trees, never persisted.
  Restarting produces an identical city; checkout, rebase, amend and force-push
  still morph it for free because none of them are events.
- Snapshots are still full, per repo, and idempotent.
- `city.js` still imports nothing and touches no DOM.
- Weather, clock, traffic and the cheat overrides are city-wide, not per repo.
  One sky over four neighbourhoods.
