// Original vegetation: curved-trunk palms with alpha-cut frond cards,
// broadleaf trees built from noise-displaced foliage lobes, and hedge
// bushes. Each species returns { parts: [{ geo, mat, castShadow }] } that
// citymesh instances per placement list.

import * as THREE from 'three';
import { mergeGeometries as mergeBG } from '../../vendor/jsm/utils/BufferGeometryUtils.js';

// ---- shared canvas textures ----

function frondTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 128, 64);
  // central rib with paired leaflets, alpha-cut
  x.strokeStyle = '#2e6e2a';
  x.lineWidth = 5;
  x.beginPath(); x.moveTo(0, 32); x.lineTo(126, 32); x.stroke();
  for (let i = 0; i < 22; i++) {
    const t = i / 22;
    const px = 6 + t * 116;
    const len = 26 * (1 - t * 0.55);
    const g = 100 + Math.round(60 * (1 - t));
    x.strokeStyle = `rgba(52,${g},44,0.98)`;
    x.lineWidth = 9;
    x.beginPath(); x.moveTo(px, 32); x.lineTo(px + 9, 32 - len); x.stroke();
    x.beginPath(); x.moveTo(px, 32); x.lineTo(px + 9, 32 + len); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function leafTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  // mottled foliage blob
  const g = x.createRadialGradient(32, 32, 6, 32, 32, 31);
  g.addColorStop(0, '#5b8a3c');
  g.addColorStop(0.75, '#41702e');
  g.addColorStop(1, '#2e5222');
  x.fillStyle = g;
  x.beginPath(); x.arc(32, 32, 31, 0, 7); x.fill();
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * 7, r = Math.random() * 28;
    x.fillStyle = Math.random() < 0.5 ? 'rgba(90,140,60,0.5)' : 'rgba(38,66,28,0.5)';
    x.beginPath();
    x.arc(32 + Math.cos(a) * r, 32 + Math.sin(a) * r, 2.4 + Math.random() * 2.4, 0, 7);
    x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function barkMat(color) {
  return new THREE.MeshLambertMaterial({ color });
}

// curved palm trunk: swept rings along a quadratic bend
function palmTrunkGeometry() {
  const segs = 7, radial = 6;
  const pos = [], uv = [], idx = [];
  const bend = 0.85;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const cx = bend * t * t;                 // quadratic lean
    const cy = t * 6.6;
    const r = 0.2 - t * 0.09;
    for (let s = 0; s <= radial; s++) {
      const a = (s / radial) * Math.PI * 2;
      pos.push(cx + Math.cos(a) * r, cy, Math.sin(a) * r);
      uv.push(s / radial, t * 5);
    }
    // ring bulges every other segment (old frond scars)
  }
  const cols = radial + 1;
  for (let i = 0; i < segs; i++) {
    for (let s = 0; s < radial; s++) {
      const a = i * cols + s;
      idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// arched frond cards radiating from the crown
function palmFrondGeometry() {
  const fronds = [];
  const one = () => {
    // 3-segment bent strip, 0.55 wide, ~2.9 long
    const p = new THREE.PlaneGeometry(3.3, 0.78, 3, 1);
    const pos = p.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const t = (x + 1.65) / 3.3;            // 0 at base → 1 at tip
      pos.setY(i, Math.sin(t * 1.8) * 0.55 - t * t * 1.3);   // arch up then droop
      pos.setX(i, x + 1.65);
    }
    p.computeVertexNormals();
    return p;
  };
  for (let i = 0; i < 9; i++) {
    const f = one();
    f.rotateY((i / 9) * Math.PI * 2 + (i % 2) * 0.22);
    const tilt = 0.1 + (i % 3) * 0.14;
    // small per-frond droop variation
    f.rotateX((i % 2 ? 1 : -1) * 0.05);
    f.translate(0.85, 6.55 - tilt * 0.4, 0);
    fronds.push(f);
  }
  // coconut cluster
  const nuts = new THREE.SphereGeometry(0.14, 6, 5);
  nuts.translate(0.85, 6.35, 0.12);
  const nuts2 = nuts.clone(); nuts2.translate(-0.22, -0.05, -0.2);
  return { fronds: mergeBG(fronds, false), nuts: mergeBG([nuts, nuts2], false) };
}

// broadleaf: tapered trunk + 4 noise-displaced foliage lobes
function broadleafGeometry() {
  const trunk = new THREE.CylinderGeometry(0.16, 0.28, 2.9, 7);
  trunk.translate(0, 1.45, 0);
  const limb = new THREE.CylinderGeometry(0.07, 0.1, 1.4, 5);
  limb.rotateZ(0.7); limb.translate(0.55, 3.1, 0.1);
  const limb2 = limb.clone(); limb2.rotateY(2.2);
  const trunkGeo = mergeBG([trunk, limb, limb2], false);

  const lobes = [];
  const lobeDefs = [
    [0, 4.4, 0, 2.1], [1.1, 3.8, 0.5, 1.5], [-1.0, 3.9, -0.4, 1.45], [0.15, 3.6, 1.05, 1.3], [-0.3, 3.7, -1.1, 1.25],
  ];
  for (const [x, y, z, r] of lobeDefs) {
    const lobe = new THREE.IcosahedronGeometry(r, 1);
    const pos = lobe.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const n = Math.sin(pos.getX(i) * 4.1 + y) * 0.13 + Math.cos(pos.getZ(i) * 3.7) * 0.13;
      const len = 1 + n;
      pos.setXYZ(i, pos.getX(i) * len, pos.getY(i) * (len * 0.92), pos.getZ(i) * len);
    }
    lobe.translate(x, y, z);
    lobes.push(lobe);
  }
  return { trunk: trunkGeo, foliage: mergeBG(lobes, false) };
}

function hedgeGeometry() {
  const g = new THREE.IcosahedronGeometry(0.62, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const n = Math.sin(pos.getX(i) * 5.2) * 0.12 + Math.cos(pos.getZ(i) * 4.4) * 0.1;
    pos.setXYZ(i, pos.getX(i) * (1 + n) * 1.15, Math.max(pos.getY(i) * (0.82 + n), -0.05) + 0.52, pos.getZ(i) * (1 + n));
  }
  g.computeVertexNormals();
  return g;
}

// ---- public: build all species once ----
export function buildVegetation() {
  const frondTex = frondTexture();
  const leafTex = leafTexture();
  const frondMat = new THREE.MeshLambertMaterial({
    map: frondTex, alphaTest: 0.28, side: THREE.DoubleSide, color: 0xffffff,
  });
  const foliageMat = new THREE.MeshLambertMaterial({ map: leafTex, color: 0xd8e6c8 });
  const palmBark = barkMat(0x8a6a48);
  const treeBark = barkMat(0x5e4530);
  const nutMat = new THREE.MeshLambertMaterial({ color: 0x5a4326 });

  const palmParts = palmFrondGeometry();
  const leaf = broadleafGeometry();

  return {
    palm: [
      { geo: palmTrunkGeometry(), mat: palmBark, castShadow: true },
      { geo: palmParts.fronds, mat: frondMat, castShadow: false },
      { geo: palmParts.nuts, mat: nutMat, castShadow: false },
    ],
    tree: [
      { geo: leaf.trunk, mat: treeBark, castShadow: true },
      { geo: leaf.foliage, mat: foliageMat, castShadow: true },
    ],
    bush: [
      { geo: hedgeGeometry(), mat: foliageMat, castShadow: false },
    ],
  };
}
