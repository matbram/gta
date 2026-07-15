// Verlet ragdoll: a 13-particle point-mass skeleton (head, chest, hips,
// shoulders, elbows, hands, knees, feet) with stick constraints, driven onto
// the character's real bones every frame. Replaces the old rigid "topple and
// go limp" fall for deaths near the camera — bodies now crumple, slide and
// come to rest naturally instead of folding their legs under the torso.
//
// Bone mapping strategy: rather than precomputing bind-pose offsets (fragile
// against the mixamo rig's π model flip and per-character height scaling),
// each frame we measure the CURRENT world direction bone→child and rotate the
// bone by the world-space delta onto the particle direction. The mixer is
// frozen on death, so the pose converges in a couple of frames and stays
// glued to the simulation afterwards.

import * as THREE from 'three';
import { clamp } from '../core/mathutil.js';

const GRAV = -20;
const H = 1 / 60;            // fixed substep
const DAMP = 0.995;
const ITERS = 3;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _cur = new THREE.Vector3();
const _want = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _pqi = new THREE.Quaternion();
const _lq = new THREE.Quaternion();
const _ident = new THREE.Quaternion();

// particle name → source bone (positions seeded from the death pose)
const P_BONES = {
  head: 'head', chest: 'neck', hips: 'hips',
  shoulderL: 'armL', shoulderR: 'armR',
  elbowL: 'foreArmL', elbowR: 'foreArmR',
  handL: 'handL', handR: 'handR',
  kneeL: 'legL', kneeR: 'legR',
  footL: 'footL', footR: 'footR',
};
// contact radius per particle (bigger for the trunk)
const P_RAD = {
  head: 0.11, chest: 0.14, hips: 0.14,
  shoulderL: 0.09, shoulderR: 0.09,
  elbowL: 0.06, elbowR: 0.06, handL: 0.05, handR: 0.05,
  kneeL: 0.07, kneeR: 0.07, footL: 0.06, footR: 0.06,
};
// stick constraints (rest lengths measured at spawn, never hard-coded —
// rigs carry per-character height scaling)
const STICKS = [
  ['hips', 'chest'], ['chest', 'head'],
  // torso brace: gives the trunk a full orientation frame
  ['shoulderL', 'shoulderR'], ['shoulderL', 'chest'], ['shoulderR', 'chest'],
  ['shoulderL', 'hips'], ['shoulderR', 'hips'],
  ['shoulderL', 'elbowL'], ['elbowL', 'handL'],
  ['shoulderR', 'elbowR'], ['elbowR', 'handR'],
  ['hips', 'kneeL'], ['kneeL', 'footL'],
  ['hips', 'kneeR'], ['kneeR', 'footR'],
];
// push-apart-only constraints: stop limbs folding through themselves —
// this is what prevents the old "legs tucked under the body" look
const MIN_DISTS = [
  ['shoulderL', 'handL', 0.6], ['shoulderR', 'handR', 0.6],
  ['hips', 'footL', 0.65], ['hips', 'footR', 0.65],
  ['kneeL', 'kneeR', 0.35],   // fraction of shoulder width
  ['hips', 'head', 0.7],
];

export class VerletRagdoll {
  // impact: {dx, dz, force, up, spin, vx?, vz?} — same contract the old
  // rigid ragdoll used, so every death call site works unchanged
  constructor(rig, city, impact = null) {
    this.rig = rig;
    this.city = city;
    this.settled = false;
    this.disposed = false;
    this.t = 0;
    this._stillT = 0;
    this._acc = 0;

    const bones = rig.animator?.bones ?? {};
    rig.group.updateMatrixWorld(true);

    // seed particles from the actual death pose (world space)
    this.p = {};
    for (const [name, boneKey] of Object.entries(P_BONES)) {
      const bone = bones[boneKey];
      if (!bone) { this.invalid = true; return; }
      bone.getWorldPosition(_a);
      this.p[name] = { x: _a.x, y: _a.y, z: _a.z, px: _a.x, py: _a.y, pz: _a.z, r: P_RAD[name] };
    }
    // hip joints for the legs are offset along the pelvis, not simulated
    this.sticks = STICKS.map(([a, b]) => {
      const pa = this.p[a], pb = this.p[b];
      return { a: pa, b: pb, rest: Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z) || 0.1 };
    });
    const armLen = this.stickRest('shoulderL', 'elbowL') + this.stickRest('elbowL', 'handL');
    const legLen = this.stickRest('hips', 'kneeL') + this.stickRest('kneeL', 'footL');
    const shoulderW = this.stickRest('shoulderL', 'shoulderR');
    const spineLen = this.stickRest('hips', 'chest') + this.stickRest('chest', 'head');
    const MIN_REF = { shoulderL: armLen, shoulderR: armLen, hips: legLen, kneeL: shoulderW };
    this.minDists = MIN_DISTS.map(([a, b, f]) => ({
      a: this.p[a], b: this.p[b],
      min: (b === 'head' ? spineLen : (MIN_REF[a] ?? 1)) * f,
    }));

    // the old fall path may have started tipping the whole group — take over
    rig.group.rotation.x = 0;
    rig.group.rotation.z = 0;

    // impact impulse: bullets whip the upper body back (feet planted for a
    // beat); big hits (cars, explosions) launch everything
    if (impact) {
      const f = impact.force ?? 1;
      const vx = (impact.vx ?? 0) + (impact.dx ?? 0) * f;
      const vz = (impact.vz ?? 0) + (impact.dz ?? 0) * f;
      const vy = 1.5 + (impact.up ?? 0);
      const whole = f > 4;
      const UPPER = ['head', 'chest', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'handL', 'handR'];
      for (const [name, P] of Object.entries(this.p)) {
        let k = whole ? 1 : (UPPER.includes(name) ? 1 : name === 'hips' ? 0.4 : 0.15);
        if (whole && name === 'hips') k = 1.6;
        P.px = P.x - (vx * k + (Math.random() - 0.5) * 0.3) * H;
        P.py = P.y - (vy * k + (Math.random() - 0.5) * 0.2) * H;
        P.pz = P.z - (vz * k + (Math.random() - 0.5) * 0.3) * H;
      }
      const spin = (impact.spin ?? 0) * 0.4;
      if (spin) {
        this.p.shoulderL.px += spin * H;
        this.p.shoulderR.px -= spin * H;
      }
    }
  }

  stickRest(a, b) {
    const s = this.sticks.find((s) => s.a === this.p[a] && s.b === this.p[b]);
    return s ? s.rest : 0.4;
  }

  groundAt(x, z) {
    return this.rig.interiorY ?? this.city.groundHeight(x, z);
  }

  update(dt) {
    if (this.invalid || this.disposed || this.settled) return;
    this.t += dt;

    // fixed-substep verlet (≤3 substeps a frame)
    this._acc = Math.min(this._acc + dt, H * 3);
    let maxMove = 0;
    while (this._acc >= H) {
      this._acc -= H;
      maxMove = Math.max(maxMove, this.substep());
    }

    // sleep when still (or force-settle a long-running one)
    if (maxMove < 0.01) {
      this._stillT += dt;
      if (this._stillT > 0.4 || this.t > 6) { this.settled = true; return; }
    } else this._stillT = 0;
    if (this.t > 6) { this.settled = true; return; }

    // off-screen ragdolls keep simulating but skip the bone mapping
    if (this.rig.group.visible) this.applyToBones();
    this.rig.animator?.mixer.update(0);   // refresh skinning matrices
  }

  substep() {
    let maxMove = 0;
    // integrate
    for (const P of Object.values(this.p)) {
      const nx = P.x + (P.x - P.px) * DAMP;
      const ny = P.y + (P.y - P.py) * DAMP + GRAV * H * H;
      const nz = P.z + (P.z - P.pz) * DAMP;
      const m = Math.abs(nx - P.x) + Math.abs(ny - P.y) + Math.abs(nz - P.z);
      if (m > maxMove) maxMove = m;
      P.px = P.x; P.py = P.y; P.pz = P.z;
      P.x = nx; P.y = ny; P.z = nz;
    }
    // constraints
    for (let it = 0; it < ITERS; it++) {
      for (const s of this.sticks) {
        const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, dz = s.b.z - s.a.z;
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        const off = (d - s.rest) / d * 0.5;
        s.a.x += dx * off; s.a.y += dy * off; s.a.z += dz * off;
        s.b.x -= dx * off; s.b.y -= dy * off; s.b.z -= dz * off;
      }
      for (const md of this.minDists) {
        const dx = md.b.x - md.a.x, dy = md.b.y - md.a.y, dz = md.b.z - md.a.z;
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        if (d >= md.min) continue;
        const off = (d - md.min) / d * 0.5;   // push apart only
        md.a.x += dx * off; md.a.y += dy * off; md.a.z += dz * off;
        md.b.x -= dx * off; md.b.y -= dy * off; md.b.z -= dz * off;
      }
      // ground: project up, drag horizontal motion (friction)
      for (const P of Object.values(this.p)) {
        const gy = this.groundAt(P.x, P.z) + P.r;
        if (P.y < gy) {
          P.y = gy;
          P.x += (P.px - P.x) * 0.5;
          P.z += (P.pz - P.z) * 0.5;
        }
      }
    }
    return maxMove;
  }

  // world-space delta rotation applied to a bone in its parent frame
  _rotateBoneWorld(bone) {
    bone.parent.getWorldQuaternion(_pq);
    _pqi.copy(_pq).invert();
    _lq.copy(_pqi).multiply(_dq).multiply(_pq);
    bone.quaternion.premultiply(_lq);
    bone.updateMatrixWorld(true);
  }

  _align(bone, refChild, fromP, toP, w = 0.85) {
    if (!bone || !refChild) return;
    bone.getWorldPosition(_a);
    refChild.getWorldPosition(_b);
    _cur.subVectors(_b, _a);
    _want.set(toP.x - fromP.x, toP.y - fromP.y, toP.z - fromP.z);
    if (_cur.lengthSq() < 1e-8 || _want.lengthSq() < 1e-8) return;
    _dq.setFromUnitVectors(_cur.normalize(), _want.normalize());
    if (w < 1) _dq.slerp(_ident, 1 - w);
    this._rotateBoneWorld(bone);
  }

  applyToBones() {
    const rig = this.rig, bones = rig.animator?.bones;
    if (!bones?.hips) return;
    const g = rig.group;
    const P = this.p;
    g.updateMatrixWorld(true);

    // 1. plant the hips bone on the hips particle by moving the group
    bones.hips.getWorldPosition(_a);
    g.position.x += P.hips.x - _a.x;
    g.position.y += P.hips.y - _a.y;
    g.position.z += P.hips.z - _a.z;
    g.updateMatrixWorld(true);

    // 2. trunk: point the spine at the chest particle...
    this._align(bones.hips, bones.spine ?? bones.spine1 ?? bones.neck, P.hips, P.chest, 1);
    // ...then roll the pelvis so the shoulder line matches the particles
    if (bones.armL && bones.armR) {
      bones.armR.getWorldPosition(_a);
      bones.armL.getWorldPosition(_b);
      _cur.subVectors(_a, _b);
      _want.set(P.shoulderR.x - P.shoulderL.x, P.shoulderR.y - P.shoulderL.y, P.shoulderR.z - P.shoulderL.z);
      _axis.set(P.chest.x - P.hips.x, P.chest.y - P.hips.y, P.chest.z - P.hips.z).normalize();
      // project both onto the plane ⊥ spine, rotate about the spine
      _t1.copy(_cur).addScaledVector(_axis, -_cur.dot(_axis));
      _t2.copy(_want).addScaledVector(_axis, -_want.dot(_axis));
      if (_t1.lengthSq() > 1e-6 && _t2.lengthSq() > 1e-6) {
        _t1.normalize(); _t2.normalize();
        const dot = clamp(_t1.dot(_t2), -1, 1);
        const cross = _cur.copy(_t1).cross(_t2).dot(_axis);
        const ang = Math.atan2(cross, dot);
        _dq.setFromAxisAngle(_axis, ang * 0.85);
        this._rotateBoneWorld(bones.hips);
      }
    }

    // 3. head + limbs (aim each segment at its particle)
    this._align(bones.neck ?? bones.spine2, bones.head, P.chest, P.head);
    this._align(bones.armL, bones.foreArmL, P.shoulderL, P.elbowL);
    this._align(bones.foreArmL, bones.handL, P.elbowL, P.handL);
    this._align(bones.armR, bones.foreArmR, P.shoulderR, P.elbowR);
    this._align(bones.foreArmR, bones.handR, P.elbowR, P.handR);
    this._align(bones.upLegL, bones.legL, P.hips, P.kneeL);
    this._align(bones.legL, bones.footL, P.kneeL, P.footL);
    this._align(bones.upLegR, bones.legR, P.hips, P.kneeR);
    this._align(bones.legR, bones.footR, P.kneeR, P.footR);
  }

  dispose() {
    this.disposed = true;
  }
}
