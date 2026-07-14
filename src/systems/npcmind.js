// NPC minds: archetype (role) + personality (per-spawn traits) drive how
// each pedestrian reacts to the world. A brave commuter films a shootout on
// their phone; a timid one runs screaming; an elderly walker cowers; a
// gang member swings back; a vendor calls the police.

import { clamp } from '../core/mathutil.js';

// fightMult scales the fight-or-flight decision when attacked directly:
// thugs and gangsters swing back, joggers and the elderly never do.
// runSpeed (m/s range) makes flight speeds match the body running away.
export const ARCHETYPES = {
  commuter: {
    weight: { crown: 4, oldtown: 3, midtown: 3, suburbs: 2, docks: 1, beach: 1, park: 1, heights: 1, farm: 0.5 },
    walkSpeed: [1.2, 1.7], runSpeed: [5.2, 6.0], scale: [0.97, 1.04],
    tints: [0x8a8f98, 0x4a5a8a, 0x5a4a3a, 0x3a4a44, 0x7a6a5a, 0x9a8a9a],
    bias: { bravery: 0, aggression: 0, curiosity: 0, civic: 0.1 },
    idles: ['phone', 'stand'], fightMult: 1.0,
    look: { topStyle: 'shirt', bottomStyle: 'slacks' },
  },
  tourist: {
    weight: { beach: 4, park: 3, crown: 2, oldtown: 1.5, midtown: 1 },
    walkSpeed: [0.9, 1.3], runSpeed: [4.8, 5.6], scale: [0.96, 1.05],
    tints: [0xd8b060, 0x60b0d8, 0xd86080, 0x80d860, 0xe8e0c0],
    bias: { bravery: -0.05, aggression: -0.2, curiosity: 0.35, civic: 0 },
    idles: ['photo', 'stand', 'phone'], fightMult: 0.7,
    look: { topStyle: 'tee', bottomStyle: 'shorts', sleeves: 'short', print: 'floral' },
  },
  jogger: {
    weight: { beach: 3, park: 3, suburbs: 1.5, heights: 1 },
    walkSpeed: [3.4, 4.2], runSpeed: [6.8, 7.4], scale: [0.98, 1.04],
    tints: [0xe84a4a, 0x4ae8b0, 0xe8e84a, 0xff8830],
    bias: { bravery: 0.05, aggression: -0.1, curiosity: -0.25, civic: -0.1 },
    idles: [], fightMult: 0.4,
    look: { topStyle: 'tee', bottomStyle: 'shorts', sleeves: 'short', hat: null, age: 0.3 },
  },
  elderly: {
    weight: { suburbs: 3, park: 2.5, oldtown: 1.5, beach: 1 },
    walkSpeed: [0.6, 0.9], runSpeed: [2.2, 3.0], scale: [0.92, 0.97],
    tints: [0xb0a890, 0x90a0b0, 0xa090a0, 0x8a8a7a],
    bias: { bravery: -0.3, aggression: -0.3, curiosity: 0.05, civic: 0.25 },
    idles: ['bench', 'stand'], fightMult: 0.2,
    look: { age: 0.85, topStyle: 'shirt', bottomStyle: 'slacks', sleeves: 'long' },
  },
  vendor: {
    weight: { oldtown: 3, midtown: 2.5, beach: 1.5, crown: 1 },
    walkSpeed: [1.0, 1.3], runSpeed: [4.6, 5.4], scale: [0.98, 1.05],
    tints: [0x6a8a5a, 0x8a6a4a, 0x5a6a8a],
    bias: { bravery: 0.05, aggression: 0, curiosity: 0.1, civic: 0.4 },
    idles: ['stand'], fightMult: 1.3,
    look: { uniform: 'vendor', topStyle: 'shirt' }, loiter: true,
  },
  gangster: {
    weight: { docks: 4, heights: 2, midtown: 0.6 },
    walkSpeed: [1.1, 1.5], runSpeed: [5.6, 6.4], scale: [1.0, 1.08],
    tints: [0x5a2430, 0x2a1a3a, 0x3a2a1a, 0x1a1a22],
    bias: { bravery: 0.35, aggression: 0.5, curiosity: -0.1, civic: -0.5 },
    idles: ['stand'], fightMult: 1.7,
    look: { topStyle: 'hoodie', age: 0.3, female: false }, loiter: true, braveChance: 0.75,
  },
  // prowls the sidewalks (no corner loiter — that's the gangsters') and
  // occasionally marks a lone mark for a mugging; cops respond to THEM
  thug: {
    weight: { docks: 2.5, heights: 2, oldtown: 0.8, midtown: 0.6, crown: 0.3 },
    walkSpeed: [1.2, 1.6], runSpeed: [5.8, 6.6], scale: [1.0, 1.06],
    tints: [0x232028, 0x3a2430, 0x2a3038],
    bias: { bravery: 0.3, aggression: 0.6, curiosity: -0.2, civic: -0.6 },
    idles: ['stand'], fightMult: 1.8, braveChance: 0.8,
    look: { topStyle: 'hoodie', age: 0.35, female: false },
  },
};

export function pickArchetype(district, rand = Math.random, hour = 12) {
  let total = 0;
  const entries = [];
  // the city's cast changes with the clock: joggers at dawn, a commuter
  // crush at rush hour, gang corners owning the small hours
  const dawn = hour >= 5 && hour < 9;
  const rush = (hour >= 7 && hour < 9.5) || (hour >= 16 && hour < 18.5);
  const night = hour >= 22 || hour < 5;
  const hourMult = (key) => {
    if (key === 'jogger') return dawn ? 3 : night ? 0.1 : 1;
    if (key === 'commuter') return rush ? 2.2 : night ? 0.5 : 1;
    if (key === 'gangster') return night ? 3 : 1;
    if (key === 'thug') return night ? 2.5 : 0.6;
    if (key === 'tourist' || key === 'elderly') return night ? 0.15 : 1;
    return 1;
  };
  for (const [key, a] of Object.entries(ARCHETYPES)) {
    const w = (a.weight[district] ?? 0.4) * hourMult(key);
    total += w;
    entries.push([key, w]);
  }
  let r = rand() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r <= 0) return key;
  }
  return 'commuter';
}

export function makePersonality(archetype, rand = Math.random) {
  const bias = ARCHETYPES[archetype]?.bias ?? {};
  const trait = (b = 0) => clamp(rand() * 0.7 + 0.15 + b, 0.02, 0.98);
  return {
    bravery: trait(bias.bravery),
    aggression: trait(bias.aggression),
    curiosity: trait(bias.curiosity),
    civic: trait(bias.civic),
  };
}

// A mugger is in your face: fight back, bolt, or hand it over.
// Returns 'fight' | 'flee' | 'comply' — most people comply.
export function reactToMugging(ped) {
  const p = ped.personality;
  if (!p) return 'comply';
  const fm = ARCHETYPES[ped.archetype]?.fightMult ?? 1;
  if (p.aggression * p.bravery * fm > 0.55) return 'fight';
  if (p.bravery > 0.65) return 'flee';
  return 'comply';
}

// Decide how this ped responds to a threat event.
// Returns 'flee' | 'cower' | 'film' | 'fight' | 'call'
export function reactToThreat(ped, distToThreat, directlyTargeted) {
  const p = ped.personality;
  if (!p) return 'flee';
  if (directlyTargeted) {
    // attacked personally: fight or flight, nothing fancy
    return p.aggression * p.bravery > 0.42 ? 'fight' : 'flee';
  }
  const scores = {
    flee: (1 - p.bravery) * 0.9 + 0.25,
    cower: distToThreat < 9 ? (1 - p.bravery) * 0.5 + (ped.archetype === 'elderly' ? 0.55 : 0) : 0,
    film: distToThreat > 11 ? p.curiosity * p.bravery * 1.45 : 0,
    fight: distToThreat < 7 ? p.aggression * p.bravery * (ped.archetype === 'gangster' ? 1.7 : 0.8) : 0,
    call: distToThreat > 8 ? p.civic * 1.15 : 0,
  };
  let best = 'flee', bs = -1;
  for (const [k, v] of Object.entries(scores)) {
    const jitter = v * (0.85 + Math.random() * 0.3);
    if (jitter > bs) { bs = jitter; best = k; }
  }
  return best;
}
