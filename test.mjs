// smallest thing that fails if the derivation breaks.
// run: node test.mjs
import assert from "node:assert/strict";
import { dirKey, floorsOf, planCity, isHouse } from "./src/city.js";

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

console.log("ok — all city derivation checks passed");
