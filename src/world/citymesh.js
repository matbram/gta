// Builds the 3D city: merged building meshes (grouped by chunk + material)
// and instanced props. Everything is generated geometry — no model files.

import * as THREE from 'three';
import { buildFacadeMaterials, FACADE_TILE } from './textures.js';
import { RNG } from '../core/rng.js';
import { mergeGeometries as mergeBG } from '../../vendor/jsm/utils/BufferGeometryUtils.js';

// Flatten a loaded GLB into per-material merged geometries, then instance it
// at every entry of `list` ({x, z, rot, s}), scaled so its height ≈ targetH.
function instancedFromModel(model, list, city, group, { targetH = null, targetW = null, yOffset = 0 } = {}) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  let s = 1;
  if (targetH) s = targetH / Math.max(size.y, 0.01);
  else if (targetW) s = targetW / Math.max(Math.max(size.x, size.z), 0.01);

  // group world-baked geometries by material
  const byMat = new Map();
  model.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(g);
  });

  const dummy = new THREE.Object3D();
  const meshes = [];
  for (const [mat, geos] of byMat) {
    let merged;
    try { merged = geos.length > 1 ? mergeBG(geos, false) : geos[0]; }
    catch { merged = geos[0]; }
    // ground the geometry at y=0 and centre x/z
    merged.translate(-(box.min.x + size.x / 2), -box.min.y, -(box.min.z + size.z / 2));
    const im = new THREE.InstancedMesh(merged, mat, list.length);
    im.castShadow = true;
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      dummy.position.set(p.x, city.groundHeight(p.x, p.z) + yOffset, p.z);
      dummy.rotation.set(0, p.rot || 0, 0);
      dummy.scale.setScalar(s * (p.s || 1));
      dummy.updateMatrix();
      im.setMatrixAt(k, dummy.matrix);
      (p._slots = p._slots || []).push({ mesh: im, idx: k });
    }
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
    meshes.push(im);
  }
  return meshes;
}

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
        push(ck, mk, translated(facadeBox(b.w, H, b.d), b.x, baseY + H / 2, b.z));
        push(ck, 'roof', translated(new THREE.BoxGeometry(b.w, 0.45, b.d), b.x, baseY + H + 0.22, b.z));
        // street-level shopfront band, slightly proud of the facade
        const sf = facadeBox(b.w + 0.5, 3.2, b.d + 0.5, FACADE_TILE, 3.2);
        push(ck, 'shopfront' + (Math.abs(Math.round(b.x * 7 + b.z * 3)) % 3), translated(sf, b.x, ground + 1.6, b.z));
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

  // ---------------------------------------------------------------- props (instanced)
  const propGroup = new THREE.Group();
  propGroup.name = 'props';

  const propDefs = {
    lamp: null, tree: null, palm: null, container: null,
    bench: null, hut: null, silo: null, crane: null,
  };
  const byKind = {};
  for (const p of city.props) (byKind[p.kind] = byKind[p.kind] || []).push(p);

  const dummy = new THREE.Object3D();

  function instanced(geo, mat, list, yOf = () => 0, extraScaleY = false) {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    im.castShadow = true;
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      dummy.position.set(p.x, city.groundHeight(p.x, p.z) + yOf(p), p.z);
      dummy.rotation.set(0, p.rot || 0, 0);
      const s = p.s || 1;
      dummy.scale.set(s, extraScaleY ? s * (0.85 + ((k * 37) % 10) * 0.05) : s, s);
      dummy.updateMatrix();
      im.setMatrixAt(k, dummy.matrix);
      (p._slots = p._slots || []).push({ mesh: im, idx: k });
    }
    im.instanceMatrix.needsUpdate = true;
    propGroup.add(im);
    return im;
  }

  const grey = new THREE.MeshLambertMaterial({ color: 0x5a5f66 });
  const darkGrey = new THREE.MeshLambertMaterial({ color: 0x3c4046 });
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6a4a32 });
  const leafMat = new THREE.MeshLambertMaterial({ color: 0x4a6e38 });
  const palmLeafMat = new THREE.MeshLambertMaterial({ color: 0x4f7a3a });
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x8a6a48 });

  // lamp: GLB streetlight when fetched, procedural pole otherwise
  if (byKind.lamp?.length) {
    const lampModel = assets?.model('streetlight');
    if (lampModel) {
      instancedFromModel(lampModel, byKind.lamp, city, propGroup, { targetH: 6.8 });
    } else {
      const pole = new THREE.CylinderGeometry(0.09, 0.13, 7.2, 6);
      pole.translate(0, 3.6, 0);
      const arm = new THREE.BoxGeometry(1.4, 0.12, 0.12);
      arm.translate(0.6, 7.05, 0);
      instanced(mergeGeometries([pole, arm]), grey, byKind.lamp);
    }
    // lamp heads (emissive at night)
    const headGeo = new THREE.BoxGeometry(0.55, 0.18, 0.3);
    headGeo.translate(lampModel ? 0.3 : 1.25, lampModel ? 6.5 : 7.0, 0);
    const headMat = new THREE.MeshLambertMaterial({ color: 0xccccbb, emissive: 0xffe9b0, emissiveIntensity: 0 });
    const heads = instanced(headGeo, headMat, byKind.lamp);
    propDefs.lampHeads = { mesh: heads, mat: headMat };
    // light pools under lamps at night
    const poolGeo = new THREE.CircleGeometry(5.5, 18);
    poolGeo.rotateX(-Math.PI / 2);
    const poolMat = new THREE.MeshBasicMaterial({
      color: 0xffdf9e, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const pools = new THREE.InstancedMesh(poolGeo, poolMat, byKind.lamp.length);
    for (let k = 0; k < byKind.lamp.length; k++) {
      const p = byKind.lamp[k];
      dummy.position.set(p.x + (lampModel ? 0.3 : 1.25), city.groundHeight(p.x, p.z) + 0.07, p.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      pools.setMatrixAt(k, dummy.matrix);
      (p._slots = p._slots || []).push({ mesh: pools, idx: k, noDebris: true });
    }
    pools.instanceMatrix.needsUpdate = true;
    propGroup.add(pools);
    propDefs.lampPools = { mesh: pools, mat: poolMat };
  }

  function fixIndexed(g) { return g.index ? g : g; }

  // tree: kenney tree cluster on grassy districts, procedural blob elsewhere
  if (byKind.tree?.length) {
    const treeModel = assets?.model('grass-trees') || assets?.model('grass-trees-tall');
    const grassy = [], other = [];
    for (const p of byKind.tree) {
      const d = city.districtAt(p.x, p.z);
      (treeModel && (d === 'park' || d === 'suburbs' || d === 'heights') ? grassy : other).push(p);
    }
    if (grassy.length) instancedFromModel(treeModel, grassy, city, propGroup, { targetH: 4.6 });
    if (other.length) {
      const trunk = new THREE.CylinderGeometry(0.22, 0.3, 2.6, 6);
      trunk.translate(0, 1.3, 0);
      instanced(trunk, trunkMat, other);
      const blob = new THREE.IcosahedronGeometry(2.4, 1);
      blob.translate(0, 4.1, 0);
      blob.scale(1, 1.15, 1);
      instanced(blob, leafMat, other, () => 0, true);
    }
  }

  // palm: lean trunk + fan of cones
  if (byKind.palm?.length) {
    const trunk = new THREE.CylinderGeometry(0.14, 0.22, 6.4, 6);
    trunk.translate(0.35, 3.2, 0);
    trunk.rotateZ(-0.1);
    instanced(trunk, trunkMat, byKind.palm);
    const fronds = [];
    for (let i = 0; i < 5; i++) {
      const f = new THREE.ConeGeometry(0.5, 3.4, 4);
      f.translate(0, -1.2, 0);
      f.rotateX(Math.PI * 0.62);
      f.rotateY((i / 5) * Math.PI * 2);
      f.translate(0.55, 6.6, 0);
      fronds.push(f);
    }
    instanced(mergeGeometries(fronds), palmLeafMat, byKind.palm);
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

  if (byKind.bench?.length) {
    const benchModel = assets?.model('bench');
    if (benchModel) {
      instancedFromModel(benchModel, byKind.bench, city, propGroup, { targetW: 2.0 });
    } else {
      const seat = new THREE.BoxGeometry(2.2, 0.1, 0.6); seat.translate(0, 0.55, 0);
      const back = new THREE.BoxGeometry(2.2, 0.5, 0.08); back.translate(0, 0.9, -0.28);
      const legA = new THREE.BoxGeometry(0.1, 0.55, 0.55); legA.translate(-0.9, 0.27, 0);
      const legB = new THREE.BoxGeometry(0.1, 0.55, 0.55); legB.translate(0.9, 0.27, 0);
      instanced(mergeGeometries([seat, back, legA, legB]), woodMat, byKind.bench);
    }
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

  // ---- kaykit street clutter (procedural stand-ins when assets are absent)
  const glbOr = (key, list, opts, fallback) => {
    if (!list?.length) return;
    const m = assets?.model(key);
    if (m) instancedFromModel(m, list, city, propGroup, opts);
    else fallback?.();
  };
  glbOr('firehydrant', byKind.hydrant, { targetH: 0.75 }, () => {
    const g = new THREE.CylinderGeometry(0.14, 0.16, 0.7, 8); g.translate(0, 0.35, 0);
    instanced(g, new THREE.MeshLambertMaterial({ color: 0xb03a2e }), byKind.hydrant);
  });
  glbOr('trash_A', byKind.trash, { targetH: 0.9 }, () => {
    const g = new THREE.CylinderGeometry(0.3, 0.26, 0.85, 8); g.translate(0, 0.42, 0);
    instanced(g, darkGrey, byKind.trash);
  });
  glbOr('dumpster', byKind.dumpster, { targetW: 2.3 }, () => {
    const g = new THREE.BoxGeometry(2.3, 1.3, 1.4); g.translate(0, 0.65, 0);
    instanced(g, new THREE.MeshLambertMaterial({ color: 0x3e5e46 }), byKind.dumpster);
  });
  glbOr('bush', byKind.bush, { targetH: 1.0 }, () => {
    const g = new THREE.IcosahedronGeometry(0.55, 1); g.translate(0, 0.5, 0);
    instanced(g, leafMat, byKind.bush);
  });
  glbOr('trafficlight_A', byKind.trafficlight, { targetH: 5.6 }, () => {
    const pole = new THREE.CylinderGeometry(0.08, 0.1, 5.4, 6); pole.translate(0, 2.7, 0);
    const box = new THREE.BoxGeometry(0.3, 0.8, 0.25); box.translate(0, 5.0, 0);
    instanced(mergeGeometries([pole, box]), darkGrey, byKind.trafficlight);
  });
  if (byKind.planter?.length) {
    // concrete box + shrub
    const boxG = new THREE.BoxGeometry(1.6, 0.5, 0.7); boxG.translate(0, 0.25, 0);
    instanced(boxG, grey, byKind.planter);
    const shrubModel = assets?.model('bush');
    if (shrubModel) instancedFromModel(shrubModel, byKind.planter, city, propGroup, { targetH: 0.8, yOffset: 0.4 });
    else {
      const s = new THREE.IcosahedronGeometry(0.4, 1); s.translate(0, 0.75, 0);
      instanced(s, leafMat, byKind.planter);
    }
  }

  scene.add(propGroup);

  return {
    cityGroup, propGroup, drawCalls,
    setNight(intensity) {
      setNight(intensity);
      if (propDefs.lampHeads) propDefs.lampHeads.mat.emissiveIntensity = intensity * 1.6;
      if (propDefs.lampPools) propDefs.lampPools.mat.opacity = intensity * 0.16;
    },
  };
}
