// smallest thing that fails if the derivation breaks.
// run: node test.mjs
import assert from "node:assert/strict";
import { dirKey, floorsOf, planCity, isHouse, DAY_MS, dayT, dayIndex, clockLabel, litAt, trafficAt, weatherAt, roadLines, intersections, nightK, GUT, focus, fmtBytes } from "./src/city.js";

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
