// PedSystem: spawns pedestrians on sidewalks around the player,
// runs their brains, handles run-overs, panic waves and cleanup.

import { Ped, randomLook } from '../entities/ped.js';
import { enrichLook } from '../entities/humanoid.js';
import { dist2d, distSq2d, clamp } from '../core/mathutil.js';
import { ARCHETYPES, pickArchetype, makePersonality } from './npcmind.js';

const TARGET_PEDS = 40;
const SPAWN_MIN = 55, SPAWN_MAX = 150, DESPAWN = 230;

export class PedSystem {
  constructor(game) {
    this.game = game;
    this.peds = [];
    this.spawnTimer = 0;
  }

  densityAt(x, z) {
    const d = this.game.city.districtAt(x, z);
    return ({
      crown: 1.0, oldtown: 1.0, midtown: 0.9, beach: 0.8, suburbs: 0.55,
      park: 0.6, docks: 0.35, heights: 0.25, farm: 0.15,
    })[d] ?? 0.4;
  }

  update(dt) {
    const game = this.game;
    const p = game.player.pos;

    // spawn up to target count
    this.spawnTimer -= dt;
    const density = this.densityAt(p.x, p.z);
    const want = Math.round(TARGET_PEDS * clamp(density + 0.25, 0.3, 1));
    if (this.peds.length < want && this.spawnTimer <= 0) {
      this.spawnTimer = 0.25;
      this.trySpawn(p);
    }

    // update + cleanup
    for (const ped of [...this.peds]) {
      ped.update(dt, game);
      const d = dist2d(ped.pos.x, ped.pos.z, p.x, p.z);
      if (d > DESPAWN || (ped.dead && ped.removeTimer > 22)) {
        ped.dispose();
        this.peds.splice(this.peds.indexOf(ped), 1);
      }
    }

    this.separate();
  }

  // soft ped-vs-ped (and ped-vs-player) pushout so crowds never merge into
  // one another. Positional only — cheap and stable at ≤41 entities.
  separate() {
    const R = 0.35, RR = (R * 2) * (R * 2);
    const list = this.peds;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.dead || a.noSeparate) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.dead || b.noSeparate) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= RR || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = (R * 2 - d) * 0.5;
        const nx = dx / d, nz = dz / d;
        a.pos.x -= nx * push; a.pos.z -= nz * push;
        b.pos.x += nx * push; b.pos.z += nz * push;
      }
      // keep walkers from standing inside the player too
      const pl = this.game.player;
      if (!pl.dead && !pl.vehicle) {
        const dx = pl.pos.x - a.pos.x, dz = pl.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < RR && d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = (R * 2 - d) * 0.5;
          a.pos.x -= (dx / d) * push;
          a.pos.z -= (dz / d) * push;
        }
      }
    }
  }

  trySpawn(p) {
    const city = this.game.city;
    // sample several random edges — most are outside the spawn ring
    for (let attempt = 0; attempt < 10; attempt++) {
      const edge = city.edges[Math.floor(Math.random() * city.edges.length)];
      const t = Math.random();
      const ex = edge.a.x + (edge.b.x - edge.a.x) * t;
      const ez = edge.a.z + (edge.b.z - edge.a.z) * t;
      const side = Math.random() < 0.5 ? 1 : -1;
      const off = edge.width / 2 + city.SIDEWALK * 0.5;
      const x = edge.horizontal ? ex : ex + off * side;
      const z = edge.horizontal ? ez + off * side : ez;
      const d = dist2d(x, z, p.x, p.z);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;
      if (!city.landAt(x, z)) continue;
      if (Math.random() > this.densityAt(x, z)) continue;

      // role + personality by district
      const district = city.districtAt(x, z);
      const archetype = pickArchetype(district);
      const arch = ARCHETYPES[archetype];
      const look = enrichLook({ ...(arch?.look ?? {}) });
      if (arch?.tints) look.shirt = arch.tints[Math.floor(Math.random() * arch.tints.length)];
      const ped = new Ped(city, this.game.scene, look, {
        archetype, personality: makePersonality(archetype),
      });
      ped.place(x, z);
      if (arch?.loiter) {
        ped.loiter = true;                        // vendors/gangsters hold their corner
      } else {
        ped.setSidewalk(edge, Math.random() < 0.5 ? 1 : -1, side);
      }
      this.peds.push(ped);

      // gangsters hang out in small groups
      if (archetype === 'gangster' && Math.random() < 0.6) {
        for (let k = 0; k < 1 + (Math.random() < 0.4 ? 1 : 0); k++) {
          const gl = enrichLook({ ...(arch?.look ?? {}) });
          gl.shirt = arch.tints[Math.floor(Math.random() * arch.tints.length)];
          const buddy = new Ped(city, this.game.scene, gl, {
            archetype, personality: makePersonality(archetype),
          });
          buddy.place(x + (Math.random() - 0.5) * 4, z + (Math.random() - 0.5) * 4);
          buddy.loiter = true;
          this.peds.push(buddy);
        }
      }
      return;
    }
  }

  // --- interactions -------------------------------------------------
  panicAt(x, z, radius) {
    for (const ped of this.peds) {
      if (distSq2d(ped.pos.x, ped.pos.z, x, z) < radius * radius) ped.panic(x, z);
    }
  }

  explosionAt(x, z, radius) {
    const targets = [...this.peds, ...(this.game.missions?.activeGoons?.() ?? [])];
    for (const ped of targets) {
      const d = dist2d(ped.pos.x, ped.pos.z, x, z);
      if (d < radius && !ped.dead) ped.damage((radius - d) * 18, this.game, 'explosion');
    }
    this.panicAt(x, z, radius * 4);
  }

  checkRunOver(vehicle, speed) {
    const targets = [...this.peds, ...(this.game.missions?.activeGoons?.() ?? [])];
    for (const ped of targets) {
      if (ped.dead) continue;
      const d = dist2d(ped.pos.x, ped.pos.z, vehicle.pos.x, vehicle.pos.z);
      if (d < vehicle.radius + 0.4) {
        if (this.game.time - (ped._lastRunOverT ?? -9) < 0.6) continue;
        ped._lastRunOverT = this.game.time;
        ped.damage(speed * 4.5, this.game, 'runover');
        if (!ped.dead) {
          // knocked aside
          const nx = (ped.pos.x - vehicle.pos.x) / (d || 1);
          const nz = (ped.pos.z - vehicle.pos.z) / (d || 1);
          ped.pos.x += nx * 1.4;
          ped.pos.z += nz * 1.4;
        }
        if (vehicle.driver === 'player' && !ped.isGoon) {
          this.game.wanted?.crime(ped.dead ? 'kill' : 'assault', ped.pos.x, ped.pos.z);
        }
      } else if (d < vehicle.radius + 3.2 && speed > 8) {
        ped.panic(vehicle.pos.x, vehicle.pos.z);
      }
    }
  }

  // driver pulled out during a carjack becomes a fleeing ped
  ejectDriver(pedLike, vehicle) {
    if (!pedLike || pedLike === 'player') return;
    const door = vehicle.seatWorldPos();
    pedLike.inVehicle = null;
    pedLike.state = 'flee';
    pedLike.panicked = true;
    pedLike.stateT = 0;
    pedLike.fleeFrom = { x: vehicle.pos.x, z: vehicle.pos.z };
    pedLike.place(door.x, door.z);
    pedLike.rig.group.visible = true;
    if (!this.peds.includes(pedLike)) this.peds.push(pedLike);
  }

  killInVehicle(pedLike, vehicle = null) {
    if (!pedLike || pedLike === 'player') return;
    if (vehicle) {
      // corpse falls beside the wreck, not at the world origin
      pedLike.place(vehicle.pos.x + 1.2, vehicle.pos.z + 1.2);
    }
    if (!this.peds.includes(pedLike)) {
      pedLike.rig.group.visible = true;
      this.peds.push(pedLike);
    }
    pedLike.die(this.game);
  }

  nearestPed(x, z, maxDist, filter = null) {
    let best = null, bd = maxDist * maxDist;
    for (const ped of this.peds) {
      if (filter && !filter(ped)) continue;
      const d = distSq2d(ped.pos.x, ped.pos.z, x, z);
      if (d < bd) { bd = d; best = ped; }
    }
    return best;
  }
}
