import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  GUT, FLOOR_H, MAX_FLOORS,
  hash, rand01, dirKey, extOf, floorsOf, isHouse, planCity,
  dayT, dayIndex, clockLabel, litAt, trafficAt, weatherAt,
  roadLines, intersections, nightK, focus,
} from "./city.js";
import {
  TEX_GLOW, GEO_CAR, GEO_VAN, GEO_TRUCK, GEO_LAMP, GEO_BUSSTOP, GEO_BIN,
  GEO_HYDRANT, GEO_SIGNPOST, mkSignTex, mkRoadTex, mkZebraTex, mkPoolTex,
} from "./props.js";

// ============================================================
// state: one entry per file on disk. animation fields live here and
// nowhere else — the city itself is never persisted.
// ============================================================
const files = new Map(); // path -> { path, bytes, target, dirty, grown, dying, flash, attn }
// a deleted file is gone from the map long before the camera finishes
// travelling to it, so its plot outlives it here as a fading pull
const ghosts = [];       // { x, z, w }
let layout = planCity([]);
let layoutDirty = true;

function ingest(snapshot) {
  const seen = new Set();
  const done = [];   // cranes coming down this snapshot: one confetti burst each
  const gone = [];   // files deleted this snapshot: one smoke column each
  for (const inc of snapshot.files) {
    seen.add(inc.path);
    const cur = files.get(inc.path);
    if (!cur) {
      // brand new: rises from nothing, scaffolding first
      files.set(inc.path, {
        path: inc.path, bytes: Math.max(96, inc.bytes), target: inc.bytes,
        dirty: inc.dirty, grown: 0, dying: 0, flash: 0, attn: 1,
      });
      layoutDirty = true;
      continue;
    }
    if (cur.dying) { cur.dying = 0; cur.grown = Math.max(0.05, cur.grown); cur.attn = 1; }
    if (Math.abs(cur.target - inc.bytes) > 0) {
      if (floorsOf(cur.target) !== floorsOf(inc.bytes)) cur.flash = 1;
      cur.target = inc.bytes;
      cur.attn = 1;
    }
    // the scaffolding coming off is the whole point of a commit: every dirty
    // file flips at once, which is what pulls the frame back out over the city
    if (cur.dirty !== inc.dirty) {
      cur.attn = 1;
      const w = fileWorld(cur);
      if (cur.dirty) done.push(cur);
      else fx("dirty", w.x, 0.2, w.z);   // work starting had no effect at all before
    }
    cur.dirty = inc.dirty;
  }
  for (const [path, f] of files) {
    if (!seen.has(path) && !f.dying) {
      f.dying = 0.001;
      const w = fileWorld(f);
      ghosts.push({ x: w.x, z: w.z, w: 1 });
      gone.push(w);
    }
  }
  // one particle budget split across the whole commit: 40 files each asking for
  // a full burst would empty the pool on the first few roofs and leave the rest
  // of the city celebrating in silence
  if (done.length) {
    const n = Math.max(4, Math.min(FX.done.n, Math.round(DUST_MAX * 0.6 / done.length)));
    for (const f of done) {
      const w = fileWorld(f);
      fx("done", w.x, w.y + 0.3, w.z, n);
    }
  }
  // deletions land in the same snapshot too, so the smoke splits the pool the
  // same way. it lives here rather than in the dying branch of the loop because
  // only ingest knows how many are going at once
  if (gone.length) {
    const n = Math.max(5, Math.min(FX.died.n, Math.round(DUST_MAX * 0.5 / gone.length)));
    for (const w of gone) fx("died", w.x, w.y * 0.5 + 0.3, w.z, n);
  }
  if (snapshot.repo && el.repo.value !== snapshot.repo) el.repo.value = snapshot.repo;
  el.branch.textContent = snapshot.branch || "?";
}

// ============================================================
// scene
// ============================================================
const canvas = document.getElementById("cv");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xc8d4de, 40, 190);

const camera = new THREE.PerspectiveCamera(32, 2, 0.5, 800);
camera.position.set(30, 30, 30);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 6;
controls.maxDistance = 300;
controls.minPolarAngle = THREE.MathUtils.degToRad(15);
controls.maxPolarAngle = THREE.MathUtils.degToRad(80);
controls.autoRotate = true;
controls.autoRotateSpeed = 0.18;
let idleTimer = 0;
controls.addEventListener("start", () => { controls.autoRotate = false; idleTimer = 0; });
controls.addEventListener("end", () => { idleTimer = 0.001; });

// ---- sky dome ----
const skyUniforms = {
  cTop: { value: new THREE.Color(0x6f9fd0) },
  cHorizon: { value: new THREE.Color(0xd9e3ea) },
  cBottom: { value: new THREE.Color(0xb4c0ca) },
};
scene.add(new THREE.Mesh(
  new THREE.SphereGeometry(420, 32, 20),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: `varying vec3 vDir;
      void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 cTop; uniform vec3 cHorizon; uniform vec3 cBottom; varying vec3 vDir;
      void main(){
        float y = vDir.y;
        vec3 c = y > 0.0 ? mix(cHorizon, cTop, pow(clamp(y,0.0,1.0), 0.55))
                         : mix(cHorizon, cBottom, pow(clamp(-y,0.0,1.0), 0.6));
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
));

// ---- night sky ----
// inside the dome (radius 420), fog off so they do not wash out at the horizon
const stars = (() => {
  const N = 700, R = 380;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const a = rand01(i * 1.7) * Math.PI * 2;
    // cubed so the field crowds the low band the camera can actually reach
    // (see the moon note below); still spread to the zenith, just thinner there
    const y = 0.02 + Math.pow(rand01(i * 3.1), 3) * 0.98;
    const rxz = Math.sqrt(Math.max(0, 1 - y * y));
    pos[i * 3] = Math.cos(a) * rxz * R;
    pos[i * 3 + 1] = y * R;
    pos[i * 3 + 2] = Math.sin(a) * rxz * R;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const m = new THREE.Points(geo, new THREE.PointsMaterial({
    // sizeAttenuation:false makes gl_PointSize device pixels, so it has to be
    // scaled by the same ratio the renderer uses or stars go sub-pixel on hidpi
    size: 1.8 * Math.min(2, window.devicePixelRatio || 1),
    sizeAttenuation: false, color: 0xdfe8f5,
    transparent: true, opacity: 0, depthWrite: false, fog: false,
  }));
  m.frustumCulled = false;
  return m;
})();
const moon = new THREE.Mesh(
  new THREE.SphereGeometry(8, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xe6ecf6, fog: false })
);
moon.visible = false;
scene.add(stars, moon);

function updateNightSky(t, overcast) {
  const night = Math.pow(Math.max(0, Math.cos(t * Math.PI * 2)), 0.7);   // 1 at midnight
  stars.material.opacity = night * (1 - overcast * 0.9);
  stars.visible = stars.material.opacity > 0.01;
  moon.visible = night > 0.05 && overcast < 0.85;
  if (moon.visible) {
    // the camera can never look up. CAM_ANGLE 52 holds the top of the default
    // frame 36 deg BELOW the horizon, and even at controls.maxPolarAngle (80)
    // it only reaches ~6 deg above it — measured, not guessed. so the moon
    // rides a deliberately low arc: at 2.2..5 deg it lands at ndc.y 0.7..0.93,
    // just under the top edge. do not "clean up" this elevation without also
    // changing CAM_ANGLE, or the moon leaves the frame for good. the 2.2 floor
    // is what keeps the whole 8-unit sphere above the ground plane.
    const a = t * Math.PI * 2;
    const R = 270, elev = THREE.MathUtils.degToRad(2.2 + night * 2.8);
    const rxz = R * Math.cos(elev);
    moon.position.set(Math.sin(a) * rxz, Math.sin(elev) * R, -Math.cos(a) * rxz);
  }
}

const hemi = new THREE.HemisphereLight(0xcfe0ef, 0x5a5348, 0.75);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0dc, 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 2;
scene.add(sun, sun.target);

// a save pings its building — pooled so a burst of writes cannot spawn 200 lights
const flashPool = [];
for (let i = 0; i < 4; i++) {
  const l = new THREE.PointLight(0xffd9a0, 0, 9, 2);
  l.visible = false;
  scene.add(l);
  flashPool.push({ light: l, life: 0 });
}
function fireFlash(x, y, z) {
  const slot = flashPool.find(s => s.life <= 0) || flashPool[0];
  slot.light.position.set(x, y, z);
  slot.light.visible = true;
  slot.life = 1;
}

// ============================================================
// procedural textures — no assets anywhere in this project
// ============================================================
function mkTex(draw) {
  const S = 64, c = document.createElement("canvas");
  c.width = c.height = S;
  draw(c.getContext("2d"), S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// one tile == one floor of one bay; uv is scaled by (bays, floors) so panes
// never crosshatch. three patterns, picked per district, give neighbourhoods
// a recognisable character.
const PATTERNS = [
  (g, S) => { // ribbon glass
    g.fillStyle = "#e8e9ec"; g.fillRect(0, 0, S, S);
    g.fillStyle = "#77828f"; g.fillRect(0, 14, S, S - 32);
    g.fillStyle = "#9aa0a8"; g.fillRect(S / 2 - 1, 14, 2, S - 32);
  },
  (g, S) => { // punched windows
    g.fillStyle = "#ded8cf"; g.fillRect(0, 0, S, S);
    g.fillStyle = "#6b7482";
    g.fillRect(10, 12, 18, S - 30);
    g.fillRect(S - 28, 12, 18, S - 30);
    g.fillStyle = "#c3bcb1"; g.fillRect(0, S - 6, S, 4);
  },
  (g, S) => { // panel slab
    g.fillStyle = "#cfd0cf"; g.fillRect(0, 0, S, S);
    g.fillStyle = "#8e9298"; g.fillRect(0, 0, S, 5); g.fillRect(0, 0, 5, S);
    g.fillStyle = "#78828e"; g.fillRect(9, 13, S - 18, S - 28);
    g.fillStyle = "#b9bcbd"; g.fillRect(9, 13 + (S - 28) / 2 - 1, S - 18, 2);
  },
];
const LIT_PATTERNS = [
  (g, S) => { g.fillStyle = "#000"; g.fillRect(0, 0, S, S); g.fillStyle = "#d99a45"; g.fillRect(0, 14, S / 2 - 4, S - 32); },
  (g, S) => { g.fillStyle = "#000"; g.fillRect(0, 0, S, S); g.fillStyle = "#e0a552"; g.fillRect(10, 12, 18, S - 30); },
  (g, S) => { g.fillStyle = "#000"; g.fillRect(0, 0, S, S); g.fillStyle = "#d4923c"; g.fillRect(9, 13, S - 18, (S - 28) / 2 - 2); },
];
// ---- materials ----
const FACADE = ["#d2d7dd", "#c6d0cb", "#dbcfbe", "#bcc6d2", "#d5c8c8", "#c8d1c0", "#c8c1cf", "#dcd5c4"];
const TEX_WIN = PATTERNS.map(mkTex);
const TEX_LIT = LIT_PATTERNS.map(mkTex);
const facadeMats = PATTERNS.map((_, pi) => FACADE.map(hex => new THREE.MeshStandardMaterial({
  color: new THREE.Color(hex),
  map: TEX_WIN[pi], emissiveMap: TEX_LIT[pi],
  emissive: new THREE.Color(0xffd9a6), emissiveIntensity: 0,
  roughness: pi === 2 ? 0.85 : 0.72,
  metalness: pi === 0 ? 0.12 : 0.02,
})));

const HOUSE = ["#d8d2c6", "#cfd4cd", "#dcd0c4", "#c9cfd6", "#d5cbc8"];
const houseMats = HOUSE.map(hex => new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.88 }));
const tileRoofMats = ["#a1604b", "#8f6b57", "#9c5f4a", "#7d6b60"].map(hex =>
  new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.85, flatShading: true }));

const roofMat = new THREE.MeshStandardMaterial({ color: 0x6d7178, roughness: 0.85 });
const propMat = new THREE.MeshStandardMaterial({ color: 0x8d9299, roughness: 0.8 });
const asphaltMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.95 });
const terrainMat = new THREE.MeshStandardMaterial({ color: 0x5d6a55, roughness: 1 });
const plateMat = new THREE.MeshStandardMaterial({ color: 0x9aa096, roughness: 0.9 });
const curbMat = new THREE.MeshStandardMaterial({ color: 0xb6bab2, roughness: 0.92 });
const parkMat = new THREE.MeshStandardMaterial({ color: 0x6f8259, roughness: 0.95 });
// vertexColors + emissiveMap is what lets one material serve every prop: the
// mesh carries its own colours, and the 3-texel glow strip decides which faces
// light up at night. instanceColor then tints only the parts painted white.
const vehicleMat = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.42, metalness: 0.3,
  emissiveMap: TEX_GLOW, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0,
});
const streetMat = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.72, metalness: 0.15,
  emissiveMap: TEX_GLOW, emissive: new THREE.Color(0xffe6b8), emissiveIntensity: 0,
});
const CAR_COLORS = [0xd8d8dc, 0x2f3540, 0xa33c33, 0x2c5f8a, 0xc9a24a, 0x5d6b53, 0x8f8f96];
const TEX_ROAD = mkRoadTex();
const roadMat = new THREE.MeshStandardMaterial({ map: TEX_ROAD, roughness: 0.95 });
const zebraMat = new THREE.MeshStandardMaterial({
  map: mkZebraTex(), transparent: true, depthWrite: false, roughness: 0.95,
});
// additive: the pool brightens asphalt instead of painting a grey disc on it
const poolMat = new THREE.MeshBasicMaterial({
  map: mkPoolTex(), transparent: true, depthWrite: false, opacity: 0,
  blending: THREE.AdditiveBlending, fog: false,
});
const scaffoldMat = new THREE.MeshStandardMaterial({ color: 0xe8a13a, roughness: 0.6, metalness: 0.2 });
const craneMat = new THREE.MeshStandardMaterial({ color: 0xf0b455, roughness: 0.5, metalness: 0.3 });
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b5540, roughness: 0.9 });
const leafMat = new THREE.MeshStandardMaterial({ color: 0x5d7f52, roughness: 0.85 });

// ---- geometry ----
const GEO_BOX = new THREE.BoxGeometry(1, 1, 1);
const GEO_MAST = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
const GEO_PYR = new THREE.ConeGeometry(1, 1, 4);
const GEO_TRUNK = new THREE.CylinderGeometry(0.05, 0.07, 0.34, 5);
const GEO_LEAF = new THREE.ConeGeometry(0.26, 0.72, 7);
const GEO_QUAD = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

// everything painted on or standing beside the asphalt shares one stack of
// heights. they are millimetres apart on purpose: coplanar quads z-fight, and
// the artefact only shows up once the camera is far enough away to matter.
const Y_ROAD_X = 0.005, Y_ROAD_Z = 0.0055, Y_ZEBRA = 0.007, Y_POOL = 0.009;
const Y_KERB = 0.083;         // top of the curb ring — where street furniture stands
// the curb ring is drawn at size + 0.62, so it eats 0.31 of the gutter on each
// side. only what is left is asphalt anyone can see, and paint outside it is
// paint under a kerb.
const KERB_OVER = 0.31;
const ROAD_W = GUT - KERB_OVER * 2;

// uv scaled per floor count, so one texture tile == one storey
const bodyGeoCache = new Map();
function bodyGeo(floors) {
  if (bodyGeoCache.has(floors)) return bodyGeoCache.get(floors);
  const g = new THREE.BoxGeometry(1, 1, 1);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 3, uv.getY(i) * floors);
  uv.needsUpdate = true;
  bodyGeoCache.set(floors, g);
  return g;
}

// ============================================================
// buildings
// ============================================================
const cityRoot = new THREE.Group();
const groundRoot = new THREE.Group();
scene.add(cityRoot, groundRoot);
const buildings = new Map(); // path -> parts

function worldPos(gx, gy) {
  return { x: gx - layout.gw / 2, z: gy - layout.gh / 2 };
}

function makeBuilding(f) {
  const floors = floorsOf(f.bytes);
  const seed = hash(f.path);
  const idx = hash(extOf(f.path)) % FACADE.length;
  const pat = hash(dirKey(f.path)) % facadeMats.length;
  const house = isHouse(floors);
  const group = new THREE.Group();

  // ponytail: one cloned material per building. clone() shares the textures by
  // reference, so this costs a uniform block each and no extra draw call. if a
  // 2k-file repo ever stutters, instance by (pattern, colour) instead.
  const facade = house ? null : facadeMats[pat][idx].clone();
  const body = house
    ? new THREE.Mesh(GEO_BOX, houseMats[seed % houseMats.length])
    : new THREE.Mesh(bodyGeo(floors), facade);
  body.castShadow = body.receiveShadow = true;
  group.add(body);

  const roof = house
    // >>> not >>: hash() is unsigned 32-bit, and a signed shift of anything
    // above 2^31 goes negative, indexing off the end and leaving the mesh with
    // three's default white material — the flat white roofs
    ? new THREE.Mesh(GEO_PYR, tileRoofMats[(seed >>> 3) % tileRoofMats.length])
    : new THREE.Mesh(GEO_BOX, roofMat);
  roof.castShadow = true;
  if (house) roof.rotation.y = Math.PI / 4;
  group.add(roof);

  let cap = null;
  if (!house && floors > 8) {
    cap = new THREE.Mesh(bodyGeo(Math.max(2, Math.round(floors * 0.3))), facade);
    cap.castShadow = true;
    group.add(cap);
  }
  let prop = null;
  if (!house && floors > 4) {
    prop = new THREE.Mesh(GEO_BOX, propMat);
    prop.castShadow = true;
    group.add(prop);
  }
  let mast = null;
  if (!house && floors > 11) {
    mast = new THREE.Mesh(GEO_MAST, propMat);
    mast.castShadow = true;
    group.add(mast);
  }

  const scaffold = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const p = new THREE.Mesh(GEO_BOX, scaffoldMat);
    p.castShadow = true;
    scaffold.add(p);
  }
  group.add(scaffold);

  const crane = new THREE.Group();
  const cMast = new THREE.Mesh(GEO_MAST, craneMat); cMast.castShadow = true;
  const cJib = new THREE.Mesh(GEO_BOX, craneMat); cJib.castShadow = true;
  const cCab = new THREE.Mesh(GEO_BOX, craneMat);
  crane.add(cMast, cJib, cCab);
  group.add(crane);

  const b = {
    group, body, roof, cap, prop, mast, scaffold, crane, floors, house,
    w: (house ? 0.80 : 0.70) + rand01(seed) * 0.12,
    d: (house ? 0.80 : 0.70) + rand01(seed + 7) * 0.12,
    spin: rand01(seed + 3) * Math.PI * 2,
    facade, lit: 0,
  };
  buildings.set(f.path, b);
  cityRoot.add(group);
  return b;
}

function disposeBuilding(path) {
  const b = buildings.get(path);
  if (!b) return;
  cityRoot.remove(b.group);
  if (b.facade) b.facade.dispose();   // cloned per building, so nothing else holds it
  buildings.delete(path);
}

function updateBuilding(f, t, dt) {
  let b = buildings.get(f.path);
  const floors = floorsOf(f.bytes);
  if (b && b.floors !== floors) { disposeBuilding(f.path); b = null; }
  if (!b) b = makeBuilding(f);

  const p = layout.pos.get(f.path);
  if (!p) { b.group.visible = false; return; }
  b.group.visible = true;

  const { x, z } = worldPos(p.gx, p.gy);
  const prog = f.dying ? Math.max(0, 1 - f.dying) : f.grown;
  const h = Math.max(0.001, floors * FLOOR_H * prog);
  b.group.position.set(x, 0, z);

  b.body.scale.set(b.w, h, b.d);
  b.body.position.y = h / 2;

  if (b.house) {
    const rh = 0.46 * prog;               // steeper: 0.34 over a 1.4-wide base read as a flat plate
    b.roof.scale.set(b.w * 0.80, rh, b.d * 0.80);
    b.roof.position.y = h + rh / 2;
  } else {
    // sits 0.01 clear of the wall top: coplanar faces z-fight and flare white
    b.roof.scale.set(b.w * 1.06, 0.06, b.d * 1.06);
    b.roof.position.y = h + 0.04;
  }

  const capH = b.cap ? floors * 0.3 * FLOOR_H * prog : 0;
  if (b.cap) {
    b.cap.scale.set(b.w * 0.58, capH, b.d * 0.58);
    b.cap.position.y = h + capH / 2;
  }
  const top = h + capH + 0.06;
  if (b.prop) {
    b.prop.scale.set(b.w * 0.3, 0.12, b.d * 0.3);
    b.prop.position.set(b.w * 0.12, top, -b.d * 0.1);
  }
  if (b.mast) {
    b.mast.scale.set(1, 0.9, 1);
    b.mast.position.set(0, top + 0.45, 0);
  }

  const working = f.grown < 1 || f.dirty;
  b.scaffold.visible = working;
  b.crane.visible = working;
  if (working) {
    const sh = h + 0.35;
    const off = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    b.scaffold.children.forEach((pole, i) => {
      pole.scale.set(0.045, sh, 0.045);
      pole.position.set(off[i][0] * b.w * 0.58, sh / 2, off[i][1] * b.d * 0.58);
    });
    // the crane sweeps a circle around its own plot, so its reach is the one
    // part of a building that can end up over the street. at a mast on the plot
    // corner and a 1.9-long jib that circle had a radius of 2.1 — two plots —
    // and a repo under construction drew a thicket of orange bars across every
    // road. pulled in to ~1.2, which still overhangs the kerb like a real one.
    const mh = h + 1.5;
    const mx = b.w * 0.62, mz = b.d * 0.62;
    b.crane.rotation.y = b.spin + clock * 0.12;
    b.crane.children[0].scale.set(1, mh, 1);
    b.crane.children[0].position.set(mx, mh / 2, mz);
    b.crane.children[1].scale.set(0.95, 0.04, 0.04);
    b.crane.children[1].position.set(mx + 0.22, mh, mz);
    b.crane.children[2].scale.set(0.1, 0.1, 0.1);
    b.crane.children[2].position.set(mx, mh - 0.1, mz);
  }

  if (b.facade) {
    // ease rather than snap: a window coming on over a fraction of a second
    // reads as somebody flicking a switch; an instant flip reads as a bug
    const want = litAt(f.path, t) * 0.85;
    b.lit += (want - b.lit) * Math.min(1, dt * 2.5);
    b.facade.emissiveIntensity = b.lit;
  }
}

// ============================================================
// ground, parks, traffic
// ============================================================
// road strips and street signs allocate per layout (a strip's uv scale and a
// sign's text both depend on it), so they must be released when the layout
// changes. groundRoot.clear() only detaches — it never frees GPU memory.
let disposables = [];

function rebuildGround() {
  groundRoot.clear();
  for (const d of disposables) d.dispose();
  disposables = [];

  const far = Math.max(layout.gw, layout.gh) * 4 + 60;
  rainSpan = Math.max(40, Math.max(layout.gw, layout.gh) + 12);
  const base = new THREE.Mesh(new THREE.PlaneGeometry(far, far), terrainMat);
  base.rotation.x = -Math.PI / 2;
  base.position.y = -0.04;
  base.receiveShadow = true;
  groundRoot.add(base);

  // asphalt only under the city; streets are the gaps between block plates
  const street = new THREE.Mesh(new THREE.PlaneGeometry(layout.gw + 3, layout.gh + 3), asphaltMat);
  street.rotation.x = -Math.PI / 2;
  street.position.y = -0.01;
  street.receiveShadow = true;
  groundRoot.add(street);

  // exact counts per material. hiding spare instances with makeScale(0,0,0)
  // yields a singular normal matrix -> NaN -> the driver draws garbage
  // triangles, which showed up as big white quads over the city.
  const cityBlocks = layout.blocks.filter(b => !b.park);
  // a district smaller than its cell only paves its own rectangle; the rest of
  // the cell is lawn, so a two-file district reads as a garden square rather
  // than as an acre of empty concrete.
  const lawnBlocks = layout.blocks.filter(b => b.park || b.inner.size < b.size);
  const curbs = new THREE.InstancedMesh(GEO_BOX, curbMat, layout.blocks.length);
  const plates = new THREE.InstancedMesh(GEO_BOX, plateMat, Math.max(1, cityBlocks.length));
  const parks = new THREE.InstancedMesh(GEO_BOX, parkMat, Math.max(1, lawnBlocks.length));
  for (const im of [curbs, plates, parks]) { im.receiveShadow = true; im.castShadow = false; }
  plates.count = cityBlocks.length;
  parks.count = lawnBlocks.length;

  const m = new THREE.Matrix4();
  const place = (bx, by, size) => ({
    size,
    cx: bx + (size - 1) / 2 - layout.gw / 2,
    cz: by + (size - 1) / 2 - layout.gh / 2,
  });
  layout.blocks.forEach((blk, i) => {
    const { size, cx, cz } = place(blk.bx, blk.by, blk.size);
    m.makeScale(size + 0.62, 0.11, size + 0.62);
    m.setPosition(cx, 0.028, cz);
    curbs.setMatrixAt(i, m);
  });
  cityBlocks.forEach((blk, i) => {
    const { size, cx, cz } = place(blk.inner.bx, blk.inner.by, blk.inner.size);
    m.makeScale(size + 0.24, 0.14, size + 0.24);
    m.setPosition(cx, 0.04, cz);
    plates.setMatrixAt(i, m);
  });
  lawnBlocks.forEach((blk, i) => {
    const { size, cx, cz } = place(blk.bx, blk.by, blk.size);
    // 0.13 tall, not 0.14: the lawn passes under the paving of its own block,
    // and two boxes with the same top face z-fight across the whole cell
    m.makeScale(size + 0.24, 0.13, size + 0.24);
    m.setPosition(cx, 0.04, cz);
    parks.setMatrixAt(i, m);
  });
  for (const im of [curbs, plates, parks]) im.instanceMatrix.needsUpdate = true;
  groundRoot.add(curbs, plates, parks);

  rebuildTrees();
  rebuildRoads();
  rebuildLamps();
  rebuildFurniture();
  rebuildCars();
  rebuildPedestrians();
}

// ---- roads ----
// the asphalt plane underneath already fills every gap; these strips only add
// the paint, which is why intersections need no special geometry.
function rebuildRoads() {
  const lines = roadLines(layout);
  if (!lines.length) return;

  for (const l of lines) {
    // uv.x scaled by the span keeps one texture tile at one world unit, so the
    // dashes stay the same length whatever size the city is
    const geo = new THREE.PlaneGeometry(l.span, ROAD_W).rotateX(-Math.PI / 2);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * l.span);
    uv.needsUpdate = true;
    disposables.push(geo);

    const mesh = new THREE.Mesh(geo, roadMat);
    mesh.receiveShadow = true;
    if (l.axis === "x") mesh.position.set(0, Y_ROAD_X, l.at);
    else { mesh.rotation.y = Math.PI / 2; mesh.position.set(l.at, Y_ROAD_Z, 0); }
    groundRoot.add(mesh);
  }

  const cross = intersections(layout);
  if (!cross.length) return;
  // four approaches per intersection, each stopping short of the junction
  const zebras = new THREE.InstancedMesh(GEO_QUAD, zebraMat, cross.length * 4);
  zebras.receiveShadow = true;
  const m = new THREE.Matrix4();
  const zscale = new THREE.Vector3(ROAD_W, 1, 0.26);
  const off = ROAD_W / 2 + 0.13;
  let i = 0;
  for (const c of cross) {
    for (const [dx, dz, turn] of [[0, -1, 0], [0, 1, 0], [-1, 0, 1], [1, 0, 1]]) {
      m.makeRotationY(turn * Math.PI / 2);
      m.scale(zscale);
      m.setPosition(c.x + dx * off, Y_ZEBRA, c.z + dz * off);
      zebras.setMatrixAt(i++, m);
    }
  }
  zebras.instanceMatrix.needsUpdate = true;
  groundRoot.add(zebras);
}

// ---- lamp posts ----
// spaced along both kerbs of every road, arm turned over the asphalt.
let pools = null;
function rebuildLamps() {
  pools = null;
  const lines = roadLines(layout);
  if (!lines.length) return;

  // posts stand on the curb strip: outside the asphalt, inside the block plate.
  // at GUT/2 - 0.1 they landed on the grass of every park block.
  const GAP = 3.2, EDGE = ROAD_W / 2 + KERB_OVER * 0.28;
  const spots = [];
  for (const l of lines) {
    for (let p = -l.span / 2 + GAP / 2; p < l.span / 2; p += GAP) {
      // `turn` puts the arm over the road: the head is at +x of the post
      if (l.axis === "x") {
        spots.push({ x: p, z: l.at - EDGE, rot: -Math.PI / 2 });
        spots.push({ x: p, z: l.at + EDGE, rot: Math.PI / 2 });
      } else {
        spots.push({ x: l.at - EDGE, z: p, rot: 0 });
        spots.push({ x: l.at + EDGE, z: p, rot: Math.PI });
      }
    }
  }
  if (!spots.length) return;
  const capped = spots.slice(0, 320);

  const lamps = new THREE.InstancedMesh(GEO_LAMP, streetMat, capped.length);
  lamps.castShadow = true;
  pools = new THREE.InstancedMesh(GEO_QUAD, poolMat, capped.length);
  pools.visible = false;                  // an additive quad at zero opacity still costs a draw
  const m = new THREE.Matrix4();
  capped.forEach((s, i) => {
    m.makeRotationY(s.rot);
    m.setPosition(s.x, Y_KERB, s.z);
    lamps.setMatrixAt(i, m);
    // the pool falls under the head, not under the post
    m.makeScale(1.5, 1, 1.5);
    m.setPosition(s.x + Math.cos(s.rot) * 0.19, Y_POOL, s.z - Math.sin(s.rot) * 0.19);
    pools.setMatrixAt(i, m);
  });
  lamps.instanceMatrix.needsUpdate = true;
  pools.instanceMatrix.needsUpdate = true;
  groundRoot.add(lamps, pools);
}

// ---- street furniture ----
// bins, hydrants, bus stops and district signs all stand on the kerb ring of a
// block, which is the same ring the pedestrians walk — one source of truth for
// where the pavement is.
let signCount = 0;
function rebuildFurniture() {
  const blocks = layout.blocks;
  if (!blocks.length) return;

  const kerb = (blk) => {
    const { x, z } = worldPos(blk.bx + (blk.size - 1) / 2, blk.by + (blk.size - 1) / 2);
    return { x, z, half: (blk.size + 0.42) / 2 };
  };

  const bins = [], hydrants = [], stops = [];
  blocks.forEach((blk, bi) => {
    const k = kerb(blk);
    const r = rand01(bi * 3.3);
    // one bus stop on roughly every fourth block, on a side chosen by the block
    if (r > 0.72) {
      const side = Math.floor(rand01(bi * 9.1) * 4);
      const u = (rand01(bi * 4.7) - 0.5) * k.half;
      const at = [[u, -k.half, 0], [k.half, u, Math.PI / 2], [u, k.half, Math.PI], [-k.half, u, -Math.PI / 2]][side];
      stops.push({ x: k.x + at[0], z: k.z + at[1], rot: at[2] });
    }
    for (let j = 0; j < 3; j++) {
      const t = rand01(bi * 7.7 + j * 2.9);
      const side = Math.floor(t * 4);
      const u = (rand01(bi * 5.1 + j * 8.3) - 0.5) * k.half * 1.7;
      const p = [[u, -k.half], [k.half, u], [u, k.half], [-k.half, u]][side];
      (j === 2 ? hydrants : bins).push({ x: k.x + p[0], z: k.z + p[1] });
    }
  });

  const m = new THREE.Matrix4();
  const place = (geo, items) => {
    if (!items.length) return;
    const im = new THREE.InstancedMesh(geo, streetMat, items.length);
    im.castShadow = true;
    items.forEach((it, i) => {
      m.makeRotationY(it.rot || 0);
      m.setPosition(it.x, Y_KERB, it.z);
      im.setMatrixAt(i, m);
    });
    im.instanceMatrix.needsUpdate = true;
    groundRoot.add(im);
  };
  place(GEO_BIN, bins);
  place(GEO_HYDRANT, hydrants);
  place(GEO_BUSSTOP, stops);

  // one named sign per district, on the corner nearest the origin. the plate is
  // the only prop with per-instance text, so it is the only one that allocates.
  const named = blocks.filter(b => b.dir);
  signCount = named.length;
  if (!named.length) return;
  const posts = new THREE.InstancedMesh(GEO_SIGNPOST, streetMat, named.length);
  posts.castShadow = true;
  named.forEach((blk, i) => {
    const k = kerb(blk);
    m.makeRotationY(0);
    m.setPosition(k.x - k.half, Y_KERB, k.z - k.half);
    posts.setMatrixAt(i, m);

    const tex = mkSignTex(blk.dir);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, side: THREE.DoubleSide });
    disposables.push(tex, mat);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.11), mat);
    disposables.push(plate.geometry);
    // the plate hangs off the post along its own width axis, which the 45°
    // turn has already rotated — offsetting in world x alone leaves it skewered
    plate.position.set(k.x - k.half + 0.155, Y_KERB + 0.47, k.z - k.half - 0.155);
    plate.rotation.y = Math.PI / 4;
    groundRoot.add(plate);
  });
  posts.instanceMatrix.needsUpdate = true;
  groundRoot.add(posts);
}

function rebuildTrees() {
  // the cap is per city, so it has to clear the lawn of every sparse district
  // at once — at 420 the last blocks came out as bare green sheets
  const spots = layout.empty.filter((s, i) => s.park || i % 3 === 0).slice(0, 1200);
  if (!spots.length) return;
  const trunks = new THREE.InstancedMesh(GEO_TRUNK, trunkMat, spots.length);
  const leaves = new THREE.InstancedMesh(GEO_LEAF, leafMat, spots.length);
  leaves.castShadow = true;
  const m = new THREE.Matrix4();
  spots.forEach((s, i) => {
    const { x, z } = worldPos(s.gx, s.gy);
    const jx = (rand01(s.gx * 3.1 + s.gy) - 0.5) * 0.4;
    const jz = (rand01(s.gx + s.gy * 2.7) - 0.5) * 0.4;
    const sc = 0.5 + rand01(s.gx * 7 + s.gy * 5) * 0.3;
    m.makeScale(sc, sc, sc); m.setPosition(x + jx, 0.09 + 0.17 * sc, z + jz);
    trunks.setMatrixAt(i, m);
    m.makeScale(sc, sc, sc); m.setPosition(x + jx, 0.09 + 0.66 * sc, z + jz);
    leaves.setMatrixAt(i, m);
  });
  trunks.instanceMatrix.needsUpdate = true;
  leaves.instanceMatrix.needsUpdate = true;
  groundRoot.add(trunks, leaves);
}

// traffic: movement on the ground is what stops it reading as a model kit.
// one InstancedMesh per body type, all driving the same lane list — a car, a
// van and a truck cannot share a geometry, but they can share the loop.
const VEHICLES = [
  { geo: GEO_CAR, share: 0.62, speed: [1.8, 1.9] },
  { geo: GEO_VAN, share: 0.24, speed: [1.5, 1.4] },
  { geo: GEO_TRUCK, share: 0.14, speed: [1.1, 0.9] },   // heavy and slow, so it holds a lane
];
let traffic = [];

function rebuildCars() {
  for (const t of traffic) scene.remove(t.mesh);
  traffic = [];

  const lanes = [];
  // half a carriageway either side of the centre dash. at the old 0.3 the wide
  // side of a truck hung over the kerb.
  const OFF = ROAD_W / 4;
  for (const l of roadLines(layout)) {
    if (l.axis === "x") lanes.push({ axis: "x", at: l.at - OFF, dir: 1, span: l.span }, { axis: "x", at: l.at + OFF, dir: -1, span: l.span });
    else lanes.push({ axis: "z", at: l.at - OFF, dir: -1, span: l.span }, { axis: "z", at: l.at + OFF, dir: 1, span: l.span });
  }
  if (!lanes.length) return;

  const total = Math.min(90, lanes.length * 4);
  const col = new THREE.Color();
  let n = 0;
  VEHICLES.forEach((kind, k) => {
    const count = k === VEHICLES.length - 1 ? total - n : Math.round(total * kind.share);
    if (count <= 0) return;
    const mesh = new THREE.InstancedMesh(kind.geo, vehicleMat, count);
    mesh.castShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const items = [];
    for (let i = 0; i < count; i++) {
      const seed = n + i;
      const lane = lanes[seed % lanes.length];
      items.push({
        lane,
        t: rand01(seed * 3.7) * lane.span,
        speed: kind.speed[0] + rand01(seed * 7.3) * kind.speed[1],
      });
      col.setHex(CAR_COLORS[seed % CAR_COLORS.length]);
      mesh.setColorAt(i, col);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.userData.items = items;
    scene.add(mesh);
    traffic.push({ mesh, items });
    n += count;
  });
}

const _cm = new THREE.Matrix4();
function updateCars(dt, density, night) {
  vehicleMat.emissiveIntensity = night;
  const pace = 0.35 + density * 0.9;
  for (const { mesh, items } of traffic) {
    // spare instances are hidden with count, never makeScale(0,0,0): a zero scale
    // gives a singular normal matrix and the driver draws garbage triangles
    mesh.count = Math.max(0, Math.round(items.length * density));
    for (let i = 0; i < mesh.count; i++) {
      const it = items[i];
      it.t += it.speed * pace * dt;
      if (it.t > it.lane.span) it.t -= it.lane.span;
      const p = it.t - it.lane.span / 2;
      // the body points along +z, so a lane running x is a quarter turn away
      if (it.lane.axis === "x") {
        _cm.makeRotationY(it.lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
        _cm.setPosition(p * it.lane.dir, 0.005, it.lane.at);
      } else {
        _cm.makeRotationY(it.lane.dir > 0 ? 0 : Math.PI);
        _cm.setPosition(it.lane.at, 0.005, p * it.lane.dir);
      }
      mesh.setMatrixAt(i, _cm);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}

// pedestrians walk the perimeter of each block plate. a walker's position is a
// single number: distance travelled around a square ring.
const GEO_PED = new THREE.BoxGeometry(0.07, 0.18, 0.07);
const pedMat = new THREE.MeshStandardMaterial({ color: 0x2f3540, roughness: 0.9 });
let peds = null;

// returns [x, z, side]; side is which of the four kerbs the walker is on
function ringAt(ring, t) {
  const s = ((t % ring.per) + ring.per) % ring.per;
  const side = Math.floor(s / (ring.half * 2));
  const u = (s % (ring.half * 2)) - ring.half;
  if (side === 0) return [u, -ring.half, 0];
  if (side === 1) return [ring.half, u, 1];
  if (side === 2) return [-u, ring.half, 2];
  return [-ring.half, -u, 3];
}

function rebuildPedestrians() {
  if (peds) { scene.remove(peds); peds = null; }
  // the plate is scaled to size + 0.24, so a ring at size + 0.10 sits on it.
  // anything wider lands on the curb, which is 0.027 lower — and the walkers
  // then visibly hover.
  const rings = layout.blocks.map(blk => {
    const { x, z } = worldPos(blk.bx + (blk.size - 1) / 2, blk.by + (blk.size - 1) / 2);
    const half = (blk.size + 0.10) / 2;
    return { x, z, half, per: half * 8 };
  });
  if (!rings.length) return;

  const max = Math.min(260, rings.length * 8);
  peds = new THREE.InstancedMesh(GEO_PED, pedMat, max);
  peds.castShadow = true;
  peds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  peds.userData.walkers = [];
  for (let i = 0; i < max; i++) {
    const ring = rings[i % rings.length];
    peds.userData.walkers.push({
      ring,
      t: rand01(i * 2.3) * ring.per,
      speed: 0.45 + rand01(i * 5.9) * 0.35,
      dir: i % 2 ? 1 : -1,
    });
  }
  scene.add(peds);
}

const _pm = new THREE.Matrix4();
function updatePedestrians(dt, density) {
  if (!peds) return;
  const w = peds.userData.walkers;
  peds.count = Math.max(0, Math.round(w.length * density));
  for (let i = 0; i < peds.count; i++) {
    const p = w[i];
    p.t += p.speed * p.dir * dt;
    const [ox, oz, side] = ringAt(p.ring, p.t);
    // face along the kerb being walked. side 0 heads +x, 1 heads +z, 2 heads -x,
    // 3 heads -z, which is (1 - side) quarter turns; reversed walkers add half.
    _pm.makeRotationY((1 - side) * Math.PI / 2 + (p.dir > 0 ? 0 : Math.PI));
    _pm.setPosition(p.ring.x + ox, 0.20, p.ring.z + oz);
    peds.setMatrixAt(i, _pm);
  }
  peds.instanceMatrix.needsUpdate = true;
}

// ============================================================
// clouds — flat-shaded puff clusters, like the cone trees and box buildings.
// they used to be one horizontal textured quad each, which read as a paper
// cutout to a camera that always looks down, and needed alphaTest 0.62 to stop
// its shadow being a hard blob. solid geometry needs no such trick, and
// overcast tints the puffs grey instead of fading them; the only opacity in
// play is the camera-proximity fade below.
// ============================================================
// detail 2, not 0: at detail 0 the twenty facets are big enough to count at
// this camera distance and the puffs read as dice rather than vapour.
const GEO_PUFF = new THREE.IcosahedronGeometry(1, 2);
const CLOUD_Y = 12;                     // floor of the deck; tallest tower is under 5
const CLOUD_CLEAR = new THREE.Color(0xf7f9fb);
const CLOUD_OVERCAST = new THREE.Color(0x8791a0);
// the emissive floor is doing real work: the hemisphere light's ground colour is
// a dark brown, so an unlit underside goes almost black and the puff reads as
// rock. clouds are lit from below by bounced sky in a way lambert cannot know.
// one material per cloud, not one shared: each fades on its own as the camera
// gets close, so a cloud drifting through the lens goes translucent instead of
// filling the screen with white. depthWrite stays on so the puffs inside a
// cluster do not double-blend into a muddy blob.
const cloudMats = [];
const clouds = [];
let cloudsOn = true;   // flipped by window.__toggle("clouds")
for (let i = 0; i < 8; i++) {
  const g = new THREE.Group();
  const s = 9 + rand01(i * 4.4) * 13;
  const puffs = 4 + Math.floor(rand01(i * 1.9) * 3);
  const cloudMat = new THREE.MeshLambertMaterial({
    color: 0xf7f9fb, emissive: 0x424b57, flatShading: true, fog: false,
    transparent: true, depthWrite: true,
  });
  cloudMats.push(cloudMat);
  for (let j = 0; j < puffs; j++) {
    const p = new THREE.Mesh(GEO_PUFF, cloudMat);
    // fatter puffs packed tighter than before: when they barely touch, the
    // intersection line lands on the silhouette and reads as two rocks glued
    // together. overlapping well past their centres hides the seam inside.
    const r = s * (0.26 + rand01(i * 7 + j * 3.7) * 0.16);
    p.scale.set(r, r * 0.62, r);      // squashed: a sphere reads as a balloon
    p.position.set(
      (rand01(i * 5 + j * 2.1) - 0.5) * s * 0.62,
      (rand01(i * 3 + j * 8.3) - 0.5) * s * 0.12,
      (rand01(i * 11 + j * 4.9) - 0.5) * s * 0.42
    );
    // spin each puff so the facets do not line up across the cluster
    p.rotation.set(rand01(i + j * 2.7) * 3, rand01(i + j * 5.3) * 3, 0);
    p.castShadow = true;
    g.add(p);
  }
  // ponytail: cloud height is a tuning knob, not a derived value. the camera
  // looks down at the city and can only be dragged to ~6 degrees above the
  // horizon, so clouds parked high are simply never in frame.
  g.position.set(-80 + rand01(i * 2.2) * 160, CLOUD_Y + rand01(i * 8.1) * 7, -80 + rand01(i * 5.5) * 160);
  g.userData.speed = 0.5 + rand01(i * 6.7) * 0.8;
  g.userData.r = s;
  scene.add(g);
  clouds.push(g);
}

// ============================================================
// dust
// ============================================================
const DUST_MAX = 900;
const dustPos = new Float32Array(DUST_MAX * 3);
const dust = [];
const dustCol = new Float32Array(DUST_MAX * 3);
const smokePos = new Float32Array(DUST_MAX * 3);
const smokeCol = new Float32Array(DUST_MAX * 3);
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
// the confetti shares this system rather than adding a second one: same buffer,
// same loop, same draw call — a spark is only a grain of dust thrown harder and
// painted warm, which is what the per-vertex colour is for
dustGeo.setAttribute("color", new THREE.BufferAttribute(dustCol, 3));
const dustPoints = new THREE.Points(dustGeo, new THREE.PointsMaterial({
  // 0.3 / 0.5 was fine when dust was one anonymous beige puff. six events that
  // have to be told apart at city framing need to out-read the rain, which is a
  // field of specks at exactly this size
  size: 0.45, vertexColors: true, transparent: true, opacity: 0.62, depthWrite: false,
}));
// smoke is the same particle in a second, fatter, fainter layer. one array, one
// update loop, two draw calls — a grain at size 0.3 reads as a gnat swarm no
// matter how dark you paint it, and demolition has to look like demolition.
const smokeGeo = new THREE.BufferGeometry();
smokeGeo.setAttribute("position", new THREE.BufferAttribute(smokePos, 3));
smokeGeo.setAttribute("color", new THREE.BufferAttribute(smokeCol, 3));
const smokePoints = new THREE.Points(smokeGeo, new THREE.PointsMaterial({
  size: 1.1, vertexColors: true, transparent: true, opacity: 0.28, depthWrite: false,
}));
dustPoints.frustumCulled = false;
smokePoints.frustumCulled = false;
scene.add(dustPoints, smokePoints);

// ---- the vocabulary ----
// six things can happen to a file, and every one of them used to be the same
// beige puff with a different particle count. the city could say that something
// happened but never what. each preset is colour + launch + physics; nothing
// here is logic, so tuning one event cannot break another.
//   spread/up: metres. g: gravity multiplier. d: drag per second.
//   r: life drained per second (1 / seconds visible). k: 1 puts it in the smoke layer.
const FX = {
  // a new building settles: pale concrete dust pushed out from the footings
  born:   { c: [[0.81, 0.78, 0.72]], n: 16, spread: 1.2, up: 0.3, out: 0.9, vy: [0.5, 1.1], g: 1, d: 1.2, r: 0.9, k: 0 },
  // the file got bigger: sparks off the roof, thrown up, barely any drag
  grow:   { c: [[1, 0.95, 0.82], [1, 0.86, 0.55]], n: 14, spread: 0.7, up: 0.1, out: 0.8, vy: [1.4, 1.0], g: 1, d: 0.1, r: 1.1, k: 0 },
  // the file got smaller: rubble shed down the sides, heavy, no lift
  shrink: { c: [[0.55, 0.44, 0.33], [0.46, 0.40, 0.34]], n: 14, spread: 1.3, up: 0.5, out: 0.5, vy: [-0.2, 0.5], g: 2, d: 0.6, r: 1.0, k: 0 },
  // work starts: a thin ochre haze at the foot of the crane
  dirty:  { c: [[0.78, 0.66, 0.40]], n: 10, spread: 1.0, up: 0.2, out: 0.5, vy: [0.3, 0.5], g: 0.5, d: 1.6, r: 0.8, k: 0 },
  // the crane comes down: confetti, thrown hard enough to arc over the roofline
  done:   { c: [[1, 0.82, 0.48], [1, 0.95, 0.82], [1, 0.60, 0.24]], n: 18, spread: 0.8, up: 0.2, out: 1.6, vy: [2.2, 1.2], g: 1, d: 0, r: 0.9, k: 0 },
  // demolition: dark smoke, buoyant, dragged to a stop and left to hang
  died:   { c: [[0.35, 0.35, 0.36], [0.28, 0.27, 0.28], [0.44, 0.42, 0.40]], n: 22, spread: 1.4, up: 0.6, out: 0.7, vy: [0.5, 0.6], g: -0.15, d: 0.9, r: 0.35, k: 1 },
};

function fx(kind, x, y, z, n) {
  const p = FX[kind];
  const count = n || p.n;
  for (let i = 0; i < count && dust.length < DUST_MAX; i++) {
    dust.push({
      x: x + (Math.random() - 0.5) * p.spread,
      y: y + Math.random() * p.up,
      z: z + (Math.random() - 0.5) * p.spread,
      vx: (Math.random() - 0.5) * p.out,
      vy: p.vy[0] + Math.random() * p.vy[1],
      vz: (Math.random() - 0.5) * p.out,
      life: 1, c: p.c[(Math.random() * p.c.length) | 0],
      g: p.g, d: p.d, r: p.r, k: p.k,
    });
  }
}

// ---- rain ----
// drops recycle forever and never change count, so unlike dust they need no
// per-particle object: the position buffer is the state.
const RAIN_MAX = 1400;
const rainPos = new Float32Array(RAIN_MAX * 3);
const rainVel = new Float32Array(RAIN_MAX);
for (let i = 0; i < RAIN_MAX; i++) {
  rainPos[i * 3 + 1] = -1;                    // below ground, so it recycles on frame one
  rainVel[i] = 9 + rand01(i * 4.1) * 5;
}
let rainSpan = 60;                            // full width of the drop box, set with the ground
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
const rainPoints = new THREE.Points(rainGeo, new THREE.PointsMaterial({
  size: 0.11, color: 0xa8bcca, transparent: true, opacity: 0.5,
  depthWrite: false, fog: false,
}));
rainPoints.frustumCulled = false;
rainPoints.visible = false;
scene.add(rainPoints);

function updateRain(dt, amount) {
  const n = Math.round(RAIN_MAX * Math.min(1, Math.max(0, amount)));
  rainPoints.visible = n > 0;
  if (!n) return;
  for (let i = 0; i < n; i++) {
    const y = rainPos[i * 3 + 1] - rainVel[i] * dt;
    if (y < 0) {
      rainPos[i * 3] = (Math.random() - 0.5) * rainSpan;
      rainPos[i * 3 + 2] = (Math.random() - 0.5) * rainSpan;
      rainPos[i * 3 + 1] = 18 + Math.random() * 10;
    } else {
      rainPos[i * 3 + 1] = y;
    }
  }
  rainGeo.setDrawRange(0, n);
  rainGeo.attributes.position.needsUpdate = true;
}

function fileWorld(f) {
  const p = layout.pos.get(f.path);
  if (!p) return { x: 0, y: 0, z: 0 };
  const { x, z } = worldPos(p.gx, p.gy);
  return { x, y: floorsOf(f.bytes) * FLOOR_H * (f.grown || 1), z };
}

// ============================================================
// camera framing
// ============================================================
const CAM_ANGLE = 52;        // degrees above the horizon; drag the scene to change it
let fogFar = 200;            // clear-sky baseline, captured below and scaled by weather
let frozenT = null;          // set by window.__time() to hold a fixed hour

// the whole-city framing. the camera only snaps to it once, on the first real
// layout: after that driveCamera eases towards it, so a file disappearing no
// longer teleports the view.
const homeTarget = new THREE.Vector3(0, 1, 0);
let homeDist = 40;
let framed = false;

function distFor(radius) {
  return radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.62;
}

// fog rides the eased distance so a close-up does not put the far side of the
// city behind fog.near. it floors at the home framing because fogFar is the
// clear-sky baseline applyTime scales by weather — writing scene.fog.far here
// instead would drop the rain multiplier on the floor.
function applyFog(dist) {
  scene.fog.near = dist * 0.95;
  fogFar = Math.max(dist, homeDist) * 4.2;
}

function frameCamera() {
  const r = Math.max(layout.gw, layout.gh) * 0.72 + 6;
  homeTarget.set(0, Math.min(6, r * 0.1), 0);
  homeDist = distFor(r);
  // the module-scope call happens before the first snapshot, on planCity([]) —
  // snapping there would frame an empty world and burn the one-shot
  if (framed || !layout.districts) return;
  framed = true;
  const polar = THREE.MathUtils.degToRad(90 - CAM_ANGLE);
  const az = Math.atan2(camera.position.x - homeTarget.x, camera.position.z - homeTarget.z) || 0.7;
  controls.target.copy(homeTarget);
  camera.position.set(
    homeTarget.x + Math.sin(az) * homeDist * Math.sin(polar),
    homeTarget.y + homeDist * Math.cos(polar),
    homeTarget.z + Math.cos(az) * homeDist * Math.sin(polar)
  );
  controls.update();
  applyFog(homeDist);
  scene.fog.far = fogFar;
}

// ---- attention camera ----
// every change marks its building with attn 1; the frame drifts to the
// weighted centre of whatever is still lit and pulls back out as they fade.
// one save is a close-up, a commit is the whole city, and going home is just
// the radius growing — there is no "return" state.
const ATTN_DECAY = 0.35;     // ~3s of pull per event
const FOCUS_MARGIN = 6;      // same slack frameCamera leaves around the city
const _want = new THREE.Vector3();
const _off = new THREE.Vector3();
const _pts = [];

function driveCamera(dt) {
  // autoRotate is the "nobody has touched the camera for 6s" flag — idleTimer
  // is 0 *during* a drag as well as when idle, so gating on it would fight the
  // pointer. while the user is driving, the director stays out of the way.
  if (!controls.autoRotate) return;
  _pts.length = 0;
  for (const f of files.values()) {
    if (f.attn <= 0) continue;
    const w = fileWorld(f);
    _pts.push({ x: w.x, z: w.z, w: f.attn });
  }
  for (const g of ghosts) _pts.push(g);

  const f = focus(_pts);
  // never closer than a third of the home framing and never wider than home:
  // city units scale with sqrt(file count), so an absolute floor would be a
  // dive in a big repo and no movement at all in a small one
  const dist = f
    ? THREE.MathUtils.clamp(distFor(f.r + FOCUS_MARGIN), homeDist * 0.35, homeDist)
    : homeDist;
  _want.set(f ? f.x : homeTarget.x, homeTarget.y, f ? f.z : homeTarget.z);
  // 1 - exp(-dt*k) instead of a fixed alpha: same easing at 30 and at 144 fps
  controls.target.lerp(_want, 1 - Math.exp(-dt * 1.1));
  // only the distance to the target moves, never the angles, so autoRotate
  // keeps turning through the whole trip and CAM_ANGLE's measured pitch (the
  // moon arc depends on it) is left alone
  _off.copy(camera.position).sub(controls.target);
  _off.setLength(THREE.MathUtils.lerp(_off.length(), dist, 1 - Math.exp(-dt * 0.9)));
  camera.position.copy(controls.target).add(_off);
  applyFog(_off.length());
}

// ============================================================
// time of day
// ============================================================
const DAY = {
  dawn:  { top: 0x527099, hor: 0xe6bb98, bot: 0x8e8781, sun: 0xffc089, si: 1.5, hemi: 0.55, fog: 0xd6bfab },
  noon:  { top: 0x5f92c9, hor: 0xdce7ee, bot: 0xb0bcc6, sun: 0xfff4e2, si: 2.05, hemi: 0.9, fog: 0xcfdae2 },
  dusk:  { top: 0x39496b, hor: 0xd9a077, bot: 0x6a6467, sun: 0xffa96b, si: 1.5, hemi: 0.42, fog: 0xb79c8b },
  night: { top: 0x101b2c, hor: 0x24334a, bot: 0x171d28, sun: 0xa8bcd8, si: 0.4, hemi: 0.26, fog: 0x1a2331 },
};
const _c1 = new THREE.Color(), _c2 = new THREE.Color();
function lerpStop(a, b, t, key) {
  _c1.setHex(a[key]); _c2.setHex(b[key]);
  return _c1.lerp(_c2, t);
}
function applyTime(t, weather) {
  let a, b, k;
  if (t < 0.25) { a = DAY.night; b = DAY.dawn; k = t / 0.25; }
  else if (t < 0.5) { a = DAY.dawn; b = DAY.noon; k = (t - 0.25) / 0.25; }
  else if (t < 0.75) { a = DAY.noon; b = DAY.dusk; k = (t - 0.5) / 0.25; }
  else { a = DAY.dusk; b = DAY.night; k = (t - 0.75) / 0.25; }

  skyUniforms.cTop.value.copy(lerpStop(a, b, k, "top"));
  skyUniforms.cHorizon.value.copy(lerpStop(a, b, k, "hor"));
  skyUniforms.cBottom.value.copy(lerpStop(a, b, k, "bot"));
  sun.color.copy(lerpStop(a, b, k, "sun"));
  // weather scales the clear-sky baseline here, in the one function that owns
  // these values. fog.far in particular is only ever written by frameCamera, so
  // scaling it in place from the loop would decay it to zero within a second.
  sun.intensity = THREE.MathUtils.lerp(a.si, b.si, k) * (1 - weather.rain * 0.55 - weather.overcast * 0.15);
  hemi.intensity = THREE.MathUtils.lerp(a.hemi, b.hemi, k);
  scene.fog.color.copy(lerpStop(a, b, k, "fog"));
  scene.fog.far = fogFar * (1 - weather.rain * 0.35);

  const day = THREE.MathUtils.clamp((t - 0.18) / 0.64, 0, 1);
  const elev = THREE.MathUtils.degToRad(6 + Math.sin(day * Math.PI) * 62);
  const azim = THREE.MathUtils.degToRad(-115 + day * 230);
  const R = Math.max(60, Math.max(layout.gw, layout.gh) * 1.6);
  sun.position.set(Math.cos(azim) * Math.cos(elev) * R, Math.max(4, Math.sin(elev) * R), Math.sin(azim) * Math.cos(elev) * R);
  sun.target.position.set(0, 0, 0);

  const span = Math.max(layout.gw, layout.gh) * 0.78 + 34;
  const sc = sun.shadow.camera;
  sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span;
  sc.near = 1; sc.far = R * 2.6;
  sc.updateProjectionMatrix();
}

// ============================================================
// hud + feed
// ============================================================
const el = {
  repo: document.getElementById("repo"),
  branch: document.getElementById("r-branch"),
  clock: document.getElementById("r-clock"),
  status: document.getElementById("r-status"),
  boot: document.getElementById("boot"),
  bootTxt: document.getElementById("boot-txt"),
  bootBar: document.querySelector("#boot-bar > i"),
};
function setStatus(text, state) {
  el.status.textContent = text;
  el.status.dataset.ok = state;
}

// "wait" = switched, snapshot not here yet; "rise" = buildings still going up.
// null = done. the tick loop owns the "rise" -> null transition, which is what
// lifts the boot curtain — the city is only ever revealed finished.
let phase = null, phaseRepo = "";
function setBoot(text, pct) {
  if (el.bootTxt.textContent !== text) el.bootTxt.textContent = text;
  el.bootBar.style.width = `${pct}%`;
}

// switching repos does not clear local state on purpose: ingest already marks
// every vanished file as dying, so the old city crumbles while the new one
// rises under scaffolding. the transition comes for free.
let es = null;
function connect(name) {
  if (es) es.close();
  phase = "wait";
  phaseRepo = name || "cidade";
  el.boot.classList.remove("done");
  setBoot(`construindo ${phaseRepo}`, 0);
  es = new EventSource(name ? `/events?repo=${encodeURIComponent(name)}` : "/events");
  es.onerror = () => {
    setStatus("sem conexão", "bad");
    if (phase) setBoot("sem conexão", 0);
  };
  es.onmessage = (ev) => {
    const snap = JSON.parse(ev.data);
    if (snap.error) { setStatus(snap.error, "bad"); if (phase) setBoot(snap.error, 0); return; }
    setStatus("ligado", "ok");
    if (phase === "wait") phase = "rise";
    ingest(snap);
  };
}

fetch("/repos")
  .then(r => r.json())
  .then(names => {
    for (const name of names) {
      const o = document.createElement("option");
      o.value = o.textContent = name;
      el.repo.append(o);
    }
    connect(names[0]);
  })
  .catch(() => connect(null));

el.repo.addEventListener("change", () => connect(el.repo.value));

// ============================================================
// loop
// ============================================================
let last = 0, clock = 0, fpsAcc = 0, fpsN = 0;
let fps = 0;

function resize() {
  const r = canvas.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);
resize();

function tick(ts) {
  const dt = Math.min(0.05, (ts - last) / 1000 || 0);
  last = ts;
  clock += dt;
  const t = frozenT ?? dayT(Date.now());

  if (layoutDirty) {
    layout = planCity([...files.values()]);
    layoutDirty = false;
    rebuildGround();
    frameCamera();
  }

  let growSum = 0, growN = 0;
  for (const [path, f] of files) {
    if (!f.dying) { growSum += f.grown; growN++; }
    const beforeFloors = floorsOf(f.bytes);
    // snap once close: the asymptotic approach can park bytes exactly on a
    // floorsOf rounding boundary, which then flips every frame — spawning dust
    // forever and rebuilding the mesh 60x a second.
    f.bytes = Math.abs(f.target - f.bytes) < 1
      ? f.target
      : f.bytes + (f.target - f.bytes) * Math.min(1, dt * 3.2);
    if (floorsOf(f.bytes) !== beforeFloors) {
      const w = fileWorld(f);
      // a file gaining a floor throws sparks off its new roof; losing one sheds
      // rubble down the sides. same event in the data, opposite reading
      if (floorsOf(f.bytes) > beforeFloors) fx("grow", w.x, w.y, w.z);
      else fx("shrink", w.x, w.y * 0.8, w.z);
    }
    f.flash = Math.max(0, f.flash - dt * 1.5);
    f.attn = Math.max(0, f.attn - dt * ATTN_DECAY);
    if (f.flash > 0.95) {
      const w = fileWorld(f);
      fireFlash(w.x, w.y * 0.7 + 0.5, w.z);
    }
    if (f.grown < 1 && !f.dying) {
      f.grown = Math.min(1, f.grown + dt * 0.75);
      if (f.grown >= 1) {
        const w = fileWorld(f);
        fx("born", w.x, 0.2, w.z);
      }
    }
    if (f.dying) {
      f.dying = Math.min(1, f.dying + dt * 1.5);
      if (f.dying >= 1) {
        disposeBuilding(path);
        files.delete(path);
        layoutDirty = true;
        continue;
      }
    }
    updateBuilding(f, t, dt);
  }

  if (phase === "rise") {
    const pct = growN ? Math.floor((growSum / growN) * 100) : 100; // empty repo: nothing to raise
    if (pct >= 100) { phase = null; setBoot(`construindo ${phaseRepo}`, 100); el.boot.classList.add("done"); }
    else setBoot(`construindo ${phaseRepo}`, pct);
  }

  for (let i = dust.length - 1; i >= 0; i--) {
    const p = dust[i];
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    p.vy -= dt * 1.5 * p.g;
    if (p.d) {
      const k = Math.max(0, 1 - p.d * dt);
      p.vx *= k; p.vy *= k; p.vz *= k;
    }
    p.life -= dt * p.r;
    if (p.life <= 0) dust.splice(i, 1);
  }
  // one pass, two cursors: the layer a particle lands in is just p.k
  let n = 0, m = 0;
  for (const p of dust) {
    const buf = p.k ? smokePos : dustPos, col = p.k ? smokeCol : dustCol;
    const j = p.k ? m++ : n++;
    buf[j * 3] = p.x; buf[j * 3 + 1] = p.y; buf[j * 3 + 2] = p.z;
    col[j * 3] = p.c[0]; col[j * 3 + 1] = p.c[1]; col[j * 3 + 2] = p.c[2];
  }
  dustGeo.setDrawRange(0, n);
  dustGeo.attributes.position.needsUpdate = true;
  dustGeo.attributes.color.needsUpdate = true;
  smokeGeo.setDrawRange(0, m);
  smokeGeo.attributes.position.needsUpdate = true;
  smokeGeo.attributes.color.needsUpdate = true;

  for (const s of flashPool) {
    if (s.life > 0) {
      s.life -= dt * 1.9;
      s.light.intensity = Math.max(0, s.life) * 9;
      s.light.visible = s.life > 0;
    }
  }

  const weather = weatherAt(dayIndex(Date.now()));
  const lim = Math.max(110, Math.max(layout.gw, layout.gh) * 1.2);
  const deck = Math.round(3 + weather.overcast * 5);
  clouds.forEach((c, i) => {
    c.position.x += c.userData.speed * dt * 2.4;
    if (c.position.x > lim) c.position.x = -lim;
    c.visible = cloudsOn && i < deck;
    // mario-style: the closer the camera is to the cluster, the more it fades,
    // so a cloud crossing the lens never blanks the city out
    const d = c.position.distanceTo(camera.position);
    cloudMats[i].opacity = THREE.MathUtils.clamp((d - c.userData.r) / (c.userData.r * 1.6), 0.1, 1);
  });

  // headlights, lamp heads and their pools all ride the same ramp, so the
  // street never lights up before the cars do
  const night = nightK(t);
  streetMat.emissiveIntensity = night;
  poolMat.opacity = night * 0.55 * (1 - weather.rain * 0.4);
  if (pools) pools.visible = night > 0.02;

  updateCars(dt, trafficAt(t), night);
  // people show up a little before the cars and linger a little later
  updatePedestrians(dt, Math.min(1, trafficAt(t - 0.02) * 1.15));
  applyTime(t, weather);
  updateNightSky(t, weather.overcast);
  updateRain(dt, weather.rain);
  for (const m of cloudMats) m.color.copy(CLOUD_CLEAR).lerp(CLOUD_OVERCAST, weather.overcast);

  for (let i = ghosts.length - 1; i >= 0; i--) {
    ghosts[i].w -= dt * ATTN_DECAY;
    if (ghosts[i].w <= 0) ghosts.splice(i, 1);
  }

  if (idleTimer > 0) {
    idleTimer += dt;
    if (idleTimer > 6) { controls.autoRotate = true; idleTimer = 0; }
  }
  driveCamera(dt);
  controls.update();
  renderer.render(scene, camera);

  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) {
    fps = Math.round(fpsN / fpsAcc);
    el.clock.textContent = clockLabel(t);
    fpsAcc = 0; fpsN = 0;
  }

  requestAnimationFrame(tick);
}

// local-only inspection hook; the smoke tests read this
window.__city = () => ({
  files: files.size,
  dirty: [...files.values()].filter(f => f.dirty).length,
  growing: [...files.values()].filter(f => f.grown < 1).length,
  dying: [...files.values()].filter(f => f.dying).length,
  cranes: [...buildings.values()].filter(b => b.crane.visible).length,
  lit: [...buildings.values()].filter(b => b.lit > 0.4).length,
  minGrown: Math.min(...[...files.values()].map(f => f.grown)),
  dust: dust.length,
  smoke: dust.filter(p => p.k).length,
  districts: layout.districts,
  cars: traffic.reduce((n, t) => n + t.mesh.count, 0),
  lamps: pools ? pools.count : 0,
  signs: signCount,
  attn: [...files.values()].filter(f => f.attn > 0).length + ghosts.length,
  camDist: +camera.position.distanceTo(controls.target).toFixed(1),
  homeDist: +homeDist.toFixed(1),
  night: +nightK(frozenT ?? dayT(Date.now())).toFixed(2),
  peds: peds ? peds.count : 0,
  fps,
});
// freeze the clock at a fixed hour for screenshots; pass null to resume
window.__time = (t) => { frozenT = t; };
window.__toggle = (what) => {
  if (what === "dust") dustPoints.visible = !dustPoints.visible;
  if (what === "cars") for (const t of traffic) t.mesh.visible = !t.mesh.visible;
  if (what === "clouds") cloudsOn = !cloudsOn;
  if (what === "city") cityRoot.visible = !cityRoot.visible;
  if (what === "ground") groundRoot.visible = !groundRoot.visible;
};

frameCamera();
applyTime(dayT(Date.now()), weatherAt(dayIndex(Date.now())));
requestAnimationFrame(tick);
