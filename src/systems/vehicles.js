// VehicleSystem: owns every vehicle in the world, handles the player's
// driving input, enter/exit/carjack, vehicle-vs-vehicle and vehicle-vs-people
// collisions, damage smoke/fire, explosions and headlights.

import * as THREE from 'three';
import { Vehicle, VEHICLE_TYPES } from '../entities/vehicle.js';
import { clamp, dist2d, distSq2d, lerp, obbVsObb, circleVsObb, circleVsAabb } from '../core/mathutil.js';

// scratch OBBs for the pair loop (no per-pair garbage)
const _oa = { x: 0, z: 0, hw: 0, hl: 0, heading: 0 };
const _ob = { x: 0, z: 0, hw: 0, hl: 0, heading: 0 };
const _solid = { x: 0, z: 0, hw: 0, hl: 0, heading: 0 };

export class VehicleSystem {
  constructor(game) {
    this.game = game;
    this.vehicles = [];
    this.night = 0;
    this.playerControl = { throttle: 0, steer: 0, handbrake: false };
    this.exitRequested = false;
  }

  spawn(type, x, z, heading = 0, colorOverride = null) {
    const v = new Vehicle(type, this.game.city, this.game.scene, colorOverride);
    v.pos.set(x, this.game.city.groundHeight(x, z), z);
    v.heading = heading;
    v.onCrash = (veh, box, impact) => this.handleStaticCrash(veh, box, impact);
    v.syncMesh(0);
    v.setNightLights(this._lightsOn ?? false);
    this.vehicles.push(v);
    return v;
  }

  debugSpawnNear(type = 'sedan') {
    const p = this.game.player.pos;
    const v = this.spawn(type, p.x + 2, p.z + 1.5, this.game.player.heading);
    return v.id;
  }

  // spawn on the nearest road, aligned with it, and put the player at the wheel side
  spawnOnRoadNear(x, z, type = 'sedan', color = null) {
    const ep = this.game.city.nearestEdgePoint(x, z);
    if (!ep) return null;
    const e = ep.edge;
    const heading = e.horizontal ? Math.PI / 2 : 0;
    const off = e.width * 0.24;
    const px = e.horizontal ? ep.x : ep.x - off;
    const pz = e.horizontal ? ep.z + off : ep.z;
    return this.spawn(type, px, pz, heading, color);
  }

  remove(v) {
    if (this.game.player.vehicle === v) this.exitVehicleForced();
    v.dispose();
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
  }

  // vehicle hit a static collider. Returns true if the obstacle broke away
  // (knockable prop) so the car keeps rolling instead of bouncing.
  handleStaticCrash(veh, box, impact) {
    if (box.kind === 'prop' && box.owner) {
      const kn = this.game.city.propPhys?.[box.owner.kind]?.knock;
      if (kn && impact > kn.minSpeed && this.game.knockables?.knock(box.owner, veh)) {
        return true;
      }
    }
    if (impact > 3 && this.game.time - (veh._lastCrashSfxT ?? -9) > 0.25) {
      veh._lastCrashSfxT = this.game.time;
      this.game.audio?.crash?.(impact, veh.pos.x, veh.pos.z);
      if (impact > 7) {
        this.game.peds?.senseEvent?.(veh.pos.x, veh.pos.z, 'crash',
          veh.driver === 'player' ? 'player' : 'ai');
      }
      if (impact > 12) this.game.particles?.glassBurst(veh.pos.x, veh.pos.y + 1.0, veh.pos.z);
      if (veh.driver === 'player') {
        this.game.cameraRig?.addShake(clamp(impact / 18, 0, 0.8));
        if (impact > 12) this.game.voice?.say?.('crash', 0.6);
      }
    }
    return false;
  }

  nearestVehicle(x, z, maxDist = 4, filter = null) {
    let best = null, bd = maxDist * maxDist;
    for (const v of this.vehicles) {
      if (filter && !filter(v)) continue;
      const d = distSq2d(v.pos.x, v.pos.z, x, z);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  // ------------------------------------------------- player enter / exit
  tryEnterExit() {
    const player = this.game.player;
    if (player.dead) return;
    if (player.vehicle) { this.exitVehicle(); return; }

    const v = this.nearestVehicle(player.pos.x, player.pos.z, 4.2, (v) => !v.dead);
    if (!v) return;

    // locked parked cars take a moment to break into
    if (v.locked && !v.driver) {
      if (!this._breakIn || this._breakIn.v !== v) {
        this._breakIn = { v, t: 0.8 };
        this.game.hud?.showToast('Breaking in…', 1.1);
      }
      return;
    }

    // carjack if occupied by AI
    if (v.driver && v.driver !== 'player') {
      const ped = v.driver;
      v.driver = null;
      this.game.peds?.ejectDriver(ped, v);
      this.game.wanted?.crime('carjack', v.pos.x, v.pos.z);
      this.game.state.stats.vehiclesJacked++;
      this.game.voice?.say?.('carjack', 0.6);
    }

    v.driver = 'player';
    v.aiControlled = false;
    v.missionDriven = false;
    v.parked = false;
    player.vehicle = v;
    player.rig.setAnim(v.spec.seat?.pose ?? 'drive');
    // slide into the seat over a beat instead of teleporting
    this._mountT = 0.35;
    this._mountFrom = { x: player.pos.x, y: player.pos.y, z: player.pos.z };
    player.rig.reachGesture?.(0.4);
    player.pos.set(v.pos.x, v.pos.y, v.pos.z);
    this.game.traffic?.releaseVehicle(v);
    this.game.wanted?.releaseCruiser(v);
    this.game.wanted?.onPlayerVehicleChange?.(v);
    this.game.audio?.carDoor();
    this.game.audio?.startEngine();
    if (this.game.audio?.radio?.station >= 0) this.game.audio.radio.resume();
    this.game.hud?.showVehicleName(v.spec.name);
    this.game.cameraRig.snapBehind(v.heading, 0.16);
    if (v.type === 'taxi') this.game.hud?.showToast('Press T to pick up fares.', 4);
  }

  exitVehicle() {
    const player = this.game.player;
    const v = player.vehicle;
    if (!v) return;
    const bailSpeed = Math.abs(v.speed);
    if (bailSpeed > 14) {
      // bail out: hit the pavement rolling, car keeps going
      player.damage(Math.min(25, (bailSpeed - 14) * 1.2), 'bail');
      this.game.cameraRig.addShake(0.5);
      this.game.particles?.dust(v.pos.x, v.pos.y + 0.3, v.pos.z, 6);
    }
    const door = v.seatWorldPos();
    player.vehicle = null;
    v.driver = null;
    player.teleport(door.x, door.z, v.heading);
    player.setVisible(true);
    this.game.audio?.carDoor();
    this.game.audio?.stopEngine();
    this.game.audio?.radio?.stop();
    this.game.cameraRig.snapBehind(v.heading, 0.24);
  }

  // ------------------------------------------------- per-frame
  update(dt) {
    const game = this.game;
    const player = game.player;
    const input = game.input;

    // player driving input
    if (player.vehicle && !player.dead) {
      const v = player.vehicle;
      this.playerControl.throttle = input.axisV();
      this.playerControl.steer = -input.axisH();
      this.playerControl.handbrake = input.down('Space');
      if (input.wasPressed('KeyF') || input.wasPressed('Enter')) this.exitVehicle();
      if (['police', 'ambulance', 'firetruck'].includes(v.type)) {
        // H toggles the siren in emergency vehicles — traffic parts for you
        if (input.wasPressed('KeyH')) {
          v.sirenOn = !v.sirenOn;
          if (v.sirenOn) game.audio?.startSiren(v.id, () => ({ x: v.pos.x, z: v.pos.z }));
          else game.audio?.stopSiren(v.id);
        }
      } else if (input.down('KeyH')) {
        if (!this._hornT || game.time - this._hornT > 0.5) {
          this._hornT = game.time;
          game.audio?.horn(v.pos.x, v.pos.z);
        }
      }
      // radio
      if (input.wasPressed('KeyR')) {
        const name = game.audio?.radio?.cycle();
        if (name) game.hud?.showRadio(name);
      }
      if (v.dead) {
        // burning or drowned → force out
        this.exitVehicleForced();
      } else {
        v.updatePhysics(dt, this.playerControl);
        player.pos.set(v.pos.x, v.pos.y, v.pos.z);
        // visible seated driver at the per-type seat (driver's side, straddle
        // on bikes), lerping in from the door during the mount beat
        player.rig.group.visible = true;
        const seat = v.seatRigWorld();
        if (this._mountT > 0) {
          this._mountT -= dt;
          const k = clamp(1 - this._mountT / 0.35, 0, 1);
          player.rig.group.position.set(
            lerp(this._mountFrom.x, seat.x, k),
            lerp(this._mountFrom.y, seat.y, k),
            lerp(this._mountFrom.z, seat.z, k));
        } else {
          player.rig.group.position.set(seat.x, seat.y, seat.z);
        }
        player.rig.group.rotation.y = v.heading;
        player.rig.update(dt, 0);
        game.state.stats.distanceDriven += Math.abs(v.speed) * dt;
        // engine audio: rpm within the current gear so shifts are audible
        game.audio?.setEngine(v.rpm ?? clamp(Math.abs(v.speed) / v.spec.maxSpeed, 0, 1),
          this.playerControl.throttle > 0, v.gear ?? 0);
        // near-miss whoosh: fast pass close to another car
        if (Math.abs(v.speed) > 14) {
          for (const o of this.vehicles) {
            if (o === v || o.dead) continue;
            const d2 = distSq2d(o.pos.x, o.pos.z, v.pos.x, v.pos.z);
            if (d2 < 12 && d2 > 5 && game.time - (this._nearMissT || -9) > 0.7) {
              this._nearMissT = game.time;
              game.audio?.whoosh?.();
              game.cameraRig.addShake(0.12);
              break;
            }
          }
        }
        // tyre screech + rubber smoke + skid marks on hard slip or burnout
        const burnout = this.playerControl.handbrake && Math.abs(v.speed) > 7;
        if ((Math.abs(v.lateral) > 3.5 && Math.abs(v.speed) > 6) || burnout) {
          game.audio?.screech(v.pos.x, v.pos.z, clamp(Math.abs(v.lateral) / 8, 0.3, 1));
          const bx = -Math.sin(v.heading) * v.spec.l * 0.32;
          const bz = -Math.cos(v.heading) * v.spec.l * 0.32;
          game.particles?.dust(v.pos.x + bx, v.pos.y + 0.15, v.pos.z + bz, burnout ? 4 : 2);
          game.particles?.skid(v.pos.x + bx, v.pos.z + bz, v.heading);
        }
        // sinking in water → dump the player swimming
        if (v.sinking > 0.3) this.exitVehicleForced();
      }
    } else if (!player.vehicle && !player.dead) {
      if (input.wasPressed('KeyF') || input.wasPressed('Enter')) this.tryEnterExit();
    }

    // break-in in progress: hold position near the car until the lock pops
    if (this._breakIn) {
      const b = this._breakIn;
      if (b.v.dead || player.vehicle ||
          dist2d(player.pos.x, player.pos.z, b.v.pos.x, b.v.pos.z) > 4.6) {
        this._breakIn = null;
      } else {
        b.t -= dt;
        if (b.t <= 0) {
          this._breakIn = null;
          b.v.locked = false;
          game.audio?.crash?.(6, b.v.pos.x, b.v.pos.z);
          game.particles?.glassBurst(b.v.pos.x, b.v.pos.y + 0.9, b.v.pos.z);
          game.wanted?.crime('breakin', b.v.pos.x, b.v.pos.z);
          game.voice?.say?.('breakin', 0.5);
          if (b.v.alarmed) { b.v.alarmT = 12; b.v.alarmed = false; }
          this.tryEnterExit();
        }
      }
    }

    // physics for AI/parked vehicles happens in traffic system (AI) or here (parked drift-stop)
    for (const v of this.vehicles) {
      if (v.driver === 'player') continue;
      if (!v.aiControlled && !v.missionDriven) {
        // parked / abandoned cars still need to roll to a stop & sink etc.
        if (v.vel.lengthSq() > 0.01 || v.sinking > 0) {
          v.updatePhysics(dt, { throttle: 0, steer: 0, handbrake: false });
        }
      }
    }

    // vehicle-vs-vehicle collisions: circle broad phase, true OBB narrow phase
    const vs = this.vehicles;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i];
      for (let j = i + 1; j < vs.length; j++) {
        const b = vs[j];
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const rr = a.boundR + b.boundR;
        const d2 = dx * dx + dz * dz;
        if (d2 > rr * rr) continue;
        _oa.x = a.pos.x; _oa.z = a.pos.z; _oa.hw = a.hw; _oa.hl = a.hl; _oa.heading = a.heading;
        _ob.x = b.pos.x; _ob.z = b.pos.z; _ob.hw = b.hw; _ob.hl = b.hl; _ob.heading = b.heading;
        let hit = obbVsObb(_oa, _ob);
        if (!hit) continue;
        // hit normal points b→a; flip so n points a→b (push-apart convention below)
        const ma = a.spec.mass, mb = b.spec.mass;
        const tot = ma + mb;
        for (let iter = 0; iter < 2 && hit; iter++) {
          const nx = -hit.nx, nz = -hit.nz;
          a.pos.x -= nx * hit.depth * (mb / tot);
          a.pos.z -= nz * hit.depth * (mb / tot);
          b.pos.x += nx * hit.depth * (ma / tot);
          b.pos.z += nz * hit.depth * (ma / tot);
          if (iter === 0) {
            // relative speed along normal
            const rvx = b.vel.x - a.vel.x, rvz = b.vel.y - a.vel.y;
            const rel = rvx * nx + rvz * nz;
            if (rel < 0) {
              const impulse = -rel * 0.8;
              a.vel.x -= nx * impulse * (mb / tot);
              a.vel.y -= nz * impulse * (mb / tot);
              b.vel.x += nx * impulse * (ma / tot);
              b.vel.y += nz * impulse * (ma / tot);
              const impact = -rel;
              if (impact > 5) {
                const culprit = (a.driver === 'player' || b.driver === 'player') ? 'player' : 'ai';
                a.applyDamage(impact * 1.2, 'crash', culprit);
                b.applyDamage(impact * 1.2, 'crash', culprit);
                // bumping an alarmed parked car sets the alarm off
                for (const c of [a, b]) {
                  if (c.alarmed && c.parked) { c.alarmT = 12; c.alarmed = false; }
                }
                this.game.particles?.sparks((a.pos.x + b.pos.x) / 2, a.pos.y + 0.6, (a.pos.z + b.pos.z) / 2, 6);
                this.game.audio?.crash?.(impact, (a.pos.x + b.pos.x) / 2, (a.pos.z + b.pos.z) / 2);
                if (impact > 12) this.game.particles?.glassBurst((a.pos.x + b.pos.x) / 2, a.pos.y + 1.0, (a.pos.z + b.pos.z) / 2);
                if (a.driver === 'player' || b.driver === 'player') {
                  this.game.cameraRig.addShake(clamp(impact / 20, 0, 0.7));
                  this.game.wanted?.crime('crash', a.pos.x, a.pos.z);
                }
                // AI drivers panic when rammed
                const other = a.driver === 'player' ? b : a;
                if (other.aiControlled) this.game.traffic?.panic(other);
              }
            }
          }
          // deep overlap (high-speed hit): resolve once more so cars never interlock
          if (hit.depth > 1.2) {
            _oa.x = a.pos.x; _oa.z = a.pos.z; _oa.heading = a.heading;
            _ob.x = b.pos.x; _ob.z = b.pos.z; _ob.heading = b.heading;
            hit = obbVsObb(_oa, _ob);
          } else hit = null;
        }
      }
    }

    // blood tracking: each WHEEL that rolls through a fresh pool gets its
    // own charge and lays its own tread line — a moto leaves 2 tracks, a
    // car that only clips a pool with one tire leaves 1
    this._bloodScanT = (this._bloodScanT ?? 0) - dt;
    const bloodScan = this._bloodScanT <= 0;
    if (bloodScan) this._bloodScanT = 0.12;
    const blood = game.gore?.blood;
    for (const v of vs) {
      if (Math.abs(v.speed) < 2) continue;
      const offs = v.wheelOffsets;
      if (!offs?.length || !blood) continue;
      const sinH = Math.sin(v.heading), cosH = Math.cos(v.heading);
      if (bloodScan) {
        for (let i = 0; i < offs.length; i++) {
          const wx = v.pos.x + offs[i].x * cosH + offs[i].z * sinH;
          const wz = v.pos.z - offs[i].x * sinH + offs[i].z * cosH;
          if (blood.freshPoolAt?.(wx, wz)) {
            (v._wheelBlood ?? (v._wheelBlood = new Array(offs.length).fill(0)))[i] = 24;
          }
        }
      }
      if (v._wheelBlood && game.time - (v._lastStreakT ?? -1) > 0.07) {
        let laid = false;
        for (let i = 0; i < offs.length; i++) {
          if (v._wheelBlood[i] <= 0) continue;
          laid = true;
          v._wheelBlood[i]--;
          const wx = v.pos.x + offs[i].x * cosH + offs[i].z * sinH;
          const wz = v.pos.z - offs[i].x * sinH + offs[i].z * cosH;
          blood.tireStreak?.(wx, wz, v.heading);
        }
        if (laid) v._lastStreakT = game.time;
      }
    }

    // vehicles vs people: fast cars run people over; EVERY car — parked,
    // idling or rolling — is a solid body nobody can walk through
    for (const v of vs) {
      const sp = Math.hypot(v.vel.x, v.vel.y);
      if (sp >= 2.5) {
        this.game.peds?.checkRunOver(v, sp);
        if (v.driver !== 'player' && !player.vehicle && !player.dead) {
          if (dist2d(v.pos.x, v.pos.z, player.pos.x, player.pos.z) < v.radius + 0.45 &&
              game.time - (v._lastPlayerHitT ?? -9) > 0.8) {
            v._lastPlayerHitT = game.time;
            player.damage(sp * 3.2, 'runover', v.pos);
            player.vel.x += v.vel.x * 0.6;
            player.vel.z += v.vel.y * 0.6;
            player.vel.y = 3;
            player.grounded = false;
          }
        }
      }
      this.resolvePeopleVsVehicle(v);
    }

    // damage visuals + explosions
    for (const v of [...vs]) {
      if (v.exploded) {
        v.exploded = false;
        this.explodeFx(v);
      }
      if (v.health < 55 && !v.dead) {
        v.smokeTimer -= dt;
        if (v.smokeTimer <= 0) {
          v.smokeTimer = v.health < 25 ? 0.06 : 0.16;
          const dark = v.health < 25 ? 0.12 : 0.42;
          this.game.particles?.puffSmoke(v.pos.x, v.pos.y + 1.0, v.pos.z + Math.cos(v.heading) * v.spec.l * 0.3, dark);
        }
        if (v.health < 12 && !v.burning) {
          v.burning = true;   // fire before the bang
          v.burnCountdown = 3.5;
        }
      }
      if (v.burning && !v.dead) {
        v.fireTimer -= dt;
        if (v.fireTimer <= 0) {
          v.fireTimer = 0.08;
          this.game.particles?.fire(v.pos.x, v.pos.y + 0.9, v.pos.z, 2);
        }
        v.burnCountdown -= dt;
        if (v.burnCountdown <= 0) v.applyDamage(999, 'fire');
      }
      if (v.dead && v.burning) {
        v.fireTimer -= dt;
        if (v.fireTimer <= 0) {
          v.fireTimer = 0.12;
          this.game.particles?.fire(v.pos.x, v.pos.y + 0.8, v.pos.z, 1);
          this.game.particles?.puffSmoke(v.pos.x, v.pos.y + 1.6, v.pos.z, 0.08);
        }
      }
      // cull orphaned alive vehicles: not the player's, not AI-owned (traffic /
      // wanted / dispatch), not parked, not mission-held, far from the player.
      // These are cars you jacked and abandoned, or spawned then left.
      if (!v.dead && v !== player.vehicle && !v.aiControlled && !v.parked &&
          !v.missionKeep && !v.missionDriven && !v.emergency && v.driver == null) {
        const d = dist2d(v.pos.x, v.pos.z, player.pos.x, player.pos.z);
        v._orphanT = d > 240 ? (v._orphanT || 0) + dt : 0;
        if (v._orphanT > 4) { this.remove(v); continue; }
      }

      // wreck lifecycle: burn out, then clear the hulk away
      if (v.dead) {
        v.deadT = (v.deadT ?? 0) + dt;
        if (v.burning && v.deadT > 16) v.burning = false;
        const d = dist2d(v.pos.x, v.pos.z, player.pos.x, player.pos.z);
        const missionHeld = v.missionKeep && this.game.missions?.active;
        if (!missionHeld && v !== player.vehicle &&
            ((v.deadT > 45 && d > 60) || v.deadT > 150 || d > 320)) {
          this.remove(v);
          continue;
        }
      }
      // siren flash for anything with a lightbar
      if (v.lightbarR) v.flashSiren(this.game.time);

      // car alarm: honk loop + flashing lights after a break-in or hard bump
      if (v.alarmT > 0) {
        v.alarmT -= dt;
        v._alarmBeep = (v._alarmBeep ?? 0) - dt;
        if (v._alarmBeep <= 0) {
          v._alarmBeep = 0.55;
          this.game.audio?.horn(v.pos.x, v.pos.z);
          if (!v._alarmNoticed) {
            v._alarmNoticed = true;   // heads turn when the alarm first trips
            this.game.peds?.senseEvent?.(v.pos.x, v.pos.z, 'alarm');
          }
        }
        v.updateLightState();
        if (v.alarmT <= 0) { v.alarmT = 0; v.updateLightState(); }
      }
    }
  }

  exitVehicleForced() {
    const player = this.game.player;
    const v = player.vehicle;
    if (!v) return;
    const door = v.seatWorldPos();
    player.vehicle = null;
    v.driver = null;      // keep the sim/cull loops running for this car
    player.teleport(door.x, door.z, v.heading);
    player.setVisible(true);
    this.game.audio?.stopEngine();
    this.game.audio?.radio?.stop();
  }

  // push people (peds + player) out of a vehicle's oriented box, then
  // re-resolve statics once so a car can't shove someone through a wall
  resolvePeopleVsVehicle(v) {
    const game = this.game;
    const peds = game.peds;
    _solid.x = v.pos.x; _solid.z = v.pos.z;
    _solid.hw = v.hw; _solid.hl = v.hl; _solid.heading = v.heading;
    const restatic = (p, r) => {
      for (const b of game.city.queryColliders(p.pos.x, p.pos.z, r + 0.5)) {
        if (b.gone) continue;
        const h = circleVsAabb(p.pos.x, p.pos.z, r, b.minX, b.minZ, b.maxX, b.maxZ);
        if (h) { p.pos.x = h.x; p.pos.z = h.z; }
      }
    };
    if (peds) {
      for (const ped of peds._vehicleTargets(v, v.boundR + 0.8)) {
        if (ped.dead || ped.inVehicle || ped.interiorY != null) continue;
        const hit = circleVsObb(ped.pos.x, ped.pos.z, 0.35, _solid);
        if (!hit) continue;
        ped.pos.x = hit.x; ped.pos.z = hit.z;
        restatic(ped, 0.35);
      }
    }
    const pl = game.player;
    if (!pl.vehicle && !pl.dead &&
        distSq2d(pl.pos.x, pl.pos.z, v.pos.x, v.pos.z) < (v.boundR + 1) * (v.boundR + 1)) {
      const hit = circleVsObb(pl.pos.x, pl.pos.z, 0.38, _solid);
      if (hit) {
        pl.pos.x = hit.x; pl.pos.z = hit.z;
        restatic(pl, 0.38);
      }
    }
  }

  explodeFx(v) {
    const { x, z } = v.pos;
    const y = v.pos.y;
    this.game.particles?.explosion(x, y + 0.5, z);
    this.game.audio?.explosion(x, z);
    this.game.cameraRig.addShake(clamp(1.2 - dist2d(x, z, this.game.player.pos.x, this.game.player.pos.z) / 40, 0, 1));
    // splash damage — chain explosions inherit the culprit of the first blast
    const culprit = v._lastHitBy === 'player' ? 'player' : 'ai';
    const player = this.game.player;
    const pd = dist2d(x, z, player.pos.x, player.pos.z);
    if (pd < 9 && !player.vehicle) player.damage((9 - pd) * 12, 'explosion');
    if (player.vehicle && dist2d(x, z, player.vehicle.pos.x, player.vehicle.pos.z) < 8 && player.vehicle !== v) {
      player.vehicle.applyDamage(40, 'explosion', culprit);
    }
    for (const o of this.vehicles) {
      if (o === v || o.dead) continue;
      const d = dist2d(x, z, o.pos.x, o.pos.z);
      if (d < 8) o.applyDamage((8 - d) * 9, 'explosion', culprit);
    }
    this.game.peds?.explosionAt(x, z, 8, culprit);
    this.game.dispatch?.reportFire(x, z, v);
    if (v.driver === 'player') {
      player.vehicle = null;
      v.driver = null;
      player.teleport(x + 2, z + 2, v.heading);
      player.setVisible(true);
      player.damage(65, 'explosion');
      this.game.audio?.stopEngine();
      this.game.audio?.radio?.stop();
    } else if (v.driver && v.driver !== 'player') {
      this.game.peds?.killInVehicle(v.driver, v);
      v.driver = null;
    }
    // only player-caused explosions are the player's crime — an AI pileup
    // burning out on its own sends a cop to look, not stars (this was the
    // "wanted level rises while standing still" bug)
    this.game.wanted?.crime('explosion', x, z, culprit);
  }

  setNight(night) {
    this.night = night;
    // headlights at night, and by day when the weather turns gloomy
    const gloom = this.game.weather && this.game.weather.state !== 'clear';
    const on = night > 0.45 || !!gloom;
    if (this._lightsOn === on) return;
    this._lightsOn = on;
    for (const v of this.vehicles) v.setNightLights(on);
  }
}
