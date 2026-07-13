// VehicleSystem: owns every vehicle in the world, handles the player's
// driving input, enter/exit/carjack, vehicle-vs-vehicle and vehicle-vs-people
// collisions, damage smoke/fire, explosions and headlights.

import * as THREE from 'three';
import { Vehicle, VEHICLE_TYPES } from '../entities/vehicle.js';
import { clamp, dist2d, distSq2d } from '../core/mathutil.js';

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
    v.syncMesh(0);
    v.setNightLights(this.night > 0.5);
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
    v.dispose();
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
    if (this.game.player.vehicle === v) this.game.player.vehicle = null;
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

    // carjack if occupied by AI
    if (v.driver && v.driver !== 'player') {
      const ped = v.driver;
      v.driver = null;
      this.game.peds?.ejectDriver(ped, v);
      this.game.wanted?.crime('carjack', v.pos.x, v.pos.z);
      this.game.state.stats.vehiclesJacked++;
    }

    v.driver = 'player';
    player.vehicle = v;
    player.setVisible(false);
    player.pos.set(v.pos.x, v.pos.y, v.pos.z);
    this.game.traffic?.releaseVehicle(v);
    this.game.audio?.carDoor();
    this.game.audio?.startEngine();
    if (this.game.audio?.radio?.station >= 0) this.game.audio.radio.start();
    this.game.hud?.showVehicleName(v.spec.name);
    this.game.cameraRig.snapBehind(v.heading, 0.16);
    if (v.type === 'taxi') this.game.hud?.showToast('Press T to pick up fares.', 4);
  }

  exitVehicle() {
    const player = this.game.player;
    const v = player.vehicle;
    if (!v) return;
    if (Math.abs(v.speed) > 14) return;   // too fast to bail at full speed (keeps it simple)
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
      if (input.down('KeyH')) {
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
        game.state.stats.distanceDriven += Math.abs(v.speed) * dt;
        // engine audio
        game.audio?.setEngine(clamp(Math.abs(v.speed) / v.spec.maxSpeed, 0, 1), this.playerControl.throttle > 0);
        // tyre screech + rubber smoke on hard lateral slip
        if (Math.abs(v.lateral) > 3.5 && Math.abs(v.speed) > 6) {
          game.audio?.screech(v.pos.x, v.pos.z, clamp(Math.abs(v.lateral) / 8, 0, 1));
          // smoke at the rear wheels
          const bx = -Math.sin(v.heading) * v.spec.l * 0.32;
          const bz = -Math.cos(v.heading) * v.spec.l * 0.32;
          game.particles?.dust(v.pos.x + bx, v.pos.y + 0.15, v.pos.z + bz, 2);
        }
        // sinking in water → dump the player swimming
        if (v.sinking > 0.3) this.exitVehicleForced();
      }
    } else if (!player.vehicle && !player.dead) {
      if (input.wasPressed('KeyF') || input.wasPressed('Enter')) this.tryEnterExit();
    }

    // physics for AI/parked vehicles happens in traffic system (AI) or here (parked drift-stop)
    for (const v of this.vehicles) {
      if (v.driver === 'player') continue;
      if (!v.aiControlled) {
        // parked / abandoned cars still need to roll to a stop & sink etc.
        if (v.vel.lengthSq() > 0.01 || v.sinking > 0) {
          v.updatePhysics(dt, { throttle: 0, steer: 0, handbrake: false });
        }
      }
    }

    // vehicle-vs-vehicle collisions (simple circle pairs)
    const vs = this.vehicles;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i];
      for (let j = i + 1; j < vs.length; j++) {
        const b = vs[j];
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const rr = a.radius + b.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 > rr * rr || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d, nz = dz / d;
        const overlap = rr - d;
        const ma = a.spec.mass, mb = b.spec.mass;
        const tot = ma + mb;
        a.pos.x -= nx * overlap * (mb / tot);
        a.pos.z -= nz * overlap * (mb / tot);
        b.pos.x += nx * overlap * (ma / tot);
        b.pos.z += nz * overlap * (ma / tot);
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
            a.applyDamage(impact * 1.2, 'crash');
            b.applyDamage(impact * 1.2, 'crash');
            this.game.particles?.sparks((a.pos.x + b.pos.x) / 2, a.pos.y + 0.6, (a.pos.z + b.pos.z) / 2, 6);
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
    }

    // run-over checks: vehicles vs pedestrians & player
    for (const v of vs) {
      const sp = Math.hypot(v.vel.x, v.vel.y);
      if (sp < 2.5) continue;
      this.game.peds?.checkRunOver(v, sp);
      if (v.driver !== 'player' && !player.vehicle && !player.dead) {
        if (dist2d(v.pos.x, v.pos.z, player.pos.x, player.pos.z) < v.radius + 0.45) {
          player.damage(sp * 3.2, 'runover');
          player.vel.x += v.vel.x * 0.6;
          player.vel.z += v.vel.y * 0.6;
          player.vel.y = 3;
          player.grounded = false;
        }
      }
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
      // siren flash
      if (v.type === 'police') v.flashSiren(this.game.time);
    }
  }

  exitVehicleForced() {
    const player = this.game.player;
    const v = player.vehicle;
    if (!v) return;
    const door = v.seatWorldPos();
    player.vehicle = null;
    player.teleport(door.x, door.z, v.heading);
    player.setVisible(true);
    this.game.audio?.stopEngine();
    this.game.audio?.radio?.stop();
  }

  explodeFx(v) {
    const { x, z } = v.pos;
    const y = v.pos.y;
    this.game.particles?.explosion(x, y + 0.5, z);
    this.game.audio?.explosion(x, z);
    this.game.cameraRig.addShake(clamp(1.2 - dist2d(x, z, this.game.player.pos.x, this.game.player.pos.z) / 40, 0, 1));
    // splash damage
    const player = this.game.player;
    const pd = dist2d(x, z, player.pos.x, player.pos.z);
    if (pd < 9 && !player.vehicle) player.damage((9 - pd) * 12, 'explosion');
    if (player.vehicle && dist2d(x, z, player.vehicle.pos.x, player.vehicle.pos.z) < 8 && player.vehicle !== v) {
      player.vehicle.applyDamage(40, 'explosion');
    }
    for (const o of this.vehicles) {
      if (o === v || o.dead) continue;
      const d = dist2d(x, z, o.pos.x, o.pos.z);
      if (d < 8) o.applyDamage((8 - d) * 9, 'explosion');
    }
    this.game.peds?.explosionAt(x, z, 8);
    if (v.driver === 'player') {
      player.vehicle = null;
      player.teleport(x + 2, z + 2, v.heading);
      player.setVisible(true);
      player.damage(65, 'explosion');
      this.game.audio?.stopEngine();
    } else if (v.driver && v.driver !== 'player') {
      this.game.peds?.killInVehicle(v.driver);
      v.driver = null;
    }
    this.game.wanted?.crime('explosion', x, z);
  }

  setNight(night) {
    this.night = night;
    const on = night > 0.45;
    if (this._lightsOn === on) return;
    this._lightsOn = on;
    for (const v of this.vehicles) v.setNightLights(on);
  }
}
