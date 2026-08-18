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

### Framing is per-viewport, not per-fov

`fitDistance` and `frameFraction` (`city.js`, tested in `test.mjs` at simulated
sizes) own the home framing. Two things were wrong before and both only showed up
in a small window:

- the fit used the *vertical* fov alone, so it was correct at one aspect and let
  the far side of the city walk off the edge of a portrait or a squat one.
  `fitDistance` fits both axes, at the camera pitch: a ground disc of radius `r`
  seen from `CAM_ANGLE` covers `r` horizontally and `r*sin(pitch)` vertically.
- home was always the *whole city*. At 300px that is a static logo — buildings
  land on three pixels each and none of the cars, cranes or lit windows read.
  `frameFraction` shrinks what home covers with the canvas (a district at pip
  size, the skyline on a desktop), so a small window is a close view that moves,
  not a distant one that does not. `autoRotateSpeed` scales with it for the same
  reason; at 0.18 the orbit is five minutes long.
- fitting *both* axes is still contain, and contain is the small-plate picture
  in a 230x330 window: the long axis fits and the short one is left over. The
  `cover` argument blends contain -> cover with the canvas, so a pip window
  fills its tight axis and lets the rest run off the edge. Cropping is the point
  of a small window, not a defect.

The near limit is on the distance (16), never on the radius. Flooring the radius
framed an 8-unit box around a 5-unit city, which is exactly how an 18-file repo
ended up as a plate in the middle of a small window.

`resize()` owns both, so dragging the window re-frames instead of stretching.
Real events still win: `attn` pulls the camera to whatever actually changed and
that distance is computed from the event, never from the home framing.

Deleted files pull through a separate `ghosts` array, because `dying` removes the
entry from `files` after 0.67s while the attention lasts ~2.9s — following an
entry that no longer exists makes the centroid jump mid-travel.

`frameCamera` no longer moves the camera except once, on the first non-empty
layout; it only records `homeTarget` / `homeDist`. That also removes the teleport
that used to fire on every `layoutDirty`. The flip side is that the layout reflow
ceiling above is now visible: a branch switch slides the city under a moving
camera instead of hiding it behind a cut.

### One particle system, six events

Six things can happen to a file — `born`, `grow`, `shrink`, `dirty`, `done`,
`died` — and each one is an entry in the `FX` table in `main.js`: colours,
launch spread, gravity multiplier, drag, life rate, and which layer it draws in.
`fx(kind, x, y, z, n)` is the only spawner. Before this the same beige puff
stood for all of them with only the particle count varying, so the city could
say that something happened but never what.

It is still one array and one update loop. Colour is per-vertex (`vertexColors`),
physics is per-particle (`g`, `d`, `r`), and `k` picks the buffer: the fine layer
(`dustPoints`, size 0.45) or the smoke layer (`smokePoints`, size 1.1, opacity
0.28). Smoke needs the second layer because a grain at 0.45 reads as a gnat
swarm no matter how dark you paint it, and demolition has to look like
demolition. Two draw calls total.

Sizes are set against the rain, not against nothing: on a wet day
(`weatherAt().rain`) the sky is already a field of specks at the old 0.3, which
is what a per-event burst has to be told apart from.

`DUST_MAX` is one global pool, so both batch events divide it by how many files
they touch. That split lives in `ingest()` — the only place that knows a commit
dropped 40 cranes at once, or a checkout deleted 40 files at once — which is why
`died` spawns there rather than in the `dying` branch of the loop. Without it the
first few roofs spend the whole pool and the rest of the city celebrates, or
burns, in silence. New files are born dirty and never flip, so the cold open
stays quiet.

### Floodlights: the city points a light at its towers

Every tower (`!house && floors > 8`, the same test that gives it a `cap`) carries three
extra meshes, all children of its own group so they rise and die with it: `GEO_FLOOD`
(four fixtures on the paving, lit by the glow texel like a lamp head), `GEO_WASH` (four
quads hugging the walls, additive, `h / 3` tall) and `GEO_FLOODPOOL` (four puddles on the
plate, the lamp's own pool texture in a colder colour). No `THREE.SpotLight` anywhere —
a real light costs on every lit material in the scene and recompiles shaders when the
count changes.

The wash is cold (`0xbfd6ff`) against a city where every other light is ochre, so it
reads as light aimed AT the building rather than light coming out of it.

Two things were measured, not guessed:

- **the wash alone does not carry.** At home distance the wall is a sliver and the
  paving is a wide surface facing the camera, so the ground pool is the half of the
  effect you actually see from there — the same reason the lamp pools are the most
  legible thing in the night city.
- **`0.55` opacity was invisible.** Additive, cold, over a dark tonemapped wall, it
  moved mean frame luminance by 0.003 — nothing. It runs at full `nightK` now. If a
  future additive layer ever "does not render", paint the material pure red for one
  build before touching the geometry: that is what proved the quads were in the right
  place all along.

`__toggle("flood")` A/Bs it in a live scene and `__city().floods` counts the lit towers.

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

### src/cheat.js: the cheats are an override layer, not state

F3 opens the debug panel and, bottom right, a slider panel: hour, rain, overcast, cloud
count, traffic, plus a button per `__toggle`. It is the clickable half of
`window.__time` / `window.__toggle`, which is why the hour is *not* in the `cheat`
object — it goes through `frozenT` like it always did, and every clock reader in
`main.js` (including the floodlight and lamp ramps off `nightK(t)`) honours it for free.

`cheat` holds one nullable field per knob, `null` meaning "follow the world", and it is
read **at the sampling site**, never written back:

- `mergeWeather(weatherAt(dayIndex(now)))` at the one line in `tick` that samples the
  day. One override there reaches rain particles, sun intensity, fog, star opacity, the
  cloud tint and the floodlight puddles together — anything that took `weather` already.
- `cheat.clouds ?? deck` and `cheat.traffic ?? trafficAt(t)`.

That placement is the whole design. `weatherAt` and `dayT` stay pure functions of the
clock, nothing is persisted, and a reload is the same city again — the load-bearing
invariant above survives a panel full of cheats because a cheat never becomes a fact.
`mergeWeather` merges per field, not per object (`??` on each key): forcing rain must
leave overcast on auto, and an override of `0` has to beat the world, which is why it
cannot be `||`. `test.mjs` covers both.

A knob on auto is a live readout — `syncCheat` feeds it the numbers the frame just used,
so the sliders track the day instead of showing a stale hour. An overridden knob keeps
its value; clicking the value column is the reset back to auto. The panel is the only
`pointer-events: auto` thing outside the hud, or a drag on a slider would reach
OrbitControls.

Verifying this headlessly: don't. `--virtual-time-budget` never expires against an
endless `requestAnimationFrame`, and swiftshader makes it hang for minutes. `mountCheat`
touches `document` only inside the function, so `test.mjs` mounts it against a
twenty-line stub instead.

## Debugging the renderer

`src/main.js` exposes two hooks on `window` for headless inspection:

```js
window.__city()            // { files, dirty, growing, dying, cranes, minGrown, dust }
window.__toggle("dust")    // also "cars", "clouds", "city", "ground", "flood"
window.__time(0.75)        // freeze the hour; null resumes. the F3 slider writes this
```

`--virtual-time-budget` never expires against the endless `requestAnimationFrame`
(see the cheat panel section above), so `--screenshot` and `--dump-dom` hang. Driving the
page over CDP does work and needs no puppeteer — node's global `WebSocket`, a
`Target.attachToTarget {flatten:true}` session, `Emulation.setDeviceMetricsOverride`
for the viewport (`--window-size` alone does not set it under `--headless=new`), a
plain ~20s wait for the cold open, then `Runtime.evaluate` and
`Page.captureScreenshot`. That is how the per-viewport framing above was measured.

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
