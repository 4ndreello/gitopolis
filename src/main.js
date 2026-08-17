import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  GUT, FLOOR_H, MAX_FLOORS,
  hash, rand01, dirKey, extOf, floorsOf, isHouse, planCity,
  dayT, dayIndex, clockLabel, litAt, trafficAt, weatherAt,
} from "./city.js";

// ============================================================
// state: one entry per file on disk. animation fields live here and
// nowhere else — the city itself is never persisted.
// ============================================================
const files = new Map(); // path -> { path, bytes, target, dirty, grown, dying, flash }
let layout = planCity([]);
let layoutDirty = true;

function ingest(snapshot) {
  const seen = new Set();
  for (const inc of snapshot.files) {
    seen.add(inc.path);
    const cur = files.get(inc.path);
    if (!cur) {
      // brand new: rises from nothing, scaffolding first
      files.set(inc.path, {
        path: inc.path, bytes: Math.max(96, inc.bytes), target: inc.bytes,
        dirty: inc.dirty, grown: 0, dying: 0, flash: 0,
      });
      layoutDirty = true;
      continue;
    }
    if (cur.dying) { cur.dying = 0; cur.grown = Math.max(0.05, cur.grown); }
    if (Math.abs(cur.target - inc.bytes) > 0) {
      if (floorsOf(cur.target) !== floorsOf(inc.bytes)) cur.flash = 1;
      cur.target = inc.bytes;
    }
    cur.dirty = inc.dirty;
  }
  for (const [path, f] of files) {
    if (!seen.has(path) && !f.dying) f.dying = 0.001;
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
const carMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.35 });
const CAR_COLORS = [0xd8d8dc, 0x2f3540, 0xa33c33, 0x2c5f8a, 0xc9a24a, 0x5d6b53, 0x8f8f96];
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
const GEO_CAR = new THREE.BoxGeometry(0.2, 0.13, 0.4);

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
    ? new THREE.Mesh(GEO_PYR, tileRoofMats[(seed >> 3) % tileRoofMats.length])
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
    const mh = h + 1.5;
    b.crane.rotation.y = b.spin + clock * 0.12;
    b.crane.children[0].scale.set(1, mh, 1);
    b.crane.children[0].position.set(b.w * 0.75, mh / 2, b.d * 0.75);
    b.crane.children[1].scale.set(1.9, 0.045, 0.045);
    b.crane.children[1].position.set(b.w * 0.75 + 0.45, mh, b.d * 0.75);
    b.crane.children[2].scale.set(0.12, 0.12, 0.12);
    b.crane.children[2].position.set(b.w * 0.75, mh - 0.12, b.d * 0.75);
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
function rebuildGround() {
  groundRoot.clear();

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
  const parkBlocks = layout.blocks.filter(b => b.park);
  const cityBlocks = layout.blocks.filter(b => !b.park);
  const curbs = new THREE.InstancedMesh(GEO_BOX, curbMat, layout.blocks.length);
  const plates = new THREE.InstancedMesh(GEO_BOX, plateMat, Math.max(1, cityBlocks.length));
  const parks = new THREE.InstancedMesh(GEO_BOX, parkMat, Math.max(1, parkBlocks.length));
  for (const im of [curbs, plates, parks]) { im.receiveShadow = true; im.castShadow = false; }
  plates.count = cityBlocks.length;
  parks.count = parkBlocks.length;

  const m = new THREE.Matrix4();
  const place = (blk) => {
    const size = blk.size;
    const cx = blk.bx + (size - 1) / 2 - layout.gw / 2;
    const cz = blk.by + (size - 1) / 2 - layout.gh / 2;
    return { size, cx, cz };
  };
  layout.blocks.forEach((blk, i) => {
    const { size, cx, cz } = place(blk);
    m.makeScale(size + 0.62, 0.11, size + 0.62);
    m.setPosition(cx, 0.028, cz);
    curbs.setMatrixAt(i, m);
  });
  cityBlocks.forEach((blk, i) => {
    const { size, cx, cz } = place(blk);
    m.makeScale(size + 0.24, 0.14, size + 0.24);
    m.setPosition(cx, 0.04, cz);
    plates.setMatrixAt(i, m);
  });
  parkBlocks.forEach((blk, i) => {
    const { size, cx, cz } = place(blk);
    m.makeScale(size + 0.24, 0.14, size + 0.24);
    m.setPosition(cx, 0.04, cz);
    parks.setMatrixAt(i, m);
  });
  for (const im of [curbs, plates, parks]) im.instanceMatrix.needsUpdate = true;
  groundRoot.add(curbs, plates, parks);

  rebuildTrees();
  rebuildCars();
  rebuildPedestrians();
}

function rebuildTrees() {
  const spots = layout.empty.filter((s, i) => s.park || i % 3 === 0).slice(0, 420);
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

// traffic: movement on the ground is what stops it reading as a model kit
let cars = null;
function rebuildCars() {
  if (cars) { scene.remove(cars); cars = null; }
  const lanes = [];
  const stride = layout.block + GUT;
  for (let r = 1; r < layout.drows; r++) {
    const z = r * stride - GUT / 2 - layout.gh / 2;
    lanes.push({ axis: "x", at: z - 0.3, dir: 1 }, { axis: "x", at: z + 0.3, dir: -1 });
  }
  for (let c = 1; c < layout.dcols; c++) {
    const x = c * stride - GUT / 2 - layout.gw / 2;
    lanes.push({ axis: "z", at: x - 0.3, dir: -1 }, { axis: "z", at: x + 0.3, dir: 1 });
  }
  if (!lanes.length) return;

  const count = Math.min(90, lanes.length * 4);
  cars = new THREE.InstancedMesh(GEO_CAR, carMat, count);
  cars.castShadow = true;
  cars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const col = new THREE.Color();
  cars.userData.items = [];
  for (let i = 0; i < count; i++) {
    const lane = lanes[i % lanes.length];
    const span = lane.axis === "x" ? layout.gw + 3 : layout.gh + 3;
    cars.userData.items.push({ lane, span, t: rand01(i * 3.7) * span, speed: 1.6 + rand01(i * 7.3) * 1.8 });
    col.setHex(CAR_COLORS[i % CAR_COLORS.length]);
    cars.setColorAt(i, col);
  }
  if (cars.instanceColor) cars.instanceColor.needsUpdate = true;
  scene.add(cars);
}

const _cm = new THREE.Matrix4();
function updateCars(dt, density) {
  if (!cars) return;
  const items = cars.userData.items;
  // spare instances are hidden with count, never makeScale(0,0,0): a zero scale
  // gives a singular normal matrix and the driver draws garbage triangles
  cars.count = Math.max(0, Math.round(items.length * density));
  const pace = 0.35 + density * 0.9;
  for (let i = 0; i < cars.count; i++) {
    const it = items[i];
    it.t += it.speed * pace * dt;
    if (it.t > it.span) it.t -= it.span;
    const p = it.t - it.span / 2;
    if (it.lane.axis === "x") {
      _cm.makeRotationY(it.lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
      _cm.setPosition(p * it.lane.dir, 0.07, it.lane.at);
    } else {
      _cm.makeRotationY(it.lane.dir > 0 ? 0 : Math.PI);
      _cm.setPosition(it.lane.at, 0.07, p * it.lane.dir);
    }
    cars.setMatrixAt(i, _cm);
  }
  cars.instanceMatrix.needsUpdate = true;
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
// overcast now tints the puffs grey instead of fading them, so there is no
// transparency to sort.
// ============================================================
const GEO_PUFF = new THREE.IcosahedronGeometry(1, 0);
const CLOUD_Y = 12;                     // floor of the deck; tallest tower is under 5
const CLOUD_CLEAR = new THREE.Color(0xf7f9fb);
const CLOUD_OVERCAST = new THREE.Color(0xa8b3bf);
const cloudMat = new THREE.MeshLambertMaterial({ color: 0xf7f9fb, flatShading: true, fog: false });
const clouds = [];
let cloudsOn = true;   // flipped by window.__toggle("clouds")
for (let i = 0; i < 8; i++) {
  const g = new THREE.Group();
  const s = 9 + rand01(i * 4.4) * 13;
  const puffs = 4 + Math.floor(rand01(i * 1.9) * 3);
  for (let j = 0; j < puffs; j++) {
    const p = new THREE.Mesh(GEO_PUFF, cloudMat);
    const r = s * (0.20 + rand01(i * 7 + j * 3.7) * 0.16);
    p.scale.set(r, r * 0.62, r);      // squashed: a sphere reads as a balloon
    p.position.set(
      (rand01(i * 5 + j * 2.1) - 0.5) * s * 0.9,
      (rand01(i * 3 + j * 8.3) - 0.5) * s * 0.16,
      (rand01(i * 11 + j * 4.9) - 0.5) * s * 0.6
    );
    // spin each puff so the 20 facets do not line up across the cluster
    p.rotation.set(rand01(i + j * 2.7) * 3, rand01(i + j * 5.3) * 3, 0);
    p.castShadow = true;
    g.add(p);
  }
  // ponytail: cloud height is a tuning knob, not a derived value. the camera
  // looks down at the city and can only be dragged to ~6 degrees above the
  // horizon, so clouds parked high are simply never in frame.
  g.position.set(-80 + rand01(i * 2.2) * 160, CLOUD_Y + rand01(i * 8.1) * 7, -80 + rand01(i * 5.5) * 160);
  g.userData.speed = 0.5 + rand01(i * 6.7) * 0.8;
  scene.add(g);
  clouds.push(g);
}

// ============================================================
// dust
// ============================================================
const DUST_MAX = 900;
const dustPos = new Float32Array(DUST_MAX * 3);
const dust = [];
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
const dustPoints = new THREE.Points(dustGeo, new THREE.PointsMaterial({
  size: 0.3, color: 0xcfc7b8, transparent: true, opacity: 0.5, depthWrite: false,
}));
dustPoints.frustumCulled = false;
scene.add(dustPoints);

function spawnDust(x, y, z, n, spread) {
  for (let i = 0; i < n && dust.length < DUST_MAX; i++) {
    dust.push({
      x: x + (Math.random() - 0.5) * spread, y: y + Math.random() * 0.3, z: z + (Math.random() - 0.5) * spread,
      vx: (Math.random() - 0.5) * 0.9, vy: 0.5 + Math.random() * 1.1, vz: (Math.random() - 0.5) * 0.9,
      life: 1,
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

function frameCamera() {
  const r = Math.max(layout.gw, layout.gh) * 0.72 + 6;
  controls.target.set(0, Math.min(6, r * 0.1), 0);
  const polar = THREE.MathUtils.degToRad(90 - CAM_ANGLE);
  const dist = r / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.62;
  const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z) || 0.7;
  camera.position.set(
    controls.target.x + Math.sin(az) * dist * Math.sin(polar),
    controls.target.y + dist * Math.cos(polar),
    controls.target.z + Math.cos(az) * dist * Math.sin(polar)
  );
  controls.update();
  scene.fog.near = dist * 0.95;
  fogFar = dist * 4.2;
  scene.fog.far = fogFar;
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
};
function setStatus(text, ok) {
  el.status.textContent = text;
  el.status.dataset.ok = ok ? "1" : "0";
}

// switching repos does not clear local state on purpose: ingest already marks
// every vanished file as dying, so the old city crumbles while the new one
// rises under scaffolding. the transition comes for free.
let es = null;
function connect(name) {
  if (es) es.close();
  es = new EventSource(name ? `/events?repo=${encodeURIComponent(name)}` : "/events");
  es.onopen = () => setStatus("ligado", true);
  es.onerror = () => setStatus("sem conexão", false);
  es.onmessage = (ev) => {
    const snap = JSON.parse(ev.data);
    if (snap.error) { setStatus(snap.error, false); return; }
    setStatus("ligado", true);
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

  for (const [path, f] of files) {
    const beforeFloors = floorsOf(f.bytes);
    // snap once close: the asymptotic approach can park bytes exactly on a
    // floorsOf rounding boundary, which then flips every frame — spawning dust
    // forever and rebuilding the mesh 60x a second.
    f.bytes = Math.abs(f.target - f.bytes) < 1
      ? f.target
      : f.bytes + (f.target - f.bytes) * Math.min(1, dt * 3.2);
    if (floorsOf(f.bytes) !== beforeFloors) {
      const w = fileWorld(f);
      spawnDust(w.x, 0.2, w.z, 6, 1.1);
    }
    f.flash = Math.max(0, f.flash - dt * 1.5);
    if (f.flash > 0.95) {
      const w = fileWorld(f);
      fireFlash(w.x, w.y * 0.7 + 0.5, w.z);
    }
    if (f.grown < 1 && !f.dying) {
      f.grown = Math.min(1, f.grown + dt * 0.75);
      if (f.grown >= 1) {
        const w = fileWorld(f);
        spawnDust(w.x, 0.2, w.z, 10, 1.2);
      }
    }
    if (f.dying) {
      f.dying = Math.min(1, f.dying + dt * 1.5);
      if (f.dying === 0.001) {
        const w = fileWorld(f);
        spawnDust(w.x, 0.3, w.z, 26, 1.5);
      }
      if (f.dying >= 1) {
        disposeBuilding(path);
        files.delete(path);
        layoutDirty = true;
        continue;
      }
    }
    updateBuilding(f, t, dt);
  }

  let n = 0;
  for (let i = dust.length - 1; i >= 0; i--) {
    const p = dust[i];
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    p.vy -= dt * 1.5;
    p.life -= dt * 0.9;
    if (p.life <= 0) dust.splice(i, 1);
  }
  for (const p of dust) {
    dustPos[n * 3] = p.x; dustPos[n * 3 + 1] = p.y; dustPos[n * 3 + 2] = p.z;
    n++;
  }
  dustGeo.setDrawRange(0, n);
  dustGeo.attributes.position.needsUpdate = true;

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
  });

  updateCars(dt, trafficAt(t));
  // people show up a little before the cars and linger a little later
  updatePedestrians(dt, Math.min(1, trafficAt(t - 0.02) * 1.15));
  applyTime(t, weather);
  updateNightSky(t, weather.overcast);
  updateRain(dt, weather.rain);
  cloudMat.color.copy(CLOUD_CLEAR).lerp(CLOUD_OVERCAST, weather.overcast);

  if (idleTimer > 0) {
    idleTimer += dt;
    if (idleTimer > 6) { controls.autoRotate = true; idleTimer = 0; }
  }
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
  districts: layout.districts,
  cars: cars ? cars.count : 0,
  peds: peds ? peds.count : 0,
  fps,
});
// freeze the clock at a fixed hour for screenshots; pass null to resume
window.__time = (t) => { frozenT = t; };
window.__toggle = (what) => {
  if (what === "dust") dustPoints.visible = !dustPoints.visible;
  if (what === "cars") cars.visible = !cars.visible;
  if (what === "clouds") cloudsOn = !cloudsOn;
  if (what === "city") cityRoot.visible = !cityRoot.visible;
  if (what === "ground") groundRoot.visible = !groundRoot.visible;
};

frameCamera();
applyTime(dayT(Date.now()), weatherAt(dayIndex(Date.now())));
requestAnimationFrame(tick);
