// PedSystem: spawns pedestrians on sidewalks around the player,
// runs their brains, handles run-overs, panic waves and cleanup.

import { Ped, randomLook } from '../entities/ped.js';
import { enrichLook, budgetLook } from '../entities/humanoid.js';
import { dist2d, distSq2d, clamp } from '../core/mathutil.js';
import { ARCHETYPES, pickArchetype, makePersonality } from './npcmind.js';

// full skinned rigs near the player; the impostor tier (pedimpostors.js)
// extends the crowd to ~1000 total out to 500m
const TARGET_PEDS = 250;
const SPAWN_MIN = 40, SPAWN_MAX = 240, DESPAWN = 300;
const MAX_CORPSES = 15;   // lingering bodies never eat the live population

// coarse neighbor grid: cell size well above 2× the separation radius so
// same-cell + adjacent-cell checks cover every possible overlap
const CELL = 4;
const cellKey = (x, z) => ((Math.floor(x / CELL) + 512) << 11) | (Math.floor(z / CELL) + 512);

export class PedSystem {
  constructor(game) {
    this.game = game;
    this.peds = [];
    this.spawnTimer = 0;
    this._grid = new Map();
    // rotating result buffers: queries can nest (a run-over damages a ped,
    // whose faction assist queries the grid mid-iteration)
    this._nearBufs = [[], [], [], []];
    this._nearBufI = 0;
    this._frame = 0;
  }

  // rebuild the neighbor grid (live, walking peds only — corpses and seated
  // peds are excluded by the same rules the old brute-force loops used)
  buildGrid() {
    const g = this._grid;
    g.clear();
    for (const ped of this.peds) {
      if (ped.dead || ped.inVehicle) continue;
      const key = cellKey(ped.pos.x, ped.pos.z);
      const list = g.get(key);
      if (list) list.push(ped); else g.set(key, [ped]);
    }
  }

  _gridQuery(x, z, r, out) {
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this._grid.get(((cx + 512) << 11) | (cz + 512));
        if (list) for (const p of list) out.push(p);
      }
    }
    return out;
  }

  // civilians only, straight from the grid (senses/panic never provoke
  // cops or goons through this path — they have their own rules)
  nearPeds(x, z, r) {
    const out = this._nearBufs[this._nearBufI = (this._nearBufI + 1) & 3];
    out.length = 0;
    return this._gridQuery(x, z, r, out);
  }

  // live peds within r of (x,z) — via the grid — plus the small dynamic
  // lists (goons, foot cops, dispatch crews) that callers distance-check
  // themselves. Buffers rotate; don't hold a result across nested queries.
  nearTargets(x, z, r) {
    const out = this._nearBufs[this._nearBufI = (this._nearBufI + 1) & 3];
    out.length = 0;
    this._gridQuery(x, z, r, out);
    const g = this.game;
    for (const p of g.missions?.activeGoons?.() ?? []) out.push(p);
    for (const p of g.wanted?.footCops ?? []) out.push(p);
    for (const p of g.dispatch?.crewPeds?.() ?? []) out.push(p);
    return out;
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
    const want = Math.round(TARGET_PEDS * clamp(density + 0.3, 0.45, 1) * nightThin * rainThin
      * (game.gfx?.density ?? 1));
    if (this.peds.length < want && this.spawnTimer <= 0) {
      // burst-fill when the street is under half strength — several per
      // tick so a 200-strong crowd assembles in seconds, not half a minute
      const burst = this.peds.length < want * 0.5;
      this.spawnTimer = burst ? 0.08 : 0.22;
      const n = burst ? 3 : 1;
      for (let i = 0; i < n && this.peds.length < want; i++) this.trySpawn(p);
    }

    // update + cleanup (reverse-index so splices don't need a copy).
    // AI is tick-staggered by distance: full brains every frame near the
    // player, every 2nd frame to 80m, every 4th beyond — skipped frames
    // just integrate motion + animation (the collision query and the state
    // machine are the per-ped costs that matter at crowd scale).
    this._frame++;
    let deadCount = 0, oldestCorpse = null;
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const ped = this.peds[i];
      const d2p = distSq2d(ped.pos.x, ped.pos.z, p.x, p.z);
      const stride = ped.panicked || ped.threat ? 1 : d2p < 30 * 30 ? 1 : d2p < 80 * 80 ? 2 : 4;
      ped._aiAcc = (ped._aiAcc ?? 0) + dt;
      if (stride === 1 || (ped.id + this._frame) % stride === 0) {
        ped.update(ped._aiAcc, game);
        ped._aiAcc = 0;
      } else {
        ped.integrate(dt);
      }
      const d = dist2d(ped.pos.x, ped.pos.z, p.x, p.z);
      if (d > DESPAWN || (ped.dead && ped.removeTimer > 22)) {
        // walkers leaving the bubble become impostors instead of vanishing
        if (!ped.dead && d > DESPAWN) game.impostors?.adopt?.(ped);
        ped.dispose();
        this.peds.splice(i, 1);
      } else if (ped.dead) {
        deadCount++;
        if (!oldestCorpse || ped.removeTimer > oldestCorpse.removeTimer) oldestCorpse = ped;
      }
    }
    // over the corpse cap: fade the oldest early (one per frame is plenty)
    if (deadCount > MAX_CORPSES && oldestCorpse) {
      oldestCorpse.dispose();
      this.peds.splice(this.peds.indexOf(oldestCorpse), 1);
    }

    this.buildGrid();
    this.separate();
  }

  // soft ped-vs-ped (and ped-vs-player) pushout so crowds never merge into
  // one another. Grid-bucketed: only same-cell and adjacent-cell pairs are
  // tested, so cost scales with crowd density instead of population².
  separate() {
    const R = 0.35, RR = (R * 2) * (R * 2);
    const g = this._grid;
    // forward half-neighborhood so every cell pair is visited exactly once
    const NEIGH = [[1, 0], [0, 1], [1, 1], [-1, 1]];
    for (const [key, list] of g) {
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (a.noSeparate) continue;
        for (let j = i + 1; j < list.length; j++) this._pushApart(a, list[j], R, RR);
      }
      const cx = (key >> 11) - 512, cz = (key & 2047) - 512;
      for (const [ox, oz] of NEIGH) {
        const nlist = g.get(((cx + ox + 512) << 11) | (cz + oz + 512));
        if (!nlist) continue;
        for (const a of list) {
          if (a.noSeparate) continue;
          for (const b of nlist) this._pushApart(a, b, R, RR);
        }
      }
    }
    // keep walkers from standing inside the player too (O(n), same
    // entity set as before the grid — civilians only)
    const pl = this.game.player;
    if (!pl.dead && !pl.vehicle) {
      for (const a of this.peds) {
        if (a.dead || a.noSeparate) continue;
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

  _pushApart(a, b, R, RR) {
    if (b.noSeparate) return;
    const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= RR || d2 < 1e-8) return;
    const d = Math.sqrt(d2);
    const push = (R * 2 - d) * 0.5;
    const nx = dx / d, nz = dz / d;
    a.pos.x -= nx * push; a.pos.z -= nz * push;
    b.pos.x += nx * push; b.pos.z += nz * push;
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
      // bias toward the near ring so the street around the player reads
      // flooded — the impostor tier covers the distance anyway
      if (Math.random() > clamp(1 - d / SPAWN_MAX, 0.25, 1)) continue;

      // role + personality by district and hour. Plain civilians draw from
      // the fixed 96-look palette so the character-texture cache always
      // hits at crowd scale; styled archetypes keep their bespoke looks.
      const district = city.districtAt(x, z);
      const archetype = pickArchetype(district, Math.random, (this.game.dayNight?.minutes ?? 720) / 60);
      const arch = ARCHETYPES[archetype];
      const plain = !arch?.look && !arch?.tints;
      const look = plain ? budgetLook() : enrichLook({ ...(arch?.look ?? {}) });
      if (arch?.tints) look.shirt = arch.tints[Math.floor(Math.random() * arch.tints.length)];
      const ped = new Ped(city, this.game.scene, look, {
        archetype, personality: makePersonality(archetype),
        faction: archetype === 'gangster' ? 'gang' : 'civ',
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
            faction: 'gang',
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
  senseEvent(x, z, kind, culprit = 'player') {
    const R = { gunshot: 34, explosion: 32, crash: 18, scream: 14, alarm: 20 }[kind] ?? 20;
    // grid-local: only peds actually within earshot are visited
    for (const ped of this.nearPeds(x, z, R)) {
      if (ped.dead || ped.inVehicle || ped.state === 'driver') continue;
      const d = dist2d(ped.pos.x, ped.pos.z, x, z);
      if (d > R) continue;
      if (d < 6 || ped.seePoint?.(x, z, { range: R })) ped.panic(x, z, false, kind, culprit);
      else ped.hearThreat(x, z, kind, culprit);
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
      for (const ped of this.nearPeds(player.pos.x, player.pos.z, 14)) {
        if (ped.dead || ped.panicked || ped.alarm || ped.isCop) continue;
        if ((ped._waryT ?? 0) > game.time) continue;
        const d = dist2d(ped.pos.x, ped.pos.z, player.pos.x, player.pos.z);
        if (d > 14 || !ped.seePoint(player.pos.x, player.pos.z, { range: 14 })) continue;
        ped._waryT = game.time + 8;
        const P = ped.personality ?? {};
        if ((P.civic ?? 0) > 0.65 && Math.random() < 0.4) {
          ped.fleeFrom.x = player.pos.x; ped.fleeFrom.z = player.pos.z;
          ped.panicked = true; ped.state = 'call'; ped.callT = 0; ped.stateT = 0;
          ped._panicCulprit = 'player';   // they saw YOUR gun
          ped.bark('bark_help');
        } else if ((P.bravery ?? 0) < 0.45 || d < 6) {
          ped.fleeFrom.x = player.pos.x; ped.fleeFrom.z = player.pos.z;
          ped.panicked = true; ped.state = 'flee'; ped.stateT = 4;   // short scurry
          ped.bark('bark_run');
        }
        // brave ones just stare — the head-tracking already sells it
      }
    }

    // corpse discovery: walking into view of a body is an event.
    // Inverted: iterate the ≤15 corpses and grid-query around each —
    // never all-peds × all-corpses.
    const corpses = this.peds.filter((c) => c.dead);
    if (corpses.length) {
      for (const c of corpses) {
        for (const ped of this.nearPeds(c.pos.x, c.pos.z, 10)) {
          if (ped.dead || ped.panicked || ped.alarm || ped._sawCorpse) continue;
          const d = dist2d(ped.pos.x, ped.pos.z, c.pos.x, c.pos.z);
          if (d > 10 || !ped.seePoint(c.pos.x, c.pos.z, { range: 10 })) continue;
          ped._sawCorpse = true;
          ped.bark('bark_help');
          // the caller reports the body they found — who killed it decides
          // whether the police come for the PLAYER or just investigate
          const culprit = c.killedBy ?? 'player';
          if ((ped.personality?.civic ?? 0) > 0.55) {
            ped.fleeFrom.x = c.pos.x; ped.fleeFrom.z = c.pos.z;
            ped.panicked = true; ped.state = 'call'; ped.callT = 0; ped.stateT = 0;
            ped._panicCulprit = culprit;
          } else {
            ped.panic(c.pos.x, c.pos.z, false, null, culprit);
          }
        }
      }
    }
  }

  // every human a car or blast can hit: civilians, mission goons, foot
  // cops, and fire/medic crews working a scene. Memoized per frame — it
  // used to be rebuilt by every vehicle every frame. Treat as read-only.
  hitTargets() {
    const g = this.game;
    if (this._htTime === g.time && this._ht) return this._ht;
    this._htTime = g.time;
    this._ht = [
      ...this.peds,
      ...(g.missions?.activeGoons?.() ?? []),
      ...(g.wanted?.footCops ?? []),
      ...(g.dispatch?.crewPeds?.() ?? []),
    ];
    return this._ht;
  }

  // an impostor walked into the live bubble: promote it to a real ped
  // (called by PedImpostors; returns false when the rig budget is full)
  spawnFromImpostor(rec) {
    if (this.peds.length >= TARGET_PEDS) return false;
    const city = this.game.city;
    const ped = new Ped(city, this.game.scene, budgetLook(rec.lookIdx), {
      archetype: 'commuter', personality: makePersonality('commuter'),
    });
    ped.place(rec.x, rec.z);
    if (rec.edge) ped.setSidewalk(rec.edge, rec.dir, rec.side);
    this.peds.push(ped);
    return true;
  }

  // an NPC committed a witnessed crime: flag them and send a cop after
  // THEM — the player's wanted level is never involved
  reportNpcCrime(perp, kind, x, z) {
    if (!perp || perp.dead) return;
    const level = kind === 'kill' ? 2 : 1;
    if (!perp.criminal || perp.criminal.level < level) perp.criminal = { level, t: 60 };
    else perp.criminal.t = 60;
    const w = this.game.wanted;
    if (!w) return;
    let cop = w.nearestCop?.(x, z, 120);
    if (!cop) cop = w.spawnFootCop?.(false, true);
    if (cop && !cop.npcTarget) cop.npcTarget = perp;
  }

  // --- interactions -------------------------------------------------
  panicAt(x, z, radius, kind = null, culprit = 'player') {
    for (const ped of this.peds) {
      if (distSq2d(ped.pos.x, ped.pos.z, x, z) < radius * radius) {
        ped.panic(x, z, false, kind, culprit);
      }
    }
  }

  explosionAt(x, z, radius, culprit = 'player') {
    for (const ped of this.hitTargets()) {
      const d = dist2d(ped.pos.x, ped.pos.z, x, z);
      if (d < radius && !ped.dead) {
        ped.damage((radius - d) * 18, this.game, 'explosion', null, culprit);
      }
    }
    this.senseEvent(x, z, 'explosion', culprit);
  }

  // vehicles query the grid instead of scanning every human in the city
  // (grid is one frame stale for vehicle systems — peds move <0.1m/frame)
  _vehicleTargets(vehicle, r) {
    if (this._grid.size === 0 && this.peds.length) return this.hitTargets();
    return this.nearTargets(vehicle.pos.x, vehicle.pos.z, r);
  }

  checkRunOver(vehicle, speed) {
    // oriented-box hit test: the old circular test used the vehicle WIDTH as
    // its radius, so the front bumper (half-LENGTH away) never registered and
    // the solid-body resolve made frontal run-overs impossible
    const sinH = Math.sin(vehicle.heading), cosH = Math.cos(vehicle.heading);
    const hitL = vehicle.hl + 0.4, hitW = vehicle.hw + 0.35;
    for (const ped of this._vehicleTargets(vehicle, vehicle.boundR + 3.6)) {
      if (ped.dead) continue;
      const dx = ped.pos.x - vehicle.pos.x, dz = ped.pos.z - vehicle.pos.z;
      const along = dx * sinH + dz * cosH;      // + = ahead of the vehicle
      const side = dx * cosH - dz * sinH;
      if (Math.abs(along) < hitL && Math.abs(side) < hitW) {
        if (this.game.time - (ped._lastRunOverT ?? -9) < 0.6) continue;
        ped._lastRunOverT = this.game.time;
        // impact carries the car's velocity so ragdolls launch with the hit
        const imp = {
          dx: vehicle.vel.x / (speed || 1), dz: vehicle.vel.y / (speed || 1),
          force: Math.min(10, speed * 0.7), up: Math.min(3, 0.6 + speed * 0.18),
          vx: vehicle.vel.x, vz: vehicle.vel.y,
        };
        ped.damage(speed * 4.5, this.game, 'runover', imp,
          vehicle.driver === 'player' ? 'player' : 'ai');
        if (!ped.dead) {
          // knocked aside, out of the box (toward the nearer flank)
          const push = Math.sign(side || 1);
          ped.pos.x += (cosH * push) * 1.4;
          ped.pos.z += (-sinH * push) * 1.4;
        }
        if (vehicle.driver === 'player' && !ped.isGoon) {
          this.game.wanted?.crime(
            ped.dead ? (ped.isCop ? 'copKill' : 'kill') : (ped.isCop ? 'copAttack' : 'assault'),
            ped.pos.x, ped.pos.z);
        }
      } else if (Math.abs(along) < hitL + 3.2 && Math.abs(side) < hitW + 3.2 && speed > 8) {
        ped.panic(vehicle.pos.x, vehicle.pos.z, false, 'runover',
          vehicle.driver === 'player' ? 'player' : 'ai');
      }
    }
  }

  // driver pulled out during a carjack becomes a fleeing ped
  ejectDriver(pedLike, vehicle) {
    if (!pedLike || pedLike === 'player') return;
    const door = vehicle.seatWorldPos();
    // the victim yells — anyone in earshot turns to look. A player carjack
    // is on the player; an AI road-rage bail-out isn't.
    const byPlayer = dist2d(this.game.player.pos.x, this.game.player.pos.z, door.x, door.z) < 4;
    this.game.audio?.scream?.(door.x, door.z);
    this.senseEvent(door.x, door.z, 'scream', byPlayer ? 'player' : 'ai');
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
