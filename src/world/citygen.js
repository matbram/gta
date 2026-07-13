// Procedural city generator for Bayvale.
// Produces: land mask, district lookup, terrain height, road grid + graph,
// building/prop placement lists, static colliders and points of interest.
// Everything is deterministic from one seed.

import { RNG, rand2i, fbm2 } from '../core/rng.js';
import { clamp, lerp } from '../core/mathutil.js';
import { DISTRICTS } from './districts.js';

export const CELL = 76;          // block pitch in metres
export const N = 24;             // cells per side  → world span 1824 m
export const HALF = (N * CELL) / 2;
export const SPAN = N * CELL;
export const ROAD_W_ART = 17;    // arterial road width
export const ROAD_W_LOC = 11;    // local street width
export const SIDEWALK = 3.6;
export const WATER_Y = -1.4;

const ART_EVERY = 4;             // every 4th grid line is an arterial

export function generateCity(seed = 1337) {
  const rng = new RNG(seed);

  // ---------------------------------------------------------------- land + height
  function landAt(x, z) {
    // super-ellipse island with a noisy coastline
    const wob = (fbm2(x * 0.0016 + 40, z * 0.0016 + 40, seed) - 0.5) * 150;
    const a = 880 + wob, b = 880 - wob * 0.6;
    const p = 3.1;
    return Math.pow(Math.abs(x) / a, p) + Math.pow(Math.abs(z) / b, p) < 1;
  }

  // signed-ish distance to shore (positive inland, metres, approximate)
  function shoreDepth(x, z) {
    const step = 22;
    if (!landAt(x, z)) return 0;
    for (let d = 1; d <= 6; d++) {
      const r = d * step;
      if (!landAt(x + r, z) || !landAt(x - r, z) || !landAt(x, z + r) || !landAt(x, z - r) ||
          !landAt(x + r * 0.7, z + r * 0.7) || !landAt(x - r * 0.7, z + r * 0.7) ||
          !landAt(x + r * 0.7, z - r * 0.7) || !landAt(x - r * 0.7, z - r * 0.7)) return r;
    }
    return 999;
  }

  function hillMask(x, z) {
    // hills rise on the northern band (negative z), outside the flat city core
    const t = clamp((-z - 480) / 330, 0, 1);
    const side = clamp(1 - Math.abs(x + 130) / 700, 0, 1);
    return t * t * side;
  }

  function groundHeight(x, z) {
    if (!landAt(x, z)) {
      // sea floor falls away from shore
      return WATER_Y - 4;
    }
    const d = shoreDepth(x, z);
    let h = 0;
    if (d < 70) h = lerp(-2.6, 0, clamp(d / 70, 0, 1));          // beach slope into water
    const hm = hillMask(x, z);
    if (hm > 0) h += hm * (14 + 26 * fbm2(x * 0.004, z * 0.004, seed + 7));
    return h;
  }

  // ---------------------------------------------------------------- districts
  function districtAt(x, z) {
    if (!landAt(x, z)) return 'bay';
    const n = (fbm2(x * 0.004 + 9, z * 0.004 + 9, seed + 3) - 0.5) * 90; // wobble the borders
    const xn = x + n, zn = z + n;
    const d = shoreDepth(x, z);
    if (d < 95 && (x < -300 || z > 430)) return 'beach';               // west + south shoreline
    if (hillMask(x, z) > 0.22) return 'heights';
    if (xn > 330 && zn < -330) return 'farm';
    if (xn >= -190 && xn <= 40 && zn >= 60 && zn <= 290) return 'park';
    if (Math.abs(xn) < 235 && zn > -280 && zn < 45) return 'crown';
    if (Math.abs(xn) < 320 && zn >= 45 && zn < 450) return 'oldtown';
    if (xn > 300 && zn > 180) return 'docks';
    if (xn < -280 && zn > -430 && zn < 380) return 'suburbs';
    return 'midtown';
  }

  // ---------------------------------------------------------------- road grid
  // grid nodes at (i, j): x = -HALF + i*CELL, z = -HALF + j*CELL, i/j ∈ [0, N]
  const nodeX = (i) => -HALF + i * CELL;
  const nodeZ = (j) => -HALF + j * CELL;

  // H[i][j] = road segment from node (i,j) → (i+1,j)  (along +x, on line z = nodeZ(j))
  // V[i][j] = road segment from node (i,j) → (i,j+1)  (along +z, on line x = nodeX(i))
  const H = [], V = [];
  for (let i = 0; i <= N; i++) { H.push(new Array(N + 1).fill(false)); V.push(new Array(N + 1).fill(false)); }

  function segLand(x0, z0, x1, z1) {
    for (let t = 0; t <= 1.0001; t += 0.25) {
      if (!landAt(lerp(x0, x1, t), lerp(z0, z1, t))) return false;
    }
    return true;
  }

  function densityFor(x, z) {
    const d = DISTRICTS[districtAt(x, z)];
    return d ? d.roadDensity : 0;
  }

  for (let i = 0; i < N; i++) {
    for (let j = 0; j <= N; j++) {
      // horizontal segment (i,j)→(i+1,j)
      const x0 = nodeX(i), z0 = nodeZ(j), x1 = nodeX(i + 1);
      if (segLand(x0, z0, x1, z0)) {
        const art = j % ART_EVERY === 0;
        const mx = (x0 + x1) / 2;
        const dens = densityFor(mx, z0);
        if (art ? dens > 0.05 : rand2i(i * 3 + 1, j * 7 + 1, seed + 11) < dens) H[i][j] = true;
      }
    }
  }
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j < N; j++) {
      const x0 = nodeX(i), z0 = nodeZ(j), z1 = nodeZ(j + 1);
      if (segLand(x0, z0, x0, z1)) {
        const art = i % ART_EVERY === 0;
        const mz = (z0 + z1) / 2;
        const dens = densityFor(x0, mz);
        if (art ? dens > 0.05 : rand2i(i * 5 + 2, j * 3 + 2, seed + 23) < dens) V[i][j] = true;
      }
    }
  }

  // park keeps only its border roads (density 0 already blocks interior lines through it)

  // ---------------------------------------------------------------- graph
  // nodes keyed "i,j"; edges have width class + endpoints
  const nodes = new Map();
  const edges = [];
  function getNode(i, j) {
    const k = i + ',' + j;
    let n = nodes.get(k);
    if (!n) { n = { i, j, x: nodeX(i), z: nodeZ(j), edges: [] }; nodes.set(k, n); }
    return n;
  }
  for (let i = 0; i < N; i++) for (let j = 0; j <= N; j++) if (H[i][j]) {
    const a = getNode(i, j), b = getNode(i + 1, j);
    const art = j % ART_EVERY === 0;
    const e = { id: edges.length, a, b, len: CELL, width: art ? ROAD_W_ART : ROAD_W_LOC, artery: art, horizontal: true };
    edges.push(e); a.edges.push(e); b.edges.push(e);
  }
  for (let i = 0; i <= N; i++) for (let j = 0; j < N; j++) if (V[i][j]) {
    const a = getNode(i, j), b = getNode(i, j + 1);
    const art = i % ART_EVERY === 0;
    const e = { id: edges.length, a, b, len: CELL, width: art ? ROAD_W_ART : ROAD_W_LOC, artery: art, horizontal: false };
    edges.push(e); a.edges.push(e); b.edges.push(e);
  }

  // keep only the largest connected component (traffic + routing need connectivity)
  {
    const seen = new Set();
    let best = null;
    for (const n of nodes.values()) {
      const k = n.i + ',' + n.j;
      if (seen.has(k)) continue;
      const comp = [];
      const stack = [n];
      seen.add(k);
      while (stack.length) {
        const cur = stack.pop();
        comp.push(cur);
        for (const e of cur.edges) {
          const other = e.a === cur ? e.b : e.a;
          const ok = other.i + ',' + other.j;
          if (!seen.has(ok)) { seen.add(ok); stack.push(other); }
        }
      }
      if (!best || comp.length > best.length) best = comp;
    }
    const keep = new Set(best.map((n) => n.i + ',' + n.j));
    for (const [k, n] of [...nodes]) {
      if (!keep.has(k)) {
        nodes.delete(k);
        // remove grid flags for dropped segments
        for (const e of n.edges) {
          if (e.horizontal) H[Math.min(e.a.i, e.b.i)][e.a.j] = false;
          else V[e.a.i][Math.min(e.a.j, e.b.j)] = false;
        }
      }
    }
    // rebuild edge list from surviving flags
    edges.length = 0;
    for (const n of nodes.values()) n.edges.length = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j <= N; j++) if (H[i][j]) {
      const a = nodes.get(i + ',' + j), b = nodes.get((i + 1) + ',' + j);
      if (!a || !b) { H[i][j] = false; continue; }
      const art = j % ART_EVERY === 0;
      const e = { id: edges.length, a, b, len: CELL, width: art ? ROAD_W_ART : ROAD_W_LOC, artery: art, horizontal: true };
      edges.push(e); a.edges.push(e); b.edges.push(e);
    }
    for (let i = 0; i <= N; i++) for (let j = 0; j < N; j++) if (V[i][j]) {
      const a = nodes.get(i + ',' + j), b = nodes.get(i + ',' + (j + 1));
      if (!a || !b) { V[i][j] = false; continue; }
      const art = i % ART_EVERY === 0;
      const e = { id: edges.length, a, b, len: CELL, width: art ? ROAD_W_ART : ROAD_W_LOC, artery: art, horizontal: false };
      edges.push(e); a.edges.push(e); b.edges.push(e);
    }
  }

  const roadHalf = (art) => (art ? ROAD_W_ART : ROAD_W_LOC) / 2;

  // ---------------------------------------------------------------- cells & lots
  const cells = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x0 = nodeX(i), z0 = nodeZ(j), x1 = nodeX(i + 1), z1 = nodeZ(j + 1);
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      if (!landAt(cx, cz)) continue;
      const district = districtAt(cx, cz);
      // surrounding roads (N side = smaller z edge etc.)
      const rN = H[i][j], rS = H[i][j + 1], rW = V[i][j], rE = V[i + 1][j];
      const insetW = rW ? roadHalf(i % ART_EVERY === 0) + SIDEWALK : 2;
      const insetE = rE ? roadHalf((i + 1) % ART_EVERY === 0) + SIDEWALK : 2;
      const insetN = rN ? roadHalf(j % ART_EVERY === 0) + SIDEWALK : 2;
      const insetS = rS ? roadHalf((j + 1) % ART_EVERY === 0) + SIDEWALK : 2;
      cells.push({
        i, j, district, cx, cz,
        x0, z0, x1, z1,
        lot: { x0: x0 + insetW, z0: z0 + insetN, x1: x1 - insetE, z1: z1 - insetS },
        hasRoad: rN || rS || rW || rE,
        rN, rS, rW, rE,
      });
    }
  }

  // ---------------------------------------------------------------- colliders (spatial hash)
  const BUCKET = 38;
  const buckets = new Map();
  const boxes = [];   // {id,minX,minZ,maxX,maxZ,h,kind,owner}
  let nextBoxId = 1;
  let queryStamp = 0;
  function bucketKey(bx, bz) { return bx + '|' + bz; }
  function addBox(minX, minZ, maxX, maxZ, h, kind = 'building', owner = null) {
    const box = { id: nextBoxId++, minX, minZ, maxX, maxZ, h, kind, owner, _stamp: 0 };
    boxes.push(box);
    const b0x = Math.floor((minX + HALF) / BUCKET), b1x = Math.floor((maxX + HALF) / BUCKET);
    const b0z = Math.floor((minZ + HALF) / BUCKET), b1z = Math.floor((maxZ + HALF) / BUCKET);
    for (let bx = b0x; bx <= b1x; bx++) for (let bz = b0z; bz <= b1z; bz++) {
      const k = bucketKey(bx, bz);
      let arr = buckets.get(k);
      if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push(box);
    }
    return box;
  }
  function removeBox(box) {
    if (!box) return;
    const b0x = Math.floor((box.minX + HALF) / BUCKET), b1x = Math.floor((box.maxX + HALF) / BUCKET);
    const b0z = Math.floor((box.minZ + HALF) / BUCKET), b1z = Math.floor((box.maxZ + HALF) / BUCKET);
    for (let bx = b0x; bx <= b1x; bx++) for (let bz = b0z; bz <= b1z; bz++) {
      const arr = buckets.get(bucketKey(bx, bz));
      if (!arr) continue;
      const i = arr.indexOf(box);
      if (i !== -1) arr.splice(i, 1);
    }
    const i = boxes.indexOf(box);
    if (i !== -1) boxes.splice(i, 1);
  }
  function queryColliders(x, z, r = 2) {
    const out = [];
    const stamp = ++queryStamp;
    const b0x = Math.floor((x - r + HALF) / BUCKET), b1x = Math.floor((x + r + HALF) / BUCKET);
    const b0z = Math.floor((z - r + HALF) / BUCKET), b1z = Math.floor((z + r + HALF) / BUCKET);
    for (let bx = b0x; bx <= b1x; bx++) for (let bz = b0z; bz <= b1z; bz++) {
      const arr = buckets.get(bucketKey(bx, bz));
      if (arr) for (const b of arr) if (b._stamp !== stamp) { b._stamp = stamp; out.push(b); }
    }
    return out;
  }

  // ---------------------------------------------------------------- buildings & props
  const buildings = []; // {kind, style, x, z, w, d, h, district}   axis-aligned
  const props = [];     // {kind, x, z, rot, s}
  const doors = [];     // enterable shopfronts: {id, x, z, face} (face = outward z sign)

  function addBuilding(kind, style, x, z, w, d, h, district, collide = true) {
    const b = { kind, style, x, z, w, d, h, district, box: null };
    buildings.push(b);
    if (collide) b.box = addBox(x - w / 2, z - d / 2, x + w / 2, z + d / 2, h, 'building', b);
    return b;
  }

  const cellRng = (c, salt) => new RNG(rand2i(c.i * 13 + salt, c.j * 31 + salt, seed + 77) * 4294967296);

  for (const c of cells) {
    const lot = c.lot;
    const lw = lot.x1 - lot.x0, ld = lot.z1 - lot.z0;
    if (lw < 8 || ld < 8) continue;
    const r = cellRng(c, 1);
    const cx = (lot.x0 + lot.x1) / 2, cz = (lot.z0 + lot.z1) / 2;

    switch (c.district) {
      case 'crown': {
        // 1–2 towers + plaza
        const n = c.hasRoad ? r.int(1, 2) : 1;
        for (let k = 0; k < n; k++) {
          const w = r.float(20, Math.min(34, lw * 0.44));
          const d = r.float(20, Math.min(34, ld * 0.44));
          const px = n === 1 ? cx : lot.x0 + lw * (0.27 + 0.46 * k) ;
          const pz = n === 1 ? cz : lot.z0 + ld * (0.27 + 0.46 * ((k + c.i) % 2));
          const h = r.float(38, 105);
          addBuilding('tower', r.int(0, 2), px, pz, w, d, h, c.district);
        }
        if (r.chance(0.5)) props.push({ kind: 'lamp', x: lot.x0 + 4, z: lot.z0 + 4, rot: 0, s: 1 });
        break;
      }
      case 'oldtown':
      case 'midtown': {
        // perimeter blocks of mid-rise commercial buildings
        const rows = [];
        let x = lot.x0;
        while (x < lot.x1 - 10) {
          const w = Math.min(r.float(13, 22), lot.x1 - x);
          rows.push({ x: x + w / 2, w });
          x += w + r.float(0.5, 2);
        }
        for (const seg of rows) {
          const d = r.float(12, Math.min(20, ld * 0.42));
          const h = r.float(8, c.district === 'oldtown' ? 17 : 24);
          // north strip — enterable store door on the street face
          addBuilding('block', r.int(0, 3), seg.x, lot.z0 + d / 2, seg.w, d, h, c.district);
          if (c.rN) doors.push({ id: doors.length, x: seg.x, z: lot.z0 - 0.6, face: -1 });
          // south strip (sometimes)
          if (ld > 34 && r.chance(0.85)) {
            const d2 = r.float(12, Math.min(20, ld * 0.42));
            addBuilding('block', r.int(0, 3), seg.x, lot.z1 - d2 / 2, seg.w, d2, r.float(8, 20), c.district);
            if (c.rS) doors.push({ id: doors.length, x: seg.x, z: lot.z1 + 0.6, face: 1 });
          }
        }
        if (r.chance(0.4)) props.push({ kind: 'tree', x: cx, z: cz, rot: r.float(0, 6.28), s: r.float(0.8, 1.2) });
        break;
      }
      case 'suburbs': {
        // little houses with yards + trees
        const nx = Math.max(1, Math.floor(lw / 17)), nz = Math.max(1, Math.floor(ld / 17));
        for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) {
          if (!r.chance(0.8)) continue;
          const px = lot.x0 + (ix + 0.5) * (lw / nx) + r.float(-2, 2);
          const pz = lot.z0 + (iz + 0.5) * (ld / nz) + r.float(-2, 2);
          addBuilding('house', r.int(0, 3), px, pz, r.float(7.5, 10), r.float(7, 9.5), r.float(4, 5.4), c.district);
          if (r.chance(0.6)) props.push({ kind: 'tree', x: px + r.float(-7, 7), z: pz + r.float(-7, 7), rot: r.float(0, 6.28), s: r.float(0.7, 1.15) });
        }
        break;
      }
      case 'docks': {
        const n = r.int(1, 2);
        for (let k = 0; k < n; k++) {
          const w = r.float(24, Math.min(44, lw * 0.8));
          const d = r.float(16, Math.min(30, ld * 0.44));
          const pz = n === 1 ? cz : lot.z0 + ld * (0.26 + 0.48 * k);
          addBuilding('warehouse', r.int(0, 1), cx + r.float(-4, 4), pz, w, d, r.float(9, 14), c.district);
        }
        // container stacks
        const stacks = r.int(1, 4);
        for (let k = 0; k < stacks; k++) {
          const px = r.float(lot.x0 + 4, lot.x1 - 4), pz = r.float(lot.z0 + 3, lot.z1 - 3);
          props.push({ kind: 'container', x: px, z: pz, rot: r.chance(0.5) ? 0 : Math.PI / 2, s: 1 });
        }
        if (r.chance(0.3)) props.push({ kind: 'crane', x: cx, z: lot.z1 - 6, rot: r.float(0, 6.28), s: 1 });
        break;
      }
      case 'beach': {
        // low hotels or huts on the inland half, palms everywhere
        if (r.chance(0.45) && lw > 20)
          addBuilding('hotel', r.int(0, 1), cx, lot.z0 + ld * 0.3, Math.min(26, lw * 0.6), Math.min(15, ld * 0.4), r.float(7, 13), c.district);
        const palms = r.int(2, 5);
        for (let k = 0; k < palms; k++)
          props.push({ kind: 'palm', x: r.float(lot.x0, lot.x1), z: r.float(lot.z0, lot.z1), rot: r.float(0, 6.28), s: r.float(0.85, 1.25) });
        if (r.chance(0.35)) props.push({ kind: 'hut', x: cx + r.float(-8, 8), z: cz + r.float(-6, 6), rot: r.float(0, 6.28), s: 1 });
        break;
      }
      case 'park': {
        const trees = r.int(5, 9);
        for (let k = 0; k < trees; k++) {
          const px = r.float(lot.x0, lot.x1), pz = r.float(lot.z0, lot.z1);
          props.push({ kind: 'tree', x: px, z: pz, rot: r.float(0, 6.28), s: r.float(0.9, 1.5) });
        }
        for (let k = 0; k < 2; k++)
          props.push({ kind: 'bench', x: r.float(lot.x0, lot.x1), z: r.float(lot.z0, lot.z1), rot: r.float(0, 6.28), s: 1 });
        break;
      }
      case 'heights': {
        if (r.chance(0.7) && lw > 18 && ld > 18) {
          const px = cx + r.float(-6, 6), pz = cz + r.float(-6, 6);
          addBuilding('mansion', r.int(0, 1), px, pz, r.float(14, 20), r.float(11, 16), r.float(6.5, 9), c.district);
          if (r.chance(0.7)) props.push({ kind: 'tree', x: px + r.float(-12, 12), z: pz + r.float(-12, 12), rot: 0, s: r.float(1, 1.4) });
        } else {
          const trees = r.int(2, 5);
          for (let k = 0; k < trees; k++)
            props.push({ kind: 'tree', x: r.float(lot.x0, lot.x1), z: r.float(lot.z0, lot.z1), rot: r.float(0, 6.28), s: r.float(0.9, 1.5) });
        }
        break;
      }
      case 'farm': {
        if (r.chance(0.4)) {
          addBuilding('barn', 0, cx + r.float(-8, 8), cz + r.float(-8, 8), r.float(11, 15), r.float(9, 12), r.float(6, 8), c.district);
          if (r.chance(0.6)) {
            const sx = cx + r.float(-16, 16), sz = cz + r.float(-16, 16);
            props.push({ kind: 'silo', x: sx, z: sz, rot: 0, s: 1 });
          }
        }
        if (r.chance(0.5)) {
          const trees = r.int(1, 3);
          for (let k = 0; k < trees; k++)
            props.push({ kind: 'tree', x: r.float(lot.x0, lot.x1), z: r.float(lot.z0, lot.z1), rot: r.float(0, 6.28), s: r.float(1, 1.6) });
        }
        break;
      }
    }
  }

  // street furniture + greenery along every road (reference look: green streets)
  const TREE_DISTRICTS = { crown: 0.5, oldtown: 0.6, midtown: 0.55, suburbs: 0.85, heights: 0.5, park: 0.9, docks: 0.15, farm: 0.3, beach: 0 };
  for (const e of edges) {
    const mx = (e.a.x + e.b.x) / 2, mz = (e.a.z + e.b.z) / 2;
    const dist = districtAt(mx, mz);
    const beach = dist === 'beach';
    const lampOff = roadHalf(e.artery) + 1.6;
    const treeOff = roadHalf(e.artery) + SIDEWALK + 1.8;

    // lamps/palms on arterials (as before)
    if (e.artery) {
      for (let t = 0.2; t < 0.9; t += 0.3) {
        const x = lerp(e.a.x, e.b.x, t), z = lerp(e.a.z, e.b.z, t);
        const side = t < 0.5 ? 1 : -1;
        const px = e.horizontal ? x : x + lampOff * side;
        const pz = e.horizontal ? z + lampOff * side : z;
        if (!landAt(px, pz)) continue;
        props.push({ kind: beach ? 'palm' : 'lamp', x: px, z: pz, rot: 0, s: 1 });
      }
    }

    // street trees / palms lining both sides
    const treeDens = TREE_DISTRICTS[dist] ?? 0.3;
    if (treeDens > 0.05) {
      for (let t = 0.14; t < 0.92; t += 0.19) {
        for (const side of [-1, 1]) {
          if (rand2i(e.id * 17 + Math.round(t * 100), side * 3, seed + 41) > treeDens) continue;
          const x = lerp(e.a.x, e.b.x, t), z = lerp(e.a.z, e.b.z, t);
          const px = e.horizontal ? x : x + treeOff * side;
          const pz = e.horizontal ? z + treeOff * side : z;
          if (!landAt(px, pz)) continue;
          const palmy = dist === 'crown' || dist === 'midtown'
            ? rand2i(e.id, side * 7, seed + 43) < 0.35 : false;
          props.push({
            kind: beach || palmy ? 'palm' : 'tree',
            x: px, z: pz, rot: rand2i(e.id, side, seed + 44) * 6.28,
            s: 0.85 + rand2i(e.id * 3, side, seed + 45) * 0.4,
          });
        }
      }
    }

    // beach palms line the shore road densely
    if (beach) {
      for (let t = 0.1; t < 0.95; t += 0.13) {
        const side = rand2i(e.id, Math.round(t * 50), seed + 46) < 0.5 ? 1 : -1;
        const x = lerp(e.a.x, e.b.x, t), z = lerp(e.a.z, e.b.z, t);
        const px = e.horizontal ? x : x + treeOff * side;
        const pz = e.horizontal ? z + treeOff * side : z;
        if (landAt(px, pz)) props.push({ kind: 'palm', x: px, z: pz, rot: t * 20, s: 0.9 + rand2i(e.id, t * 99 | 0, seed + 47) * 0.5 });
      }
    }
  }

  // sidewalk clutter: hydrants near intersections, trash by shopfronts,
  // planters downtown, hedges along suburb lots, dumpsters in docks/midtown
  for (const n of nodes.values()) {
    if (rand2i(n.i, n.j, seed + 51) < 0.3 && n.edges.length >= 3) {
      const off = roadHalf(true) + 1.2;
      props.push({ kind: 'hydrant', x: n.x + off, z: n.z + off, rot: 0, s: 1 });
    }
  }
  for (const c of cells) {
    const r2 = cellRng(c, 9);
    if ((c.district === 'oldtown' || c.district === 'midtown') && c.hasRoad) {
      if (r2.chance(0.6)) props.push({ kind: 'trash', x: c.lot.x0 + r2.float(1, 4), z: c.lot.z0 - 1.6, rot: 0, s: 1 });
      if (r2.chance(0.3)) {
        const dx = c.lot.x1 - 2, dz = c.lot.z1 - 2.5;
        props.push({ kind: 'dumpster', x: dx, z: dz, rot: r2.chance(0.5) ? 0 : Math.PI / 2, s: 1 });
      }
    }
    if (c.district === 'crown' && c.hasRoad && r2.chance(0.5)) {
      props.push({ kind: 'planter', x: (c.lot.x0 + c.lot.x1) / 2, z: c.lot.z0 - 1.8, rot: 0, s: 1 });
    }
    if (c.district === 'suburbs' && r2.chance(0.55)) {
      // hedge row along the lot front
      const n = Math.floor((c.lot.x1 - c.lot.x0) / 2.6);
      for (let k = 0; k < Math.min(n, 8); k++) {
        props.push({ kind: 'bush', x: c.lot.x0 + 1.5 + k * 2.6, z: c.lot.z0 + 0.6, rot: 0, s: 0.9 + r2.float(0, 0.4) });
      }
    }
  }

  // traffic lights at arterial×arterial intersections (rendered + obeyed by AI)
  const trafficLights = [];
  for (const n of nodes.values()) {
    const arts = n.edges.filter((e) => e.artery);
    if (arts.length < 3 || n.i % ART_EVERY !== 0 || n.j % ART_EVERY !== 0) continue;
    const off = roadHalf(true) + 1.0;
    // one pole per approach corner, facing incoming traffic
    trafficLights.push({ node: n, x: n.x + off, z: n.z + off, rot: Math.PI });
    trafficLights.push({ node: n, x: n.x - off, z: n.z - off, rot: 0 });
    props.push({ kind: 'trafficlight', x: n.x + off, z: n.z + off, rot: Math.PI, s: 1 });
    props.push({ kind: 'trafficlight', x: n.x - off, z: n.z - off, rot: 0, s: 1 });
    n.hasSignal = true;
  }

  // curb parking slots (consumed by the parked-car system)
  const parkingSlots = [];
  {
    const PARK_DIST = { crown: 0.22, oldtown: 0.3, midtown: 0.28, suburbs: 0.3, docks: 0.18, beach: 0.22, heights: 0.14, farm: 0.06 };
    let slotId = 0;
    for (const e of edges) {
      const mx = (e.a.x + e.b.x) / 2, mz = (e.a.z + e.b.z) / 2;
      const dens = PARK_DIST[districtAt(mx, mz)] ?? 0;
      if (dens <= 0) continue;
      const curb = roadHalf(e.artery) - 1.25;
      for (let t = 0.12; t < 0.9; t += 0.105) {
        for (const side of [-1, 1]) {
          if (rand2i(e.id * 29 + Math.round(t * 200), side * 11, seed + 61) > dens) continue;
          const x = lerp(e.a.x, e.b.x, t), z = lerp(e.a.z, e.b.z, t);
          const px = e.horizontal ? x : x + curb * side;
          const pz = e.horizontal ? z + curb * side : z;
          if (!landAt(px, pz)) continue;
          parkingSlots.push({
            id: slotId++,
            x: px, z: pz,
            heading: e.horizontal ? Math.PI / 2 : 0,
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------- prop colliders
  // Half-extents (pre-rotation) + knock behaviour per prop kind. Every solid
  // street prop stops vehicles; 'knock' kinds break loose on a hard enough hit
  // (handled by the knockables system). Bushes/hedges stay drive-through soft.
  const PROP_PHYS = {
    tree: { hw: 0.35, hd: 0.35, h: 6, scale: true },
    palm: { hw: 0.30, hd: 0.30, h: 7, scale: true },
    lamp: { hw: 0.16, hd: 0.16, h: 7, knock: { minSpeed: 7, fall: true, sparks: true } },
    trafficlight: { hw: 0.16, hd: 0.16, h: 5.5, knock: { minSpeed: 7, fall: true, sparks: true } },
    hydrant: { hw: 0.22, hd: 0.22, h: 0.8, knock: { minSpeed: 4, geyser: true } },
    bench: { hw: 1.10, hd: 0.35, h: 0.95, knock: { minSpeed: 5, topple: true } },
    trash: { hw: 0.30, hd: 0.30, h: 0.9, knock: { minSpeed: 2, topple: true } },
    planter: { hw: 0.85, hd: 0.40, h: 0.55 },
    dumpster: { hw: 1.20, hd: 0.80, h: 1.4 },
    container: { hw: 3.20, hd: 1.40, h: 2.9 },
    silo: { hw: 2.40, hd: 2.40, h: 11 },
    crane: { hw: 1.20, hd: 1.20, h: 15 },
    hut: { hw: 2.20, hd: 2.20, h: 3 },
  };
  for (const p of props) {
    const ph = PROP_PHYS[p.kind];
    if (!ph) continue;
    const sc = ph.scale ? (p.s || 1) : 1;
    const cr = Math.abs(Math.cos(p.rot || 0)), sr = Math.abs(Math.sin(p.rot || 0));
    const ex = (cr * ph.hw + sr * ph.hd) * sc;   // AABB of the rotated footprint
    const ez = (sr * ph.hw + cr * ph.hd) * sc;
    p.box = addBox(p.x - ex, p.z - ez, p.x + ex, p.z + ez, ph.h * sc, 'prop', p);
  }

  // ---------------------------------------------------------------- points of interest
  // Snap POIs onto cells of given district that touch a road.
  function findPoiCell(district, prefer) {
    let best = null, bestScore = -1;
    for (const c of cells) {
      if (c.district !== district || !c.hasRoad) continue;
      const score = 1000 - Math.abs(c.cx - prefer.x) - Math.abs(c.cz - prefer.z);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }
  function poiFromCell(c, name, icon) {
    if (!c) return null;
    // place marker on the sidewalk edge of the lot nearest a road
    return { name, icon, x: (c.lot.x0 + c.lot.x1) / 2, z: c.lot.z0 - 1.5, cell: c };
  }

  const pois = {};
  pois.safehouse   = poiFromCell(findPoiCell('oldtown', { x: 120, z: 380 }), 'Safehouse', 'house');
  pois.taxiDepot   = poiFromCell(findPoiCell('oldtown', { x: -220, z: 200 }), 'Delgado Taxi Co.', 'taxi');
  pois.gunShop     = poiFromCell(findPoiCell('midtown', { x: 260, z: -60 }), 'Bullseye Rounds', 'gun');
  pois.respray     = poiFromCell(findPoiCell('docks', { x: 420, z: 300 }), 'Kandy Kustoms Respray', 'spray');
  pois.hospital    = poiFromCell(findPoiCell('crown', { x: -160, z: -160 }), 'St. Aurora Medical', 'hospital');
  pois.policeHQ    = poiFromCell(findPoiCell('crown', { x: 180, z: -220 }), 'BPD Headquarters', 'police');
  pois.nightclub   = poiFromCell(findPoiCell('crown', { x: 0, z: -60 }), 'The Velvet Iguana', 'club');
  pois.docksWarehouse = poiFromCell(findPoiCell('docks', { x: 560, z: 480 }), 'Pier 9 Warehouse', 'warehouse');
  pois.mansion     = poiFromCell(findPoiCell('heights', { x: -100, z: -700 }), 'Corvo Estate', 'skull');
  pois.foodShop    = poiFromCell(findPoiCell('oldtown', { x: 0, z: 300 }), 'Pronto Burger', 'food');

  // give each POI ground clearance: remove buildings colliding with its marker area
  // (buildings stay, marker sits on sidewalk — nothing to clear with this placement)

  // ---------------------------------------------------------------- helpers exposed
  function nearestNode(x, z) {
    let best = null, bd = Infinity;
    for (const n of nodes.values()) {
      const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  function nearestEdgePoint(x, z) {
    // closest point on any road edge — used for spawning traffic & routing
    let best = null, bd = Infinity;
    for (const e of edges) {
      let px, pz, t;
      if (e.horizontal) {
        t = clamp((x - e.a.x) / (e.b.x - e.a.x), 0, 1);
        px = lerp(e.a.x, e.b.x, t); pz = e.a.z;
      } else {
        t = clamp((z - e.a.z) / (e.b.z - e.a.z), 0, 1);
        px = e.a.x; pz = lerp(e.a.z, e.b.z, t);
      }
      const d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bd) { bd = d; best = { edge: e, x: px, z: pz, t }; }
    }
    return best;
  }

  return {
    seed, CELL, N, HALF, SPAN, WATER_Y,
    ROAD_W_ART, ROAD_W_LOC, SIDEWALK,
    landAt, districtAt, groundHeight, shoreDepth, hillMask,
    H, V, nodeX, nodeZ,
    nodes, edges, cells,
    buildings, props, pois, doors,
    trafficLights, parkingSlots,
    addBox, removeBox, queryColliders, boxes, propPhys: PROP_PHYS,
    nearestNode, nearestEdgePoint,
    roadHalf,
  };
}
