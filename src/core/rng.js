// Deterministic seeded RNG (mulberry32) + hashing helpers.
// The whole city is generated from one seed so every playthrough shares the same map.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2i(x, y, seed = 0) {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x9E3779B1);
  h = Math.imul(h ^ (y | 0), 0x85EBCA77);
  h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE3D);
  h ^= h >>> 16;
  return h >>> 0;
}

// hash → [0,1)
export function rand2i(x, y, seed = 0) {
  return hash2i(x, y, seed) / 4294967296;
}

export class RNG {
  constructor(seed) { this.next = mulberry32(seed); }
  float(min = 0, max = 1) { return min + this.next() * (max - min); }
  int(min, max) { return Math.floor(this.float(min, max + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
}

// Smooth value noise in 2D built on the integer hash (no external deps).
export function valueNoise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(xf), v = s(yf);
  const a = rand2i(xi, yi, seed), b = rand2i(xi + 1, yi, seed);
  const c = rand2i(xi, yi + 1, seed), d = rand2i(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm2(x, y, seed = 0, octaves = 4) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + i * 101);
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}
