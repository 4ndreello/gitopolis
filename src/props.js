// procedural props: vehicles, lamp posts, street furniture, road paint.
// geometry factories only — no scene, no state, no animation. main.js places
// and animates what this file builds.
//
// every prop is a merge of boxes and cylinders into ONE geometry per type, so a
// hundred cars stay one draw call. two tricks carry the whole file:
//
//   vertex colour  — instanceColor multiplies it, so a white body takes the
//                    per-car tint while dark wheels and glass stay dark.
//   glow uv        — every vertex is pinned to one texel of a 3-pixel strip
//                    (unlit / white / red). that strip is the emissiveMap, so
//                    raising emissiveIntensity lights only the headlights and
//                    the lamp heads. same mechanism as the building windows.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const BODY = 0xffffff;      // takes the per-instance tint
const DARK = 0x24282e;      // tyres, poles
const GLASS = 0x39434f;
const METAL = 0x4a5058;

const GLOW_OFF = 0, GLOW_WHITE = 1, GLOW_RED = 2;

function mkGlowTex() {
  const c = document.createElement("canvas");
  c.width = 3; c.height = 1;
  const g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, 1, 1);
  g.fillStyle = "#fff"; g.fillRect(1, 0, 1, 1);
  g.fillStyle = "#ff5a3c"; g.fillRect(2, 0, 1, 1);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export const TEX_GLOW = mkGlowTex();

const _c = new THREE.Color();
// one part of a prop. `g` overrides the default box (used for cylinders, which
// must be sized at construction because rotating a scaled box is not a wheel).
function part({ g, w = 1, h = 1, d = 1, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, color = BODY, glow = GLOW_OFF }) {
  const geo = g ? g.clone() : new THREE.BoxGeometry(w, h, d);
  if (rx) geo.rotateX(rx);
  if (ry) geo.rotateY(ry);
  if (rz) geo.rotateZ(rz);
  geo.translate(x, y, z);

  const n = geo.attributes.position.count;
  _c.set(color);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));

  // collapse the uvs onto a single texel of the 3-pixel glow strip
  const uv = geo.attributes.uv;
  const u = (glow + 0.5) / 3;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u, 0.5);
  uv.needsUpdate = true;
  return geo;
}

const merge = (parts) => mergeGeometries(parts.map(part));

// wheels: a cylinder laid on its side. 6 sides is enough at this camera range
// and keeps the flat-shaded look of the cone trees and box buildings.
const wheel = (r, w) => new THREE.CylinderGeometry(r, r, w, 6);
const tyre = (g, x, y, z) => ({ g, x, y, z, rz: Math.PI / 2, color: DARK });

// vehicles point along +z: the traffic loop rotates that onto the lane axis.
// all of them sit with y = 0 on the road surface.
export const GEO_CAR = merge([
  tyre(wheel(0.055, 0.05), -0.1, 0.055, 0.14), tyre(wheel(0.055, 0.05), 0.1, 0.055, 0.14),
  tyre(wheel(0.055, 0.05), -0.1, 0.055, -0.14), tyre(wheel(0.055, 0.05), 0.1, 0.055, -0.14),
  { w: 0.2, h: 0.1, d: 0.42, y: 0.105 },
  { w: 0.175, h: 0.08, d: 0.19, y: 0.195, z: -0.02, color: GLASS },
  { w: 0.04, h: 0.025, d: 0.02, x: -0.06, y: 0.13, z: 0.212, glow: GLOW_WHITE },
  { w: 0.04, h: 0.025, d: 0.02, x: 0.06, y: 0.13, z: 0.212, glow: GLOW_WHITE },
  { w: 0.035, h: 0.022, d: 0.02, x: -0.065, y: 0.13, z: -0.212, glow: GLOW_RED },
  { w: 0.035, h: 0.022, d: 0.02, x: 0.065, y: 0.13, z: -0.212, glow: GLOW_RED },
]);

export const GEO_VAN = merge([
  tyre(wheel(0.06, 0.05), -0.105, 0.06, 0.16), tyre(wheel(0.06, 0.05), 0.105, 0.06, 0.16),
  tyre(wheel(0.06, 0.05), -0.105, 0.06, -0.16), tyre(wheel(0.06, 0.05), 0.105, 0.06, -0.16),
  { w: 0.22, h: 0.19, d: 0.5, y: 0.155 },
  { w: 0.2, h: 0.06, d: 0.015, y: 0.2, z: 0.251, color: GLASS },
  { w: 0.015, h: 0.06, d: 0.12, x: -0.111, y: 0.2, z: 0.1, color: GLASS },
  { w: 0.015, h: 0.06, d: 0.12, x: 0.111, y: 0.2, z: 0.1, color: GLASS },
  { w: 0.04, h: 0.025, d: 0.02, x: -0.075, y: 0.095, z: 0.252, glow: GLOW_WHITE },
  { w: 0.04, h: 0.025, d: 0.02, x: 0.075, y: 0.095, z: 0.252, glow: GLOW_WHITE },
  { w: 0.035, h: 0.03, d: 0.02, x: -0.08, y: 0.13, z: -0.252, glow: GLOW_RED },
  { w: 0.035, h: 0.03, d: 0.02, x: 0.08, y: 0.13, z: -0.252, glow: GLOW_RED },
]);

export const GEO_TRUCK = merge([
  tyre(wheel(0.06, 0.05), -0.11, 0.06, 0.22), tyre(wheel(0.06, 0.05), 0.11, 0.06, 0.22),
  tyre(wheel(0.06, 0.05), -0.11, 0.06, -0.05), tyre(wheel(0.06, 0.05), 0.11, 0.06, -0.05),
  tyre(wheel(0.06, 0.05), -0.11, 0.06, -0.19), tyre(wheel(0.06, 0.05), 0.11, 0.06, -0.19),
  { w: 0.23, h: 0.17, d: 0.2, y: 0.145, z: 0.2 },
  { w: 0.21, h: 0.06, d: 0.015, y: 0.185, z: 0.297, color: GLASS },
  { w: 0.25, h: 0.22, d: 0.42, y: 0.17, z: -0.09 },
  { w: 0.04, h: 0.025, d: 0.02, x: -0.08, y: 0.085, z: 0.302, glow: GLOW_WHITE },
  { w: 0.04, h: 0.025, d: 0.02, x: 0.08, y: 0.085, z: 0.302, glow: GLOW_WHITE },
  { w: 0.035, h: 0.03, d: 0.02, x: -0.09, y: 0.12, z: -0.301, glow: GLOW_RED },
  { w: 0.035, h: 0.03, d: 0.02, x: 0.09, y: 0.12, z: -0.301, glow: GLOW_RED },
]);

// the arm reaches along +x; instances are turned so it hangs over the road.
// thin on purpose: a post as chunky as a car reads as a totem, and next to a
// 0.24-tall car this one is already only half the height a real lamp would be.
export const GEO_LAMP = merge([
  { g: new THREE.CylinderGeometry(0.013, 0.019, 0.66, 6), y: 0.33, color: METAL },
  { w: 0.17, h: 0.018, d: 0.018, x: 0.085, y: 0.655, color: METAL },
  { w: 0.085, h: 0.032, d: 0.05, x: 0.155, y: 0.632, color: 0xdfd8c8, glow: GLOW_WHITE },
]);

export const GEO_BUSSTOP = merge([
  { w: 0.028, h: 0.46, d: 0.028, x: -0.2, y: 0.23, color: METAL },
  { w: 0.028, h: 0.46, d: 0.028, x: 0.2, y: 0.23, color: METAL },
  { w: 0.5, h: 0.03, d: 0.26, y: 0.475, color: METAL },
  { w: 0.46, h: 0.3, d: 0.015, y: 0.3, z: -0.11, color: GLASS },
  { w: 0.42, h: 0.04, d: 0.09, y: 0.13, z: -0.04, color: 0x7a6a52 },
]);

export const GEO_BIN = merge([
  { g: new THREE.CylinderGeometry(0.035, 0.03, 0.11, 6), y: 0.055, color: 0x6d7a70 },
  { g: new THREE.CylinderGeometry(0.04, 0.04, 0.015, 6), y: 0.117, color: 0x8b9299 },
]);

export const GEO_HYDRANT = merge([
  { w: 0.04, h: 0.1, d: 0.04, y: 0.05, color: 0xb04a41 },
  { w: 0.09, h: 0.025, d: 0.025, y: 0.078, color: 0xb04a41 },
  { g: new THREE.CylinderGeometry(0.025, 0.025, 0.025, 6), y: 0.112, color: 0xb04a41 },
]);

export const GEO_SIGNPOST = merge([
  { g: new THREE.CylinderGeometry(0.016, 0.016, 0.52, 5), y: 0.26, color: METAL },
]);

// street signs are the one prop with per-instance text, so they are the one
// prop that allocates a texture per rebuild. main.js disposes them.
export function mkSignTex(name) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#2f6b4f"; g.fillRect(0, 0, 256, 64);
  g.strokeStyle = "#e8efe9"; g.lineWidth = 4;
  g.strokeRect(6, 6, 244, 52);
  g.fillStyle = "#e8efe9";
  g.font = "bold 30px monospace";
  g.textAlign = "center"; g.textBaseline = "middle";
  const label = name.length > 14 ? name.slice(-14) : name;
  g.fillText(label.toUpperCase(), 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---- road paint ----
// one tile is one world unit along the road and the full road width across, so
// a strip repeats by scaling its uv.x — no per-road texture clone to dispose.
// the strip is only as wide as the visible asphalt (ROAD_W in main.js): drawn
// the full gutter width, both edge lines vanished under the curb overhang.
export function mkRoadTex() {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 96;
  const g = c.getContext("2d");
  g.fillStyle = "#34383f"; g.fillRect(0, 0, 128, 96);
  // the road is only ROAD_W (0.73) wide, so a 2px line on a 96px tile came out
  // 1.5cm across and vanished next to the kerb. paint has to be fat here.
  g.fillStyle = "#b9bdb0";
  g.fillRect(0, 6, 128, 5);          // edge lines, a hair inside the kerb
  g.fillRect(0, 85, 128, 5);
  g.fillStyle = "#d8dccd";
  g.fillRect(34, 43, 60, 9);         // centre dash
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// stripes run along the direction of travel, so they repeat across the quad's u
export function mkZebraTex() {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 64;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 128, 64);
  g.fillStyle = "#d5d9cb";
  for (let i = 0; i < 5; i++) g.fillRect(8 + i * 24, 4, 13, 56);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// the pool of light a lamp throws. additive, so it must fade to zero alpha at
// the rim or the quad's edge shows as a square on the asphalt.
export function mkPoolTex() {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,226,168,0.85)");
  grad.addColorStop(0.45, "rgba(255,214,140,0.32)");
  grad.addColorStop(1, "rgba(255,200,120,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---- tower floodlights ----
// four fixtures on the pavement at the foot of a tower, lens turned up at the
// wall. the positions sit on a UNIT square, so main.js scales the merged
// geometry by the building footprint and each one lands just outside its own
// wall, whatever that building's width happens to be.
//
// ponytail: that scale is non-uniform (w != d), so the boxes get squeezed by up
// to ~10% across the range of footprints. invisible at this size; the fix, if
// it ever is not, is four separate meshes instead of one merged one.
const floodAt = (x, z, ry = 0) => [
  { w: 0.085, h: 0.05, d: 0.06, x, y: 0.025, z, ry, color: METAL },
  { w: 0.062, h: 0.012, d: 0.038, x, y: 0.056, z, ry, color: 0xdfd8c8, glow: GLOW_WHITE },
];
export const GEO_FLOOD = merge([
  ...floodAt(0, 0.57), ...floodAt(0, -0.57),
  ...floodAt(0.57, 0, Math.PI / 2), ...floodAt(-0.57, 0, Math.PI / 2),
]);

// the light those fixtures throw: four quads hugging the walls, unit cube, open
// top and bottom. this is the one geometry in the file that does NOT go through
// part() — it is textured by a gradient, and part() collapses every uv onto a
// single texel of the glow strip.
const washQuad = (ry, x, z) => {
  const g = new THREE.PlaneGeometry(1, 1);
  if (ry) g.rotateY(ry);
  g.translate(x, 0.5, z);
  return g;
};
export const GEO_WASH = mergeGeometries([
  washQuad(0, 0, 0.5),
  washQuad(Math.PI, 0, -0.5),
  washQuad(Math.PI / 2, 0.5, 0),
  washQuad(-Math.PI / 2, -0.5, 0),
]);

// the wash itself. additive like the lamp pools, so it must reach zero alpha on
// three sides: at the top, where the beam runs out, and on both edges, or the
// quad reads as a lit rectangle taped to the wall instead of a beam.
export function mkWashTex() {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 128;
  const g = c.getContext("2d");
  const up = g.createLinearGradient(0, 128, 0, 0);
  up.addColorStop(0, "rgba(255,255,255,0.92)");
  up.addColorStop(0.3, "rgba(255,255,255,0.36)");
  up.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = up;
  g.fillRect(0, 0, 64, 128);

  const side = g.createLinearGradient(0, 0, 64, 0);
  side.addColorStop(0, "rgba(0,0,0,0)");
  side.addColorStop(0.5, "rgba(0,0,0,1)");
  side.addColorStop(1, "rgba(0,0,0,0)");
  g.globalCompositeOperation = "destination-in";
  g.fillStyle = side;
  g.fillRect(0, 0, 64, 128);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// the puddle each fixture throws on the paving. y is baked at 0.115 — just
// above the 0.11 top of the block plate — because main.js scales this mesh by
// the footprint on x and z only, and a horizontal quad does not care about y.
const poolQuad = (x, z) => {
  const g = new THREE.PlaneGeometry(0.46, 0.46).rotateX(-Math.PI / 2);
  g.translate(x, 0.115, z);
  return g;
};
export const GEO_FLOODPOOL = mergeGeometries([
  poolQuad(0, 0.57), poolQuad(0, -0.57), poolQuad(0.57, 0), poolQuad(-0.57, 0),
]);
