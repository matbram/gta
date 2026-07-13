// Pedestrian entity: a Humanoid rig plus a small state machine
// (wander / idle / flee / fight / dead). Cops extend the same brain in phase C.

import * as THREE from 'three';
import { Humanoid, randomLook } from './humanoid.js';
import { clamp, angleDamp, circleVsAabb, dist2d } from '../core/mathutil.js';

const RADIUS = 0.35;
let nextPedId = 1;

export class Ped {
  constructor(city, scene, look, opts = {}) {
    this.id = nextPedId++;
    this.city = city;
    this.scene = scene;
    this.rig = new Humanoid(look);
    scene.add(this.rig.group);

    this.pos = new THREE.Vector3();
    this.heading = Math.random() * Math.PI * 2;
    this.speed = 0;
    this.health = opts.health ?? 35;
    this.dead = false;
    this.state = 'wander';        // wander | idle | flee | fight | dead | driver
    this.stateT = 0;
    this.target = { x: 0, z: 0 };
    this.fleeFrom = { x: 0, z: 0 };
    this.walkSpeed = 1.15 + Math.random() * 0.6;
    this.runSpeed = 5.2 + Math.random() * 0.9;
    this.brave = Math.random() < (opts.braveChance ?? 0.08);   // fights back instead of fleeing
    this.attackCooldown = 0;
    this.removeTimer = 0;         // counts up after death
    this.isCop = false;
    this.inVehicle = null;
  }

  place(x, z) {
    this.pos.set(x, this.city.groundHeight(x, z), z);
    this.pickWanderTarget();
    this.syncRig();
  }

  pickWanderTarget() {
    // walk along the nearest sidewalk direction: pick a point 15-40 m away
    const a = Math.random() * Math.PI * 2;
    const d = 15 + Math.random() * 28;
    this.target.x = this.pos.x + Math.cos(a) * d;
    this.target.z = this.pos.z + Math.sin(a) * d;
  }

  panic(fromX, fromZ) {
    if (this.dead || this.state === 'driver') return;
    if (this.brave && !this.panicked) {
      this.state = 'fight';
      this.stateT = 0;
      return;
    }
    this.panicked = true;
    this.state = 'flee';
    this.stateT = 0;
    this.fleeFrom.x = fromX;
    this.fleeFrom.z = fromZ;
  }

  damage(amount, game, source = 'player') {
    if (this.dead) return;
    this.health -= amount;
    game.particles?.blood(this.pos.x, this.pos.y + 1.1, this.pos.z, 4);
    if (this.health <= 0) {
      this.die(game);
      return;
    }
    this.panic(game.player.pos.x, game.player.pos.z);
  }

  die(game) {
    if (this.dead) return;
    this.dead = true;
    this.state = 'dead';
    this.rig.die();
    game.audio?.scream(this.pos.x, this.pos.z);
    game.state.stats.kills++;
    // panic everyone nearby
    game.peds?.panicAt(this.pos.x, this.pos.z, 26);
    // drop some cash
    game.worldlife?.dropCash?.(this.pos.x, this.pos.z, 10 + Math.floor(Math.random() * 30));
  }

  update(dt, game) {
    if (this.dead) {
      this.rig.update(dt, 0);
      this.removeTimer += dt;
      return;
    }
    this.stateT += dt;
    const player = game.player;

    switch (this.state) {
      case 'wander': {
        const d = dist2d(this.pos.x, this.pos.z, this.target.x, this.target.z);
        if (d < 1.6 || this.stateT > 40) {
          this.state = Math.random() < 0.25 ? 'idle' : 'wander';
          this.stateT = 0;
          this.pickWanderTarget();
        }
        this.moveToward(this.target.x, this.target.z, this.walkSpeed, dt);
        this.rig.setAnim(this.speed > 0.2 ? 'walk' : 'idle');
        break;
      }
      case 'idle': {
        this.speed = 0;
        this.rig.setAnim('idle');
        if (this.stateT > 2 + Math.random() * 4) {
          this.state = 'wander';
          this.stateT = 0;
          this.pickWanderTarget();
        }
        break;
      }
      case 'flee': {
        // run directly away from the threat
        const dx = this.pos.x - this.fleeFrom.x, dz = this.pos.z - this.fleeFrom.z;
        const len = Math.hypot(dx, dz) || 1;
        this.moveToward(this.pos.x + (dx / len) * 30, this.pos.z + (dz / len) * 30, this.runSpeed, dt);
        this.rig.setAnim('run');
        if (this.stateT > 9) { this.state = 'wander'; this.panicked = false; this.stateT = 0; }
        break;
      }
      case 'fight': {
        // brave ped charges the player and swings
        const d = dist2d(this.pos.x, this.pos.z, player.pos.x, player.pos.z);
        if (player.dead || d > 30 || this.stateT > 25) { this.state = 'wander'; this.stateT = 0; break; }
        if (d > 1.4) {
          this.moveToward(player.pos.x, player.pos.z, this.runSpeed * 0.85, dt);
          this.rig.setAnim('run');
        } else {
          this.speed = 0;
          this.rig.setAnim('idle');
          this.heading = Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
          this.attackCooldown -= dt;
          if (this.attackCooldown <= 0) {
            this.attackCooldown = 1.1;
            this.rig.startPunch();
            if (!player.vehicle) {
              player.damage(6, 'ped');
              game.audio?.punch();
            }
          }
        }
        break;
      }
    }

    this.rig.update(dt, this.speed);
    this.syncRig();
  }

  moveToward(tx, tz, speed, dt) {
    const dx = tx - this.pos.x, dz = tz - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.2) { this.speed = 0; return; }
    const want = Math.atan2(dx, dz);
    this.heading = angleDamp(this.heading, want, 8, dt);
    this.speed = speed;
    const mx = Math.sin(this.heading) * speed * dt;
    const mz = Math.cos(this.heading) * speed * dt;
    this.pos.x += mx;
    this.pos.z += mz;
    // static collision: slide along buildings
    const cols = this.city.queryColliders(this.pos.x, this.pos.z, RADIUS + 0.6);
    for (const b of cols) {
      const hit = circleVsAabb(this.pos.x, this.pos.z, RADIUS, b.minX, b.minZ, b.maxX, b.maxZ);
      if (hit) {
        this.pos.x = hit.x;
        this.pos.z = hit.z;
        if (this.state === 'wander' && Math.random() < 0.05) this.pickWanderTarget();
      }
    }
    // stay out of deep water
    if (this.city.groundHeight(this.pos.x, this.pos.z) < this.city.WATER_Y - 0.1) {
      this.pos.x -= mx * 2;
      this.pos.z -= mz * 2;
      this.pickWanderTarget();
    }
    this.pos.y = this.city.groundHeight(this.pos.x, this.pos.z);
  }

  syncRig() {
    this.rig.group.position.copy(this.pos);
    this.rig.group.rotation.y = this.heading;
  }

  dispose() {
    this.rig.dispose();
  }
}

export { randomLook, RADIUS as PED_RADIUS };
