// Character atlas painter. One 512² canvas per distinct look — face with
// age/expression, clothing with sleeves/uniforms, hair colour, shoes —
// memoized by look-hash and shared between characters with the same look.
//
// Atlas layout (UV space, v=0 bottom). The geometry in charactermesh.js maps
// body-part rings into these regions; u wraps the circumference with the
// FRONT at u=0.5 of each strip, v runs along the part's length (0 = lower).

import * as THREE from 'three';

export const ATLAS = {
  head: { u0: 0.00, v0: 0.750, u1: 0.50, v1: 1.000 },  // full 360° head strip
  torso: { u0: 0.00, v0: 0.375, u1: 0.50, v1: 0.750 }, // pelvis→shoulders
  arm: { u0: 0.50, v0: 0.500, u1: 0.75, v1: 1.000 },   // shoulder→wrist (both arms)
  leg: { u0: 0.75, v0: 0.500, u1: 1.00, v1: 1.000 },   // hip→ankle (both legs)
  hand: { u0: 0.50, v0: 0.4375, u1: 0.5625, v1: 0.500 },
  shoe: { u0: 0.5625, v0: 0.4375, u1: 0.625, v1: 0.500 },
  hair: { u0: 0.625, v0: 0.4375, u1: 0.6875, v1: 0.500 },
  accent: { u0: 0.6875, v0: 0.4375, u1: 0.75, v1: 0.500 }, // hat / badge / brim
};

const SIZE = 512;

function css(c) { return '#' + new THREE.Color(c).getHexString(); }
function shade(c, f) {
  const col = new THREE.Color(c);
  col.multiplyScalar(f);
  return '#' + col.getHexString();
}

// canvas rect for a region (canvas y=0 is top; UV v=1 is canvas top)
function rect(r) {
  return {
    x: r.u0 * SIZE,
    y: (1 - r.v1) * SIZE,
    w: (r.u1 - r.u0) * SIZE,
    h: (r.v1 - r.v0) * SIZE,
  };
}

// canvas x for wrap-u (0..1) inside a region; canvas y for part-t (0 = v0 bottom)
function rx(reg, u) { return (reg.u0 + u * (reg.u1 - reg.u0)) * SIZE; }
function ry(reg, t) { return (1 - (reg.v0 + t * (reg.v1 - reg.v0))) * SIZE; }

// ---------------------------------------------------------------- painters

function paintHead(ctx, look) {
  const R = rect(ATLAS.head);
  const skin = css(look.skin);
  ctx.fillStyle = skin;
  ctx.fillRect(R.x, R.y, R.w, R.h);

  // gentle top-down shading + jaw shadow
  const grad = ctx.createLinearGradient(0, R.y, 0, R.y + R.h);
  grad.addColorStop(0, 'rgba(0,0,0,0.10)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = grad;
  ctx.fillRect(R.x, R.y, R.w, R.h);

  const age = look.age ?? 0.3;
  const cx = rx(ATLAS.head, 0.5);          // face centre (front)
  const eyeY = ry(ATLAS.head, 0.62);
  const eyeDX = R.w * 0.055;

  // eyes: sclera, iris, pupil — high contrast so they read at street distance
  for (const s of [-1, 1]) {
    const ex = cx + s * eyeDX;
    ctx.fillStyle = '#f7f3ec';
    ctx.beginPath(); ctx.ellipse(ex, eyeY, 9, 5.4, 0, 0, 7); ctx.fill();
    ctx.fillStyle = css(look.eyes ?? 0x4a3624);
    ctx.beginPath(); ctx.arc(ex, eyeY + 0.4, 4.0, 0, 7); ctx.fill();
    ctx.fillStyle = '#12100e';
    ctx.beginPath(); ctx.arc(ex, eyeY + 0.4, 2.1, 0, 7); ctx.fill();
    // lid line
    ctx.strokeStyle = 'rgba(50,32,24,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ex - 9, eyeY - 5); ctx.lineTo(ex + 9, eyeY - 5); ctx.stroke();
  }

  // brows
  ctx.strokeStyle = shade(look.hair ?? 0x2a2018, 0.8);
  ctx.lineWidth = look.female ? 2.2 : 3.4;
  for (const s of [-1, 1]) {
    const ex = cx + s * eyeDX;
    ctx.beginPath();
    ctx.moveTo(ex - 8, eyeY - 9);
    ctx.quadraticCurveTo(ex, eyeY - 12, ex + 8, eyeY - 9);
    ctx.stroke();
  }

  // nose hint
  ctx.strokeStyle = 'rgba(90,55,35,0.4)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, eyeY + 2);
  ctx.lineTo(cx - 2.5, eyeY + 12);
  ctx.lineTo(cx + 2.5, eyeY + 13);
  ctx.stroke();

  // mouth
  const mouthY = ry(ATLAS.head, 0.40);
  ctx.strokeStyle = look.female ? '#9c3d45' : 'rgba(95,45,38,0.95)';
  ctx.lineWidth = look.female ? 5 : 3.4;
  ctx.beginPath();
  ctx.moveTo(cx - 10, mouthY);
  ctx.quadraticCurveTo(cx, mouthY + (age > 0.75 ? -1 : 2.6), cx + 10, mouthY);
  ctx.stroke();

  // age wrinkles
  if (age > 0.6) {
    ctx.strokeStyle = 'rgba(80,50,35,0.35)';
    ctx.lineWidth = 1.2;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + s * (eyeDX + 9), eyeY - 2);
      ctx.lineTo(cx + s * (eyeDX + 13), eyeY + 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + s * 5, mouthY - 12);
      ctx.quadraticCurveTo(cx + s * 11, mouthY - 4, cx + s * 8, mouthY + 4);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - 10, eyeY - 16); ctx.lineTo(cx + 10, eyeY - 16);
    ctx.moveTo(cx - 8, eyeY - 20); ctx.lineTo(cx + 8, eyeY - 20);
    ctx.stroke();
  }

  // stubble / beard band around the jaw and mouth
  if (look.beard) {
    ctx.fillStyle = shade(look.hair ?? 0x2a2018, 0.7);
    ctx.globalAlpha = look.beard === 'full' ? 0.95 : 0.45;
    ctx.fillRect(R.x + R.w * 0.33, mouthY + 6, R.w * 0.34, R.h * 0.22);
    ctx.fillRect(R.x + R.w * 0.33, mouthY - 6, R.w * 0.055, R.h * 0.26); // sideburn L
    ctx.fillRect(R.x + R.w * 0.615, mouthY - 6, R.w * 0.055, R.h * 0.26); // sideburn R
    if (look.beard === 'full') {
      // moustache
      ctx.fillRect(R.x + R.w * 0.42, mouthY - 7, R.w * 0.16, 6);
    }
    ctx.globalAlpha = 1;
  }

  // scalp: hair colour on the top rows + back of the strip (outside the face arc)
  const hairC = css(look.hair ?? 0x2a2018);
  const isBald = look.hairStyle === 'bald';
  const buzz = look.hairStyle === 'buzz' || isBald;
  ctx.fillStyle = hairC;
  ctx.globalAlpha = isBald ? 0 : buzz ? 0.55 : 1;
  if (!isBald) {
    // top rows (crown)
    ctx.fillRect(R.x, R.y, R.w, R.h * 0.14);
    // back of head: u < .3 and u > .7 down to the nape
    ctx.fillRect(R.x, R.y, R.w * 0.26, R.h * (look.female && look.hairStyle !== 'buzz' ? 0.78 : 0.55));
    ctx.fillRect(R.x + R.w * 0.74, R.y, R.w * 0.26, R.h * (look.female && look.hairStyle !== 'buzz' ? 0.78 : 0.55));
    // hairline arc over the face
    ctx.fillRect(R.x + R.w * 0.26, R.y, R.w * 0.48, R.h * (0.16 + (age > 0.7 && !look.female ? -0.06 : 0)));
  }
  ctx.globalAlpha = 1;
}

function paintTorso(ctx, look) {
  const R = rect(ATLAS.torso);
  const top = look.uniform ? UNIFORM_TOP[look.uniform] : css(look.shirt);
  ctx.fillStyle = top;
  ctx.fillRect(R.x, R.y, R.w, R.h);

  // waistband: bottom 10% is trouser colour so shirts tuck believably
  const pants = look.uniform ? UNIFORM_PANTS[look.uniform] : css(look.pants);
  ctx.fillStyle = pants;
  ctx.fillRect(R.x, ry(ATLAS.torso, 0.1), R.w, R.h * 0.1);
  // belt
  ctx.fillStyle = '#241d16';
  ctx.fillRect(R.x, ry(ATLAS.torso, 0.135), R.w, R.h * 0.035);
  ctx.fillStyle = '#c9a94a';
  ctx.fillRect(rx(ATLAS.torso, 0.485), ry(ATLAS.torso, 0.133), R.w * 0.03, R.h * 0.03);

  // side shading (u≈0.25/0.75 are the flanks)
  for (const u of [0.25, 0.75]) {
    const g = ctx.createLinearGradient(rx(ATLAS.torso, u - 0.08), 0, rx(ATLAS.torso, u + 0.08), 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.18)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(rx(ATLAS.torso, u - 0.08), R.y, R.w * 0.16, R.h);
  }

  const cx = rx(ATLAS.torso, 0.5);
  switch (look.uniform) {
    case 'cop': {
      // placket, tie, badge, shoulder patches
      ctx.fillStyle = shade(0x27324a, 0.75);
      ctx.fillRect(cx - 2, R.y, 4, R.h * 0.86);
      ctx.fillStyle = '#141a28';
      ctx.beginPath();
      ctx.moveTo(cx, ry(ATLAS.torso, 0.93));
      ctx.lineTo(cx - 5, ry(ATLAS.torso, 0.80));
      ctx.lineTo(cx, ry(ATLAS.torso, 0.55));
      ctx.lineTo(cx + 5, ry(ATLAS.torso, 0.80));
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#d8c25e';
      ctx.beginPath(); ctx.arc(cx - R.w * 0.10, ry(ATLAS.torso, 0.78), 5, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(216,194,94,0.9)';
      ctx.fillRect(R.x + R.w * 0.02, ry(ATLAS.torso, 0.9), R.w * 0.05, R.h * 0.05);
      ctx.fillRect(R.x + R.w * 0.93, ry(ATLAS.torso, 0.9), R.w * 0.05, R.h * 0.05);
      break;
    }
    case 'fire': {
      // reflective stripes on turnout gear
      ctx.fillStyle = '#cfd8dc';
      ctx.fillRect(R.x, ry(ATLAS.torso, 0.42), R.w, R.h * 0.05);
      ctx.fillStyle = '#f4d03f';
      ctx.fillRect(R.x, ry(ATLAS.torso, 0.40), R.w, R.h * 0.018);
      ctx.fillRect(R.x, ry(ATLAS.torso, 0.455), R.w, R.h * 0.018);
      // front closure clasps
      ctx.fillStyle = '#5d6d7e';
      for (let i = 0; i < 4; i++) ctx.fillRect(cx - 6, ry(ATLAS.torso, 0.82 - i * 0.16), 12, 5);
      break;
    }
    case 'medic': {
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(R.x, ry(ATLAS.torso, 1.0), R.w, R.h * 0.14);        // shoulders red
      const bx = cx - R.w * 0.12, by = ry(ATLAS.torso, 0.72);
      ctx.fillRect(bx - 3, by - 9, 6, 18);                              // cross
      ctx.fillRect(bx - 9, by - 3, 18, 6);
      ctx.fillStyle = '#2c3e50';
      ctx.fillRect(cx - 2, R.y, 4, R.h * 0.86);                         // zip
      break;
    }
    case 'keeper': {
      // apron over the shirt
      ctx.fillStyle = '#7d5a3c';
      ctx.fillRect(R.x + R.w * 0.30, R.y + R.h * 0.08, R.w * 0.40, R.h * 0.8);
      ctx.strokeStyle = '#4a3524';
      ctx.lineWidth = 3;
      ctx.strokeRect(R.x + R.w * 0.30, R.y + R.h * 0.08, R.w * 0.40, R.h * 0.8);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(R.x + R.w * 0.34, ry(ATLAS.torso, 0.42), R.w * 0.32, R.h * 0.12); // pocket
      break;
    }
    default: {
      if (look.topStyle === 'hoodie') {
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(R.x, R.y, R.w, R.h * 0.10);                        // hood shadow
        ctx.fillStyle = shade(look.shirt, 0.8);
        ctx.fillRect(cx - R.w * 0.13, ry(ATLAS.torso, 0.52), R.w * 0.26, R.h * 0.14); // pouch
        ctx.strokeStyle = '#e8e8e8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - 6, R.y + R.h * 0.10); ctx.lineTo(cx - 7, R.y + R.h * 0.28);
        ctx.moveTo(cx + 6, R.y + R.h * 0.10); ctx.lineTo(cx + 7, R.y + R.h * 0.28);
        ctx.stroke();
      } else if (look.topStyle === 'shirt') {
        ctx.fillStyle = shade(look.shirt, 0.82);
        ctx.fillRect(cx - 1.5, R.y + R.h * 0.06, 3, R.h * 0.8);         // placket
        ctx.fillStyle = '#20242a';
        for (let i = 0; i < 5; i++) {
          ctx.beginPath(); ctx.arc(cx, R.y + R.h * (0.14 + i * 0.14), 1.6, 0, 7); ctx.fill();
        }
        // collar
        ctx.fillStyle = shade(look.shirt, 0.9);
        ctx.beginPath();
        ctx.moveTo(cx - 10, R.y + R.h * 0.02); ctx.lineTo(cx, R.y + R.h * 0.1); ctx.lineTo(cx - 16, R.y + R.h * 0.1);
        ctx.closePath(); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx + 10, R.y + R.h * 0.02); ctx.lineTo(cx, R.y + R.h * 0.1); ctx.lineTo(cx + 16, R.y + R.h * 0.1);
        ctx.closePath(); ctx.fill();
      } else if (look.topStyle === 'jacket') {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(cx - 3, R.y + R.h * 0.04, 6, R.h * 0.84);          // open zip
        ctx.fillStyle = shade(look.shirt2 ?? 0xd8d8d8, 1);
        ctx.fillRect(cx - 14, R.y + R.h * 0.06, 11, R.h * 0.8);         // inner tee
        ctx.fillRect(cx + 3, R.y + R.h * 0.06, 11, R.h * 0.8);
      } else if (look.female && look.topStyle === 'tee') {
        // subtle waist shaping shade
        ctx.fillStyle = 'rgba(0,0,0,0.10)';
        ctx.fillRect(R.x, ry(ATLAS.torso, 0.45), R.w, R.h * 0.1);
      }
      // vendor/tourist prints
      if (look.print === 'stripes') {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        for (let i = 0; i < 5; i++) ctx.fillRect(R.x, R.y + R.h * (0.12 + i * 0.16), R.w, R.h * 0.05);
      } else if (look.print === 'floral') {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        for (let i = 0; i < 14; i++) {
          const fx = R.x + ((i * 73) % 97) / 97 * R.w;
          const fy = R.y + R.h * 0.08 + ((i * 41) % 83) / 83 * R.h * 0.75;
          ctx.beginPath(); ctx.arc(fx, fy, 3.2, 0, 7); ctx.fill();
        }
      }
    }
  }

  // underarm AO
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.fillRect(R.x, R.y, R.w, R.h * 0.045);
}

function paintArms(ctx, look) {
  const R = rect(ATLAS.arm);
  const skin = css(look.skin);
  const top = look.uniform ? UNIFORM_TOP[look.uniform] : css(look.shirt);
  const short = !look.uniform && (look.sleeves === 'short');
  // t runs 0=shoulder → 1=wrist, and t=0 is the BOTTOM of the canvas rect
  // (UV v=0 is canvas bottom). Sleeves cover the shoulder end: t < sleeveT.
  ctx.fillStyle = skin;
  ctx.fillRect(R.x, R.y, R.w, R.h);
  ctx.fillStyle = top;
  const sleeveT = look.uniform || look.sleeves === 'long' ? 1.0 : short ? 0.3 : 1.0;
  ctx.fillRect(R.x, R.y + R.h * (1 - sleeveT), R.w, R.h * sleeveT);
  if (sleeveT < 1) {
    ctx.fillStyle = shade(look.shirt, 0.8);
    ctx.fillRect(R.x, R.y + R.h * (1 - sleeveT), R.w, 3);   // hem
  }
  if (look.uniform === 'fire') {
    ctx.fillStyle = '#f4d03f';
    ctx.fillRect(R.x, R.y + R.h * 0.38, R.w, R.h * 0.05);   // stripe near the forearm
    ctx.fillStyle = '#cfd8dc';
    ctx.fillRect(R.x, R.y + R.h * 0.40, R.w, R.h * 0.018);
  }
  if (look.uniform === 'cop') {
    ctx.fillStyle = 'rgba(216,194,94,0.85)';                // shoulder patch
    ctx.fillRect(R.x + R.w * 0.1, R.y + R.h * 0.85, R.w * 0.16, R.h * 0.1);
  }
  // arm shading columns
  const g = ctx.createLinearGradient(R.x, 0, R.x + R.w, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.14)');
  g.addColorStop(0.5, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.14)');
  ctx.fillStyle = g;
  ctx.fillRect(R.x, R.y, R.w, R.h);
}

function paintLegs(ctx, look) {
  const R = rect(ATLAS.leg);
  const skin = css(look.skin);
  const pants = look.uniform ? UNIFORM_PANTS[look.uniform] : css(look.pants);
  ctx.fillStyle = skin;
  ctx.fillRect(R.x, R.y, R.w, R.h);
  // t runs 0=hip → 1=ankle with t=0 at the canvas BOTTOM of the rect;
  // shorts cover the hip end (t < 0.45)
  const hem = look.bottomStyle === 'shorts' && !look.uniform ? 0.45 : 1.0;
  ctx.fillStyle = pants;
  ctx.fillRect(R.x, R.y + R.h * (1 - hem), R.w, R.h * hem);
  if (hem < 1) {
    ctx.fillStyle = shade(look.pants, 0.75);
    ctx.fillRect(R.x, R.y + R.h * (1 - hem), R.w, 3);
  } else if (!look.uniform && look.bottomStyle !== 'slacks') {
    // jeans seams + thigh fade (thighs are near the canvas bottom)
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(R.x + R.w * 0.2, R.y + R.h * 0.55, R.w * 0.6, R.h * 0.35);
    ctx.strokeStyle = 'rgba(230,220,180,0.35)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(rx(ATLAS.leg, 0.25), R.y); ctx.lineTo(rx(ATLAS.leg, 0.25), R.y + R.h);
    ctx.moveTo(rx(ATLAS.leg, 0.75), R.y); ctx.lineTo(rx(ATLAS.leg, 0.75), R.y + R.h);
    ctx.stroke();
  }
  if (look.uniform === 'fire') {
    ctx.fillStyle = '#f4d03f';
    ctx.fillRect(R.x, R.y + R.h * 0.22, R.w, R.h * 0.05);   // shin stripe (t≈0.75)
  }
  if (look.uniform === 'cop') {
    ctx.fillStyle = 'rgba(0,0,0,0.4)';                    // trouser stripe
    ctx.fillRect(rx(ATLAS.leg, 0.235), R.y, 3, R.h);
    ctx.fillRect(rx(ATLAS.leg, 0.765), R.y, 3, R.h);
  }
  const g = ctx.createLinearGradient(R.x, 0, R.x + R.w, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.15)');
  g.addColorStop(0.5, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.15)');
  ctx.fillStyle = g;
  ctx.fillRect(R.x, R.y, R.w, R.h);
}

function paintPatches(ctx, look) {
  // hands (skin), shoes, hair patch, accent patch
  let r = rect(ATLAS.hand);
  ctx.fillStyle = css(look.skin);
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (look.uniform === 'fire') { ctx.fillStyle = '#3b3b3b'; ctx.fillRect(r.x, r.y, r.w, r.h); } // gloves

  r = rect(ATLAS.shoe);
  ctx.fillStyle = css(look.shoes ?? 0x2c2620);
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(r.x, r.y + r.h * 0.75, r.w, r.h * 0.12);   // sole line

  r = rect(ATLAS.hair);
  ctx.fillStyle = css(look.hair ?? 0x2a2018);
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  for (let i = 0; i < 6; i++) ctx.fillRect(r.x + (i / 6) * r.w, r.y, 1.5, r.h); // strands

  r = rect(ATLAS.accent);
  ctx.fillStyle = css(look.accent ?? ACCENT_DEFAULT[look.uniform] ?? look.shirt ?? 0x333333);
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (look.uniform === 'cop') {
    ctx.fillStyle = '#d8c25e';
    ctx.fillRect(r.x + r.w * 0.4, r.y + r.h * 0.4, r.w * 0.2, r.h * 0.25); // cap shield
  }
}

const UNIFORM_TOP = {
  cop: '#27324a', fire: '#b8a83c', medic: '#e8e8ea', keeper: '#5a728a', vendor: '#7a4a2a',
};
const UNIFORM_PANTS = {
  cop: '#1d2536', fire: '#a89838', medic: '#39424e', keeper: '#3a4048', vendor: '#3c342c',
};
const ACCENT_DEFAULT = {
  cop: 0x1d2536, fire: 0xb03a2e, medic: 0xe8e8ea, keeper: 0x7d5a3c, vendor: 0x7a4a2a,
};

// ---------------------------------------------------------------- cache

const texCache = new Map();   // hash → { tex, mat, uses, last }
let cacheTick = 0;
const CACHE_MAX = 280;        // looks in active use stay; idle looks evict LRU
                              // (must exceed the ~200-ped street population,
                              // or the cache thrashes and every spawn repaints
                              // + re-uploads a canvas texture)

function evictIdle() {
  if (texCache.size <= CACHE_MAX) return;
  const idle = [...texCache.entries()]
    .filter(([, e]) => e.uses <= 0)
    .sort((a, b) => a[1].last - b[1].last);
  for (const [hash, e] of idle) {
    if (texCache.size <= CACHE_MAX) break;
    e.tex.dispose();
    e.mat.dispose();
    texCache.delete(hash);
  }
}

// characters call this on dispose so unused looks can be evicted
export function releaseMaterial(mat) {
  const entry = texCache.get(mat?.userData?.lookHash);
  if (entry) entry.uses = Math.max(0, entry.uses - 1);
}

export function lookHash(look) {
  return [
    look.skin, look.shirt, look.pants, look.hair, look.shoes, look.eyes,
    look.female ? 'f' : 'm', look.age?.toFixed(1), look.hairStyle, look.beard,
    look.topStyle, look.bottomStyle, look.sleeves, look.print,
    look.uniform, look.accent,
  ].join('|');
}

export function materialForLook(look) {
  const hash = lookHash(look);
  let entry = texCache.get(hash);
  if (!entry) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#777';
    ctx.fillRect(0, 0, SIZE, SIZE);
    paintHead(ctx, look);
    paintTorso(ctx, look);
    paintArms(ctx, look);
    paintLegs(ctx, look);
    paintPatches(ctx, look);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.86, metalness: 0.0, envMapIntensity: 0.35,
    });
    mat.userData.lookHash = hash;
    entry = { tex, mat, uses: 0, last: 0 };
    texCache.set(hash, entry);
  }
  entry.uses++;
  entry.last = ++cacheTick;
  evictIdle();
  return entry.mat;
}

export function textureCacheSize() { return texCache.size; }
