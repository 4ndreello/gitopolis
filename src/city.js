// pure derivation: repo file list -> city plan.
// no three.js, no dom — so it is testable and runnable in node.

export const GUT = 1.35;
export const FLOOR_H = 0.30;
export const MAX_FLOORS = 13;
export const DISTRICT_DEPTH = 2;

export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rand01(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// district = the file's directory, truncated to DISTRICT_DEPTH.
// must drop the basename first: slicing the full path put `src/main.tsx`
// in its own district instead of in `src`.
export function dirKey(path) {
  const parts = path.split("/");
  parts.pop();
  if (!parts.length) return "/";
  return parts.slice(0, DISTRICT_DEPTH).join("/");
}

export function extOf(path) {
  const b = path.split("/").pop();
  const i = b.indexOf(".");
  return i < 0 ? "" : b.slice(i + 1);
}

export function floorsOf(bytes) {
  return Math.max(1, Math.min(MAX_FLOORS, Math.round(Math.log2(Math.max(96, bytes) / 96) * 1.35)));
}

export function isHouse(floors) {
  return floors <= 2;
}

// plots and districts are hashed, never index-assigned, so a file keeps its
// address when siblings appear or vanish.
export function planCity(files) {
  const byDir = new Map();
  for (const f of files) {
    const d = dirKey(f.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(f);
  }
  const dirs = [...byDir.keys()].sort();
  const nd = dirs.length;

  // each district is sized to its own contents. a single global size (from the
  // fattest directory) left small districts as empty plateaus.
  const sizeOf = new Map();
  let maxSize = 2;
  for (const [d, arr] of byDir) {
    const s = Math.max(2, Math.ceil(Math.sqrt(arr.length)));
    sizeOf.set(d, s);
    maxSize = Math.max(maxSize, s);
  }
  const block = maxSize;          // cell pitch: the largest district defines it
  const stride = block + GUT;

  const dcols = Math.max(1, Math.ceil(Math.sqrt(nd)));
  const drows = Math.max(1, Math.ceil(nd / dcols));
  const cells = dcols * drows;

  const takenCell = new Set();
  const dcell = new Map();
  for (const d of dirs) {
    let i = hash(d) % cells;
    while (takenCell.has(i)) i = (i + 1) % cells;
    takenCell.add(i);
    dcell.set(d, i);
  }

  const pos = new Map();
  const empty = [];
  const blocks = [];
  for (const d of dirs) {
    const cell = dcell.get(d);
    const size = sizeOf.get(d);
    // centre a small district inside its cell so streets stay aligned
    const pad = (block - size) / 2;
    const cx = (cell % dcols) * stride;
    const cy = Math.floor(cell / dcols) * stride;
    const bx = cx + pad;
    const by = cy + pad;
    // the block covers the whole cell even when the district is smaller than
    // it: paving only the district left a small block as an island in the
    // middle of the asphalt, which reads as a city built on top of the road.
    // `inner` is the padded rectangle the buildings actually occupy — the
    // renderer paves that and lays the rest of the cell to lawn.
    blocks.push({ bx: cx, by: cy, size: block, inner: { bx, by, size }, dir: d, park: false });
    const slots = size * size;
    const taken = new Set();
    // sorted so probe order does not depend on scan order
    const arr = byDir.get(d).slice().sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const f of arr) {
      const base = f.path.split("/").pop();
      let j = hash(base) % slots;
      while (taken.has(j)) j = (j + 1) % slots;
      taken.add(j);
      pos.set(f.path, { gx: bx + (j % size), gy: by + Math.floor(j / size) });
    }
    for (let j = 0; j < slots; j++) {
      if (!taken.has(j)) empty.push({ gx: bx + (j % size), gy: by + Math.floor(j / size), park: false });
    }
    // the strip of cell the district does not fill is lawn, so offer it as
    // ground for trees. pad can be a half unit, hence the interval test rather
    // than an index lookup.
    const within = (g, lo, n) => g >= lo - 0.5 && g < lo + n - 0.5;
    for (let j = 0; j < block * block; j++) {
      const gx = cx + (j % block), gy = cy + Math.floor(j / block);
      if (within(gx, bx, size) && within(gy, by, size)) continue;
      empty.push({ gx, gy, park: false });
    }
  }

  // the district grid is square; leftover cells would read as holes in the
  // asphalt, so they become parks
  for (let i = 0; i < cells; i++) {
    if (takenCell.has(i)) continue;
    const bx = (i % dcols) * stride;
    const by = Math.floor(i / dcols) * stride;
    blocks.push({ bx, by, size: block, dir: null, park: true });
    for (let j = 0; j < block * block; j++) {
      empty.push({ gx: bx + (j % block), gy: by + Math.floor(j / block), park: true });
    }
  }

  return {
    block, dcols, drows,
    gw: dcols * stride - GUT,
    gh: drows * stride - GUT,
    districts: nd,
    pos, empty, blocks,
  };
}

// ---- streets ----
// the gaps between district cells are the roads. one derivation, consumed by
// the traffic lanes, the painted strips, the crosswalks and the lamp posts —
// when they each computed it themselves they drifted apart by a curb width.
// `at` is the fixed coordinate of the road centreline; `span` is its length.
// the half plot: a cell of `block` columns has its plots on integer centres
// `bx .. bx+block-1`, so it spans block-1, not block. centring the road on the
// cell gap put it half a plot into the next block — the paint ended up under
// that block's kerb and the lamp posts on its lawn.
export function roadLines(layout) {
  const stride = layout.block + GUT;
  const lines = [];
  for (let r = 1; r < layout.drows; r++) {
    lines.push({ axis: "x", at: r * stride - (GUT + 1) / 2 - layout.gh / 2, span: layout.gw + 3 });
  }
  for (let c = 1; c < layout.dcols; c++) {
    lines.push({ axis: "z", at: c * stride - (GUT + 1) / 2 - layout.gw / 2, span: layout.gh + 3 });
  }
  return lines;
}

export function intersections(layout) {
  const lines = roadLines(layout);
  const out = [];
  for (const a of lines) {
    if (a.axis !== "x") continue;
    for (const b of lines) {
      if (b.axis === "z") out.push({ x: b.at, z: a.at });
    }
  }
  return out;
}

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

// headlights, lamp posts and their light pools all ramp on this. eased over two
// hours at each end so nothing snaps on: dark before 05:00, lit after 19:00.
export function nightK(t) {
  const hour = t * 24;
  const ramp = (a, b) => Math.min(1, Math.max(0, (hour - a) / (b - a)));
  return hour < 12 ? 1 - ramp(5, 7) : ramp(17, 19);
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

// where the camera should look: the weighted centre of everything that just
// changed, plus how far that crowd spreads. the weight is the caller's decaying
// attention, and it scales the radius too — a building whose moment has passed
// stops holding the frame open instead of dropping out of the radius all at
// once, which is what makes the pull-out smooth rather than a dive.
export function focus(pts) {
  let W = 0, cx = 0, cz = 0;
  for (const p of pts) { W += p.w; cx += p.x * p.w; cz += p.z * p.w; }
  if (!W) return null;
  cx /= W; cz /= W;
  let r = 0;
  for (const p of pts) r = Math.max(r, Math.hypot(p.x - cx, p.z - cz) * p.w);
  return { x: cx, z: cz, r };
}
