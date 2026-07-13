// On-foot player controller: camera-relative movement, sprint stamina,
// jumping, swimming, collision against the static world.

import * as THREE from 'three';
import { Humanoid } from './humanoid.js';
import { clamp, damp, angleDamp, circleVsAabb, wrapAngle } from '../core/mathutil.js';

const WALK = 2.3, RUN = 5.4, SPRINT = 7.6, SWIM = 2.6;
const RADIUS = 0.38;

export class Player {
  constructor(city, scene) {
    this.city = city;
    this.scene = scene;

    // fixed protagonist look — stable across sessions
    this.rig = new Humanoid({
      skin: 0xb98a62, shirt: 0xf2efe6, pants: 0x4a5240, hair: 0x17120e,
      shoes: 0xe8e4da, eyes: 0x4a3624, female: false, age: 0.34, body: 'avg',
      hairStyle: 'short', beard: 'stubble', topStyle: 'tee', bottomStyle: 'jeans',
      sleeves: 'short', heightScale: 1.01,
    });
    scene.add(this.rig.group);

    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.heading = 0;              // facing angle
    this.grounded = true;
    this.swimming = false;

    this.health = 100;
    this.maxHealth = 100;
    this.armor = 0;
    this.stamina = 1;
    this.dead = false;

    this.vehicle = null;           // set by vehicle system when driving
    this.interiorY = null;         // interiors override terrain height
    this.aiming = false;
    this.speed2d = 0;

    this.onDamaged = null;         // callback(amount, source)
    this.onDied = null;
  }

  teleport(x, z, heading = 0) {
    // find a clear spot: if the target is inside a collider, spiral outwards
    let fx = x, fz = z;
    outer:
    for (let ring = 0; ring < 10; ring++) {
      const r = ring * 1.5;
      for (let a = 0; a < (ring === 0 ? 1 : 8); a++) {
        const ang = (a / 8) * Math.PI * 2;
        const tx = x + Math.cos(ang) * r, tz = z + Math.sin(ang) * r;
        const cols = this.city.queryColliders(tx, tz, RADIUS + 0.2);
        let blocked = false;
        for (const b of cols) {
          if (circleVsAabb(tx, tz, RADIUS, b.minX, b.minZ, b.maxX, b.maxZ)) { blocked = true; break; }
        }
        if (!blocked) { fx = tx; fz = tz; break outer; }
      }
    }
    this.pos.set(fx, this.interiorY ?? this.city.groundHeight(fx, fz), fz);
    this.vel.set(0, 0, 0);
    this.heading = heading;
    this.rig.group.visible = true;
    this.syncRig();
  }

  damage(amount, source = 'unknown') {
    if (this.dead) return;
    if (this.iframeT > 0 && source !== 'fall' && source !== 'explosion') return;   // dodge i-frames
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, amount * 0.7);
      this.armor -= absorbed;
      amount -= absorbed;
    }
    this.health -= amount;
    this.onDamaged?.(amount, source);
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      this.rig.die();
      this.onDied?.(source);
    }
  }

  heal(hp) { this.health = clamp(this.health + hp, 0, this.maxHealth); }

  // dirX/dirZ: camera-relative input already rotated to world; run/sprint flags
  update(dt, input, camYaw, aiming) {
    if (this.dead) {
      this.rig.update(dt, 0);
      return;
    }
    if (this.vehicle) return;     // vehicle system drives the transform

    this.aiming = aiming;
    const v = input.axisV(), h = input.axisH();
    const moving = v !== 0 || h !== 0;

    // world-space move direction from camera yaw (camera looks along -yaw dir)
    let mx = 0, mz = 0;
    if (moving) {
      const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);   // camera forward on ground
      const rx = -fz, rz = fx;                                 // camera right
      mx = fx * v + rx * h;
      mz = fz * v + rz * h;
      const len = Math.hypot(mx, mz) || 1;
      mx /= len; mz /= len;
    }

    const ground = this.interiorY ?? this.city.groundHeight(this.pos.x, this.pos.z);
    const inWater = this.interiorY == null && ground < this.city.WATER_Y - 0.15;

    // --- swimming ---
    if (inWater && this.pos.y <= this.city.WATER_Y + 0.4) {
      this.swimming = true;
      this.pos.y = this.city.WATER_Y - 0.35;
      this.vel.y = 0;
      const sp = moving ? SWIM : 0;
      this.pos.x += mx * sp * dt;
      this.pos.z += mz * sp * dt;
      if (moving) this.heading = angleDamp(this.heading, Math.atan2(mx, mz), 10, dt);
      this.speed2d = sp;
      this.rig.setAnim('swim');
      this.rig.update(dt, sp);
      this.syncRig();
      this.collide();
      return;
    }
    if (this.swimming && !inWater) this.swimming = false;

    // --- ground locomotion ---
    const wantSprint = input.down('ShiftLeft') || input.down('ShiftRight');
    let speed = 0;
    if (moving) {
      if (wantSprint && this.stamina > 0.05) speed = SPRINT;
      else speed = RUN;
      if (aiming) speed = Math.min(speed, 3.1);
    }
    if (wantSprint && moving) this.stamina = clamp(this.stamina - dt * 0.16, 0, 1);
    else this.stamina = clamp(this.stamina + dt * 0.22, 0, 1);

    // acceleration toward desired velocity
    const ax = mx * speed, az = mz * speed;
    this.vel.x = damp(this.vel.x, ax, 12, dt);
    this.vel.z = damp(this.vel.z, az, 12, dt);

    // dodge roll while locked on (Space) — quick sidestep with brief i-frames
    if (this.lockHeading != null && this.grounded && input.wasPressed('Space') && this.dodgeT <= 0) {
      const sideSign = h >= 0 ? 1 : -1;
      const dodgeAng = this.heading + Math.PI / 2 * sideSign;
      this.vel.x = Math.sin(dodgeAng) * 11;
      this.vel.z = Math.cos(dodgeAng) * 11;
      this.dodgeT = 0.35;
      this.iframeT = 0.35;
    } else if (this.grounded && input.wasPressed('Space')) {
      // gravity + jump
      this.vel.y = 5.6;
      this.grounded = false;
    }
    if (this.dodgeT > 0) this.dodgeT -= dt;
    if (this.iframeT > 0) this.iframeT -= dt;
    this.vel.y -= 18 * dt;

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;

    const g2 = this.interiorY ?? this.city.groundHeight(this.pos.x, this.pos.z);
    if (this.pos.y <= g2) {
      if (this.vel.y < -13) this.damage((-this.vel.y - 13) * 6, 'fall');
      this.pos.y = g2;
      this.vel.y = 0;
      this.grounded = true;
    } else if (this.pos.y > g2 + 0.05) {
      this.grounded = false;
    }

    this.collide();

    // facing: lock-on → face target; aim → face camera; else face movement
    if (this.lockHeading != null && this.dodgeT <= 0) {
      this.heading = angleDamp(this.heading, this.lockHeading, 16, dt);
    } else if (aiming) {
      this.heading = angleDamp(this.heading, camYaw + Math.PI, 18, dt);
    } else if (moving) {
      this.heading = angleDamp(this.heading, Math.atan2(mx, mz), 14, dt);
    }

    this.speed2d = Math.hypot(this.vel.x, this.vel.z);

    // animation state
    if (!this.grounded) this.rig.setAnim('jump');
    else if (aiming) this.rig.setAnim(this.speed2d > 0.4 ? 'aimwalk' : 'aim');
    else if (this.speed2d > 6.2) this.rig.setAnim('sprint');
    else if (this.speed2d > 3.2) this.rig.setAnim('run');
    else if (this.speed2d > 0.35) this.rig.setAnim('walk');
    else this.rig.setAnim('idle');

    this.rig.update(dt, this.speed2d);
    this.syncRig();

    // footsteps synced to gait
    if (this.grounded && this.speed2d > 1) {
      this.stepPhase = (this.stepPhase || 0) + this.speed2d * dt * 0.9;
      if (this.stepPhase >= 1) {
        this.stepPhase -= 1;
        this._audio?.footstep(this.speed2d > 4);
      }
    }
  }

  collide() {
    const cols = this.city.queryColliders(this.pos.x, this.pos.z, RADIUS + 1);
    for (const b of cols) {
      // ignore boxes we are standing on top of (none currently walkable)
      const hit = circleVsAabb(this.pos.x, this.pos.z, RADIUS, b.minX, b.minZ, b.maxX, b.maxZ);
      if (hit) {
        const groundY = this.city.groundHeight(this.pos.x, this.pos.z);
        if (this.pos.y < groundY + b.h - 0.2) {
          this.pos.x = hit.x;
          this.pos.z = hit.z;
          // kill velocity into the wall
          const dot = this.vel.x * hit.nx + this.vel.z * hit.nz;
          if (dot < 0) { this.vel.x -= hit.nx * dot; this.vel.z -= hit.nz * dot; }
        }
      }
    }
    // world bounds (not while inside an interior room)
    if (this.interiorY == null) {
      const lim = this.city.HALF - 6;
      this.pos.x = clamp(this.pos.x, -lim, lim);
      this.pos.z = clamp(this.pos.z, -lim, lim);
    }
  }

  syncRig() {
    this.rig.group.position.copy(this.pos);
    this.rig.group.rotation.y = this.heading;
  }

  setVisible(v) { this.rig.group.visible = v; }
}
