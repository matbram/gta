// PedSystem: spawns pedestrians on sidewalks around the player,
// runs their brains, handles run-overs, panic waves and cleanup.

import { Ped, randomLook } from '../entities/ped.js';
import { enrichLook } from '../entities/humanoid.js';
import { dist2d, distSq2d, clamp } from '../core/mathutil.js';
import { ARCHETYPES, pickArchetype, makePersonality } from './npcmind.js';

const TARGET_PEDS = 60;
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

    // slow scanner: brandished weapons and corpse discovery (0.5s cadence)
    this.scanT = (this.scanT ?? 0) - dt;
    if (this.scanT <= 0) {
      this.scanT = 0.5;
      this.senseScan();
    }

    // refresh the ring of edges we can actually spawn on (near-100% hit
    // rate vs sampling the whole 1.8km map)
    this.edgeCacheT = (this.edgeCacheT ?? 0) - dt;
    if (this.edgeCacheT <= 0) {
      this.edgeCacheT = 1.5;
      this.nearEdges = game.city.edges.filter((e) => {
        const mx = (e.a.x + e.b.x) / 2, mz = (e.a.z + e.b.z) / 2;
        return dist2d(mx, mz, p.x, p.z) < SPAWN_MAX + e.len / 2;
      });
    }

    // spawn up to target count — the streets thin out deep at night and in rain
    this.spawnTimer -= dt;
    const density = this.densityAt(p.x, p.z);
    const hour = (game.dayNight?.minutes ?? 720) / 60;
    const nightThin = (hour >= 23 || hour < 5) ? 0.45 : 1;
    const rainThin = game.weather?.state === 'rain' ? 0.65 : 1;
    const want = Math.round(TARGET_PEDS * clamp(density + 0.25, 0.3, 1) * nightThin * rainThin);
    if (this.peds.length < want && this.spawnTimer <= 0) {
      // burst-fill when the street is under half strength
      this.spawnTimer = this.peds.length < want * 0.5 ? 0.08 : 0.22;
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
          // sprinting into someone: they stumble, protest, and remember you
          if (pl.speed2d > 5.5 && this.game.time - (a._bumpT ?? -9) > 3) {
            a._bumpT = this.game.time;
            a.rig.flinch?.();
            a.bark?.('bark_backoff');
            a.avoidPlayerT = 20;
          }
        }
      }
    }
  }

  trySpawn(p) {
    const city = this.game.city;
    const pool = this.nearEdges?.length ? this.nearEdges : city.edges;
    for (let attempt = 0; attempt < 10; attempt++) {
      const edge = pool[Math.floor(Math.random() * pool.length)];
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

      // role + personality by district and hour
      const district = city.districtAt(x, z);
      const archetype = pickArchetype(district, Math.random, (this.game.dayNight?.minutes ?? 720) / 60);
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

  // ---- senses ------------------------------------------------------
  // a loud event: peds who SEE it panic at once; the rest hear it, turn
  // toward the sound, and react after a beat
  senseEvent(x, z, kind) {
    const R = { gunshot: 34, explosion: 32, crash: 18, scream: 14, alarm: 20 }[kind] ?? 20;
    for (const ped of this.peds) {
      if (ped.dead || ped.inVehicle || ped.state === 'driver') continue;
      const d = dist2d(ped.pos.x, ped.pos.z, x, z);
      if (d > R) continue;
      if (d < 6 || ped.seePoint?.(x, z, { range: R })) ped.panic(x, z);
      else ped.hearThreat(x, z, kind);
    }
  }

  senseScan() {
    const game = this.game;
    const player = game.player;
    if (player.dead || game.state.mode !== 'play') return;

    // brandishing: walking around with a gun out makes people who SEE it
    // nervous — they clear off, and civic types may call it in
    const gunOut = game.combat && !['fists', 'bat'].includes(game.combat.current);
    const onFoot = !player.vehicle && !game.interiors?.playerInside;
    if (gunOut && onFoot) {
      for (const ped of this.peds) {
        if (ped.dead || ped.panicked || ped.alarm || ped.isCop) continue;
        if ((ped._waryT ?? 0) > game.time) continue;
        const d = dist2d(ped.pos.x, ped.pos.z, player.pos.x, player.pos.z);
        if (d > 14 || !ped.seePoint(player.pos.x, player.pos.z, { range: 14 })) continue;
        ped._waryT = game.time + 8;
        const P = ped.personality ?? {};
        if ((P.civic ?? 0) > 0.65 && Math.random() < 0.4) {
          ped.fleeFrom.x = player.pos.x; ped.fleeFrom.z = player.pos.z;
          ped.panicked = true; ped.state = 'call'; ped.callT = 0; ped.stateT = 0;
          ped.bark('bark_help');
        } else if ((P.bravery ?? 0) < 0.45 || d < 6) {
          ped.fleeFrom.x = player.pos.x; ped.fleeFrom.z = player.pos.z;
          ped.panicked = true; ped.state = 'flee'; ped.stateT = 4;   // short scurry
          ped.bark('bark_run');
        }
        // brave ones just stare — the head-tracking already sells it
      }
    }

    // corpse discovery: walking into view of a body is an event
    const corpses = this.peds.filter((c) => c.dead);
    if (corpses.length) {
      for (const ped of this.peds) {
        if (ped.dead || ped.panicked || ped.alarm || ped._sawCorpse) continue;
        for (const c of corpses) {
          const d = dist2d(ped.pos.x, ped.pos.z, c.pos.x, c.pos.z);
          if (d > 10 || !ped.seePoint(c.pos.x, c.pos.z, { range: 10 })) continue;
          ped._sawCorpse = true;
          ped.bark('bark_help');
          if ((ped.personality?.civic ?? 0) > 0.55) {
            ped.fleeFrom.x = c.pos.x; ped.fleeFrom.z = c.pos.z;
            ped.panicked = true; ped.state = 'call'; ped.callT = 0; ped.stateT = 0;
          } else {
            ped.panic(c.pos.x, c.pos.z);
          }
          break;
        }
      }
    }
  }

  // every human a car or blast can hit: civilians, mission goons, foot
  // cops, and fire/medic crews working a scene
  hitTargets() {
    const g = this.game;
    return [
      ...this.peds,
      ...(g.missions?.activeGoons?.() ?? []),
      ...(g.wanted?.footCops ?? []),
      ...(g.dispatch?.crewPeds?.() ?? []),
    ];
  }

  // --- interactions -------------------------------------------------
  panicAt(x, z, radius) {
    for (const ped of this.peds) {
      if (distSq2d(ped.pos.x, ped.pos.z, x, z) < radius * radius) ped.panic(x, z);
    }
  }

  explosionAt(x, z, radius) {
    for (const ped of this.hitTargets()) {
      const d = dist2d(ped.pos.x, ped.pos.z, x, z);
      if (d < radius && !ped.dead) ped.damage((radius - d) * 18, this.game, 'explosion');
    }
    this.senseEvent(x, z, 'explosion');
  }

  checkRunOver(vehicle, speed) {
    for (const ped of this.hitTargets()) {
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
          this.game.wanted?.crime(
            ped.dead ? (ped.isCop ? 'copKill' : 'kill') : (ped.isCop ? 'copAttack' : 'assault'),
            ped.pos.x, ped.pos.z);
        }
      } else if (d < vehicle.radius + 3.2 && speed > 8) {
        ped.panic(vehicle.pos.x, vehicle.pos.z);
      }
    }
  }

  // slow rolling cars shoulder people aside instead of passing through them
  nudgeAside(vehicle, dt) {
    const r = vehicle.radius + 0.45;
    for (const ped of this.hitTargets()) {
      if (ped.dead || ped.inVehicle) continue;
      const d = dist2d(ped.pos.x, ped.pos.z, vehicle.pos.x, vehicle.pos.z);
      if (d >= r || d < 1e-4) continue;
      const push = Math.min(r - d, 3.5 * dt);
      ped.pos.x += (ped.pos.x - vehicle.pos.x) / d * push;
      ped.pos.z += (ped.pos.z - vehicle.pos.z) / d * push;
    }
    const pl = this.game.player;
    if (!pl.vehicle && !pl.dead) {
      const d = dist2d(pl.pos.x, pl.pos.z, vehicle.pos.x, vehicle.pos.z);
      if (d < r && d > 1e-4) {
        const push = Math.min(r - d, 3.5 * dt);
        pl.pos.x += (pl.pos.x - vehicle.pos.x) / d * push;
        pl.pos.z += (pl.pos.z - vehicle.pos.z) / d * push;
      }
    }
  }

  // driver pulled out during a carjack becomes a fleeing ped
  ejectDriver(pedLike, vehicle) {
    if (!pedLike || pedLike === 'player') return;
    const door = vehicle.seatWorldPos();
    // the victim yells — anyone in earshot turns to look
    this.game.audio?.scream?.(door.x, door.z);
    this.senseEvent(door.x, door.z, 'scream');
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
