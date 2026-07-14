// Builds the 3D city: merged building meshes (grouped by chunk + material)
// and instanced props. Everything is generated geometry — no model files.

import * as THREE from 'three';
import { buildFacadeMaterials, FACADE_TILE } from './textures.js';
import { buildVegetation } from './vegetation.js';
import { buildPropLibrary } from './props.js';
import { RNG } from '../core/rng.js';
import { mergeGeometries as mergeBG } from '../../vendor/jsm/utils/BufferGeometryUtils.js';

const CHUNK_CELLS = 4;   // 4×4 cells per chunk

// ---------------------------------------------------------------- merge utility
// Merge indexed BufferGeometries that all have position/normal/uv.
function mergeGeometries(geos) {
  let vCount = 0, iCount = 0;
  for (const g of geos) { vCount += g.attributes.position.count; iCount += g.index.count; }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0, io = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// Box with UVs scaled so the facade texture repeats every FACADE_TILE metres.
function facadeBox(w, h, d, uvTile = FACADE_TILE, vTile = null) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const vt = vTile || uvTile;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 verts each)
  const faceU = [d, d, w, w, w, w];
  const faceV = [h, h, d, d, h, h];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * (faceU[f] / uvTile), uv.getY(i) * (faceV[f] / vt));
    }
  }
  return g;
}

// Simple gabled roof prism (ridge along x)
function roofPrism(w, h, d) {
  const g = new THREE.BufferGeometry();
  const hw = w / 2, hd = d / 2;
  const verts = [
    // front triangle (z = +hd)
    -hw, 0, hd, hw, 0, hd, 0, h, hd,
    // back triangle
    hw, 0, -hd, -hw, 0, -hd, 0, h, -hd,
    // left slope
    -hw, 0, -hd, -hw, 0, hd, 0, h, hd, -hw, 0, -hd, 0, h, hd, 0, h, -hd,
    // right slope
    hw, 0, hd, hw, 0, -hd, 0, h, -hd, hw, 0, hd, 0, h, -hd, 0, h, hd,
  ];
  const uvs = [];
  for (let i = 0; i < verts.length / 3; i++) uvs.push(verts[i * 3] * 0.1, verts[i * 3 + 2] * 0.1);
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex([...Array(verts.length / 3).keys()]);
  g.computeVertexNormals();
  return g;
}

function translated(geo, x, y, z) {
  const g = geo.clone();
  g.translate(x, y, z);
  return g;
}


// bold spray-art canvases for the side-wall murals (6 distinct styles)
function buildMuralTextures(seed) {
  const rng = new RNG(seed + 71);
  const palettes = [
    ['#e8623c', '#f7b32b', '#2d3047', '#e8e4da'],
    ['#4ecdc4', '#1a535c', '#ff6b6b', '#f7fff7'],
    ['#9b5de5', '#f15bb5', '#fee440', '#00bbf9'],
    ['#264653', '#2a9d8f', '#e9c46a', '#e76f51'],
  ];
  const styles = [];
  for (let sI = 0; sI < 6; sI++) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 192;
    const x = c.getContext('2d');
    const pal = palettes[sI % palettes.length];
    x.fillStyle = pal[0];
    x.fillRect(0, 0, 256, 192);
    switch (sI % 6) {
      case 0: {   // sunset bands + rising sun
        for (let i = 0; i < 5; i++) { x.fillStyle = i % 2 ? pal[1] : pal[3]; x.fillRect(0, 96 + i * 20, 256, 12); }
        x.fillStyle = pal[1];
        x.beginPath(); x.arc(128, 96, 46, Math.PI, 0); x.fill();
        break;
      }
      case 1: {   // wave + sun
        x.fillStyle = pal[3]; x.fillRect(0, 0, 256, 192);
        x.fillStyle = pal[0];
        x.beginPath(); x.moveTo(0, 150);
        for (let i = 0; i < 8; i++) x.quadraticCurveTo(i * 32 + 16, 150 - (i % 2 ? 70 : 20), (i + 1) * 32, 150);
        x.lineTo(256, 192); x.lineTo(0, 192); x.closePath(); x.fill();
        x.fillStyle = pal[2];
        x.beginPath(); x.arc(200, 52, 28, 0, 7); x.fill();
        break;
      }
      case 2: {   // triangles
        for (let i = 0; i < 14; i++) {
          x.fillStyle = pal[1 + (i % 3)];
          const px = rng.float(0, 256), py = rng.float(0, 192), r = rng.float(14, 42);
          x.beginPath(); x.moveTo(px, py - r); x.lineTo(px + r, py + r); x.lineTo(px - r, py + r); x.closePath(); x.fill();
        }
        break;
      }
      case 3: {   // lettering
        x.fillStyle = pal[3];
        x.font = 'bold 54px Impact, sans-serif';
        x.textAlign = 'center';
        x.save(); x.translate(128, 108); x.rotate(-0.05);
        x.strokeStyle = pal[1]; x.lineWidth = 10; x.strokeText('BAYVALE', 0, 0);
        x.fillText('BAYVALE', 0, 0);
        x.restore();
        x.fillStyle = pal[1];
        x.font = 'bold 22px monospace';
        x.fillText('OLD CORONET', 128, 152);
        break;
      }
      case 4: {   // overlapping circles
        x.globalAlpha = 0.85;
        for (let i = 0; i < 9; i++) {
          x.fillStyle = pal[1 + (i % 3)];
          x.beginPath(); x.arc(rng.float(20, 236), rng.float(20, 172), rng.float(12, 44), 0, 7); x.fill();
        }
        x.globalAlpha = 1;
        break;
      }
      default: {  // skyline silhouette
        x.fillStyle = pal[1]; x.fillRect(0, 0, 256, 120);
        x.fillStyle = pal[0];
        let bx = 0;
        while (bx < 250) { const w = rng.float(18, 40), h = rng.float(40, 100); x.fillRect(bx, 120 - h, w, h + 72); bx += w + 4; }
        x.fillStyle = pal[2];
        x.beginPath(); x.arc(60, 40, 20, 0, 7); x.fill();
      }
    }
    x.fillStyle = 'rgba(0,0,0,0.25)';
    x.fillRect(0, 180, 256, 12);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    styles.push(tex);
  }
  return styles;
}

// ---------------------------------------------------------------- city meshes
export function buildCityMeshes(city, scene, seed = 1, assets = null) {
  const { mats, setNight } = buildFacadeMaterials(seed);
  const rng = new RNG(seed + 31);

  // chunk key from world position
  const chunkOf = (x, z) => {
    const ci = Math.floor((x + city.HALF) / (CHUNK_CELLS * city.CELL));
    const cj = Math.floor((z + city.HALF) / (CHUNK_CELLS * city.CELL));
    return ci + '|' + cj;
  };

  // bins: chunkKey → matKey → geometry list
  const bins = new Map();
  function push(chunk, matKey, geo) {
    let m = bins.get(chunk);
    if (!m) { m = new Map(); bins.set(chunk, m); }
    let arr = m.get(matKey);
    if (!arr) { arr = []; m.set(matKey, arr); }
    arr.push(geo);
  }

  const bandLists = [[], [], []];   // walk-in shopfront ground floors per variant
  const towerMats = ['glassA', 'glassB', 'office'];
  const blockMats = ['brick', 'stucco', 'office', 'concrete'];
  const houseMats = ['houseA', 'houseB', 'houseA', 'stucco'];
  const hotelMats = ['pastelA', 'pastelB'];
  const metalMats = ['metalA', 'metalB'];
  const mansionMats = ['white', 'pastelA'];

  for (const b of city.buildings) {
    const ground = city.groundHeight(b.x, b.z);
    const baseY = ground - 1.5;                       // sink foundations on slopes
    const ck = chunkOf(b.x, b.z);
    const H = b.h + 1.5;

    switch (b.kind) {
      case 'tower': {
        const mk = towerMats[b.style % towerMats.length];
        push(ck, mk, translated(facadeBox(b.w, H, b.d), b.x, baseY + H / 2, b.z));
        push(ck, 'roof', translated(new THREE.BoxGeometry(b.w, 0.5, b.d), b.x, baseY + H + 0.25, b.z));
        // rooftop unit
        push(ck, 'roof', translated(new THREE.BoxGeometry(b.w * 0.3, 2.2, b.d * 0.3), b.x + b.w * 0.15, baseY + H + 1.35, b.z));
        // setback crown for tall towers
        if (b.h > 70) {
          const cw = b.w * 0.62, cd = b.d * 0.62, chh = b.h * 0.18;
          push(ck, mk, translated(facadeBox(cw, chh, cd), b.x, baseY + H + chh / 2, b.z));
          push(ck, 'roof', translated(new THREE.BoxGeometry(cw, 0.4, cd), b.x, baseY + H + chh + 0.2, b.z));
        }
        break;
      }
      case 'block': {
        const mk = blockMats[b.style % blockMats.length];
        const sfv = Math.abs(Math.round(b.x * 7 + b.z * 3)) % 3;
        push(ck, 'roof', translated(new THREE.BoxGeometry(b.w, 0.45, b.d), b.x, baseY + H + 0.22, b.z));
        if (b.hasDoor) {
          // walk-in shopfront: the merged shell starts above the ground
          // floor; the ground floor is a swappable instanced band that the
          // interiors system hides when it hollows the building out
          const upperH = Math.max(b.h - 3.2, 1);
          push(ck, mk, translated(facadeBox(b.w, upperH, b.d), b.x, ground + 3.2 + upperH / 2, b.z));
          bandLists[sfv].push(b);
        } else {
          push(ck, mk, translated(facadeBox(b.w, H, b.d), b.x, baseY + H / 2, b.z));
          // street-level shopfront band, slightly proud of the facade
          const sf = facadeBox(b.w + 0.5, 3.2, b.d + 0.5, FACADE_TILE, 3.2);
          push(ck, 'shopfront' + sfv, translated(sf, b.x, ground + 1.6, b.z));
        }
        break;
      }
      case 'house': {
        const mk = houseMats[b.style % houseMats.length];
        push(ck, mk, translated(facadeBox(b.w, H, b.d, 6, 6), b.x, baseY + H / 2, b.z));
        push(ck, 'roofShingle', translated(roofPrism(b.w + 0.8, 2.2, b.d + 0.8), b.x, baseY + H, b.z));
        break;
      }
      case 'warehouse': {
        const mk = metalMats[b.style % metalMats.length];
        push(ck, mk, translated(facadeBox(b.w, H, b.d), b.x, baseY + H / 2, b.z));
        push(ck, 'roofMetal', translated(roofPrism(b.w + 0.5, 1.6, b.d + 0.5), b.x, baseY + H, b.z));
        break;
      }
      case 'hotel': {
        const mk = hotelMats[b.style % hotelMats.length];
        push(ck, mk, translated(facadeBox(b.w, H, b.d), b.x, baseY + H / 2, b.z));
        push(ck, 'roof', translated(new THREE.BoxGeometry(b.w, 0.4, b.d), b.x, baseY + H + 0.2, b.z));
        break;
      }
      case 'mansion': {
        const mk = mansionMats[b.style % mansionMats.length];
        push(ck, mk, translated(facadeBox(b.w, H, b.d, 8, 8), b.x, baseY + H / 2, b.z));
        push(ck, 'roofShingle', translated(roofPrism(b.w + 1, 2.6, b.d + 1), b.x, baseY + H, b.z));
        break;
      }
      case 'barn': {
        push(ck, 'barnred', translated(facadeBox(b.w, H, b.d, 8, 8), b.x, baseY + H / 2, b.z));
        push(ck, 'roofMetal', translated(roofPrism(b.w + 0.6, 2.8, b.d + 0.6), b.x, baseY + H, b.z));
        break;
      }
    }
  }

  // build merged meshes
  const cityGroup = new THREE.Group();
  cityGroup.name = 'city';
  let drawCalls = 0;
  for (const [, matMap] of bins) {
    for (const [matKey, geos] of matMap) {
      const merged = mergeGeometries(geos);
      const mesh = new THREE.Mesh(merged, mats[matKey]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      cityGroup.add(mesh);
      drawCalls++;
    }
  }
  scene.add(cityGroup);

  // swappable ground-floor bands for the walk-in shopfronts (one instanced
  // mesh per shopfront variant; interiors zero a slot to hollow a building)
  {
    const dummy2 = new THREE.Object3D();
    const bandGeo = facadeBox(12, 3.2, 12, FACADE_TILE, 3.2);
    for (let v = 0; v < 3; v++) {
      const list = bandLists[v];
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(bandGeo, mats['shopfront' + v], list.length);
      im.castShadow = true;
      im.receiveShadow = true;
      for (let k = 0; k < list.length; k++) {
        const b = list[k];
        const g = city.groundHeight(b.x, b.z);
        dummy2.position.set(b.x, g + 1.6, b.z);
        dummy2.scale.set((b.w + 0.5) / 12, 1, (b.d + 0.5) / 12);
        dummy2.updateMatrix();
        im.setMatrixAt(k, dummy2.matrix);
        b._bandSlot = { mesh: im, idx: k };
      }
      im.instanceMatrix.needsUpdate = true;
      cityGroup.add(im);
      drawCalls++;
    }
  }

  // ---------------------------------------------------------------- props (instanced)
  // All street furniture + vegetation are original generated meshes from
  // props.js / vegetation.js — one InstancedMesh per (kind, material part).
  const propGroup = new THREE.Group();
  propGroup.name = 'props';

  const propDefs = {};
  const byKind = {};
  for (const p of city.props) (byKind[p.kind] = byKind[p.kind] || []).push(p);

  const dummy = new THREE.Object3D();

  function instanced(geo, mat, list, yOf = () => 0, extraScaleY = false, castShadow = true) {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    im.castShadow = castShadow;
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      dummy.position.set(p.x, city.groundHeight(p.x, p.z) + yOf(p), p.z);
      dummy.rotation.set(0, p.rot || 0, 0);
      const sc = p.s || 1;
      dummy.scale.set(sc, extraScaleY ? sc * (0.85 + ((k * 37) % 10) * 0.05) : sc, sc);
      dummy.updateMatrix();
      im.setMatrixAt(k, dummy.matrix);
      (p._slots = p._slots || []).push({ mesh: im, idx: k });
    }
    im.instanceMatrix.needsUpdate = true;
    propGroup.add(im);
    return im;
  }

  const grey = new THREE.MeshLambertMaterial({ color: 0x5a5f66 });
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x8a6a48 });

  const vegLib = buildVegetation();
  const propLib = buildPropLibrary();
  const buildKind = (kind, list, yOf = () => 0, extraScaleY = false) => {
    const parts = vegLib[kind] || propLib[kind];
    if (!parts || !list?.length) return;
    for (const part of parts) {
      instanced(part.geo, part.mat, list, yOf, extraScaleY, part.castShadow !== false);
      if (part.nightKey) propDefs[part.nightKey] = { mat: part.mat };
    }
  };

  buildKind('palm', byKind.palm);
  buildKind('tree', byKind.tree, () => 0, true);
  buildKind('bush', byKind.bush);
  buildKind('bench', byKind.bench);
  buildKind('hydrant', byKind.hydrant);
  buildKind('trash', byKind.trash);
  buildKind('dumpster', byKind.dumpster);
  buildKind('trafficlight', byKind.trafficlight);
  buildKind('utilitypole', byKind.utilitypole);

  // streetlights + emissive heads + night light pools
  if (byKind.lamp?.length) {
    buildKind('lamp', byKind.lamp);
    const headGeo = new THREE.BoxGeometry(0.6, 0.16, 0.26);
    headGeo.translate(1.42, 7.32, 0);
    const headMat = new THREE.MeshLambertMaterial({ color: 0xccccbb, emissive: 0xffe9b0, emissiveIntensity: 0 });
    instanced(headGeo, headMat, byKind.lamp);
    propDefs.lampHeads = { mat: headMat };
    const poolGeo = new THREE.CircleGeometry(5.5, 18);
    poolGeo.rotateX(-Math.PI / 2);
    const poolMat = new THREE.MeshBasicMaterial({
      color: 0xffdf9e, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const pools = new THREE.InstancedMesh(poolGeo, poolMat, byKind.lamp.length);
    for (let k = 0; k < byKind.lamp.length; k++) {
      const p = byKind.lamp[k];
      dummy.position.set(p.x + 1.42, city.groundHeight(p.x, p.z) + 0.07, p.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      pools.setMatrixAt(k, dummy.matrix);
      (p._slots = p._slots || []).push({ mesh: pools, idx: k, noDebris: true });
    }
    pools.instanceMatrix.needsUpdate = true;
    propGroup.add(pools);
    propDefs.lampPools = { mat: poolMat };
  }

  // planters: concrete box + hedge shrub
  if (byKind.planter?.length) {
    const boxG = new THREE.BoxGeometry(1.6, 0.5, 0.7);
    boxG.translate(0, 0.25, 0);
    instanced(boxG, grey, byKind.planter);
    for (const part of vegLib.bush) {
      instanced(part.geo, part.mat, byKind.planter, () => 0.32, false, false);
    }
  }

  // containers with instance colours
  if (byKind.container?.length) {
    const geo = new THREE.BoxGeometry(6.4, 2.8, 2.8);
    geo.translate(0, 1.4, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const im = instanced(geo, mat, byKind.container);
    const cols = [0x9a4a3a, 0x3a6a8a, 0x4a7a4a, 0xb08a3a, 0x707880];
    for (let k = 0; k < byKind.container.length; k++)
      im.setColorAt(k, new THREE.Color(cols[k % cols.length]));
    im.instanceColor.needsUpdate = true;
  }

  if (byKind.hut?.length) {
    const body = new THREE.BoxGeometry(3.4, 2.6, 3); body.translate(0, 1.3, 0);
    const roof = roofPrism(4, 1.2, 3.6); roof.translate(0, 2.6, 0);
    instanced(mergeGeometries([body, roof]), woodMat, byKind.hut);
  }

  if (byKind.silo?.length) {
    const body = new THREE.CylinderGeometry(2.1, 2.1, 9, 10); body.translate(0, 4.5, 0);
    const cap = new THREE.ConeGeometry(2.2, 1.8, 10); cap.translate(0, 9.9, 0);
    instanced(mergeGeometries([body, cap]), grey, byKind.silo);
  }

  if (byKind.crane?.length) {
    const tower = new THREE.BoxGeometry(1.6, 18, 1.6); tower.translate(0, 9, 0);
    const jib = new THREE.BoxGeometry(14, 1.1, 1.1); jib.translate(4.5, 18, 0);
    const counter = new THREE.BoxGeometry(3, 2, 2); counter.translate(-3.5, 17.6, 0);
    instanced(mergeGeometries([tower, jib, counter]), new THREE.MeshLambertMaterial({ color: 0xa85f2a }), byKind.crane);
  }

  // ---- sagging utility wires strung between consecutive poles per street
  if (byKind.utilitypole?.length) {
    const groups = new Map();
    for (const p of byKind.utilitypole) {
      if (p.wireGroup === undefined) continue;
      (groups.get(p.wireGroup) ?? groups.set(p.wireGroup, []).get(p.wireGroup)).push(p);
    }
    const pts = [];
    const SAG = 0.55, WIRE_Y = 7.02, SEGS = 6;
    for (const list of groups.values()) {
      list.sort((a, b) => a.seq - b.seq);
      for (let i = 0; i < list.length - 1; i++) {
        const a = list[i], b = list[i + 1];
        const ya = city.groundHeight(a.x, a.z) + WIRE_Y;
        const yb = city.groundHeight(b.x, b.z) + WIRE_Y;
        // two wires on crossarm pins, offset perpendicular to the span
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        const px = -dz / len, pz = dx / len;
        for (const off of [-0.42, 0.42]) {
          for (let sgi = 0; sgi < SEGS; sgi++) {
            for (const tt of [sgi / SEGS, (sgi + 1) / SEGS]) {
              const sag = Math.sin(tt * Math.PI) * -SAG;
              pts.push(
                a.x + dx * tt + px * off,
                ya + (yb - ya) * tt + sag,
                a.z + dz * tt + pz * off,
              );
            }
          }
        }
      }
    }
    if (pts.length) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const wires = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x15151a }));
      wires.name = 'wires';
      propGroup.add(wires);
    }
  }

  // ---- murals: bold canvas art on blank side walls in the older districts
  {
    const muralStyles = buildMuralTextures(seed);
    const perStyle = muralStyles.map(() => []);
    let mi = 0;
    for (const b of city.buildings) {
      if (b.kind !== 'block' || b.h < 7) continue;
      const dist = city.districtAt(b.x, b.z);
      if (dist !== 'oldtown' && dist !== 'midtown') continue;
      const hash = Math.abs(Math.round(b.x * 13 + b.z * 7));
      if (hash % 6 !== 0) continue;
      // hash is always divisible by 6 here, so use an independent bit
      const side = Math.round(hash / 6) % 2 ? 1 : -1;
      perStyle[mi % muralStyles.length].push({ b, side });
      mi++;
    }
    for (let si = 0; si < muralStyles.length; si++) {
      const list = perStyle[si];
      if (!list.length) continue;
      const geo = new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.MeshLambertMaterial({ map: muralStyles[si] });
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      for (let k = 0; k < list.length; k++) {
        const { b, side } = list[k];
        const g = city.groundHeight(b.x, b.z);
        const w = Math.min(b.d * 0.62, 9);
        const h = Math.min(b.h * 0.52, 7);
        dummy.position.set(b.x + side * (b.w / 2 + 0.07), g + 3.4 + h / 2, b.z);
        dummy.rotation.set(0, side > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
        dummy.scale.set(w, h, 1);
        dummy.updateMatrix();
        im.setMatrixAt(k, dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
      propGroup.add(im);
    }
    propDefs.muralCount = mi;
  }

  // ---- rooftop clutter: AC units + water tanks on mid-rise roofs
  {
    const acList = [];
    const rr = new RNG(seed + 97);
    for (const b of city.buildings) {
      if ((b.kind !== 'block' && b.kind !== 'tower') || b.h < 9) continue;
      const g = city.groundHeight(b.x, b.z);
      const n = b.kind === 'tower' ? 2 : rr.chance(0.6) ? 1 : 2;
      for (let k = 0; k < n; k++) {
        acList.push({
          x: b.x + rr.float(-0.3, 0.3) * b.w,
          z: b.z + rr.float(-0.3, 0.3) * b.d,
          rot: rr.chance(0.5) ? 0 : Math.PI / 2,
          s: 1,
          _y: g + b.h + 0.35,
        });
      }
    }
    if (acList.length) {
      const box = new THREE.BoxGeometry(1.3, 0.62, 0.95);
      const fan = new THREE.CylinderGeometry(0.34, 0.34, 0.1, 8);
      fan.translate(0, 0.67, 0);   // fan sits on TOP of the housing
      const geo = mergeGeometries([box, fan].map((gg, i) => {
        if (i === 0) gg.translate(0, 0.31, 0);
        return gg;
      }));
      const im = new THREE.InstancedMesh(geo, grey, acList.length);
      for (let k = 0; k < acList.length; k++) {
        const p = acList[k];
        // roof slabs top out ~0.45 above b.h — sit the unit on the slab
        dummy.position.set(p.x, p._y + 0.11, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        im.setMatrixAt(k, dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
      propGroup.add(im);
    }
  }

  scene.add(propGroup);

  return {
    cityGroup, propGroup, drawCalls,
    setNight(intensity) {
      setNight(intensity);
      if (propDefs.lampHeads) propDefs.lampHeads.mat.emissiveIntensity = intensity * 1.6;
      if (propDefs.lampPools) propDefs.lampPools.mat.opacity = intensity * 0.16;
      if (propDefs.signalLens) propDefs.signalLens.mat.emissiveIntensity = 0.35 + intensity * 1.45;
    },
  };
}
