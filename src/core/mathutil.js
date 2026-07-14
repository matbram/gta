// Small math helpers shared across the game.

export const TAU = Math.PI * 2;

export function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function unlerp(a, b, v) { return a === b ? 0 : (v - a) / (b - a); }

// frame-rate independent exponential smoothing
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function wrapAngle(a) {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

export function angleLerp(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

export function angleDamp(current, target, lambda, dt) {
  return current + wrapAngle(target - current) * (1 - Math.exp(-lambda * dt));
}

export function dist2d(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

export function distSq2d(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  return dx * dx + dz * dz;
}

// Push a circle (x, z, r) out of an axis-aligned box. Returns null or {x, z, nx, nz, depth}.
export function circleVsAabb(x, z, r, minX, minZ, maxX, maxZ) {
  const cx = clamp(x, minX, maxX);
  const cz = clamp(z, minZ, maxZ);
  const dx = x - cx, dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return null;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    const nx = dx / d, nz = dz / d;
    return { x: cx + nx * r, z: cz + nz * r, nx, nz, depth: r - d };
  }
  // centre inside the box: push out along the smallest axis distance
  const left = x - minX, right = maxX - x, near = z - minZ, far = maxZ - z;
  const m = Math.min(left, right, near, far);
  if (m === left)  return { x: minX - r, z, nx: -1, nz: 0, depth: left + r };
  if (m === right) return { x: maxX + r, z, nx: 1, nz: 0, depth: right + r };
  if (m === near)  return { x, z: minZ - r, nx: 0, nz: -1, depth: near + r };
  return { x, z: maxZ + r, nx: 0, nz: 1, depth: far + r };
}

// Push a circle (x, z, r) out of an oriented box {x, z, hw, hl, heading}.
// Returns null or {x, z, nx, nz, depth} in world space (mirrors circleVsAabb).
export function circleVsObb(px, pz, r, obb) {
  const s = Math.sin(obb.heading), c = Math.cos(obb.heading);
  const dx = px - obb.x, dz = pz - obb.z;
  // into OBB frame: l along the length axis (sin h, cos h), w along width
  const l = dx * s + dz * c;
  const w = dx * c - dz * s;
  const cl = clamp(l, -obb.hl, obb.hl);
  const cw = clamp(w, -obb.hw, obb.hw);
  let nl, nw, depth;
  if (cl !== l || cw !== w) {
    // centre outside: closest point on the box perimeter
    const el = l - cl, ew = w - cw;
    const d2 = el * el + ew * ew;
    if (d2 >= r * r) return null;
    const d = Math.sqrt(d2) || 1e-6;
    nl = el / d; nw = ew / d;
    depth = r - d;
  } else {
    // centre inside: push out along the smallest local-axis penetration
    const pl = obb.hl - Math.abs(l), pw = obb.hw - Math.abs(w);
    if (pw <= pl) { nw = w >= 0 ? 1 : -1; nl = 0; depth = pw + r; }
    else { nl = l >= 0 ? 1 : -1; nw = 0; depth = pl + r; }
  }
  // normal back to world space
  const nx = nl * s + nw * c;
  const nz = nl * c - nw * s;
  return { x: px + nx * depth, z: pz + nz * depth, nx, nz, depth };
}

// 2D oriented-box helpers. An OBB is (cx, cz, hw, hl, heading) where heading is
// the yaw of the +length axis (matches vehicle.heading: forward = (sin h, cos h)).

export function obbCorners(cx, cz, hw, hl, heading, out = new Array(8)) {
  const s = Math.sin(heading), c = Math.cos(heading);
  // length axis L = (s, c), width axis W = (c, -s)
  const lx = s * hl, lz = c * hl;
  const wx = c * hw, wz = -s * hw;
  out[0] = cx + lx + wx; out[1] = cz + lz + wz;
  out[2] = cx + lx - wx; out[3] = cz + lz - wz;
  out[4] = cx - lx - wx; out[5] = cz - lz - wz;
  out[6] = cx - lx + wx; out[7] = cz - lz + wz;
  return out;
}

// project 4 corners onto axis (ax, az), return [min, max]
function projectCorners(corners, ax, az) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < 8; i += 2) {
    const p = corners[i] * ax + corners[i + 1] * az;
    if (p < mn) mn = p;
    if (p > mx) mx = p;
  }
  return [mn, mx];
}

// OBB vs axis-aligned box via SAT (4 axes). Returns null or {nx, nz, depth}
// with the normal pointing from the AABB toward the OBB centre.
export function obbVsAabb(cx, cz, hw, hl, heading, minX, minZ, maxX, maxZ) {
  const s = Math.sin(heading), c = Math.cos(heading);
  const corners = obbCorners(cx, cz, hw, hl, heading);
  let bestDepth = Infinity, bestNx = 0, bestNz = 0;
  const bcx = (minX + maxX) / 2, bcz = (minZ + maxZ) / 2;

  // world axes: use the OBB corners vs box extents
  {
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (let i = 0; i < 8; i += 2) {
      if (corners[i] < mnx) mnx = corners[i];
      if (corners[i] > mxx) mxx = corners[i];
      if (corners[i + 1] < mnz) mnz = corners[i + 1];
      if (corners[i + 1] > mxz) mxz = corners[i + 1];
    }
    const oxDepth = Math.min(mxx, maxX) - Math.max(mnx, minX);
    if (oxDepth <= 0) return null;
    if (oxDepth < bestDepth) { bestDepth = oxDepth; bestNx = cx >= bcx ? 1 : -1; bestNz = 0; }
    const ozDepth = Math.min(mxz, maxZ) - Math.max(mnz, minZ);
    if (ozDepth <= 0) return null;
    if (ozDepth < bestDepth) { bestDepth = ozDepth; bestNx = 0; bestNz = cz >= bcz ? 1 : -1; }
  }

  // OBB axes: project the AABB corners onto L and W
  const aabb = [minX, minZ, maxX, minZ, maxX, maxZ, minX, maxZ];
  const axes = [[s, c, hl], [c, -s, hw]];
  for (const [ax, az, half] of axes) {
    const co = cx * ax + cz * az;
    const [mn, mx] = projectCorners(aabb, ax, az);
    const depth = Math.min(co + half, mx) - Math.max(co - half, mn);
    if (depth <= 0) return null;
    if (depth < bestDepth) {
      bestDepth = depth;
      const sign = co >= (mn + mx) / 2 ? 1 : -1;
      bestNx = ax * sign; bestNz = az * sign;
    }
  }
  return { nx: bestNx, nz: bestNz, depth: bestDepth };
}

// OBB vs OBB via SAT (4 axes). a/b: {x, z, hw, hl, heading}. Returns null or
// {nx, nz, depth} with the normal pointing from b toward a.
export function obbVsObb(a, b) {
  const ca = obbCorners(a.x, a.z, a.hw, a.hl, a.heading);
  const cb = obbCorners(b.x, b.z, b.hw, b.hl, b.heading);
  const sa = Math.sin(a.heading), caH = Math.cos(a.heading);
  const sb = Math.sin(b.heading), cbH = Math.cos(b.heading);
  const axes = [[sa, caH], [caH, -sa], [sb, cbH], [cbH, -sb]];
  let bestDepth = Infinity, bestNx = 0, bestNz = 0;
  for (const [ax, az] of axes) {
    const [amn, amx] = projectCorners(ca, ax, az);
    const [bmn, bmx] = projectCorners(cb, ax, az);
    const depth = Math.min(amx, bmx) - Math.max(amn, bmn);
    if (depth <= 0) return null;
    if (depth < bestDepth) {
      bestDepth = depth;
      const sign = (a.x - b.x) * ax + (a.z - b.z) * az >= 0 ? 1 : -1;
      bestNx = ax * sign; bestNz = az * sign;
    }
  }
  return { nx: bestNx, nz: bestNz, depth: bestDepth };
}

export function formatMoney(n) {
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatClock(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = Math.floor(m % 60);
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

export function formatTimer(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
