// Vehicle entity: procedurally built meshes (boxes + cylinders) and
// arcade driving physics with grip/drift, damage, smoke, fire, explosion.

import * as THREE from 'three';
import { clamp, damp, lerp, obbVsAabb, wrapAngle } from '../core/mathutil.js';
import { buildVehicleMesh, SHARED_MATS, SHARED_GEOS, charredMat } from './vehiclemesh.js';

// All vehicle names are original.
// seat: where the driver's rig root sits in local space (x right, z forward,
// y relative to the vehicle origin) and which pose they hold.
export const VEHICLE_TYPES = {
  sedan:   { name: 'Falcon',    w: 1.85, l: 4.5,  h: 1.42, maxSpeed: 38, accel: 11, grip: 7.5, steer: 2.3, mass: 1.0, colors: [0x8a2f26, 0x2e4a6a, 0x777d85, 0x3e3e42, 0x8a7c58, 0x5b6b5a],
    seat: { x: -0.38, y: -0.36, z: 0.1, pose: 'drive' } },
  sports:  { name: 'Vespera',   w: 1.9,  l: 4.3,  h: 1.16, maxSpeed: 58, accel: 17, grip: 9.5, steer: 2.7, mass: 0.9, colors: [0xb03a2e, 0xe8c84a, 0x2255aa, 0x111111, 0xd8d8d8],
    seat: { x: -0.36, y: -0.46, z: 0.02, pose: 'drive' } },
  taxi:    { name: 'Falcon Cab',w: 1.85, l: 4.5,  h: 1.42, maxSpeed: 38, accel: 11, grip: 7.5, steer: 2.3, mass: 1.0, colors: [0xd8a018],
    seat: { x: -0.38, y: -0.36, z: 0.1, pose: 'drive' } },
  pickup:  { name: 'Mesa',      w: 2.0,  l: 5.0,  h: 1.75, maxSpeed: 36, accel: 9, grip: 6.5, steer: 2.0, mass: 1.35, colors: [0x5a4632, 0x3e4a3e, 0x6b7078, 0x7a3020],
    seat: { x: -0.42, y: -0.2, z: 0.3, pose: 'drive' } },
  van:     { name: 'Boxer',     w: 2.05, l: 5.2,  h: 2.25, maxSpeed: 33, accel: 8, grip: 6,   steer: 1.9, mass: 1.5,  colors: [0xd8d4c8, 0x4a5a6a, 0x7a6a4a],
    seat: { x: -0.44, y: -0.08, z: 1.0, pose: 'drive' } },
  bus:     { name: 'Bayliner',  w: 2.5,  l: 10.5, h: 3.0,  maxSpeed: 27, accel: 5.5, grip: 5.5, steer: 1.35, mass: 3.2, colors: [0x3a6a8a],
    seat: { x: -0.6, y: 0.12, z: 3.6, pose: 'drive' } },
  police:  { name: 'Interceptor', w: 1.9, l: 4.7, h: 1.45, maxSpeed: 49, accel: 15, grip: 8.5, steer: 2.5, mass: 1.1, colors: [0x16181d],
    seat: { x: -0.38, y: -0.35, z: 0.12, pose: 'drive' } },
  moto:    { name: 'Comet 250', w: 0.8,  l: 2.2,  h: 1.1,  maxSpeed: 54, accel: 16, grip: 8,   steer: 3.0, mass: 0.35, colors: [0x8a2f26, 0x22262c, 0x2e4a6a],
    seat: { x: 0, y: 0.02, z: -0.24, pose: 'ride' } },
  ambulance: { name: 'Lifeline', w: 2.1, l: 5.4,  h: 2.4,  maxSpeed: 36, accel: 9.5, grip: 6.5, steer: 2.0, mass: 1.6, colors: [0xe8e4dc],
    seat: { x: -0.46, y: -0.02, z: 1.5, pose: 'drive' } },
  firetruck: { name: 'BFD Engine 3', w: 2.4, l: 7.6, h: 2.9, maxSpeed: 30, accel: 8, grip: 6.5, steer: 1.7, mass: 2.6, colors: [0xb02318],
    seat: { x: -0.52, y: 0.1, z: 2.3, pose: 'drive' } },
};

let nextVehicleId = 1;

// clearcoat paint needs the env map — main.js turns it off on low quality
let paintPhysical = true;
export function setPaintQuality(physical) { paintPhysical = !!physical; }

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
    // true oriented footprint for collision; radius stays width-scale for
    // run-over / door checks that model "touching the car's side"
    this.hw = this.spec.w / 2 + 0.05;
    this.hl = this.spec.l / 2;
    this.boundR = Math.hypot(this.hw, this.hl);
    this.radius = this.spec.w * 0.5 + 0.3;
    this.onCrash = null;               // set by VehicleSystem (sfx + knockables)

    // crash dynamics: vertical velocity + visual pitch/roll springs so hard
    // hits lift and rock the body (arcade — clamped well short of a rollover)
    this.vy = 0;
    this.airborne = false;
    this.pitchOff = 0; this.pitchVel = 0;
    this.rollOff = 0; this.rollVel = 0;
    this.angKick = 0;                  // brief yaw impulse from glancing hits
    // flip dynamics: a violent side hit (or a blast under the car) rolls the
    // BODY past the spring clamp while the physics footprint stays 2D
    this.flipping = false;             // actively rolling
    this.flipRoll = 0;                 // extra Z-roll (unwrapped while airborne)
    this.flipVel = 0;
    this.flipped = false;              // at rest on the roof
    this.rightT = 0;                   // player auto-right countdown
    this.onFlipped = null;             // set by VehicleSystem
    this.wheelPull = 0;                // late-game busted-axle steering drift

    this.buildMesh(colorOverride);
  }

  buildMesh(colorOverride) {
    const S = this.spec;
    const color = colorOverride ?? S.colors[Math.floor(Math.random() * S.colors.length)];
    this.baseColor = new THREE.Color(color);
    const built = buildVehicleMesh(this.type, S, color, { physical: paintPhysical });
    this.group = built.group;
    this.bodyMat = built.bodyMat;
    this.bodyMesh = built.bodyMesh ?? null;
    this.wheels = built.wheels;
    this.frontPivots = built.frontPivots;
    this.wheelR = built.wheelR;
    // per-wheel local XZ offsets (front wheels sit inside steering pivots,
    // so read the pivot) — used for per-wheel blood tracking
    this.wheelOffsets = built.wheels.map((w) => {
      const n = w.parent && w.parent !== built.group ? w.parent : w;
      return { x: n.position.x, z: n.position.z };
    });
    this.headMat = built.headMat;
    this.tailMat = built.tailMat;
    this.reverseMat = built.reverseMat ?? null;
    if (built.lightbarR) { this.lightbarR = built.lightbarR; this.lightbarB = built.lightbarB; }
    this.parts = built.parts ?? {};
    this.partState = {};   // per part: undefined attached, 1 loose, 2 gone
    this.scene.add(this.group);
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

  // where the driver's rig root goes, in world space, plus the pose to hold
  seatRigWorld() {
    const s = this.spec.seat ?? { x: -0.38, y: -(0.32 + (1.6 - this.spec.h) * 0.35), z: 0, pose: 'drive' };
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    return {
      x: this.pos.x + fz * s.x + fx * s.z,
      y: this.pos.y + s.y,
      z: this.pos.z - fx * s.x + fz * s.z,
      pose: s.pose,
    };
  }

  // control: {throttle: -1..1, steer: -1..1, handbrake: bool}
  updatePhysics(dt, control) {
    if ((this.dead && !this.sinkingActive) || this.flipping || this.flipped) {
      control = { throttle: 0, steer: 0, handbrake: false };   // engine is done
    }
    const S = this.spec;

    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    let vf = this.vel.x * fx + this.vel.y * fz;      // forward speed
    let vl = this.vel.x * -fz + this.vel.y * fx;     // lateral speed (right positive)

    // engine / brakes
    const top = S.maxSpeed * this.maxHealthSpeedFactor * (this.chaseBoost || 1);
    if (control.throttle > 0) {
      // torque curve: punchy launch that tapers off toward the top end
      const r = clamp(vf / top, 0, 1);
      // taper leaves 40% torque at the top so cars actually REACH top speed
      // on a straight instead of asymptoting at two-thirds of it
      const torque = S.accel * (1.35 - 0.4 * r - 0.55 * r * r);
      const nvf = vf + control.throttle * torque * dt;
      vf = nvf > top ? Math.max(vf, top) : nvf;   // engine can't push past top
    } else if (control.throttle < 0) {
      if (vf > 0.5) vf += control.throttle * S.accel * 2.2 * dt;         // braking
      else vf = Math.max(vf + control.throttle * S.accel * 0.7 * dt, -top * 0.3); // reverse
    }
    this.braking = control.throttle < -0.05 && vf > 0.6;
    this.reversing = vf < -0.4;

    // drag + rolling resistance
    vf -= vf * 0.012 * dt * 60;
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), 0.6 * dt);

    // handbrake + grip (no tyre grip while airborne — velocity is ballistic)
    const grip = this.airborne ? 0 : (control.handbrake ? S.grip * 0.16 : S.grip);
    vl -= vl * clamp(grip * dt, 0, 1);
    if (control.handbrake && Math.abs(vf) > 4 && !this.airborne) vf -= Math.sign(vf) * 5.5 * dt;

    // steering (speed sensitive, reversed in reverse, useless mid-air)
    const speedFactor = this.airborne ? 0 : clamp(Math.abs(vf) / 6, 0, 1) * (1 / (1 + Math.abs(vf) * 0.028));
    const steerDir = vf >= 0 ? 1 : -1;
    this.heading += control.steer * S.steer * speedFactor * steerDir * dt *
      (control.handbrake ? 1.5 : 1);
    this.heading += this.angKick * dt;
    this.angKick *= Math.max(0, 1 - dt * 3.3);
    // a battered chassis pulls to one side (set once at health < 15)
    if (this.wheelPull && !this.airborne) {
      this.heading += this.wheelPull * clamp(Math.abs(vf) / 10, 0, 1) * dt;
    }
    this.steerVis = damp(this.steerVis, control.steer, 10, dt);

    // recompose velocity
    const nfx = Math.sin(this.heading), nfz = Math.cos(this.heading);
    this.vel.x = nfx * vf + -nfz * vl * (control.handbrake ? 1 : 0.55);
    this.vel.y = nfz * vf + nfx * vl * (control.handbrake ? 1 : 0.55);
    this.speed = vf;
    this.lateral = vl;

    // 3-gear feel for the engine note: rpm climbs within a gear, drops on shift
    const ratio = clamp(Math.abs(vf) / top, 0, 1);
    const g3 = ratio < 0.32 ? 0 : ratio < 0.64 ? 1 : 2;
    const lo = g3 === 0 ? 0 : g3 === 1 ? 0.32 : 0.64;
    const hi = g3 === 0 ? 0.32 : g3 === 1 ? 0.64 : 1.0001;
    this.gear = g3;
    this.rpm = (ratio - lo) / (hi - lo);

    // integrate (substepped so fast cars can't tunnel through thin poles)
    const steps = Math.min(4, Math.max(1, Math.ceil((this.vel.length() * dt) / 1.5)));
    const sdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.pos.x += this.vel.x * sdt;
      this.pos.z += this.vel.y * sdt;
      this.collideStatic();
    }

    // terrain follow / airborne arc / sinking
    const ground = this.city.groundHeight(this.pos.x, this.pos.z);
    if (ground < this.city.WATER_Y - 0.25) {
      // in water: sink
      this.sinking += dt;
      this.vy = 0; this.airborne = false;
      this.pos.y = Math.max(this.pos.y - dt * 0.9, ground - 0.4);
      this.vel.x *= 0.95; this.vel.y *= 0.95;
      if (this.sinking > 0.4 && !this.dead) this.drown();
    } else if (this.vy > 0 || this.pos.y > ground + 0.02) {
      // launched by an impact: ballistic until touchdown
      this.airborne = true;
      this.sinking = 0;
      this.vy -= 20 * dt;
      this.pos.y += this.vy * dt;
      if (this.pos.y <= ground) {
        this.pos.y = ground;
        if (this.vy < -6) {
          this.applyDamage((-this.vy - 6) * 3, 'crash', this.driver === 'player' ? 'player' : 'ai');
          this.pitchVel += this.vy * 0.12;   // slam nose-dip on hard landings
        }
        this.vy = this.vy < -4 ? -this.vy * 0.18 : 0;
        if (this.vy < 0.5) { this.vy = 0; this.airborne = false; }
      }
    } else {
      this.pos.y = ground;
      this.vy = 0;
      this.airborne = false;
      this.sinking = 0;
      // catching air off a crest: climbing fast onto terrain that falls
      // away means the wheels can't follow the ground
      if (Math.abs(vf) > 20 && !this.flipping && !this.flipped) {
        const bH = this.city.groundHeight(this.pos.x - nfx * 1.6, this.pos.z - nfz * 1.6);
        const s = (ground - bH) / 1.6;          // rise per metre along heading
        const vRate = s * vf;                    // our current vertical rate
        if (vRate > 1.5) {
          const aH = this.city.groundHeight(this.pos.x + nfx * 3, this.pos.z + nfz * 3);
          if (aH < ground + s * 3 - 0.3) {       // convex crest: ground drops off
            this.vy = vRate;
            this.airborne = true;
          }
        }
      }
    }

    // pitch/roll rock: damped spring, clamped well short of a rollover
    this.pitchVel -= (this.pitchOff * 28 + this.pitchVel * 6) * dt;
    this.rollVel -= (this.rollOff * 28 + this.rollVel * 6) * dt;
    this.pitchOff = clamp(this.pitchOff + this.pitchVel * dt, -0.55, 0.55);
    this.rollOff = clamp(this.rollOff + this.rollVel * dt, -0.55, 0.55);

    // active flip: free barrel roll in the air; on the ground, gravity
    // torque settles the shell onto its wheels or its roof
    if (this.flipping) {
      this.flipRoll += this.flipVel * dt;
      if (this.airborne) {
        this.flipVel *= Math.max(0, 1 - 0.15 * dt);
      } else {
        this.flipRoll = wrapAngle(this.flipRoll);
        const target = Math.abs(this.flipRoll) > Math.PI / 2 ? Math.sign(this.flipRoll) * Math.PI : 0;
        this.flipVel += (target - this.flipRoll) * 10 * dt;
        this.flipVel *= Math.max(0, 1 - 4 * dt);
        this.vel.multiplyScalar(Math.max(0, 1 - 1.8 * dt));   // shell scrapes, speed dies
        if (Math.abs(target - this.flipRoll) < 0.12 && Math.abs(this.flipVel) < 0.4) {
          this.flipRoll = target;
          this.flipVel = 0;
          this.flipping = false;
          if (target !== 0) this.enterFlipped();
          else this.rollVel += 0.6;                            // upright: spring settle
        }
      }
    }
    if (this.flipped && this.rightT > 0) {
      this.rightT -= dt;
      if (this.rightT <= 0) this.selfRight();
    }

    // world bounds
    const lim = this.city.HALF - 4;
    if (Math.abs(this.pos.x) > lim || Math.abs(this.pos.z) > lim) {
      this.pos.x = clamp(this.pos.x, -lim, lim);
      this.pos.z = clamp(this.pos.z, -lim, lim);
      this.vel.multiplyScalar(0.5);
    }

    this.syncMesh(dt);
  }

  collideStatic() {
    const cols = this.city.queryColliders(this.pos.x, this.pos.z, this.boundR + 1.5);
    for (const b of cols) {
      if (b.gone) continue;   // knocked-loose prop, collider being retired
      if (b.baseY != null && b.baseY > this.pos.y + 2) continue;   // upper-floor walls
      const hit = obbVsAabb(this.pos.x, this.pos.z, this.hw, this.hl, this.heading,
        b.minX, b.minZ, b.maxX, b.maxZ);
      if (!hit) continue;
      const vn = this.vel.x * hit.nx + this.vel.y * hit.nz;
      const impact = vn < 0 ? -vn : 0;
      // knockable props break away instead of stopping the car
      if (this.onCrash && this.onCrash(this, b, impact) === true) continue;
      this.pos.x += hit.nx * hit.depth;
      this.pos.z += hit.nz * hit.depth;
      if (vn < 0) {
        this.vel.x -= hit.nx * vn * 1.4;   // bounce
        this.vel.y -= hit.nz * vn * 1.4;
        if (impact > 4) {
          this.applyDamage(impact * 1.7, 'crash', this.driver === 'player' ? 'player' : 'ai');
          this.lastHitSpeed = impact;
        }
      }
    }
  }

  // impact torque: decompose a hit normal (pointing INTO this car) onto the
  // body axes and rock the pitch/roll springs; lift adds vertical launch
  crashKick(nx, nz, impact, lift = 0) {
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const fwd = nx * fx + nz * fz;
    const side = nx * fz - nz * fx;
    this.pitchVel += -fwd * impact * 0.05;
    this.rollVel += side * impact * 0.06;
    if (lift > 0) this.vy = Math.max(this.vy, lift);
    // violent T-bones and blasts under the car roll it for real (walls
    // only rock the pitch — head-on hits shouldn't barrel-roll anyone)
    if (!this.flipping && !this.flipped && !this.dead && this.sinking <= 0 &&
        this.type !== 'moto') {
      if (impact > 14 && Math.abs(side) > 0.7) this.startFlip(Math.sign(side), impact);
      else if (lift > 5) this.startFlip(Math.random() < 0.5 ? 1 : -1, impact);
    }
  }

  startFlip(dir, impact) {
    this.flipping = true;
    this.flipVel = dir * (2.5 + Math.min(impact, 30) * 0.12);
    this.vy = Math.max(this.vy, Math.min(6, impact * 0.25));
    this.airborne = true;
    this.rollOff = 0;
    this.rollVel = 0;   // the spring hands the roll over to the flip
  }

  enterFlipped() {
    this.flipped = true;
    this.sirenOn = false;
    this.vel.multiplyScalar(0.3);
    this.onFlipped?.(this);
  }

  // the lurch back onto the wheels (player cars only, after a beat)
  selfRight() {
    this.flipped = false;
    this.flipping = true;
    this.flipVel = -Math.sign(this.flipRoll || 1) * 3.5;
    this.vy = 3;
    this.airborne = true;
    this.applyDamage(15, 'crash');
  }

  // culprit tracks WHO wrecked this car ('player'|'ai') so an eventual
  // explosion can be attributed — AI pileups must not raise player heat
  applyDamage(amount, cause = 'unknown', culprit = null) {
    if (this.dead) return;
    if (culprit) this._lastHitBy = culprit;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.explode(cause);
    }
  }

  // the greenhouse pane hides = glass gone (glassBurst FX comes from the caller)
  shatterGlass() {
    if (this.partState.windows) return false;
    const w = this.parts?.windows;
    if (!w) return false;
    w.visible = false;
    this.partState.windows = 2;
    return true;
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
    // paint materials are shared between cars of the same colour — swap the
    // painted meshes onto the shared charred material instead of tinting
    const paint = this.bodyMat;
    this.group.traverse((o) => { if (o.isMesh && o.material === paint) o.material = charredMat; });
    this.bodyMat = charredMat;
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
    const lean = this.type === 'moto' ? -this.steerVis * clamp(Math.abs(this.speed) / 12, 0, 1) * 0.45 : 0;
    this.group.rotation.set(pitch + this.pitchOff, this.heading, lean + this.rollOff + this.flipRoll, 'YXZ');
    // a rolling body rides up on its side / rests on its roof — visual
    // lift only; the physics origin stays at wheel-contact height
    if (this.flipRoll !== 0) {
      const wr = wrapAngle(this.flipRoll);
      this.group.position.y += Math.abs(Math.sin(wr)) * this.hw * 0.55 +
        Math.max(0, -Math.cos(wr)) * (this.spec.h - this.wheelR);
    }

    // wheels spin + front steering pivots
    const spin = (this.flipping || this.flipped) ? 0 : this.speed * dt / this.wheelR;
    for (const w of this.wheels) w.rotation.x += spin;
    const steer = this.steerVis * (this.type === 'moto' ? 0.5 : 0.45);
    for (const p of this.frontPivots) p.rotation.y = steer;
    this.updateLightState();
  }

  updateLightState() {
    if (!this.headMat) return;
    // alarm flash overrides; brake tails stack on top of night tails
    const flash = this.alarmT > 0 && Math.floor(this.alarmT * 2.5) % 2 === 0;
    this.headMat.emissiveIntensity = (this.lightsOn || flash) ? 1.4 : 0;
    this.tailMat.emissiveIntensity =
      (this.braking ? 1.9 : 0) + ((this.lightsOn || flash) ? 0.9 : 0);
    if (this.reverseMat) this.reverseMat.emissiveIntensity = this.reversing ? 1.5 : 0;
  }

  setNightLights(on) {
    this.lightsOn = on;
    this.updateLightState();
  }

  flashSiren(t) {
    if (!this.lightbarR) return;
    const phase = Math.floor(t * 4) % 2;
    this.lightbarR.emissiveIntensity = this.sirenOn ? (phase ? 2.2 : 0.1) : 0;
    this.lightbarB.emissiveIntensity = this.sirenOn ? (phase ? 0.1 : 2.2) : 0;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        if (!SHARED_GEOS.has(o.geometry)) o.geometry?.dispose();
        if (!SHARED_MATS.has(o.material)) o.material?.dispose();
      }
    });
    this.group.removeFromParent();
  }
}
