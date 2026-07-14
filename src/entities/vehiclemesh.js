// Original procedural vehicle bodies. Each car is ONE beveled extrusion of a
// hand-tuned side profile — wheel arches are cut straight into the outline,
// so hood/roof/trunk curvature and wheel wells come from a single geometry —
// plus an inset smoked-glass greenhouse, bumpers, mirrors, plates, lights
// and per-type extras (taxi sign, lightbars, ladder, bus glass band...).
// Clearcoat paint on medium/high quality, Lambert on low.

import * as THREE from 'three';

// ---- shared resources (never disposed per-vehicle) ------------------------
export const SHARED_MATS = new Set();
export const SHARED_GEOS = new Set();

const glassMat = new THREE.MeshLambertMaterial({ color: 0x131c26 });
const tireMat = new THREE.MeshLambertMaterial({ color: 0x14161a });
const trimMat = new THREE.MeshLambertMaterial({ color: 0x1e2126 });
const steelMat = new THREE.MeshLambertMaterial({ color: 0xb8bec4 });
const wellMat = new THREE.MeshLambertMaterial({ color: 0x0c0d10, side: THREE.DoubleSide });
SHARED_MATS.add(glassMat).add(tireMat).add(trimMat).add(steelMat).add(wellMat);

let rimMat = null;
function getRimMat() {
  if (rimMat) return rimMat;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#15171a';
  x.fillRect(0, 0, 64, 64);
  x.fillStyle = '#a9adb4';
  x.beginPath(); x.arc(32, 32, 22, 0, 7); x.fill();
  x.fillStyle = '#2a2d33';
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    x.beginPath(); x.arc(32 + Math.cos(a) * 12, 32 + Math.sin(a) * 12, 4.6, 0, 7); x.fill();
  }
  x.beginPath(); x.arc(32, 32, 4.5, 0, 7); x.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  rimMat = new THREE.MeshLambertMaterial({ color: 0xffffff, map: tex });
  SHARED_MATS.add(rimMat);
  return rimMat;
}

let plateMat = null;
function getPlateMat() {
  if (plateMat) return plateMat;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 32;
  const x = c.getContext('2d');
  x.fillStyle = '#e8e2c8';
  x.fillRect(0, 0, 128, 32);
  x.strokeStyle = '#3a4a8a'; x.lineWidth = 3;
  x.strokeRect(2, 2, 124, 28);
  x.fillStyle = '#22283a';
  x.font = 'bold 17px monospace';
  x.textAlign = 'center';
  x.fillText('BAY·VALE', 64, 23);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  plateMat = new THREE.MeshLambertMaterial({ color: 0xffffff, map: tex });
  SHARED_MATS.add(plateMat);
  return plateMat;
}

const wheelGeoCache = new Map();   // "r|w" → { tire, rim }
function wheelGeos(r, w) {
  const key = r.toFixed(2) + '|' + w.toFixed(2);
  let e = wheelGeoCache.get(key);
  if (!e) {
    const tire = new THREE.CylinderGeometry(r, r, w, 16);
    tire.rotateZ(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(r * 0.62, r * 0.62, w + 0.02, 12);
    rim.rotateZ(Math.PI / 2);
    e = { tire, rim };
    SHARED_GEOS.add(tire).add(rim);
    wheelGeoCache.set(key, e);
  }
  return e;
}

// ---------------------------------------------------------------- profiles
// All numbers are fractions: z of L (rear −0.5 … +0.5 front), y of H (0…1).
// The body outline runs bumper → trunk → roof → hood → nose, then back along
// the bottom cutting the two wheel arches.
const PROFILES = {
  sedan: {
    bottom: 0.21, tailTop: 0.46, trunk: [-0.42, 0.52], rearGlass: [-0.28, 0.55],
    roof: [[-0.15, 1.0], [0.10, 1.0]], windshield: [0.27, 0.56], hood: [0.415, 0.5],
    nose: 0.42, axle: 0.30, archR: 0.30,
  },
  sports: {
    bottom: 0.20, tailTop: 0.52, trunk: [-0.38, 0.62], rearGlass: [-0.34, 0.66],
    roof: [[-0.18, 1.0], [-0.02, 1.0]], windshield: [0.22, 0.52], hood: [0.40, 0.40],
    nose: 0.30, axle: 0.32, archR: 0.34,
  },
  pickup: {
    bottom: 0.20, tailTop: 0.42, trunk: [-0.44, 0.44], rearGlass: [-0.10, 0.44],
    roof: [[-0.06, 1.0], [0.16, 1.0]], windshield: [0.28, 0.58], hood: [0.40, 0.5],
    nose: 0.44, axle: 0.31, archR: 0.26,
  },
  van: {
    bottom: 0.17, tailTop: 0.94, trunk: [-0.49, 0.97], rearGlass: [-0.48, 0.98],
    roof: [[-0.44, 1.0], [0.16, 1.0]], windshield: [0.32, 0.52], hood: [0.42, 0.42],
    nose: 0.36, axle: 0.33, archR: 0.24,
  },
  bus: {
    bottom: 0.14, tailTop: 0.95, trunk: [-0.495, 0.98], rearGlass: [-0.49, 0.985],
    roof: [[-0.46, 1.0], [0.42, 1.0]], windshield: [0.465, 0.62], hood: [0.485, 0.5],
    nose: 0.42, axle: 0.34, archR: 0.115,
  },
  ambulance: {
    bottom: 0.16, tailTop: 0.92, trunk: [-0.49, 0.96], rearGlass: [-0.48, 0.97],
    roof: [[-0.44, 1.0], [0.10, 1.0]], windshield: [0.26, 0.50], hood: [0.40, 0.40],
    nose: 0.33, axle: 0.33, archR: 0.22,
  },
  firetruck: {
    bottom: 0.15, tailTop: 0.80, trunk: [-0.49, 0.84], rearGlass: [-0.48, 0.85],
    roof: [[-0.46, 0.86], [0.14, 0.86]], windshield: [0.30, 0.55], hood: [0.42, 0.46],
    nose: 0.38, axle: 0.32, archR: 0.17,
  },
};
PROFILES.taxi = PROFILES.sedan;
PROFILES.police = { ...PROFILES.sedan, nose: 0.40 };

function bodyGeometry(type, W, L, H, wheelR) {
  const P = PROFILES[type] ?? PROFILES.sedan;
  const s = new THREE.Shape();
  const z = (f) => f * L;
  const y = (f) => f * H;
  const axF = z(P.axle), axR = -z(P.axle);
  const r = wheelR + 0.11;                    // arch hugs the tire
  const cy = wheelR;                          // arch centre = axle height
  const yBot = Math.max(y(P.bottom), cy - r + 0.02);

  s.moveTo(-L / 2, yBot + 0.04);
  s.lineTo(-L / 2, y(P.tailTop));                       // tail face
  s.quadraticCurveTo(z(P.trunk[0] - 0.04), y(P.trunk[1] + 0.02), z(P.trunk[0]), y(P.trunk[1]));
  s.lineTo(z(P.rearGlass[0]), y(P.rearGlass[1]));       // trunk lid
  s.lineTo(z(P.roof[0][0]), y(P.roof[0][1]));           // rear glass rake
  s.lineTo(z(P.roof[1][0]), y(P.roof[1][1]));           // roof
  s.lineTo(z(P.windshield[0]), y(P.windshield[1]));     // windshield rake
  s.lineTo(z(P.hood[0]), y(P.hood[1]));                 // hood
  s.quadraticCurveTo(L / 2 - 0.02, y(P.hood[1] - 0.02), L / 2, y(P.nose));  // nose curve
  s.lineTo(L / 2, yBot + 0.04);                         // front bumper face
  // bottom edge, front → rear, cutting an upward arch over each wheel:
  // arc runs CCW from its right (+z) bottom intersection over the top to the
  // left (−z) one
  const aR = -Math.asin(Math.min(0.9, (cy - yBot) / r));
  const xOff = r * Math.cos(aR);
  s.lineTo(axF + xOff, yBot);
  s.absarc(axF, cy, r, aR, Math.PI - aR, false);
  s.lineTo(axR + xOff, yBot);
  s.absarc(axR, cy, r, aR, Math.PI - aR, false);
  s.closePath();

  const bev = Math.min(0.09, W * 0.055);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: W - bev * 2, bevelEnabled: true, curveSegments: 7,
    bevelThickness: bev, bevelSize: bev, bevelSegments: 3, steps: 1,
  });
  // shape space: x = length (+x is the nose), y = height, extrusion z =
  // width. Rotate −90° so the nose lands on +Z, matching the drive
  // direction (+90° put every car in reverse — the playtest bug).
  geo.translate(0, 0, -(W - bev * 2) / 2);
  geo.rotateY(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

// greenhouse: small extrusion tracing the cabin glass, sunk into the roofline
function glassGeometry(type, W, L, H) {
  const P = PROFILES[type] ?? PROFILES.sedan;
  const s = new THREE.Shape();
  const z = (f) => f * L;
  const y = (f) => f * H;
  const drop = 0.05 * H;
  s.moveTo(z(P.rearGlass[0]) - 0.06 * L, y(P.rearGlass[1]) - drop);
  s.lineTo(z(P.roof[0][0]), y(P.roof[0][1]) - drop * 0.4);
  s.lineTo(z(P.roof[1][0]), y(P.roof[1][1]) - drop * 0.4);
  s.lineTo(z(P.windshield[0]) + 0.05 * L, y(P.windshield[1]) - drop);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: W * 0.8, bevelEnabled: true,
    bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1, steps: 1,
  });
  geo.translate(0, 0, -W * 0.4);
  geo.rotateY(-Math.PI / 2);
  return geo;
}

// windshield + front side windows: brighter panes so glass reads from
// outside (the greenhouse block alone was too subtle)
const windowMat = new THREE.MeshLambertMaterial({
  color: 0x7e97a8, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
});
SHARED_MATS.add(windowMat);

function addWindows(out, g, type, W, L, H) {
  const P = PROFILES[type] ?? PROFILES.sedan;
  const wsMat = windowMat;
  const own = (m) => { (out._ownGeos = out._ownGeos || new Set()).add(m.geometry); return m; };
  // windshield: quad along the rake from windshield base to roof front
  const zA = P.windshield[0] * L, yA = P.windshield[1] * H;
  const zB = P.roof[1][0] * L, yB = P.roof[1][1] * H;
  const rakeLen = Math.hypot(zA - zB, yA - yB);
  const ws = own(new THREE.Mesh(new THREE.PlaneGeometry(W * 0.78, rakeLen * 0.92), wsMat));
  ws.position.set(0, (yA + yB) / 2 + 0.015, (zA + zB) / 2 + 0.02);
  ws.rotation.x = -Math.atan2(zA - zB, yB - yA);
  g.add(ws);
  // front side windows
  for (const sx of [-1, 1]) {
    const win = own(new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(zA - zB) * 0.8, (yB - yA) * 0.7), wsMat));
    win.position.set(sx * (W / 2 - 0.02), (yA + yB) / 2 + 0.05, (zA + zB) / 2 - 0.1);
    win.rotation.y = sx * Math.PI / 2;
    g.add(win);
  }
}

// ---------------------------------------------------------------- factory

export function buildVehicleMesh(type, spec, color, { physical = true } = {}) {
  const g = new THREE.Group();
  const out = { group: g, wheels: [], frontPivots: [] };
  const W = spec.w, L = spec.l, H = spec.h;
  const wheelR = type === 'moto' ? 0.34 : type === 'bus' || type === 'firetruck' ? 0.46 : 0.37;
  out.wheelR = wheelR;

  const paintColor = new THREE.Color(color);
  out.bodyMat = physical
    ? new THREE.MeshPhysicalMaterial({
      color: paintColor, metalness: 0.25, roughness: 0.42,
      clearcoat: 0.9, clearcoatRoughness: 0.22, envMapIntensity: 1.0,
    })
    : new THREE.MeshLambertMaterial({ color: paintColor });

  if (type === 'moto') {
    buildMoto(out, g, spec, wheelR);
    finish(out, g);
    return out;
  }

  // body shell (raised so the bottom clears the ground on its wheels)
  const body = new THREE.Mesh(bodyGeometry(type, W, L, H, wheelR), out.bodyMat);
  body.castShadow = true;
  g.add(body);
  out.bodyMesh = body;

  // greenhouse + readable windshield/side panes
  const glass = new THREE.Mesh(glassGeometry(type, W, L, H), glassMat);
  g.add(glass);
  addWindows(out, g, type, W, L, H);

  // wheels (front wheels wrapped in steering pivots)
  const P = PROFILES[type] ?? PROFILES.sedan;
  const wx = W / 2 - 0.17;
  const geos = wheelGeos(wheelR, type === 'bus' || type === 'firetruck' ? 0.34 : 0.26);
  for (const [sx, szF] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const az = szF > 0 ? P.axle * L : -P.axle * L;
    const tire = new THREE.Mesh(geos.tire, tireMat);
    const rim = new THREE.Mesh(geos.rim, getRimMat());
    tire.castShadow = true;
    tire.add(rim);
    if (szF > 0) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * wx, wheelR, az);
      pivot.add(tire);
      g.add(pivot);
      out.frontPivots.push(pivot);
    } else {
      tire.position.set(sx * wx, wheelR, az);
      g.add(tire);
    }
    out.wheels.push(tire);
  }

  // bumpers
  for (const zs of [1, -1]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(W * 0.98, 0.16, 0.14), trimMat);
    b.position.set(0, H * (PROFILES[type]?.bottom ?? 0.2) + 0.09, zs * (L / 2 - 0.02));
    g.add(b);
    (out._ownGeos = out._ownGeos || new Set()).add(b.geometry);
    // license plates
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.12), getPlateMat());
    pl.position.set(0, b.position.y + 0.02, zs * (L / 2 + 0.055));
    if (zs < 0) pl.rotation.y = Math.PI;
    g.add(pl);
    out._ownGeos.add(pl.geometry);
  }

  // mirrors
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.06), trimMat);
    const wsZ = (PROFILES[type]?.windshield?.[0] ?? 0.27) * L;
    m.position.set(sx * (W / 2 + 0.06), H * 0.62, wsZ * 0.9);
    g.add(m);
    (out._ownGeos = out._ownGeos || new Set()).add(m.geometry);
  }

  // head/tail lights + brake-bright tails + white reverse lamps
  out.headMat = new THREE.MeshLambertMaterial({ color: 0xd8d8c8, emissive: 0xfff2cc, emissiveIntensity: 0 });
  out.tailMat = new THREE.MeshLambertMaterial({ color: 0x551512, emissive: 0xff2a1a, emissiveIntensity: 0 });
  out.reverseMat = new THREE.MeshLambertMaterial({ color: 0xd8d8d0, emissive: 0xffffff, emissiveIntensity: 0 });
  const noseY = H * (PROFILES[type]?.nose ?? 0.45) * 0.82;
  const tailY = H * (PROFILES[type]?.tailTop ?? 0.46) - 0.1;
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.13, 0.07), out.headMat);
    hl.position.set(sx * (W / 2 - 0.32), noseY + 0.12, L / 2 + 0.01);
    g.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.07), out.tailMat);
    tl.position.set(sx * (W / 2 - 0.3), tailY, -L / 2 - 0.01);
    g.add(tl);
    const rv = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.06), out.reverseMat);
    rv.position.set(sx * (W / 2 - 0.56), tailY, -L / 2 - 0.01);
    g.add(rv);
    (out._ownGeos = out._ownGeos || new Set()).add(hl.geometry).add(tl.geometry).add(rv.geometry);
  }

  addExtras(out, g, type, spec, W, L, H, wheelR);
  finish(out, g);
  return out;
}

function addExtras(out, g, type, spec, W, L, H, wheelR) {
  const own = (m) => { (out._ownGeos = out._ownGeos || new Set()).add(m.geometry); return m; };
  const roofY = H;

  if (type === 'taxi') {
    const sign = own(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.2, 0.28),
      new THREE.MeshLambertMaterial({ color: 0xe8c84a, emissive: 0xe8c84a, emissiveIntensity: 0.25 })));
    sign.position.set(0, roofY + 0.08, -0.1);
    g.add(sign);
    out._extraMats = [sign.material];
  }
  if (type === 'police' || type === 'firetruck' || type === 'ambulance') {
    out.lightbarR = new THREE.MeshLambertMaterial({ color: 0x772222, emissive: 0xff2222, emissiveIntensity: 0 });
    out.lightbarB = new THREE.MeshLambertMaterial({ color: 0x223377, emissive: type === 'police' ? 0x2244ff : 0xff4422, emissiveIntensity: 0 });
    const y = type === 'police' ? roofY + 0.04 : H * 0.86 + 0.1;
    const z = type === 'police' ? -0.05 : L * 0.3;
    const lb1 = own(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.13, 0.3), out.lightbarR));
    lb1.position.set(-0.24, y, z);
    g.add(lb1);
    const lb2 = own(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.13, 0.3), out.lightbarB));
    lb2.position.set(0.24, y, z);
    g.add(lb2);
  }
  if (type === 'police') {
    const doors = own(new THREE.Mesh(new THREE.BoxGeometry(W + 0.02, H * 0.26, L * 0.3),
      new THREE.MeshLambertMaterial({ color: 0xe8e4dc })));
    doors.position.set(0, H * 0.36, 0.25);
    g.add(doors);
    out._extraMats = [doors.material];
  }
  if (type === 'ambulance') {
    const stripe = own(new THREE.Mesh(new THREE.BoxGeometry(W + 0.03, 0.26, L * 0.8),
      new THREE.MeshLambertMaterial({ color: 0xb03a2e })));
    stripe.position.set(0, H * 0.5, -0.2);
    g.add(stripe);
    out._extraMats = [stripe.material];
  }
  if (type === 'bus') {
    const band = own(new THREE.Mesh(new THREE.BoxGeometry(W + 0.03, H * 0.28, L * 0.82), glassMat));
    band.position.set(0, H * 0.62, -L * 0.02);
    g.add(band);
    const door = own(new THREE.Mesh(new THREE.BoxGeometry(0.06, H * 0.55, 1.1), glassMat));
    door.position.set(W / 2, H * 0.36, L * 0.32);
    g.add(door);
  }
  if (type === 'firetruck') {
    const ladder = own(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.16, L * 0.6), steelMat));
    ladder.position.set(0, H * 0.86 + 0.1, -L * 0.14);
    g.add(ladder);
    const stripe = own(new THREE.Mesh(new THREE.BoxGeometry(W + 0.03, 0.22, L * 0.8),
      new THREE.MeshLambertMaterial({ color: 0xe8e4dc })));
    stripe.position.set(0, H * 0.3, 0);
    g.add(stripe);
    out._extraMats = [stripe.material];
  }
  if (type === 'pickup') {
    // open bed cavity
    const bed = own(new THREE.Mesh(new THREE.BoxGeometry(W * 0.8, 0.05, L * 0.36), trimMat));
    bed.position.set(0, H * 0.46, -L * 0.27);
    g.add(bed);
  }
}

function buildMoto(out, g, spec, wheelR) {
  const own = (m) => { (out._ownGeos = out._ownGeos || new Set()).add(m.geometry); return m; };
  // frame spine
  const frame = own(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 1.45), out.bodyMat));
  frame.position.y = wheelR + 0.28;
  frame.castShadow = true;
  g.add(frame);
  // tank: squashed sphere
  const tank = own(new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), out.bodyMat));
  tank.scale.set(0.8, 0.72, 1.4);
  tank.position.set(0, wheelR + 0.52, 0.22);
  g.add(tank);
  // seat
  const seat = own(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.09, 0.6), trimMat));
  seat.position.set(0, wheelR + 0.5, -0.32);
  g.add(seat);
  // forks + bars
  for (const sx of [-1, 1]) {
    const fork = own(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.62, 6), steelMat));
    fork.position.set(sx * 0.09, wheelR + 0.32, 0.78);
    fork.rotation.x = 0.42;
    g.add(fork);
  }
  const bars = own(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.68, 6), trimMat));
  bars.rotation.z = Math.PI / 2;
  bars.position.set(0, wheelR + 0.78, 0.62);
  g.add(bars);
  // headlight
  out.headMat = new THREE.MeshLambertMaterial({ color: 0xd8d8c8, emissive: 0xfff2cc, emissiveIntensity: 0 });
  out.tailMat = new THREE.MeshLambertMaterial({ color: 0x551512, emissive: 0xff2a1a, emissiveIntensity: 0 });
  const hl = own(new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), out.headMat));
  hl.position.set(0, wheelR + 0.66, 0.86);
  g.add(hl);
  const tl = own(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.05), out.tailMat));
  tl.position.set(0, wheelR + 0.42, -1.02);
  g.add(tl);
  // wheels: front in a steering pivot
  const geos = wheelGeos(wheelR, 0.13);
  for (const zOff of [0.82, -0.82]) {
    const tire = new THREE.Mesh(geos.tire, tireMat);
    const rim = new THREE.Mesh(geos.rim, getRimMat());
    tire.add(rim);
    tire.castShadow = true;
    if (zOff > 0) {
      const pivot = new THREE.Group();
      pivot.position.set(0, wheelR, zOff);
      pivot.add(tire);
      g.add(pivot);
      out.frontPivots.push(pivot);
    } else {
      tire.position.set(0, wheelR, zOff);
      g.add(tire);
    }
    out.wheels.push(tire);
  }
}

function finish(out, g) {
  g.traverse((o) => { if (o.isMesh) o.receiveShadow = false; });
}
