// Parked cars along curbs. Slots come from citygen; cars spawn in a bubble
// around the player and despawn when far. A stolen/moved car frees its slot
// permanently for the session (the city remembers).

import { dist2d, distSq2d } from '../core/mathutil.js';
import { rand2i } from '../core/rng.js';

const SPAWN_R = 170, DESPAWN_R = 220, MAX_ACTIVE = 16;
const TYPES = ['sedan', 'sedan', 'sedan', 'taxi', 'pickup', 'van', 'sports', 'moto'];

export class ParkedCars {
  constructor(game) {
    this.game = game;
    this.active = new Map();     // slotId → vehicle
    this.disturbed = new Set();  // slots whose car was moved/stolen/destroyed
    this.scanT = 0;
  }

  update(dt) {
    this.scanT -= dt;
    if (this.scanT > 0) return;
    this.scanT = 0.7;

    const game = this.game;
    const p = game.player.pos;

    // despawn far, untouched cars; free the slot for respawn
    for (const [slotId, v] of [...this.active]) {
      const d = dist2d(v.pos.x, v.pos.z, p.x, p.z);
      const slot = game.city.parkingSlots[slotId];
      const moved = v.dead || v.driver || distSq2d(v.pos.x, v.pos.z, slot.x, slot.z) > 9;
      if (moved) {
        this.disturbed.add(slotId);
        this.active.delete(slotId);       // vehicle lives on under the vehicle system
        continue;
      }
      if (d > DESPAWN_R) {
        game.vehicles.remove(v);
        this.active.delete(slotId);
      }
    }

    if (this.active.size >= MAX_ACTIVE) return;

    // spawn nearby slots
    for (const slot of game.city.parkingSlots) {
      if (this.active.size >= MAX_ACTIVE) break;
      if (this.active.has(slot.id) || this.disturbed.has(slot.id)) continue;
      const d = dist2d(slot.x, slot.z, p.x, p.z);
      if (d > SPAWN_R || d < 35) continue;
      // don't spawn into another car
      let blocked = false;
      for (const o of game.vehicles.vehicles) {
        if (distSq2d(o.pos.x, o.pos.z, slot.x, slot.z) < 30) { blocked = true; break; }
      }
      if (blocked) continue;
      const type = TYPES[rand2i(slot.id, 7, game.city.seed) * TYPES.length | 0];
      const v = game.vehicles.spawn(type, slot.x, slot.z, slot.heading + (rand2i(slot.id, 3, 1) < 0.5 ? 0 : Math.PI));
      v.parked = true;
      this.active.set(slot.id, v);
    }
  }
}
