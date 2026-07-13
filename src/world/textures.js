// All textures in the game are painted onto canvases at boot — no asset files.
// Facade textures tile every 12 m × 12 m (4 window bays × 4 storeys per tile).
// Each facade style has a day map and a night emissive map (lit windows).

import * as THREE from 'three';
import { RNG, hash2i } from '../core/rng.js';

export const FACADE_TILE = 12;   // metres covered by one texture repeat

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function noiseOverlay(ctx, w, h, alpha, rng) {
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let i = 0; i < 220; i++) {
    const g = rng.int(0, 60);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(rng.float(0, w), rng.float(0, h), rng.float(1, 5), rng.float(2, 14));
  }
  ctx.restore();
}

// Paint a 4×4 grid of window bays. Returns list of window rects for the night pass.
function paintWindowGrid(ctx, size, opts) {
  const { wall, frame, glassDay, sillShadow = true, winW = 0.52, winH = 0.5, rng } = opts;
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, size, size);
  noiseOverlay(ctx, size, size, 0.05, rng);
  const bay = size / 4;
  const rects = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const cx = (i + 0.5) * bay, cy = (j + 0.5) * bay;
      const w = bay * winW, h = bay * winH;
      const x = cx - w / 2, y = cy - h / 2;
      ctx.fillStyle = frame;
      ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
      const grad = ctx.createLinearGradient(x, y, x, y + h);
      grad.addColorStop(0, glassDay[0]);
      grad.addColorStop(1, glassDay[1]);
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);
      if (sillShadow) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x - 2, y + h + 2, w + 4, 3);
      }
      rects.push([x, y, w, h]);
    }
  }
  return rects;
}

function paintNightWindows(size, rects, litChance, rng, warm = true) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  for (const [x, y, w, h] of rects) {
    if (rng.chance(litChance)) {
      const warmth = warm ? rng.float(0.75, 1) : rng.float(0.4, 0.7);
      const r = 255, g = Math.floor(190 + 40 * warmth), b = Math.floor(110 + 60 * (1 - warmth));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, y, w, h);
      // soft spill
      ctx.fillStyle = `rgba(${r},${g},${b},0.18)`;
      ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
    }
  }
  return c;
}

// glass curtain-wall (towers): continuous mullion grid
function paintGlassTower(size, tint, rng) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, tint[0]);
  grad.addColorStop(1, tint[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(20,26,34,0.85)';
  ctx.lineWidth = 3;
  const step = size / 8;
  for (let i = 0; i <= 8; i++) {
    ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * step); ctx.lineTo(size, i * step); ctx.stroke();
  }
  // sky reflection streak
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.beginPath();
  ctx.moveTo(size * 0.1, 0); ctx.lineTo(size * 0.35, 0); ctx.lineTo(size * 0.05, size); ctx.lineTo(-size * 0.15, size);
  ctx.closePath(); ctx.fill();
  const rects = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++)
    rects.push([i * step + 3, j * step + 3, step - 6, step - 6]);
  return { canvas: c, rects };
}

const SHOP_WORDS = [
  'CAFE', 'MARKET', 'PAWN', 'DINER', 'BOOKS', 'TOOLS', 'BAR', 'LAUNDRY',
  'TACOS', 'RECORDS', 'BARBER', 'FLOWERS', 'PIZZA', 'NOODLES', 'GYM',
  'TATTOO', 'PHONES', 'SHOES', 'BAKERY', 'DELI', 'GALLERY', 'SURF SHOP',
  'VINYL', 'JEWELERS',
];

function paintShopfront(size, rng, variant = 0) {
  // one tile = a row of 3 storefronts, 3.2 m tall band stretched over tile
  const c = makeCanvas(size, size / 2);
  const ctx = c.getContext('2d');
  const H = size / 2;
  const awn = ['#7a4030', '#3e5e46', '#46507a', '#7a6a34', '#6a3a5e', '#2e6470', '#804828'];
  const walls = ['#4c4640', '#3e3a36', '#564a42'];
  const signCols = ['#efe6d2', '#e8c84a', '#c8e0e8', '#e8b0a0'];
  ctx.fillStyle = walls[variant % walls.length];
  ctx.fillRect(0, 0, size, H);
  const w = size / 3;
  const salt = rng.int(0, 9999) + variant * 313;
  for (let i = 0; i < 3; i++) {
    const x = i * w;
    // window
    ctx.fillStyle = '#182028';
    ctx.fillRect(x + w * 0.08, H * 0.30, w * 0.62, H * 0.62);
    ctx.fillStyle = 'rgba(140,170,190,0.25)';
    ctx.fillRect(x + w * 0.08, H * 0.30, w * 0.62, H * 0.25);
    // door
    ctx.fillStyle = '#241d18';
    ctx.fillRect(x + w * 0.74, H * 0.34, w * 0.18, H * 0.58);
    // awning — striped half the time
    const awnCol = awn[hash2i(i, 3, salt) % awn.length];
    ctx.fillStyle = awnCol;
    ctx.fillRect(x + w * 0.04, H * 0.16, w * 0.7, H * 0.14);
    if (hash2i(i, 11, salt) % 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      for (let sx = 0; sx < w * 0.7; sx += w * 0.1)
        ctx.fillRect(x + w * 0.04 + sx, H * 0.16, w * 0.05, H * 0.14);
    }
    // sign
    ctx.fillStyle = signCols[hash2i(i, 5, salt) % signCols.length];
    ctx.font = `bold ${Math.floor(H * 0.13)}px Arial`;
    ctx.textAlign = 'center';
    ctx.fillText(SHOP_WORDS[hash2i(i, 7, salt) % SHOP_WORDS.length], x + w * 0.4, H * 0.12);
  }
  return c;
}

function tex(canvas, repeat = true) {
  const t = new THREE.CanvasTexture(canvas);
  if (repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}


// derive a tangent-space normal map from a canvas's luminance so window
// frames/ledges read as real relief under sun + headlights
function normalFromCanvas(canvas, strength = 1.6) {
  const s = canvas.width;
  const src = canvas.getContext('2d').getImageData(0, 0, s, s).data;
  const lum = new Float32Array(s * s);
  for (let i = 0; i < s * s; i++) {
    lum[i] = (src[i * 4] * 0.3 + src[i * 4 + 1] * 0.59 + src[i * 4 + 2] * 0.11) / 255;
  }
  const cb = (v) => Math.max(-127, Math.min(127, v));
  const out = document.createElement('canvas');
  out.width = out.height = s;
  const octx = out.getContext('2d');
  const img = octx.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = y * s + x;
      const xl = lum[y * s + ((x - 1 + s) % s)], xr = lum[y * s + ((x + 1) % s)];
      const yu = lum[((y - 1 + s) % s) * s + x], yd = lum[((y + 1) % s) * s + x];
      img.data[i * 4] = 128 + cb((xl - xr) * 127 * strength);
      img.data[i * 4 + 1] = 128 + cb((yd - yu) * 127 * strength);
      img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(out);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------ facade set
export function buildFacadeMaterials(seed = 1) {
  const rng = new RNG(seed * 7 + 5);
  const size = 256;
  const mats = {};
  const nightMats = [];

  function windowStyle(key, opts, litChance = 0.42, warm = true) {
    const day = makeCanvas(size, size);
    const rects = paintWindowGrid(day.getContext('2d'), size, { ...opts, rng });
    const night = paintNightWindows(size, rects, litChance, rng, warm);
    const m = new THREE.MeshStandardMaterial({
      map: tex(day),
      normalMap: normalFromCanvas(day),
      normalScale: new THREE.Vector2(0.55, 0.55),
      emissive: new THREE.Color(0xffffff),
      emissiveMap: tex(night),
      emissiveIntensity: 0,
      roughness: 0.88, metalness: 0.02,
    });
    mats[key] = m;
    nightMats.push(m);
  }

  function glassStyle(key, tint, litChance) {
    const { canvas, rects } = paintGlassTower(size, tint, rng);
    const night = paintNightWindows(size, rects, litChance, rng, false);
    const m = new THREE.MeshStandardMaterial({
      map: tex(canvas),
      emissive: new THREE.Color(0xffffff),
      emissiveMap: tex(night),
      emissiveIntensity: 0,
      roughness: 0.35, metalness: 0.55,
    });
    mats[key] = m;
    nightMats.push(m);
  }

  glassStyle('glassA', ['#5a7d96', '#31465c'], 0.5);
  glassStyle('glassB', ['#4d6455', '#2b3a33'], 0.45);
  windowStyle('office', { wall: '#8d867c', frame: '#3a3a3a', glassDay: ['#2e3d4a', '#1c2732'] }, 0.5);
  windowStyle('concrete', { wall: '#9a948b', frame: '#4a4a48', glassDay: ['#33404a', '#202b34'] }, 0.35);
  windowStyle('brick', { wall: '#8a5a44', frame: '#2f2620', glassDay: ['#38424c', '#232c35'], winW: 0.4, winH: 0.55 }, 0.4);
  windowStyle('stucco', { wall: '#c0a882', frame: '#5a4a38', glassDay: ['#3a444e', '#242e38'], winW: 0.42, winH: 0.5 }, 0.42);
  windowStyle('houseA', { wall: '#b8b09a', frame: '#54483a', glassDay: ['#3c464e', '#28323a'], winW: 0.44, winH: 0.42 }, 0.6);
  windowStyle('houseB', { wall: '#9aa8a0', frame: '#404a44', glassDay: ['#3c464e', '#28323a'], winW: 0.44, winH: 0.42 }, 0.6);
  windowStyle('pastelA', { wall: '#d8b8a0', frame: '#6a5a4c', glassDay: ['#3a4750', '#25303a'] }, 0.55);
  windowStyle('pastelB', { wall: '#b0c4bc', frame: '#4e5e58', glassDay: ['#3a4750', '#25303a'] }, 0.55);
  windowStyle('white', { wall: '#ddd8cc', frame: '#6a665e', glassDay: ['#3a4750', '#25303a'], winW: 0.5, winH: 0.56 }, 0.65);

  // warehouse — corrugated metal, few windows
  {
    const day = makeCanvas(size, size);
    const ctx = day.getContext('2d');
    ctx.fillStyle = '#7e8288';
    ctx.fillRect(0, 0, size, size);
    for (let x = 0; x < size; x += 10) {
      ctx.fillStyle = x % 20 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.12)';
      ctx.fillRect(x, 0, 5, size);
    }
    ctx.fillStyle = 'rgba(120,70,40,0.25)';
    for (let i = 0; i < 12; i++) ctx.fillRect(rng.float(0, size), rng.float(0, size), rng.float(4, 20), rng.float(2, 8));
    const night = makeCanvas(size, size);
    const nctx = night.getContext('2d');
    nctx.fillStyle = '#000'; nctx.fillRect(0, 0, size, size);
    const m = new THREE.MeshStandardMaterial({ map: tex(day), emissive: 0xffffff, emissiveMap: tex(night), emissiveIntensity: 0, roughness: 0.75, metalness: 0.25 });
    mats.metalA = m;
    const m2 = m.clone(); m2.color = new THREE.Color('#8a7a6a');
    mats.metalB = m2;
    nightMats.push(m, m2);
  }

  // barn — red planks
  {
    const day = makeCanvas(size, size);
    const ctx = day.getContext('2d');
    ctx.fillStyle = '#7e3b2e';
    ctx.fillRect(0, 0, size, size);
    for (let x = 0; x < size; x += 16) { ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(x, 0, 2, size); }
    ctx.strokeStyle = '#e8e0d0'; ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, size - 12, size - 12);
    const m = new THREE.MeshStandardMaterial({ map: tex(day), roughness: 0.9 });
    mats.barnred = m;
  }

  // shopfront bands — three variants so streets don't repeat
  for (let variant = 0; variant < 3; variant++) {
    const canvas = paintShopfront(512, rng, variant);
    const night = makeCanvas(512, 256);
    const nctx = night.getContext('2d');
    nctx.fillStyle = '#000'; nctx.fillRect(0, 0, 512, 256);
    const w = 512 / 3;
    for (let i = 0; i < 3; i++) {
      nctx.fillStyle = 'rgba(255,220,150,0.9)';
      nctx.fillRect(i * w + w * 0.08, 256 * 0.30, w * 0.62, 256 * 0.62);
    }
    const m = new THREE.MeshStandardMaterial({ map: tex(canvas), emissive: 0xffffff, emissiveMap: tex(night), emissiveIntensity: 0, roughness: 0.8 });
    mats['shopfront' + variant] = m;
    if (variant === 0) mats.shopfront = m;   // legacy key
    nightMats.push(m);
  }

  // roofs
  mats.roof = new THREE.MeshStandardMaterial({ color: '#55524c', roughness: 0.95 });
  mats.roofShingle = new THREE.MeshStandardMaterial({ color: '#6a4438', roughness: 0.9 });
  mats.roofMetal = new THREE.MeshStandardMaterial({ color: '#66707a', roughness: 0.55, metalness: 0.5 });

  function setNight(intensity) {
    for (const m of nightMats) m.emissiveIntensity = intensity;
  }

  return { mats, setNight };
}

// ------------------------------------------------------------------ ground texture
// A coarse land-colour pass (smooth coastline) scaled up, then crisp roads on top.
export function makeGroundCanvas(city, size = 4096) {
  const { HALF, SPAN } = city;
  const px = (x) => ((x + HALF) / SPAN) * size;
  const scale = size / SPAN;   // px per metre

  // --- coarse base ---
  const base = makeCanvas(512, 512);
  const bctx = base.getContext('2d');
  const bstep = SPAN / 512;
  for (let i = 0; i < 512; i++) {
    for (let j = 0; j < 512; j++) {
      const x = -HALF + (i + 0.5) * bstep;
      const z = -HALF + (j + 0.5) * bstep;
      let col;
      if (!city.landAt(x, z)) col = '#31576e';
      else {
        const d = city.shoreDepth(x, z);
        const dist = city.districtAt(x, z);
        if (d < 55 || dist === 'beach') col = '#cfb98a';           // sand
        else if (dist === 'park') col = '#5e7a48';
        else if (dist === 'farm') col = '#8a814f';
        else if (dist === 'heights') col = '#6f7c52';
        else if (dist === 'suburbs') col = '#7d8560';
        else col = '#6f6d66';                                       // city ground
      }
      bctx.fillStyle = col;
      bctx.fillRect(i, j, 1, 1);
    }
  }

  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, 0, 0, size, size);

  // subtle ground noise
  for (let i = 0; i < 4000; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(x, y, 3, 3);
  }

  // suburb lawns + driveways
  for (const cell of city.cells) {
    if (cell.district !== 'suburbs') continue;
    ctx.fillStyle = 'rgba(96,140,72,0.55)';
    ctx.fillRect(px(cell.lot.x0), px(cell.lot.z0), px(cell.lot.x1) - px(cell.lot.x0), px(cell.lot.z1) - px(cell.lot.z0));
    // driveway strip to the street
    ctx.fillStyle = 'rgba(150,146,138,0.8)';
    const dw = 3 * scale;
    ctx.fillRect(px(cell.lot.x0 + 4), px(cell.z0), dw, px(cell.lot.z0) - px(cell.z0) + 6 * scale);
  }

  // farm furrows
  for (const cell of city.cells) {
    if (cell.district !== 'farm') continue;
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = '#5e5636';
    ctx.lineWidth = Math.max(1, 1.2 * scale);
    for (let z = cell.lot.z0; z < cell.lot.z1; z += 6) {
      ctx.beginPath();
      ctx.moveTo(px(cell.lot.x0), px(z));
      ctx.lineTo(px(cell.lot.x1), px(z));
      ctx.stroke();
    }
    ctx.restore();
  }

  // park paths
  for (const cell of city.cells) {
    if (cell.district !== 'park') continue;
    ctx.strokeStyle = '#b7a988';
    ctx.lineWidth = 2.4 * scale;
    ctx.beginPath();
    ctx.moveTo(px(cell.x0), px((cell.z0 + cell.z1) / 2));
    ctx.lineTo(px(cell.x1), px((cell.z0 + cell.z1) / 2));
    ctx.moveTo(px((cell.x0 + cell.x1) / 2), px(cell.z0));
    ctx.lineTo(px((cell.x0 + cell.x1) / 2), px(cell.z1));
    ctx.stroke();
  }

  // --- sidewalks (light strips wider than the road) ---
  for (const e of city.edges) {
    const w = e.width + city.SIDEWALK * 2;
    ctx.strokeStyle = '#8f8d86';
    ctx.lineWidth = w * scale;
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(px(e.a.x), px(e.a.z));
    ctx.lineTo(px(e.b.x), px(e.b.z));
    ctx.stroke();
  }

  // --- asphalt ---
  for (const e of city.edges) {
    ctx.strokeStyle = e.artery ? '#3a3a3e' : '#434347';
    ctx.lineWidth = e.width * scale;
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(px(e.a.x), px(e.a.z));
    ctx.lineTo(px(e.b.x), px(e.b.z));
    ctx.stroke();
  }

  // --- lane markings ---
  for (const e of city.edges) {
    ctx.strokeStyle = e.artery ? 'rgba(214,180,90,0.85)' : 'rgba(220,220,220,0.5)';
    ctx.lineWidth = Math.max(1, 0.35 * scale);
    ctx.setLineDash([3.2 * scale, 4.2 * scale]);
    ctx.beginPath();
    ctx.moveTo(px(e.a.x), px(e.a.z));
    ctx.lineTo(px(e.b.x), px(e.b.z));
    ctx.stroke();
    ctx.setLineDash([]);
    if (e.artery) {
      // outer lane divider dashes
      const off = e.width * 0.25 * scale;
      ctx.strokeStyle = 'rgba(220,220,220,0.4)';
      ctx.setLineDash([2.4 * scale, 5 * scale]);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        if (e.horizontal) {
          ctx.moveTo(px(e.a.x), px(e.a.z) + off * s);
          ctx.lineTo(px(e.b.x), px(e.b.z) + off * s);
        } else {
          ctx.moveTo(px(e.a.x) + off * s, px(e.a.z));
          ctx.lineTo(px(e.b.x) + off * s, px(e.b.z));
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }

  // --- stop lines at signalled intersections ---
  for (const n of city.nodes.values()) {
    if (!n.hasSignal) continue;
    const rw = city.ROAD_W_ART / 2;
    const stop = rw + 2.6;
    ctx.fillStyle = 'rgba(235,235,235,0.7)';
    // bars across the right-hand approach lane of each arm
    ctx.fillRect(px(n.x + 0.5), px(n.z + stop), (rw - 0.5) * scale, 0.5 * scale);          // south approach (northbound)
    ctx.fillRect(px(n.x - rw), px(n.z - stop - 0.5), (rw - 0.5) * scale, 0.5 * scale);     // north approach
    ctx.fillRect(px(n.x + stop), px(n.z - rw), 0.5 * scale, (rw - 0.5) * scale);           // east approach
    ctx.fillRect(px(n.x - stop - 0.5), px(n.z + 0.5), 0.5 * scale, (rw - 0.5) * scale);    // west approach
  }

  // --- crosswalks at arterial intersections ---
  for (const n of city.nodes.values()) {
    const arts = n.edges.filter((e) => e.artery);
    if (arts.length < 3) continue;
    const cxp = px(n.x), czp = px(n.z);
    const rw = (city.ROAD_W_ART / 2 + 1.2) * scale;
    ctx.fillStyle = 'rgba(228,228,228,0.55)';
    const stripe = 0.55 * scale, gap = 0.55 * scale, len = 3.4 * scale;
    for (const side of [-1, 1]) {
      for (let s = -3; s <= 3; s++) {
        ctx.fillRect(cxp + s * (stripe + gap), czp + side * rw - len / 2, stripe, len);
        ctx.fillRect(cxp + side * rw - len / 2, czp + s * (stripe + gap), len, stripe);
      }
    }
  }

  return c;
}

// ------------------------------------------------------------------ map (minimap + big map)
export function makeMapCanvas(city, size = 1024) {
  const { HALF, SPAN } = city;
  const px = (x) => ((x + HALF) / SPAN) * size;
  const scale = size / SPAN;

  const base = makeCanvas(256, 256);
  const bctx = base.getContext('2d');
  const bstep = SPAN / 256;
  for (let i = 0; i < 256; i++) {
    for (let j = 0; j < 256; j++) {
      const x = -HALF + (i + 0.5) * bstep;
      const z = -HALF + (j + 0.5) * bstep;
      let col = '#5b87a6';
      if (city.landAt(x, z)) {
        const dist = city.districtAt(x, z);
        const dd = city.shoreDepth(x, z);
        if (dd < 45) col = '#e3d3a8';
        else col = ({
          beach: '#e0d2ac', park: '#94b478', farm: '#c0b988', heights: '#a9b18e',
          docks: '#a8a29a', suburbs: '#c8bfa8',
        })[dist] || '#c4bbaa';
      }
      bctx.fillStyle = col;
      bctx.fillRect(i, j, 1, 1);
    }
  }

  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, 0, 0, size, size);

  for (const e of city.edges) {
    ctx.strokeStyle = '#f5f1e6';
    ctx.lineWidth = Math.max(1.5, (e.artery ? e.width + 4 : e.width) * scale * 0.9);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(px(e.a.x), px(e.a.z));
    ctx.lineTo(px(e.b.x), px(e.b.z));
    ctx.stroke();
  }
  // outline roads slightly
  for (const e of city.edges) {
    if (!e.artery) continue;
    ctx.strokeStyle = 'rgba(120,110,90,0.55)';
    ctx.lineWidth = Math.max(1, scale * 1.4);
    ctx.beginPath();
    ctx.moveTo(px(e.a.x), px(e.a.z));
    ctx.lineTo(px(e.b.x), px(e.b.z));
    ctx.stroke();
  }
  return c;
}
