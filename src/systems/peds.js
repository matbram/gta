// PedSystem: spawns pedestrians on sidewalks around the player,
// runs their brains, handles run-overs, panic waves and cleanup.

import { Ped, randomLook } from '../entities/ped.js';
import { dist2d, distSq2d, clamp } from '../core/mathutil.js';

const TARGET_PEDS = 26;
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
  }

  trySpawn(p) {
    const city = this.game.city;
    // pick a random point on a road edge in the ring, offset to the sidewalk
    const edge = city.edges[Math.floor(Math.random() * city.edges.length)];
    const t = Math.random();
    const ex = edge.a.x + (edge.b.x - edge.a.x) * t;
    const ez = edge.a.z + (edge.b.z - edge.a.z) * t;
    const side = Math.random() < 0.5 ? 1 : -1;
    const off = edge.width / 2 + city.SIDEWALK * 0.5;
    const x = edge.horizontal ? ex : ex + off * side;
    const z = edge.horizontal ? ez + off * side : ez;
    const d = dist2d(x, z, p.x, p.z);
    if (d < SPAWN_MIN || d > SPAWN_MAX) return;
    if (!city.landAt(x, z)) return;
    if (Math.random() > this.densityAt(x, z)) return;

    const ped = new Ped(city, this.game.scene, randomLook(Math.random));
    ped.place(x, z);
    this.peds.push(ped);
  }

  // --- interactions -------------------------------------------------
  panicAt(x, z, radius) {
    for (const ped of this.peds) {
      if (distSq2d(ped.pos.x, ped.pos.z, x, z) < radius * radius) ped.panic(x, z);
    }
  }

  explosionAt(x, z, radius) {
    for (const ped of this.peds) {
      const d = dist2d(ped.pos.x, ped.pos.z, x, z);
      if (d < radius) ped.damage((radius - d) * 18, this.game, 'explosion');
    }
    this.panicAt(x, z, radius * 4);
  }

  checkRunOver(vehicle, speed) {
    for (const ped of this.peds) {
      if (ped.dead) continue;
      const d = dist2d(ped.pos.x, ped.pos.z, vehicle.pos.x, vehicle.pos.z);
      if (d < vehicle.radius + 0.4) {
        ped.damage(speed * 4.5, this.game, 'runover');
        if (!ped.dead) {
          // knocked aside
          const nx = (ped.pos.x - vehicle.pos.x) / (d || 1);
          const nz = (ped.pos.z - vehicle.pos.z) / (d || 1);
          ped.pos.x += nx * 1.4;
          ped.pos.z += nz * 1.4;
        }
        if (vehicle.driver === 'player') {
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

  killInVehicle(pedLike) {
    if (!pedLike || pedLike === 'player') return;
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
