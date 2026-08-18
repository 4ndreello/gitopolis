# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A desktop toy: a 3D city that is a live view of a git repository — up to four of them at
once, each a neighbourhood of the same city. Every tracked (or untracked-but-not-ignored)
file is a building. File size sets height, directory sets district, uncommitted files
wear scaffolding and a crane, and committing drops every crane at once.

## Commands

```bash
npm run build                        # esbuild -> bundle.js (required before serving)
npm run dev                          # same, in --watch
node server.mjs <path>               # serve on :4173. a repo, or a dir of repos
                                     # (one level deep); the hud picks up to 4
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

`server.mjs` sends a **full snapshot** on every change (`{repo, branch, watching,
files[]}`), not a diff, and one message carries one repo. The client owns all diffing and
animation. This is deliberate: snapshots are idempotent, so a dropped or duplicated
message cannot desync the city — which is also what lets four repos share one stream
without any ordering guarantee between them.

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

**Known ceiling, mostly closed:** block size and grid width derive from file count, so
crossing a threshold reshuffled every coordinate — invisible during normal editing,
visible on a branch switch. `blockStep` and `rectStep` quantize both, which is the
"power-of-two steps" fix this note used to list as considered-and-not-done. See the
multi-repo section below for why four repos are what forced it. What is left is a real
reflow when a *step* is crossed; animating it as a city-wide slide is still unbuilt.

### Multi-repo: four repos, one city

Up to four repos are watched at once. Each becomes a contiguous rectangle of the same
district grid, separated by a one-cell green belt and named by a sign.

**One `planCity` call, not four layouts.** The alternative was a layout per repo, offset
on a 2x2. It loses on cost: `layout` is a single module-level object read at 21 sites in
`main.js` — `worldPos`, `fileWorld`, the ground rebuild, road lines, lamp spacing, tree
spots, car lanes, pedestrian rings, the sun orbit, the fog span, the home framing. One
merged call leaves all 21 untouched; four layouts need an indirection at every one. The
whole feature then lands in cell allocation.

**Two step tables, and merging them reopens a bug.** `BLOCK_STEPS` quantizes the cell
pitch; `RECT_STEPS` quantizes a repo's rectangle and is far coarser. They are not
duplicates and must not be unified. Rectangle slack is whole unclaimed cells, which
already become parks; pitch slack is lawn inside *every* block and therefore multiplies.
`BLOCK_STEPS` also holds both 3 and 4, so it cannot stabilise a rectangle at the scale
where the problem lives: nine top-level directories becoming ten crosses
`ceil(sqrt(9))` to `ceil(sqrt(10))`.

Every repo gets the *same* rectangle, sized to the largest. Sizing each to its own
contents was the obvious version and it reintroduced the pitch bug one level up —
widths were continuous and origins were their running sum, so a repo gaining a directory
slid its neighbours sideways. A repo you are not looking at must not move because you
ran `mkdir src/thing` in another one. Uniform alone was not enough either: when the repo
that grows is the largest, the shared rectangle grows and everything moves anyway. Hence
uniform *and* quantized.

**The seeding rule**, which is one character apart at the call site:

- **building identity** — plot, district, `litAt`, window pattern — is seeded from the
  composite key `repo + "\0" + path`. Two repos can each hold a `src/index.js`; without
  this they fight over one plot and one entry in the `buildings` Map, and the building
  flickers between two positions every frame.
- **file type** — the facade colour from `extOf(path)` — is seeded from the bare path.
  Two `.rs` files are the same colour in every repo. That is the point of colouring by
  extension.

`dirKey` still takes the bare path. Prefixing the path instead would spend one level of
`DISTRICT_DEPTH` on the repo name, collapsing `src/three/foo.js` into `gitopolis/src`
rather than `src/three`.

**The identity seed is the repo's *name*, not its path.** `server.mjs` sends
`repo.name`, a basename. Sending the resolved path would make `node server.mjs ../foo`
and `node server.mjs /home/me/dev/foo` two different cities for the same repo — the
"restarting produces an identical city" invariant broken by how the argument was typed.

**One repo per SSE message**, still a full snapshot: `{repo, branch, watching, files}`.
Bundling all four would re-send four repos' worth of JSON whenever any one changed. Per
repo keeps each message idempotent — the reason snapshots are full in the first place —
while the wire cost stays proportional to what moved. `lastPayload` is per repo too, so
a busy repo never un-quiets its idle neighbours.

**The client's deletion sweep is scoped, and that cuts both ways.** A snapshot names one
repo, so an unscoped sweep reads repo B's arrival as "every file in repo A vanished" and
demolishes the neighbourhood next door. Scoping it then breaks the other direction: a
repo dropped from the selection stops sending snapshots, so the sweep can never notice
it went and its buildings stand forever. `connect` is the only place that knows the
*subscription* changed, which is why the retirement lives there rather than in `ingest`.

**A repo that errors counts as having reported.** The boot curtain waits for every
subscribed repo before lifting, or the city is revealed with a hole in it. Leaving an
erroring repo out of that tally was harmless with one repo — an error meant there was
nothing to reveal — but with four it held an opaque overlay over three healthy
neighbourhoods that were already built.

**Draw calls: measured, and the obvious optimisation was wrong.** With four repos and
132 files, `__city().dc` is 1046 idle and 1855 at cold open. A building is roughly eight
draw calls, not one — body, roof, cap, the three floodlight meshes, scaffold posts and
crane bars while dirty, and the shadow pass counts every caster again. Instancing
facades by (pattern, colour) therefore buys about 18% here, in exchange for the
project's first custom shader: `emissiveIntensity` is per building and a material
uniform is shared across an `InstancedMesh` bucket, so keeping the one-building-at-a-time
window ramp needs an `InstancedBufferAttribute` plus `onBeforeCompile`. Not done.
Reopen if `dc` passes ~3000 idle or a single repo passes ~800 files, and re-measure
first.

The better target at that point is towers, not facades. `flood` (on shared `streetMat`)
and `pool` (on `floodPoolMat`) have no per-building uniform and instance cleanly with no
shader patch; `wash` cannot, because its opacity is `night * (1 - b.lit/0.5)`, per
tower. But it is not free: the fixtures are children of a group that rises and dies with
its building, so instancing moves that bookkeeping to the CPU — eight matrices per tower
per frame while it grows, since their scale follows `h`. It trades `floods * 8 - 2` draw
calls for that write. Measure the towers' share in isolation before committing to it;
`__city().floods` gives the count.

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
quads hugging the walls, additive, the full wall height) and `GEO_FLOODPOOL` (four puddles on the
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
- **opacity is not the strength knob; `toneMapped` is.** ACES compresses a full-alpha
  additive quad to ~0.8 and rolls the highlight off on top of that, and pushing opacity
  past 1 does exactly nothing — GL clamps the `SRC_ALPHA` blend factor to 1. `washMat`
  has `toneMapped: false`; that, not the alpha, is what finally made the beam carry.

The beam covers the **whole** wall, and two things follow from that:

- **the height and the gradient in `mkWashTex` only mean anything together.** The ramp
  is 1.0 at the pavement, 0.62 at half height, 0 at the roof line. A full-height quad
  whose alpha died at 0.3 looked identical to the old third-height one.
- **a lit tower gets no beam.** `washMat` is cloned per tower and its opacity is
  `night * (1 - min(1, b.lit / 0.5))`, so the wash is what covers for the windows being
  *off*; once they are on, the windows describe the tower and the cold wash only fogs
  them. The ground pool stays either way — it is a fixture on the paving, not a beam on
  the wall. The clone is why `disposeBuilding` frees `b.wash.material`.

`__toggle("flood")` A/Bs it in a live scene and `__city().floods` counts the lit towers.

### Beacons: the rig has obstruction lights

A crane under construction carries a red strobe on the mast head, a green steady out at
the jib tip, and a red steady on one scaffold corner. Each is `mkBeacon()`: a
`toneMapped: false` dot plus an additive halo `Sprite`. The dot alone is one pixel at
home distance, so the halo is the half that reads; the halo is night-only, since additive
over a daylit sky is a pale smudge. No `PointLight`, for the same reason there is no
`SpotLight` above.

The strobe is a hard on/off (`sin(clock * 2.4 + b.spin) > 0.45`), phased by `b.spin` so
forty dirty files do not blink in unison. The jib beacon sits at `mx + 0.69` — read off
the jib's own `0.95` scale and `mx + 0.22` centre, not guessed.

The scaffold pole loop iterates `off`, **not** `scaffold.children`: the beacon lives in
that group too, and indexing children by `i` walked past the four poles into it (a
`Cannot read properties of undefined` every frame). Anything added to `scaffold` or
`crane` has to leave the pole/jib indexing alone.

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

Both are per repo. Each watched repo owns its watcher and its own 700ms interval, armed
behind a stagger offset so four repos do not scan on the same tick, with an `inflight`
flag so a scan slower than its own interval drops a tick instead of lapping itself. A
repo is watched while at least one client subscribes to it; the last leaver takes its
watcher and timer down.

`fs.watch` needs an `'error'` listener, not just a `try/catch`. The `try/catch` covers
only the synchronous open; a watcher that loses access to its tree afterwards
(`chmod 000 .git` on a live repo does it) reports that asynchronously, and an unhandled
`'error'` event takes the whole node process down. With one repo that died along with
the only city on screen. With four it would drop three healthy neighbourhoods because a
fourth changed permissions. The handler drops that repo to poll-only, which is what the
`watching: false` flag already on the wire exists to tell the hud about.

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
window.__city()            // { files, dirty, growing, dying, cranes, minGrown, dust,
                           //   repos: [{ name, files, dirty }], dc, tris, signs, ... }
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
everywhere and is not a bug. It is also the **peak** mesh count the scene ever reaches —
every building carrying scaffolding, a crane and beacons at once — so it is the sample
to take when measuring load, not the commit that drops them.

**Do not measure cost with `fps`.** It counts `requestAnimationFrame` callbacks, so it
is capped by vsync: the renderer can sit at 7ms, one millisecond from dropping frames,
and the panel still reads a contented 120. It reports the ceiling, not the load. Read
`__city().dc` (`renderer.info.render.calls`) and `tris` instead, and isolate a layer's
share with `__toggle`. That distinction is the whole reason facade instancing was
measured and then not built — see the multi-repo section.

And close the tab when you are done. Every left-open headless tab keeps rasterizing
three.js through the swiftshader CPU rasterizer forever, because the render loop never
idles; `fetch('/json/close/<targetId>')` then kill the browser. Also check the port
first — there is usually already a server on 4173, and `EADDRINUSE` fails quietly while
the page still loads from that one, which has produced a full round of testing against
the wrong repo.

## Fixed: the flat white roofs

House roofs picked their tile material with `tileRoofMats[(seed >> 3) % len]`. `hash()`
returns an *unsigned* 32-bit value, so any seed above 2^31 went negative under the signed
`>>`, the modulo stayed negative, the lookup returned `undefined`, and `new THREE.Mesh(geo,
undefined)` silently falls back to three's default white `MeshBasicMaterial` — unlit, hence
flat white. Fixed by using `>>>`. Any future `hash()`-derived index must use `>>>` or
`Math.abs`; a negative index here fails silently instead of throwing.
