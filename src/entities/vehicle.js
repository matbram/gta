// Vehicle entity: procedurally built meshes (boxes + cylinders) and
// arcade driving physics with grip/drift, damage, smoke, fire, explosion.

import * as THREE from 'three';
import { clamp, damp, lerp, circleVsAabb, wrapAngle } from '../core/mathutil.js';

// All vehicle names are original.
export const VEHICLE_TYPES = {
  sedan:   { name: 'Falcon',    w: 1.85, l: 4.5,  h: 1.42, maxSpeed: 31, accel: 9,  grip: 7.5, steer: 2.3, mass: 1.0, colors: [0x8a2f26, 0x2e4a6a, 0x777d85, 0x3e3e42, 0x8a7c58, 0x5b6b5a] },
  sports:  { name: 'Vespera',   w: 1.9,  l: 4.3,  h: 1.16, maxSpeed: 44, accel: 14, grip: 9.5, steer: 2.7, mass: 0.9, colors: [0xb03a2e, 0xe8c84a, 0x2255aa, 0x111111, 0xd8d8d8] },
  taxi:    { name: 'Falcon Cab',w: 1.85, l: 4.5,  h: 1.42, maxSpeed: 31, accel: 9,  grip: 7.5, steer: 2.3, mass: 1.0, colors: [0xd8a018] },
  pickup:  { name: 'Mesa',      w: 2.0,  l: 5.0,  h: 1.75, maxSpeed: 28, accel: 7.5, grip: 6.5, steer: 2.0, mass: 1.35, colors: [0x5a4632, 0x3e4a3e, 0x6b7078, 0x7a3020] },
  van:     { name: 'Boxer',     w: 2.05, l: 5.2,  h: 2.25, maxSpeed: 26, accel: 6.5, grip: 6,   steer: 1.9, mass: 1.5,  colors: [0xd8d4c8, 0x4a5a6a, 0x7a6a4a] },
  bus:     { name: 'Bayliner',  w: 2.5,  l: 10.5, h: 3.0,  maxSpeed: 22, accel: 4.5, grip: 5.5, steer: 1.35, mass: 3.2, colors: [0x3a6a8a] },
  police:  { name: 'Interceptor', w: 1.9, l: 4.7, h: 1.45, maxSpeed: 38, accel: 12, grip: 8.5, steer: 2.5, mass: 1.1, colors: [0x16181d] },
  moto:    { name: 'Comet 250', w: 0.8,  l: 2.2,  h: 1.1,  maxSpeed: 40, accel: 13, grip: 8,   steer: 3.0, mass: 0.35, colors: [0x8a2f26, 0x22262c, 0x2e4a6a] },
  ambulance: { name: 'Lifeline', w: 2.1, l: 5.4,  h: 2.4,  maxSpeed: 30, accel: 8,  grip: 6.5, steer: 2.0, mass: 1.6, colors: [0xe8e4dc] },
};

const glassMatShared = new THREE.MeshLambertMaterial({ color: 0x1a2732 });
const tireMatShared = new THREE.MeshLambertMaterial({ color: 0x14161a });
const headlightOff = new THREE.Color(0xd8d8c8);

let nextVehicleId = 1;

export class Vehicle {
  constructor(typeKey, city, scene, colorOverride = null) {
    this.id = nextVehicleId++;
    this.type = typeKey;
    this.spec = VEHICLE_TYPES[typeKey];
    this.city = city;
    this.scene = scene;

    this.pos = new THREE.Vector3();
    this.heading = 0;
    this.vel = new THREE.Vector2();     // world-space ground velocity (x, z)
    this.speed = 0;                     // signed forward speed
    this.steerVis = 0;

    this.health = 100;
    this.dead = false;                  // exploded / drowned
    this.burning = false;
    this.sinking = 0;
    this.driver = null;                 // null | 'player' | Ped
    this.horn = 0;
    this.sirenOn = false;
    this.lightsOn = false;
    this.smokeTimer = 0;
    this.fireTimer = 0;
    this.lastHitSpeed = 0;
    this.radius = Math.max(this.spec.w, this.spec.l) * 0.36;

    this.buildMesh(colorOverride);
  }

  buildMesh(colorOverride) {
    const S = this.spec;
    const g = new THREE.Group();
    const color = colorOverride ?? S.colors[Math.floor(Math.random() * S.colors.length)];
    this.bodyMat = new THREE.MeshLambertMaterial({ color });
    this.baseColor = new THREE.Color(color);

    const W = S.w, L = S.l, H = S.h;
    const wheelR = this.type === 'moto' ? 0.34 : 0.36;
    this.wheelR = wheelR;

    if (this.type === 'moto') {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.35, 1.5), this.bodyMat);
      frame.position.y = wheelR + 0.25;
      frame.castShadow = true;
      g.add(frame);
      const tank = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.26, 0.6), this.bodyMat);
      tank.position.set(0, wheelR + 0.5, 0.25);
      g.add(tank);
      const bars = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 0.08), tireMatShared);
      bars.position.set(0, wheelR + 0.72, 0.72);
      g.add(bars);
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.55), tireMatShared);
      seat.position.set(0, wheelR + 0.52, -0.3);
      g.add(seat);
      this.wheels = [];
      for (const zOff of [0.82, -0.82]) {
        const wm = new THREE.Mesh(new THREE.CylinderGeometry(wheelR, wheelR, 0.14, 12), tireMatShared);
        wm.rotation.z = Math.PI / 2;
        wm.position.set(0, wheelR, zOff);
        wm.castShadow = true;
        g.add(wm);
        this.wheels.push(wm);
      }
    } else {
      // body: lower slab + cabin
      const bodyH = H * 0.52, cabinH = H * 0.46;
      const body = new THREE.Mesh(new THREE.BoxGeometry(W, bodyH, L), this.bodyMat);
      body.position.y = wheelR + bodyH / 2 - 0.05;
      body.castShadow = true;
      g.add(body);
      this.bodyMesh = body;

      const isBoxy = ['van', 'bus', 'ambulance', 'pickup'].includes(this.type);
      const cabinL = this.type === 'pickup' ? L * 0.42 : isBoxy ? L * 0.9 : L * 0.55;
      const cabinZ = this.type === 'pickup' ? L * 0.12 : 0;
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(W * 0.88, cabinH, cabinL), this.bodyMat);
      cabin.position.set(0, wheelR + bodyH + cabinH / 2 - 0.08, cabinZ);
      cabin.castShadow = true;
      g.add(cabin);

      // glass band around cabin
      const glass = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, cabinH * 0.55, cabinL * 0.98), glassMatShared);
      glass.position.copy(cabin.position);
      glass.position.y += cabinH * 0.1;
      g.add(glass);

      // wheels
      this.wheels = [];
      const wx = W / 2 - 0.12, wz = L * 0.32;
      for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
        const wm = new THREE.Mesh(new THREE.CylinderGeometry(wheelR, wheelR, 0.24, 12), tireMatShared);
        wm.rotation.z = Math.PI / 2;
        wm.position.set(sx * wx, wheelR, sz * wz);
        wm.castShadow = true;
        g.add(wm);
        this.wheels.push(wm);
      }

      // head/tail lights
      this.headMat = new THREE.MeshLambertMaterial({ color: headlightOff, emissive: 0xfff2cc, emissiveIntensity: 0 });
      this.tailMat = new THREE.MeshLambertMaterial({ color: 0x551512, emissive: 0xff2a1a, emissiveIntensity: 0 });
      for (const sx of [-1, 1]) {
        const hl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.06), this.headMat);
        hl.position.set(sx * (W / 2 - 0.3), wheelR + bodyH * 0.6, L / 2 + 0.02);
        g.add(hl);
        const tl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.06), this.tailMat);
        tl.position.set(sx * (W / 2 - 0.3), wheelR + bodyH * 0.6, -L / 2 - 0.02);
        g.add(tl);
      }

      // type extras
      if (this.type === 'taxi') {
        const sign = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.22, 0.3),
          new THREE.MeshLambertMaterial({ color: 0xe8c84a, emissive: 0xe8c84a, emissiveIntensity: 0.25 }));
        sign.position.set(0, wheelR + bodyH + cabinH + 0.06, 0);
        g.add(sign);
      }
      if (this.type === 'police') {
        this.lightbarR = new THREE.MeshLambertMaterial({ color: 0x772222, emissive: 0xff2222, emissiveIntensity: 0 });
        this.lightbarB = new THREE.MeshLambertMaterial({ color: 0x223377, emissive: 0x2244ff, emissiveIntensity: 0 });
        const lb1 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.3), this.lightbarR);
        lb1.position.set(-0.24, wheelR + bodyH + cabinH + 0.02, 0);
        g.add(lb1);
        const lb2 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.3), this.lightbarB);
        lb2.position.set(0.24, wheelR + bodyH + cabinH + 0.02, 0);
        g.add(lb2);
        // white doors
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(W + 0.02, bodyH * 0.5, L * 0.3),
          new THREE.MeshLambertMaterial({ color: 0xe8e4dc }));
        stripe.position.set(0, wheelR + bodyH / 2, 0.2);
        g.add(stripe);
      }
      if (this.type === 'ambulance') {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(W + 0.02, 0.3, L * 0.85),
          new THREE.MeshLambertMaterial({ color: 0xb03a2e }));
        stripe.position.set(0, wheelR + bodyH * 0.75, -0.2);
        g.add(stripe);
      }
      if (this.type === 'bus') {
        // windows along the side
        const band = new THREE.Mesh(new THREE.BoxGeometry(W + 0.04, 0.8, L * 0.86), glassMatShared);
        band.position.set(0, wheelR + bodyH + cabinH * 0.4, 0);
        g.add(band);
      }
    }

    g.traverse((o) => { if (o.isMesh) o.receiveShadow = false; });
    this.group = g;
    this.scene.add(g);
  }

  get maxHealthSpeedFactor() { return clamp(this.health / 100, 0.45, 1); }

  seatWorldPos() {
    // door position (left side) for enter/exit
    const lx = -Math.cos(this.heading), lz = Math.sin(this.heading);
    return {
      x: this.pos.x + lx * (this.spec.w / 2 + 0.7),
      z: this.pos.z + lz * (this.spec.w / 2 + 0.7),
    };
  }

  // control: {throttle: -1..1, steer: -1..1, handbrake: bool}
  updatePhysics(dt, control) {
    if (this.dead && !this.sinkingActive) control = { throttle: 0, steer: 0, handbrake: false };
    const S = this.spec;

    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    let vf = this.vel.x * fx + this.vel.y * fz;      // forward speed
    let vl = this.vel.x * -fz + this.vel.y * fx;     // lateral speed (right positive)

    // engine / brakes
    const top = S.maxSpeed * this.maxHealthSpeedFactor;
    if (control.throttle > 0) {
      const t = control.throttle * S.accel * (1 - clamp(vf / top, 0, 1) * 0.75);
      vf += t * dt;
    } else if (control.throttle < 0) {
      if (vf > 0.5) vf += control.throttle * S.accel * 2.2 * dt;         // braking
      else vf = Math.max(vf + control.throttle * S.accel * 0.7 * dt, -top * 0.3); // reverse
    }

    // drag + rolling resistance
    vf -= vf * 0.012 * dt * 60;
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), 0.6 * dt);

    // handbrake + grip
    const grip = control.handbrake ? S.grip * 0.16 : S.grip;
    vl -= vl * clamp(grip * dt, 0, 1);
    if (control.handbrake && Math.abs(vf) > 4) vf -= Math.sign(vf) * 5.5 * dt;

    // steering (speed sensitive, reversed in reverse)
    const speedFactor = clamp(Math.abs(vf) / 6, 0, 1) * (1 / (1 + Math.abs(vf) * 0.028));
    const steerDir = vf >= 0 ? 1 : -1;
    this.heading += control.steer * S.steer * speedFactor * steerDir * dt *
      (control.handbrake ? 1.5 : 1);
    this.steerVis = damp(this.steerVis, control.steer, 10, dt);

    // recompose velocity
    const nfx = Math.sin(this.heading), nfz = Math.cos(this.heading);
    this.vel.x = nfx * vf + -nfz * vl * (control.handbrake ? 1 : 0.55);
    this.vel.y = nfz * vf + nfx * vl * (control.handbrake ? 1 : 0.55);
    this.speed = vf;
    this.lateral = vl;

    // integrate
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.y * dt;

    // terrain follow / sinking
    const ground = this.city.groundHeight(this.pos.x, this.pos.z);
    if (ground < this.city.WATER_Y - 0.25) {
      // in water: sink
      this.sinking += dt;
      this.pos.y = Math.max(this.pos.y - dt * 0.9, ground - 0.4);
      this.vel.x *= 0.95; this.vel.y *= 0.95;
      if (this.sinking > 0.4 && !this.dead) this.drown();
    } else {
      this.pos.y = ground;
      this.sinking = 0;
    }

    // world bounds
    const lim = this.city.HALF - 4;
    if (Math.abs(this.pos.x) > lim || Math.abs(this.pos.z) > lim) {
      this.pos.x = clamp(this.pos.x, -lim, lim);
      this.pos.z = clamp(this.pos.z, -lim, lim);
      this.vel.multiplyScalar(0.5);
    }

    this.collideStatic();
    this.syncMesh(dt);
  }

  collideStatic() {
    const cols = this.city.queryColliders(this.pos.x, this.pos.z, this.radius + 1.5);
    for (const b of cols) {
      const hit = circleVsAabb(this.pos.x, this.pos.z, this.radius, b.minX, b.minZ, b.maxX, b.maxZ);
      if (!hit) continue;
      this.pos.x = hit.x;
      this.pos.z = hit.z;
      const vn = this.vel.x * hit.nx + this.vel.y * hit.nz;
      if (vn < 0) {
        const impact = -vn;
        this.vel.x -= hit.nx * vn * 1.4;   // bounce
        this.vel.y -= hit.nz * vn * 1.4;
        if (impact > 4) {
          this.applyDamage(impact * 1.7, 'crash');
          this.lastHitSpeed = impact;
        }
      }
    }
  }

  applyDamage(amount, cause = 'unknown') {
    if (this.dead) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.explode(cause);
    }
  }

  drown() {
    this.dead = true;
    this.burning = false;
    this.health = 0;
  }

  explode() {
    if (this.dead) return;
    this.dead = true;
    this.burning = true;
    this.bodyMat.color.set(0x1c1a18);
    this.exploded = true;   // consumed by VehicleSystem for boom fx/damage
  }

  syncMesh(dt) {
    this.group.position.copy(this.pos);
    // visual tilt from terrain slope
    const ahead = this.city.groundHeight(
      this.pos.x + Math.sin(this.heading) * 1.6,
      this.pos.z + Math.cos(this.heading) * 1.6);
    const behind = this.city.groundHeight(
      this.pos.x - Math.sin(this.heading) * 1.6,
      this.pos.z - Math.cos(this.heading) * 1.6);
    const pitch = Math.atan2(behind - ahead, 3.2);
    this.group.rotation.set(pitch, this.heading, this.type === 'moto' ? -this.steerVis * clamp(Math.abs(this.speed) / 12, 0, 1) * 0.45 : 0, 'YXZ');

    // wheels spin + front steer
    const spin = this.speed * dt / this.wheelR;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.rotation.x += spin;
      if (this.type !== 'moto' && i < 2) w.rotation.y = this.steerVis * 0.45;
      if (this.type === 'moto' && i === 0) w.rotation.y = this.steerVis * 0.5;
    }
  }

  setNightLights(on) {
    if (!this.headMat) return;
    this.lightsOn = on;
    this.headMat.emissiveIntensity = on ? 1.4 : 0;
    this.tailMat.emissiveIntensity = on ? 0.9 : 0;
  }

  flashSiren(t) {
    if (!this.lightbarR) return;
    const phase = Math.floor(t * 4) % 2;
    this.lightbarR.emissiveIntensity = this.sirenOn ? (phase ? 2.2 : 0.1) : 0;
    this.lightbarB.emissiveIntensity = this.sirenOn ? (phase ? 0.1 : 2.2) : 0;
  }

  dispose() {
    this.group.removeFromParent();
  }
}
