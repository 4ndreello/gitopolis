// smallest thing that fails if the derivation breaks.
// run: node test.mjs
import assert from "node:assert/strict";
import { cheat, mergeWeather, mountCheat } from "./src/cheat.js";
import { fitDistance, fillFor, frameFraction, dirKey, floorsOf, planCity, blockStep, BLOCK_STEPS, BELT, isHouse, DAY_MS, dayT, dayIndex, clockLabel, litAt, trafficAt, weatherAt, roadLines, intersections, nightK, GUT, focus, fmtBytes } from "./src/city.js";

// --- fmtBytes stays three characters wide across the unit boundaries ---
assert.equal(fmtBytes(0), "0");
assert.equal(fmtBytes(999), "999");
assert.equal(fmtBytes(1023), "1023", "still bytes right up to the boundary");
assert.equal(fmtBytes(1024), "1.0k");
assert.equal(fmtBytes(4300), "4.2k");
assert.equal(fmtBytes(2_000_000), "1.9M");

// --- dirKey drops the basename before truncating ---
assert.equal(dirKey("src/main.tsx"), "src", "a file directly in src belongs to src, not to its own district");
assert.equal(dirKey("package.json"), "/");
assert.equal(dirKey("src/components/ui/Button.tsx"), "src/components", "deeper than depth 2 collapses upward");
assert.equal(dirKey(".github/workflows/ci.yml"), ".github/workflows");

// --- height is monotonic in bytes and bounded ---
assert.equal(floorsOf(0), 1);
assert.ok(floorsOf(1000) < floorsOf(50000));
assert.ok(floorsOf(50_000_000) <= 13, "one giant lockfile must not produce an infinite tower");
assert.ok(isHouse(floorsOf(200)), "a tiny file is a house");
assert.ok(!isHouse(floorsOf(60_000)), "a big file is a tower");

const mk = (paths) => paths.map(p => ({ path: p, bytes: 2000 }));
const REPO = [
  "package.json", "tsconfig.json",
  "src/App.tsx", "src/main.tsx",
  "src/components/Hero.tsx", "src/components/Nav.tsx", "src/components/Footer.tsx",
  "src/i18n/pt.json", "src/i18n/en.json",
  "src/lib/util.ts",
  ".github/workflows/ci.yml",
];

// --- same input, same plan (no Math.random, no insertion-order dependency) ---
{
  const a = planCity(mk(REPO));
  const b = planCity(mk([...REPO].reverse()));
  for (const p of REPO) {
    assert.deepEqual(a.pos.get(p), b.pos.get(p), `plot for ${p} must not depend on scan order`);
  }
}

// --- every file gets its own plot ---
{
  const plan = planCity(mk(REPO));
  const seen = new Set();
  for (const p of REPO) {
    const q = plan.pos.get(p);
    assert.ok(q, `${p} has no plot`);
    const key = `${q.gx},${q.gy}`;
    assert.ok(!seen.has(key), `two files landed on the same plot: ${key}`);
    seen.add(key);
  }
  assert.equal(plan.districts, 6, "expected /, src, src/components, src/i18n, src/lib, .github/workflows");
}

// --- editing a file must not move any building ---
{
  const before = planCity(mk(REPO));
  const edited = mk(REPO).map(f => f.path === "src/App.tsx" ? { ...f, bytes: 90_000 } : f);
  const after = planCity(edited);
  for (const p of REPO) {
    assert.deepEqual(before.pos.get(p), after.pos.get(p), `${p} moved when an unrelated file changed size`);
  }
}

// --- adding a sibling keeps existing plots inside an unfilled block ---
{
  const before = planCity(mk(REPO));
  const after = planCity(mk([...REPO, "src/components/Card.tsx"]));
  if (after.block === before.block && after.dcols === before.dcols) {
    for (const p of REPO) {
      assert.deepEqual(before.pos.get(p), after.pos.get(p), `${p} moved when a sibling was added`);
    }
  }
  // known ceiling: crossing a block-size threshold reshuffles the whole grid.
  // see the `ponytail:` note in src/city.js consumers.
}

// --- leftover district cells become parks, never holes ---
{
  const plan = planCity(mk(REPO));
  assert.equal(plan.blocks.length, plan.dcols * plan.drows, "every grid cell must be a block or a park");
  assert.ok(plan.blocks.some(b => b.park) || plan.districts === plan.dcols * plan.drows);
}

// --- the cell pitch is quantized, so one district crossing a threshold does
// not slide the whole city (and, with four repos, three neighbourhoods you are
// not even looking at) ---
{
  let last = 0;
  for (let n = 0; n <= 200; n++) {
    const s = blockStep(n);
    assert.ok(s >= Math.max(2, n), `blockStep(${n}) = ${s} must still hold a district of ${n}`);
    assert.ok(s >= last, "blockStep must never dip as the city grows");
    assert.equal(blockStep(s), s, `blockStep(${s}) is not idempotent — the pitch would drift on replan`);
    last = s;
  }
  // the design doc says "6 and 7 land on the same step", but its own
  // BLOCK_STEPS holds both 6 and 8, so that pair cannot collapse. the table is
  // given verbatim in the spec and wins; these are the collapses it does make.
  assert.equal(blockStep(5), blockStep(6), "a district growing past a step boundary keeps the pitch");
  assert.equal(blockStep(7), blockStep(8));
  assert.equal(blockStep(1), BLOCK_STEPS[0], "below the table, the smallest step");
  assert.equal(blockStep(49), 64, "above the table, round up to a multiple of 16");
}

// --- multi-repo: each repo is a contiguous rectangle, belts are parks ---
const mkr = (repo, paths) => paths.map(p => ({ repo, key: `${repo}\0${p}`, path: p, bytes: 2000 }));
const BRAVO = [
  "readme.md",
  "lib/x.ts", "lib/y.ts",
  "web/app/page.tsx", "web/app/layout.tsx",
  "infra/main.tf",
];
{
  const plan = planCity([...mkr("alpha", REPO), ...mkr("bravo", BRAVO), ...mkr("charlie", ["one.txt"]), ...mkr("delta", ["x/a.ts", "y/b.ts"])]);
  assert.deepEqual(plan.repos.map(r => r.name), ["alpha", "bravo", "charlie", "delta"],
    "repos are sorted, not selection-ordered, so the same four always make the same city");

  // no two neighbourhoods share a cell
  for (const a of plan.repos) {
    for (const b of plan.repos) {
      if (a === b) continue;
      const apart = a.cx + a.cols <= b.cx || b.cx + b.cols <= a.cx || a.cy + a.rows <= b.cy || b.cy + b.rows <= a.cy;
      assert.ok(apart, `${a.name} and ${b.name} overlap`);
    }
  }

  // every district lands inside its own repo's rectangle: probing must not
  // escape into the neighbour's neighbourhood
  const stride = plan.block + GUT;
  const at = new Map();
  for (const b of plan.blocks) at.set(`${Math.round(b.bx / stride)},${Math.round(b.by / stride)}`, b);
  const byName = new Map(plan.repos.map(r => [r.name, r]));
  for (const b of plan.blocks) {
    if (b.park) continue;
    const r = byName.get(b.repo);
    const c = Math.round(b.bx / stride), rw = Math.round(b.by / stride);
    assert.ok(c >= r.cx && c < r.cx + r.cols && rw >= r.cy && rw < r.cy + r.rows,
      `district ${b.repo}/${b.dir} sits at ${c},${rw}, outside its repo rectangle`);
  }

  // a belt column (or row) is one no repo covers. every cell of it is a park,
  // through the leftover-cell path that already existed — no new branch.
  const cov = (lo, n, xs) => { for (let i = lo; i < lo + n; i++) xs.add(i); return xs; };
  const cols = new Set(), rows = new Set();
  for (const r of plan.repos) { cov(r.cx, r.cols, cols); cov(r.cy, r.rows, rows); }
  let belts = 0;
  for (let c = 0; c < plan.dcols; c++) {
    for (let r = 0; r < plan.drows; r++) {
      if (cols.has(c) && rows.has(r)) continue;
      const b = at.get(`${c},${r}`);
      assert.ok(b, `belt cell ${c},${r} is a hole in the asphalt, not a block`);
      assert.ok(b.park, `belt cell ${c},${r} was built on`);
      belts++;
    }
  }
  assert.ok(belts > 0, "four repos on a 2x2 meta-grid must have a belt between them");
  assert.equal(plan.blocks.length, plan.dcols * plan.drows, "every grid cell is still a block or a park");
  assert.equal(BELT, 1);
}

// --- cross-repo stability: growing repo A must not move a building in repo B ---
// the multi-repo form of the sibling invariant. the file added takes `big` from
// 25 files to 26, which is exactly the district-size threshold (5 -> 6) that
// used to change the global pitch and slide every coordinate in the city.
{
  const big = Array.from({ length: 25 }, (_, i) => `big/g${i}.ts`);
  const B = mkr("bravo", BRAVO);
  const before = planCity([...mkr("alpha", ["a.txt", ...big]), ...B]);
  const after = planCity([...mkr("alpha", ["a.txt", ...big, "big/g25.ts"]), ...B]);
  assert.equal(after.block, before.block, "the quantized pitch must survive a district crossing sqrt(25)");
  for (const f of B) {
    assert.deepEqual(before.pos.get(f.key), after.pos.get(f.key), `${f.key} moved when another repo grew`);
  }
}

// --- a repo with no name is still a city: the single-repo call is unchanged ---
{
  const plan = planCity(mk(REPO));
  assert.equal(plan.repos.length, 1, "no repo field means one unnamed repo");
  assert.deepEqual(plan.repos[0], { name: "", cx: 0, cy: 0, cols: plan.dcols, rows: plan.drows },
    "and its rectangle is the whole grid, with no belt");
  assert.ok(plan.pos.get("src/App.tsx"), "files with no key are still keyed by path");
}

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

// --- roads are the gaps between district cells ---
{
  const layout = planCity(mk(REPO));
  const lines = roadLines(layout);
  assert.equal(lines.length, (layout.dcols - 1) + (layout.drows - 1), "one road per gap, none around the outside");
  for (const l of lines) {
    assert.ok(Math.abs(l.at) <= Math.max(layout.gw, layout.gh) / 2, "a road centreline lands inside the city");
    assert.ok(l.span > 0);
  }
  assert.equal(intersections(layout).length,
    lines.filter(l => l.axis === "x").length * lines.filter(l => l.axis === "z").length);

  // a street sits midway between the two rows of buildings it separates. plots
  // are integer centres, so a cell of `block` columns spans block-1, not block:
  // centring the road on the cell gap instead pushed it half a plot into the
  // next block, which buried the paint under that block's kerb and stood its
  // lamp posts on the lawn.
  {
    const stride = layout.block + GUT;
    const dist = (a, b) => Math.abs(a - b);
    for (const l of lines) {
      const half = l.axis === "x" ? layout.gh / 2 : layout.gw / 2;
      const g = l.at + half;                       // back to grid coordinates
      const r = Math.round((g + (GUT + 1) / 2) / stride);
      const near = (r - 1) * stride + layout.block - 1;   // last plot column before the road
      const far = r * stride;                            // first plot column after it
      assert.ok(Math.abs(dist(g, near) - dist(g, far)) < 1e-9,
        `road at ${g} is ${dist(g, near)} from one kerb and ${dist(g, far)} from the other`);
    }
  }

  // a repo small enough to be one district has no gaps, so no roads and no cars
  assert.deepEqual(roadLines(planCity(mk(["a.txt", "b.txt"]))), []);
  assert.deepEqual(intersections(planCity(mk(["a.txt", "b.txt"]))), []);
}

// --- headlights are off at noon and full at midnight ---
assert.equal(nightK(0.5), 0, "noon is not night");
assert.equal(nightK(0), 1, "midnight is fully night");
assert.ok(nightK(18 / 24) > 0 && nightK(18 / 24) < 1, "dusk is a ramp, not a switch");
for (let i = 0; i <= 96; i++) {
  const k = nightK(i / 96);
  assert.ok(k >= 0 && k <= 1, `nightK stays in [0,1] at ${(i / 96 * 24).toFixed(1)}h`);
}

console.log("ok — all city derivation checks passed");

// --- focus: the camera's aim point, weighted by attention ---
assert.equal(focus([]), null, "nothing changed means no opinion about where to look");
{
  const one = focus([{ x: 3, z: -4, w: 1 }]);
  assert.deepEqual(one, { x: 3, z: -4, r: 0 }, "a single change is framed dead on, with no spread");
  const two = focus([{ x: -10, z: 0, w: 1 }, { x: 10, z: 0, w: 1 }]);
  assert.equal(two.x, 0);
  assert.equal(two.r, 10, "two changes of equal weight sit half the span apart");
}
// the radius is weighted, not thresholded: fading attention has to shrink the
// frame continuously, or every focus ends with a dive at the city as the last
// buildings drop out of the radius together
{
  const faint = focus([{ x: 0, z: 0, w: 0.1 }, { x: 20, z: 0, w: 0.1 }]);
  assert.equal(faint.x, 10, "faint points still count toward the centre");
  assert.equal(faint.r, 1, "and hold the frame open only in proportion to their weight");
  let last = Infinity;
  for (let w = 1; w > 0; w -= 0.05) {
    const r = focus([{ x: 0, z: 0, w: 1 }, { x: 20, z: 0, w }]).r;
    assert.ok(r <= last + 1e-9, "radius must never jump as attention decays");
    last = r;
  }
}

// --- framing: the city has to fit the viewport it is actually rendered into ---
// screen fraction the city spans, by projecting the two extremes with the same
// small-angle approximation fitDistance uses. 1 means it exactly touches the edge.
function spans(dist, aspect, { r = 20, h = 3.9, fov = 32, pitch = 52 } = {}) {
  const vTan = Math.tan((fov / 2) * Math.PI / 180), p = pitch * Math.PI / 180;
  return {
    x: r / (dist * vTan * aspect),
    y: (r * Math.sin(p) + h * Math.cos(p)) / (dist * vTan),
  };
}
{
  // whatever the viewport, the city lands inside it and fills most of the tight axis
  for (const [w, hpx] of [[320, 200], [420, 320], [900, 600], [1920, 1080], [600, 900], [400, 800]]) {
    const fill = fillFor(w, hpx);
    const d = fitDistance(20, 3.9, 32, w / hpx, 52, fill);
    const s = spans(d, w / hpx);
    assert.ok(s.x <= 1.001 && s.y <= 1.001, `city overflows ${w}x${hpx}: ${JSON.stringify(s)}`);
    assert.ok(Math.max(s.x, s.y) > fill - 1e-6, `city marooned in ${w}x${hpx}: ${JSON.stringify(s)}`);
  }
}
// a portrait viewport is horizontally starved and must pull further back than a
// landscape one of the same height — this is the whole bug on a narrow window
assert.ok(
  fitDistance(20, 3.9, 32, 0.6, 52, 0.9) > fitDistance(20, 3.9, 32, 1.8, 52, 0.9),
  "narrow viewports need more distance, not the same"
);
// a small canvas gets a tighter frame: at 300px the buildings are a few pixels
// wide, so the margin a desktop can afford is dead screen there
assert.ok(fillFor(320, 200) > fillFor(1920, 1080), "small canvas fills more of the frame");
assert.ok(fillFor(320, 200) <= 1 && fillFor(1920, 1080) >= 0.6, "fill stays sane at both ends");
// monotonic in what it is framing, or growth would pull the camera inwards
{
  let last = 0;
  for (let r = 5; r < 80; r += 3) {
    const d = fitDistance(r, 3.9, 32, 1.6, 52, 0.85);
    assert.ok(d > last, "distance must grow with the city");
    last = d;
  }
}

// --- a small viewport frames less city, not the same city further away ---
// the whole-city plate is unreadable at 300px: a district you are standing in
// carries more information than a city you cannot resolve. so the fit target
// shrinks with the canvas instead of the distance growing.
assert.ok(frameFraction(320, 210) < frameFraction(1920, 1080) * 0.7, "a pip window frames a district, not the skyline");
assert.equal(frameFraction(1600, 1000), 1, "a desktop still gets the whole city");
{
  let last = 0;
  for (let px = 200; px <= 1400; px += 50) {
    const f = frameFraction(px * 1.5, px);
    assert.ok(f >= last, "framed fraction must grow with the canvas, never dip");
    assert.ok(f > 0.2 && f <= 1, `framed fraction out of range at ${px}: ${f}`);
    last = f;
  }
}

// --- cheats override the world without replacing it ---
// mergeWeather is the whole cheat model in one function: null follows the day,
// a number wins, and per field so forcing one knob does not freeze the other.
const auto = { overcast: 0.4, rain: 0.1 };
assert.deepEqual(mergeWeather(auto, { rain: null, overcast: null }), auto, "no cheat set means the world's own weather");
assert.equal(mergeWeather(auto, { rain: 1, overcast: null }).overcast, 0.4, "forcing rain must leave overcast on auto");
// the one that a `||` would get wrong: 0 is an override, not an absence
assert.equal(mergeWeather({ overcast: 0.9, rain: 0.8 }, { rain: 0, overcast: null }).rain, 0, "a cheat of zero must beat the world, not fall through to it");

// --- cover: a small window crops, it does not shrink the city to fit ---
{
  const arg = [20, 3.9, 32, 0.7, 52, 0.9];           // portrait, horizontally starved
  const contain = fitDistance(...arg, 0), crop = fitDistance(...arg, 1);
  assert.ok(crop < contain, "covering sits closer than containing");
  const s = spans(crop, 0.7);
  assert.ok(Math.min(s.x, s.y) > 0.9 - 1e-6, "the tight axis is filled, not left over");
  assert.ok(Math.max(s.x, s.y) > 1, "and the other one is allowed to run off the edge");
  assert.equal(fitDistance(...arg), contain, "contain stays the default");
}

// --- the panel wires a drag to the override and the value back to auto ---
// a stub document instead of a browser: mountCheat only ever calls append,
// addEventListener and classList, and the rAF loop makes real chromium hang.
{
  const mk = () => {
    const n = { children: [], attrs: {}, on: {}, className: "", textContent: "", style: {} };
    n.append = (...c) => n.children.push(...c);
    n.addEventListener = (ev, fn) => { n.on[ev] = fn; };
    n.classList = { toggle: (c, v) => { n[c] = v; } };
    n.toggleAttribute = (a, v) => { n.attrs[a] = v; };
    n.hasAttribute = (a) => !!n.attrs[a];
    return n;
  };
  globalThis.document = { createElement: mk, activeElement: null };
  const root = mk();
  let time = null, toggled = null;
  const sync = mountCheat(root, {
    setTime: (v) => { time = v; },
    getTime: () => time,
    toggle: (n) => { toggled = n; },
  });
  // rows land in order after the <h4>: hora, chuva, nublado, nuvens, trânsito
  const row = (i) => root.children[1 + i];
  const [input, val] = [1, 2].map(j => row(1).children[j]);   // chuva

  input.value = 50; input.on.input();
  assert.equal(cheat.rain, 0.5, "dragging a slider writes the override as a 0..1 fraction");
  val.on.click();
  assert.equal(cheat.rain, null, "clicking the value column drops the knob back to auto");

  row(0).children[1].value = 750; row(0).children[1].on.input();
  assert.equal(time, 750 / 1440, "the hour knob goes through setTime, not the cheat object");

  const flood = root.children[6].children.at(-1);
  flood.on.click();
  assert.equal(toggled, "flood", "the toggle row calls window.__toggle by name");

  sync({ time: 60, rain: 20, overcast: 30, clouds: 4, traffic: 10 });
  assert.equal(val.textContent, "20%", "a knob on auto displays the live value, not a stale one");
  // the hour is still overridden from above: an override must out-rank the live
  // value, or a forced sunset would tick back to the wall clock every 0.5s
  assert.equal(row(0).children[2].textContent, "12:30", "an overridden knob keeps its own value while auto knobs track the world");
  delete globalThis.document;
}
