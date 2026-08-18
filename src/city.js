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

// the cell pitch. it used to be the largest district's exact size, which is
// continuous: a district growing from 6 files to 7 changed the pitch and slid
// every coordinate in the city. with one repo that was invisible during normal
// editing; with four it means a district crossing a threshold in repo A
// teleports every building in B, C and D — a repo you are not even looking at
// reshuffles under an `npm i` somewhere else.
export const BLOCK_STEPS = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
export const BELT = 1;   // cells of green belt between repo rectangles

export function blockStep(n) {
  for (const s of BLOCK_STEPS) if (s >= n) return s;
  // 48 is a multiple of 16, so the tail keeps the table monotone and idempotent
  return Math.ceil(n / 16) * 16;
}

// the same trick for a repo's rectangle, on a far coarser table. BLOCK_STEPS is
// fine at the low end on purpose — pitch slack is lawn inside every block, and
// paying it on all of them adds up — but it is *too* fine to stabilise a
// rectangle: 3 and 4 are both in it, so nine districts becoming ten still
// widens the grid. rectangle slack is whole unclaimed cells, which already
// become parks, so it can afford to be bought in doublings.
export const RECT_STEPS = [1, 2, 4, 8, 16, 32];

export function rectStep(n) {
  for (const s of RECT_STEPS) if (s >= n) return s;
  return Math.ceil(n / 32) * 32;
}

// plots and districts are hashed, never index-assigned, so a file keeps its
// address when siblings appear or vanish.
export function planCity(files) {
  const byDir = new Map();
  const ndOf = new Map();          // repo -> district count
  for (const f of files) {
    const repo = f.repo ?? "";
    // the repo prefixes the grouping *key*, not the path. prefixing the path
    // would spend one level of DISTRICT_DEPTH on the repo name, so
    // `gitopolis/src/three/foo.js` would collapse to `gitopolis/src` instead
    // of `src/three`. dirKey stays a pure function of the path.
    const d = repo + "\0" + dirKey(f.path);
    if (!byDir.has(d)) {
      byDir.set(d, []);
      ndOf.set(repo, (ndOf.get(repo) || 0) + 1);
    }
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
  // quantized, not exact: only the global pitch snaps to a step, each district
  // keeps its own sizeOf, so the slack is the lawn strip already paved round
  // `inner`.
  const block = blockStep(maxSize);
  const stride = block + GUT;

  // every repo owns the *same* rectangle of cells, sized to the largest, and
  // the meta-grid tiles those rectangles with a belt between them. sorted, not
  // selection-ordered, so the same four repos always produce the same city.
  //
  // sizing each repo to its own contents instead was the obvious version and it
  // reintroduced the bug blockStep exists to kill, one level up: rectangle
  // widths were continuous and the origins were their running sum, so a repo
  // gaining a top-level directory slid every neighbour sideways. A repo you are
  // not looking at must not move because you ran `mkdir src/thing` in another.
  //
  // uniform alone is not enough — when the repo that grows *is* the largest,
  // the shared rectangle grows and everything moves anyway — so the dimensions
  // are quantized too, on a much coarser table than the pitch. coarse is
  // affordable here in a way it is not for `block`: rectangle slack is whole
  // cells nobody claims, and those already become parks.
  const names = [...ndOf.keys()].sort();
  const mcols = Math.max(1, Math.ceil(Math.sqrt(names.length)));
  const mrows = Math.max(1, Math.ceil(names.length / mcols));
  let rcols = 1;
  for (const n of ndOf.values()) rcols = Math.max(rcols, Math.ceil(Math.sqrt(n)));
  rcols = rectStep(rcols);
  let rrows = 1;
  for (const n of ndOf.values()) rrows = Math.max(rrows, Math.ceil(n / rcols));
  rrows = rectStep(rrows);

  const dcols = mcols * rcols + BELT * (mcols - 1);
  const drows = mrows * rrows + BELT * (mrows - 1);
  const cells = dcols * drows;

  const repos = names.map((name, i) => ({
    name,
    cx: (i % mcols) * (rcols + BELT),
    cy: Math.floor(i / mcols) * (rrows + BELT),
    cols: rcols, rows: rrows,
  }));
  const repoAt = new Map(repos.map(r => [r.name, r]));
  const cellOf = (r, i) => (r.cy + Math.floor(i / r.cols)) * dcols + r.cx + (i % r.cols);

  const takenCell = new Set();
  const dcell = new Map();
  for (const d of dirs) {
    const r = repoAt.get(d.slice(0, d.indexOf("\0")));
    const slots = r.cols * r.rows;
    // probe inside the repo's own rectangle. probing the global grid would let
    // a full repo spill its districts into the neighbour's neighbourhood.
    let i = hash(d) % slots;
    while (takenCell.has(cellOf(r, i))) i = (i + 1) % slots;
    takenCell.add(cellOf(r, i));
    dcell.set(d, cellOf(r, i));
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
    // `dir` stays the bare directory — it is the sign text, and two repos both
    // signing a district `src` is the correct picture.
    const cut = d.indexOf("\0");
    blocks.push({ bx: cx, by: cy, size: block, inner: { bx, by, size }, dir: d.slice(cut + 1), repo: d.slice(0, cut), park: false });
    const slots = size * size;
    const taken = new Set();
    // sorted so probe order does not depend on scan order
    const arr = byDir.get(d).slice().sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const f of arr) {
      // ponytail: the plot seed is the bare basename, not the composite key the
      // design names for building identity. within one district every file
      // shares a repo, so the prefix would only shift the whole probe sequence
      // — and districts are already per-repo, so two `index.js` cannot collide.
      // switch to `f.key` if plots ever need to survive a repo rename.
      const base = f.path.split("/").pop();
      let j = hash(base) % slots;
      while (taken.has(j)) j = (j + 1) % slots;
      taken.add(j);
      pos.set(f.key ?? f.path, { gx: bx + (j % size), gy: by + Math.floor(j / size) });
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
    block, dcols, drows, repos,
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

// bytes for a one-line log: three significant figures, never a decimal point
// on a raw byte count. sits next to clockLabel because it is the same kind of
// thing — a pure formatter the test can import with no DOM.
export function fmtBytes(n) {
  if (n < 1024) return String(Math.round(n));
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k`;
  return `${(n / 1048576).toFixed(1)}M`;
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

// ---- framing ----
// how far the camera has to sit to fit a city of ground radius `r` and skyline
// height `h` into a viewport, given the vertical fov, its aspect and the pitch
// the camera looks down at. framing off the vertical fov alone (what this used
// to do) is right only at one aspect: a portrait or a squat window is starved
// horizontally, and the far side of the city walks off the edge.
//
// the projection is the small-angle one — a ground disc of radius r seen from
// `pitch` degrees up covers r horizontally and r*sin(pitch) vertically, with
// the buildings adding h*cos(pitch) on top. exact enough at fov 32; `fill`
// carries the slack for the asymmetry of the far-side skyline.
// `cover` picks which axis wins: 0 fits both (the whole city inside the frame,
// the short axis left over) and 1 fills the tight axis and crops the other.
// contain is right on a desktop and wrong in a 230x330 window, where fitting
// the long axis leaves the city a small plate floating in the middle of the
// short one. cropping is the point of a small window, not a defect.
export function fitDistance(r, h, fovDeg, aspect, pitchDeg, fill, cover = 0) {
  const vTan = Math.tan((fovDeg / 2) * Math.PI / 180);
  const p = pitchDeg * Math.PI / 180;
  const halfV = r * Math.sin(p) + h * Math.cos(p);
  const v = halfV / vTan, hz = r / (vTan * aspect);
  return (Math.max(v, hz) * (1 - cover) + Math.min(v, hz) * cover) / fill;
}

// how much of that viewport the city should actually take. a 300px picture-in-
// picture window and a 1080p one are the same framing in world units and very
// different pictures: at 300px a building is three pixels wide, so the margin a
// desktop reads as breathing room is just dead screen. small canvas, tight frame.
export function fillFor(w, h) {
  const px = Math.min(w, h);
  return Math.max(0.72, Math.min(0.94, 1.06 - px / 3600));
}

// how much of the city a viewport should frame. the whole-city plate is the
// right picture on a desktop and the wrong one at 300px: buildings land on
// three pixels each and the thing reads as a static logo. a small canvas gets
// a district instead — close enough that the cars, the cranes and the lit
// windows are the picture, and close enough that autoRotate is visible motion.
// real events still override this: attention pulls the camera wherever a file
// actually changed, and that framing is computed from the event, not from here.
export function frameFraction(w, h) {
  const px = Math.min(w, h);
  return Math.max(0.34, Math.min(1, (px - 120) / 780));
}
