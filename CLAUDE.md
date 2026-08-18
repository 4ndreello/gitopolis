# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A desktop toy: a 3D city that is a live view of a git repository. Every tracked (or
untracked-but-not-ignored) file is a building. File size sets height, directory sets
district, uncommitted files wear scaffolding and a crane, and committing drops every
crane at once.

## Commands

```bash
npm run build                        # esbuild -> bundle.js (required before serving)
npm run dev                          # same, in --watch
node server.mjs <path-to-any-repo>   # serve on :4173, watching that repo
npm test                             # node test.mjs — the whole suite
PORT=4180 node server.mjs ../foo     # override port
```

`npm test` runs a single flat file of `assert` calls with no framework. There is no
per-test runner: to isolate a case, comment out the others or add a temporary
`process.exit()`. Keep it that way unless the suite grows past one screen.

The user has `repocity` / `rc` / `repocity-stop` shell functions in `~/.zshrc` that wrap
build + serve + open browser. `bundle.js` is gitignored, so a fresh checkout must build.

## Architecture

Two processes, because a browser cannot read the filesystem or run git.

```
server.mjs  ── git + fs ──►  SSE /events  ──►  src/main.js (three.js)  ──►  canvas
             (node)          full snapshot      diffs vs prev frame
```

`server.mjs` sends a **full snapshot** on every change (`{repo, branch, files[]}`), not a
diff. The client owns all diffing and animation. This is deliberate: snapshots are
idempotent, so a dropped or duplicated message cannot desync the city.

### The load-bearing invariant

**The city is a pure projection of the working tree and is never persisted.** There is no
save file and no "last processed commit" cursor. Restarting produces an identical city;
`git checkout`, rebase, amend and force-push all morph it correctly for free, because
none of them are treated as events — only the resulting file tree matters.

Animation state (`grown`, `dying`, `flash`, the eased `bytes`) lives *only* in the
client's in-memory `files` Map in `src/main.js`. It is derived from comparing consecutive
snapshots, never stored. Do not add persistence for it; that reintroduces the whole
git-history-reconciliation problem this design exists to avoid.

### src/city.js is pure on purpose

It holds `hash`, `dirKey`, `floorsOf`, `planCity` and the tuning constants, and imports
nothing. That is why `test.mjs` can import it in plain node with no DOM and no WebGL.
Keep three.js, `document` and `window` out of this file — the test suite is the only
cheap way to verify the derivation, and it dies the moment this file needs a browser.

### Layout: hashed districts, hashed plots

`planCity` assigns positions as `hash(dirname) -> block cell` and
`hash(basename) -> plot inside that block`, with linear probing over a path-sorted list.
Nothing is index-assigned. The point is that **adding or removing a file must not move
its siblings** — teleporting buildings destroy the illusion instantly. `test.mjs` guards
this; if a change makes those assertions fail, the change is wrong, not the test.

Districts are sized to their own contents (`ceil(sqrt(count))`) and centered in a cell
whose pitch comes from the largest district. Leftover grid cells become parks, never
holes in the asphalt.

A block always covers its **whole cell**; `blk.inner` is the smaller rectangle the
buildings occupy. The renderer paves `inner` and lays the rest of the cell to lawn.
Paving only `inner` left a two-file district as a small plate marooned in the middle of
the asphalt, which read as a city block built on top of the road.

**Known ceiling:** block size and grid width derive from file count, so crossing a
threshold reshuffles every coordinate. Invisible during normal editing, visible on a
branch switch that adds dozens of files. Unfixed. The fixes considered were growing the
grid in power-of-two steps, or animating the reflow as a city-wide slide.

### Streets: one derivation, four consumers

`roadLines(layout)` and `intersections(layout)` in `city.js` are the only place the road
grid is computed. Traffic lanes, painted strips, crosswalks and lamp posts all read them;
when the lane list was computed inline in `rebuildCars` it drifted from everything else by
a curb width.

A cell is `block` columns wide, but its plots sit on integer centres `bx .. bx+block-1`,
so it only *spans* `block - 1`. `roadLines` centred the road on the cell gap
(`r*stride - GUT/2`) instead of between the plot columns (`r*stride - (GUT+1)/2`), which
put every street half a plot into the next block: two thirds of the paint ended up buried
under that block's kerb and the far row of lamp posts stood on its lawn. `test.mjs` now
asserts a road is equidistant from the plot column on each side.

The gutter is `GUT` (1.35) wide but the curb ring overhangs `0.31` on each side, so only
`ROAD_W` (0.73) is asphalt anyone can see. Paint outside that is paint under a kerb — the
first version of the edge lines was invisible for exactly this reason. Anything drawn on
the road stacks on the documented `Y_*` heights in `main.js`; they are millimetres apart
because coplanar quads z-fight.

The crane is the one part of a building that can legitimately leave its plot: it sweeps a
circle around its own plot centre. At the original mast offset and a 1.9-long jib that
radius was 2.1 — two plots — so a repo under construction drew a thicket of orange bars
across every road. It is now ~1.2, which overhangs the kerb and stops there. Bodies and
scaffolding never leave the paving; if that ever looks wrong, measure before changing the
layout.

### The camera aims itself

`driveCamera` in `main.js` eases `controls.target` and the camera→target distance
towards `focus()` (`city.js`), the attention-weighted centre of everything that
just changed. Every diff in `ingest()` stamps `attn = 1` on its file; `attn` decays
at 0.35/s, so one save is a close-up and a commit — where every `dirty` flag flips
at once — pulls the frame back out over the whole city. Going home is not a state:
it is the focus radius growing until it matches `homeDist`.

Three things here are not free choices:

- The gate is `controls.autoRotate`, **not** `idleTimer === 0`. `idleTimer` is 0
  *during* a drag as well as when idle, so gating on it makes the camera fight the
  pointer. `autoRotate` is the real "nobody has touched this for 6s" flag.
- The radius is weighted (`hypot * w`), never thresholded. A commit stamps every
  file in the same frame, so any cutoff drops them all together and the frame
  collapses to the minimum distance for a fifth of a second before pulling out.
- Only the distance moves; the polar angle is left alone. `CAM_ANGLE` carries a
  measured contract (the moon arc rides just under the top edge at that pitch).

Deleted files pull through a separate `ghosts` array, because `dying` removes the
entry from `files` after 0.67s while the attention lasts ~2.9s — following an
entry that no longer exists makes the centroid jump mid-travel.

`frameCamera` no longer moves the camera except once, on the first non-empty
layout; it only records `homeTarget` / `homeDist`. That also removes the teleport
that used to fire on every `layoutDirty`. The flip side is that the layout reflow
ceiling above is now visible: a branch switch slides the city under a moving
camera instead of hiding it behind a cut.

### src/props.js: procedural props

Vehicles, lamp posts, bus stops, bins, hydrants and sign posts are each **one merged
geometry** (`mergeGeometries` over boxes and cylinders), so a hundred cars are one draw
call. Two tricks carry the file:

- **vertex colour** — `instanceColor` multiplies it, so a white body takes the per-car
  tint while dark tyres and glass stay dark.
- **glow uv** — every vertex is pinned to one texel of a 3-pixel strip (unlit / white /
  red) used as the `emissiveMap`, so raising `emissiveIntensity` lights only the
  headlights and the lamp heads. `nightK(t)` drives it, the same way `litAt` drives the
  building windows.

### How git is actually used

Only two things come from git; everything else is `fs.statSync`.

- `git ls-files -z -c -o --exclude-standard` — the file list. `--exclude-standard` is what
  honours `.gitignore`, and it is the single flag preventing `node_modules` from becoming
  40,000 buildings. Untracked-but-not-ignored files are included on purpose: a file you
  just created is the most interesting event there is.
- `git status --porcelain -z` — the dirty set, which drives scaffolding and cranes.

Diff magnitude is deliberately *not* used: it is only defined against HEAD, so it goes
stale the moment you commit, while `fs.stat` is always current.

Change detection is two mechanisms, and both are needed:
- recursive `fs.watch` on the repo (~150ms debounce) for content edits. `.git/` and
  `node_modules/` events are skipped.
- a 700ms poll for commits, checkouts and stashes. These rewrite refs in `.git`
  subdirectories, so no single non-recursive watch catches them reliably. Measured
  commit-to-cranes-drop latency is ~280ms.

### No assets, by design

Every texture (facade patterns, lit windows, clouds) is drawn into a canvas at runtime;
every mesh is procedural three.js geometry. There is no image, model or font file in the
project, which is why it needs no art pipeline and no build step beyond esbuild. Before
adding an asset, know that this is a decision, not an oversight — the alternative
evaluated and kept in reserve is Kenney's CC0 `.glb` city kits, which would slot into the
same grid cells.

## Debugging the renderer

`src/main.js` exposes two hooks on `window` for headless inspection:

```js
window.__city()            // { files, dirty, growing, dying, cranes, minGrown, dust }
window.__toggle("dust")    // also "cars", "clouds", "city", "ground"
```

Visual bugs here are best confirmed with a headless browser using
`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`, screenshotting
`#cv`, and reading `window.__city()`. Two real bugs were found that way and neither was
visible from reading the code: a `dust` count stuck above zero with nothing growing
(`floorsOf` oscillating on a rounding boundary — hence the byte snap in the loop), and
`InstancedMesh` instances hidden with `makeScale(0,0,0)`, whose singular normal matrix
makes drivers emit garbage triangles (hence the exact per-material instance counts).

Note the cold open: on launch every file is new to the client, so the whole city rises
under scaffolding and settles after ~5s. A screenshot taken before then shows cranes
everywhere and is not a bug.

## Fixed: the flat white roofs

House roofs picked their tile material with `tileRoofMats[(seed >> 3) % len]`. `hash()`
returns an *unsigned* 32-bit value, so any seed above 2^31 went negative under the signed
`>>`, the modulo stayed negative, the lookup returned `undefined`, and `new THREE.Mesh(geo,
undefined)` silently falls back to three's default white `MeshBasicMaterial` — unlit, hence
flat white. Fixed by using `>>>`. Any future `hash()`-derived index must use `>>>` or
`Math.abs`; a negative index here fails silently instead of throwing.
