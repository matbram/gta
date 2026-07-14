// Ragdoll physics + blood decals. The ragdoll drives the whole character
// group as a rigid body toppling under an impact impulse, with the skeleton's
// limbs jittering via the animator's overlay — cheap but convincingly floppy.
// Blood decals are pooled ground quads that pool and fade under bodies.

import * as THREE from 'three';
import { clamp, distSq2d } from '../core/mathutil.js';
import { VerletRagdoll } from './ragdoll.js';

// -------- cheap ragdoll: rigid topple + limp bone pose ------------------
// Still used for knockdowns (stagger needs a get-up-friendly pose) and for
// deaths far from the camera; nearby deaths get the real verlet ragdoll.
export class Ragdoll {
  constructor(rig, city, opts = {}) {
    this.rig = rig;
    this.city = city;
    this.group = rig.group;
    // linear + angular state of the body
    this.vx = opts.vx ?? 0;
    this.vy = opts.vy ?? 2 + Math.random() * 1.5;
    this.vz = opts.vz ?? 0;
    this.angVel = (Math.random() - 0.5) * 4 + (opts.spin ?? 0);
    this.tiltVel = 3 + Math.random() * 3;   // topple speed
    this.tiltAxis = Math.random() < 0.5 ? 'x' : 'z';
    this.tilt = 0;
    this.baseY = this.group.position.y;
    this.settled = false;
    this.t = 0;
    // limb flop targets on the skinned rig
    this.bones = rig.animator?.bones ?? null;
    this.phase = Math.random() * 6;
  }

  update(dt) {
    this.t += dt;
    const g = this.group;

    if (!this.settled) {
      // integrate a little hop + gravity
      this.vy -= 20 * dt;
      g.position.x += this.vx * dt;
      g.position.z += this.vz * dt;
      const ground = (this.rig.interiorY ?? this.city.groundHeight(g.position.x, g.position.z));
      g.position.y += this.vy * dt;

      // topple toward lying flat
      this.tilt = Math.min(Math.PI / 2, this.tilt + this.tiltVel * dt);
      this.tiltVel *= 0.98;
      g.rotation.y += this.angVel * dt;
      this.angVel *= 0.9;
      if (this.tiltAxis === 'x') g.rotation.x = this.tilt;
      else g.rotation.z = this.tilt * (this.vx >= 0 ? 1 : -1);

      // land
      if (g.position.y <= ground + 0.12) {
        g.position.y = ground + 0.12;
        this.vy *= -0.25;          // small bounce
        this.vx *= 0.6; this.vz *= 0.6;
        if (Math.abs(this.vy) < 0.6 && this.tilt >= Math.PI / 2 - 0.15) {
          this.settled = true;
          this.tilt = Math.PI / 2;
          if (this.tiltAxis === 'x') g.rotation.x = this.tilt;
          else g.rotation.z = this.tilt * (this.vx >= 0 ? 1 : -1);
        }
      }
    }

    // limbs go limp: relax bones toward a slack hang (skinned rigs only)
    if (this.bones) {
      this.phase += dt * 2;
      const b = this.bones;
      const slack = (bone, x, z) => {
        if (!bone) return;
        bone.rotation.x = x + Math.sin(this.phase + bone.id) * 0.04;
        bone.rotation.z = z;
      };
      const limp = this.settled ? 1 : clamp(this.t * 2, 0, 1);
      slack(b.armL, -0.3 * limp, 0.5 * limp);
      slack(b.armR, -0.3 * limp, -0.5 * limp);
      slack(b.foreArmL, -0.4 * limp, 0);
      slack(b.foreArmR, -0.4 * limp, 0);
      slack(b.upLegL, 0.2 * limp, 0.1 * limp);
      slack(b.upLegR, 0.2 * limp, -0.1 * limp);
      if (b.head) b.head.rotation.x = 0.3 * limp;
      if (b.spine1) b.spine1.rotation.x = 0.1 * limp;
    }
    this.rig.animator?.mixer.update(0);   // keep skinning matrices fresh
  }
}

// -------- gore manager: ragdoll factory + blood --------
export class Gore {
  constructor(game) {
    this.game = game;
    this.blood = new BloodSystem(game);
    this.activeRagdolls = [];
  }

  // cheap: true forces the rigid topple (stagger knockdowns need a pose
  // the get-up can recover from). Deaths near the camera get the verlet
  // ragdoll, capped at 8 live simulations; everything else topples.
  makeRagdoll(rig, impact, { cheap = false } = {}) {
    if (!cheap && rig.animator?.bones?.hips) {
      const cam = this.game.camera;
      const near = !cam || distSq2d(rig.group.position.x, rig.group.position.z,
        cam.position.x, cam.position.z) < 70 * 70;
      this.activeRagdolls = this.activeRagdolls.filter((r) => !r.disposed && !r.settled);
      if (near && this.activeRagdolls.length < 8) {
        const rag = new VerletRagdoll(rig, this.game.city, impact);
        if (!rag.invalid) {
          this.activeRagdolls.push(rag);
          return rag;
        }
      }
    }
    const opts = {};
    if (impact) {
      opts.vx = (impact.dx ?? 0) * (impact.force ?? 1);
      opts.vz = (impact.dz ?? 0) * (impact.force ?? 1);
      opts.vy = 1.5 + (impact.up ?? 0);
      opts.spin = (impact.spin ?? 0);
    }
    return new Ragdoll(rig, this.game.city, opts);
  }
  update(dt) { this.blood.update(dt); }
}

// -------- blood: impact spurts + growing ground pools --------
export class BloodSystem {
  constructor(game) {
    this.game = game;
    this.decals = [];
    this.max = 40;
    // shared round decal texture
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    grad.addColorStop(0, 'rgba(120,10,8,0.95)');
    grad.addColorStop(0.7, 'rgba(90,6,6,0.8)');
    grad.addColorStop(1, 'rgba(70,4,4,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    // irregular splat
    ctx.moveTo(32, 2);
    for (let a = 0; a < Math.PI * 2; a += 0.4) {
      const r = 22 + Math.sin(a * 3) * 6 + Math.random() * 4;
      ctx.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    this.tex = new THREE.CanvasTexture(c);
    this.geo = new THREE.PlaneGeometry(1, 1);
    this.geo.rotateX(-Math.PI / 2);
  }

  // splat under a hit position; grows over the next couple seconds
  pool(x, z, y = null) {
    const game = this.game;
    const gy = (y ?? game.city.groundHeight(x, z)) + 0.03;
    const mat = new THREE.MeshBasicMaterial({
      map: this.tex, transparent: true, opacity: 0.85, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2,
    });
    const m = new THREE.Mesh(this.geo, mat);
    m.position.set(x, gy, z);
    m.rotation.y = Math.random() * Math.PI * 2;
    m.scale.setScalar(0.3);
    game.scene.add(m);
    const decal = { mesh: m, mat, grow: 1.4 + Math.random() * 1.2, t: 0, ttl: 40 };
    this.decals.push(decal);
    if (this.decals.length > this.max) {
      const old = this.decals.shift();
      old.mesh.removeFromParent();
      old.mat.dispose();
    }
  }

  // fresh enough pool to track blood out of?
  freshPoolAt(x, z) {
    for (const d of this.decals) {
      if (d.t < 30 &&
          Math.abs(d.mesh.position.x - x) < 1.0 &&
          Math.abs(d.mesh.position.z - z) < 1.0) return true;
    }
    return false;
  }

  // small alternating footprints tracked out of a pool (instanced ring)
  footprint(x, z, heading, side) {
    if (!this._fpPool) {
      const geo = new THREE.PlaneGeometry(0.11, 0.27);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x6a0806, transparent: true, opacity: 0.55, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2,
      });
      this._fpPool = new THREE.InstancedMesh(geo, mat, 120);
      this._fpPool.frustumCulled = false;
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < 120; i++) this._fpPool.setMatrixAt(i, zero);
      this._fpIdx = 0;
      this._fpDummy = new THREE.Object3D();
      this.game.scene.add(this._fpPool);
    }
    const g = this.game.city.groundHeight(x, z);
    const px = Math.cos(heading) * 0.13 * side, pz = -Math.sin(heading) * 0.13 * side;
    this._fpDummy.position.set(x + px, g + 0.028, z + pz);
    this._fpDummy.rotation.set(0, heading, 0);
    this._fpDummy.scale.setScalar(1);
    this._fpDummy.updateMatrix();
    this._fpPool.setMatrixAt(this._fpIdx % 120, this._fpDummy.matrix);
    this._fpPool.instanceMatrix.needsUpdate = true;
    this._fpIdx++;
  }

  // one dark red tread strip at an actual wheel's contact point — the
  // caller tracks each wheel separately, so a moto lays 2 tracks and a
  // car that only clipped a pool with one tire lays 1
  tireStreak(x, z, heading) {
    if (!this._tsPool) {
      const geo = new THREE.PlaneGeometry(0.26, 1.1);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x5c0a08, transparent: true, opacity: 0.42, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2,
      });
      this._tsPool = new THREE.InstancedMesh(geo, mat, 180);
      this._tsPool.frustumCulled = false;
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < 180; i++) this._tsPool.setMatrixAt(i, zero);
      this._tsIdx = 0;
      this._tsDummy = new THREE.Object3D();
      this.game.scene.add(this._tsPool);
    }
    const g = this.game.city.groundHeight(x, z);
    this._tsDummy.position.set(x, g + 0.027, z);
    this._tsDummy.rotation.set(0, heading, 0);
    this._tsDummy.scale.setScalar(1);
    this._tsDummy.updateMatrix();
    this._tsPool.setMatrixAt(this._tsIdx % 180, this._tsDummy.matrix);
    this._tsIdx++;
    this._tsPool.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    for (const d of this.decals) {
      d.t += dt;
      if (d.t < 2) d.mesh.scale.setScalar(0.3 + (d.grow - 0.3) * (d.t / 2));
      if (d.t > d.ttl - 6) d.mat.opacity = 0.85 * clamp((d.ttl - d.t) / 6, 0, 1);
      if (d.t > d.ttl) { d.mesh.removeFromParent(); d.mat.dispose(); d._dead = true; }
    }
    if (this.decals.some((d) => d._dead)) this.decals = this.decals.filter((d) => !d._dead);
  }
}
