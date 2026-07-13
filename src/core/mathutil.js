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
