// Original street furniture: curved-arm streetlights, lathe fire hydrants,
// slat benches, fluted trash cans, lidded dumpsters, mast-arm traffic
// lights, utility poles. Each kind returns parts [{ geo, mat, castShadow }]
// that citymesh instances; the same geometry doubles as knockable debris.

import * as THREE from 'three';
import { mergeGeometries as mergeBG } from '../../vendor/jsm/utils/BufferGeometryUtils.js';

const grey = new THREE.MeshLambertMaterial({ color: 0x62676e });
const darkGrey = new THREE.MeshLambertMaterial({ color: 0x393d43 });
const hydrantRed = new THREE.MeshLambertMaterial({ color: 0xb03227 });
const wood = new THREE.MeshLambertMaterial({ color: 0x8a6a48 });
const ironGreen = new THREE.MeshLambertMaterial({ color: 0x2e4436 });
const dumpGreen = new THREE.MeshLambertMaterial({ color: 0x3e5e46 });
const poleBrown = new THREE.MeshLambertMaterial({ color: 0x6a5138 });

function streetlight() {
  // tapered pole with a curved arm sweeping over the road
  const pole = new THREE.CylinderGeometry(0.07, 0.12, 6.9, 7);
  pole.translate(0, 3.45, 0);
  const base = new THREE.CylinderGeometry(0.16, 0.2, 0.5, 7);
  base.translate(0, 0.25, 0);
  // arm: 4-segment arc
  const armSegs = [];
  for (let i = 0; i < 4; i++) {
    const t0 = i / 4, t1 = (i + 1) / 4;
    const x0 = t0 * 1.5, x1 = t1 * 1.5;
    const y0 = 6.9 + Math.sin(t0 * 1.4) * 0.55 - t0 * 0.1;
    const y1 = 6.9 + Math.sin(t1 * 1.4) * 0.55 - t1 * 0.1;
    const seg = new THREE.CylinderGeometry(0.05, 0.055, Math.hypot(x1 - x0, y1 - y0) + 0.02, 5);
    seg.rotateZ(Math.PI / 2 - Math.atan2(y1 - y0, x1 - x0));
    seg.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
    armSegs.push(seg);
  }
  return [{ geo: mergeBG([pole, base, ...armSegs], false), mat: grey, castShadow: true }];
}

function hydrant() {
  // classic lathe: dome cap, barrel, flange, side nozzles
  const pts = [
    new THREE.Vector2(0.0, 0.86), new THREE.Vector2(0.07, 0.84), new THREE.Vector2(0.12, 0.78),
    new THREE.Vector2(0.14, 0.7), new THREE.Vector2(0.15, 0.58), new THREE.Vector2(0.15, 0.3),
    new THREE.Vector2(0.17, 0.26), new THREE.Vector2(0.17, 0.18), new THREE.Vector2(0.2, 0.12),
    new THREE.Vector2(0.2, 0.0),
  ];
  pts.reverse();   // lathe profiles must run bottom-up for outward normals
  const body = new THREE.LatheGeometry(pts, 9);
  const cap = new THREE.CylinderGeometry(0.045, 0.06, 0.07, 6);
  cap.translate(0, 0.88, 0);
  const noz1 = new THREE.CylinderGeometry(0.055, 0.055, 0.14, 6);
  noz1.rotateZ(Math.PI / 2); noz1.translate(0.18, 0.52, 0);
  const noz2 = noz1.clone(); noz2.rotateY(Math.PI);
  const noz3 = new THREE.CylinderGeometry(0.05, 0.05, 0.13, 6);
  noz3.rotateX(Math.PI / 2); noz3.translate(0, 0.52, 0.17);
  return [{ geo: mergeBG([body, cap, noz1, noz2, noz3], false), mat: hydrantRed, castShadow: true }];
}

function bench() {
  const parts = [];
  for (let i = 0; i < 4; i++) {          // seat slats
    const s = new THREE.BoxGeometry(2.1, 0.045, 0.13);
    s.translate(0, 0.52, -0.21 + i * 0.14);
    parts.push(s);
  }
  for (let i = 0; i < 3; i++) {          // back slats
    const s = new THREE.BoxGeometry(2.1, 0.11, 0.04);
    s.translate(0, 0.66 + i * 0.16, -0.3);
    parts.push(s);
  }
  const legs = [];
  for (const sx of [-0.88, 0.88]) {
    const leg = new THREE.BoxGeometry(0.07, 0.52, 0.5);
    leg.translate(sx, 0.26, -0.05);
    const back = new THREE.BoxGeometry(0.07, 0.62, 0.06);
    back.rotateX(-0.15);
    back.translate(sx, 0.75, -0.31);
    legs.push(leg, back);
  }
  return [
    { geo: mergeBG(parts, false), mat: wood, castShadow: true },
    { geo: mergeBG(legs, false), mat: ironGreen, castShadow: false },
  ];
}

function trashcan() {
  // fluted barrel
  const body = new THREE.CylinderGeometry(0.3, 0.26, 0.86, 12);
  body.translate(0, 0.43, 0);
  const rim = new THREE.TorusGeometry(0.3, 0.03, 5, 12);
  rim.rotateX(Math.PI / 2); rim.translate(0, 0.87, 0);
  const bands = [];
  for (const y of [0.2, 0.55]) {
    const b = new THREE.TorusGeometry(0.295, 0.018, 4, 12);
    b.rotateX(Math.PI / 2); b.translate(0, y, 0);
    bands.push(b);
  }
  return [{ geo: mergeBG([body, rim, ...bands], false), mat: darkGrey, castShadow: true }];
}

function dumpster() {
  const body = new THREE.BoxGeometry(2.3, 1.15, 1.4);
  body.translate(0, 0.72, 0);
  const lid = new THREE.BoxGeometry(2.34, 0.09, 1.46);
  lid.rotateX(-0.12);
  lid.translate(0, 1.36, -0.05);
  const rail = new THREE.BoxGeometry(2.4, 0.12, 0.1);
  rail.translate(0, 0.62, 0.76);
  const wheels = [];
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const w = new THREE.CylinderGeometry(0.09, 0.09, 0.08, 7);
    w.rotateZ(Math.PI / 2);
    w.translate(sx * 1.0, 0.1, sz * 0.58);
    wheels.push(w);
  }
  return [
    { geo: mergeBG([body, lid, rail], false), mat: dumpGreen, castShadow: true },
    { geo: mergeBG(wheels, false), mat: darkGrey, castShadow: false },
  ];
}

function trafficlight() {
  const pole = new THREE.CylinderGeometry(0.07, 0.1, 5.2, 7);
  pole.translate(0, 2.6, 0);
  // mast arm reaching over the lane
  const arm = new THREE.CylinderGeometry(0.05, 0.06, 2.6, 5);
  arm.rotateZ(Math.PI / 2);
  arm.translate(1.25, 5.05, 0);
  const housing = new THREE.BoxGeometry(0.26, 0.78, 0.24);
  housing.translate(2.35, 4.62, 0);
  const housing2 = new THREE.BoxGeometry(0.24, 0.7, 0.22);
  housing2.translate(0, 4.9, 0);
  const structure = [{ geo: mergeBG([pole, arm, housing, housing2], false), mat: darkGrey, castShadow: true }];
  // lenses (emissive, night-boosted by citymesh like lamp heads)
  const lenses = [];
  for (const [hx, hy] of [[2.35, 4.62], [0, 4.9]]) {
    for (let i = 0; i < 3; i++) {
      const l = new THREE.CircleGeometry(0.055, 8);
      l.translate(hx, hy + 0.24 - i * 0.24, 0.13);
      lenses.push(l);
    }
  }
  structure.push({
    geo: mergeBG(lenses, false),
    mat: new THREE.MeshLambertMaterial({ color: 0x552211, emissive: 0xcc5522, emissiveIntensity: 0.35 }),
    castShadow: false,
    nightKey: 'signalLens',   // citymesh boosts this after dark
  });
  return structure;
}

function utilitypole() {
  const pole = new THREE.CylinderGeometry(0.09, 0.12, 7.6, 6);
  pole.translate(0, 3.8, 0);
  const cross = new THREE.BoxGeometry(1.7, 0.09, 0.09);
  cross.translate(0, 7.05, 0);
  const cross2 = new THREE.BoxGeometry(1.3, 0.08, 0.08);
  cross2.translate(0, 6.55, 0);
  const pins = [];
  for (const x of [-0.75, -0.3, 0.3, 0.75]) {
    const p = new THREE.CylinderGeometry(0.025, 0.025, 0.14, 4);
    p.translate(x, 7.16, 0);
    pins.push(p);
  }
  const tf = new THREE.CylinderGeometry(0.16, 0.16, 0.5, 7);   // transformer can
  tf.translate(0.42, 6.0, 0);
  return [{ geo: mergeBG([pole, cross, cross2, tf, ...pins], false), mat: poleBrown, castShadow: true }];
}

export function buildPropLibrary() {
  return {
    lamp: streetlight(),
    hydrant: hydrant(),
    bench: bench(),
    trash: trashcan(),
    dumpster: dumpster(),
    trafficlight: trafficlight(),
    utilitypole: utilitypole(),
  };
}
