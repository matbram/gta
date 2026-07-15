// Animator: drives a skinned character. Wraps AnimationMixer with a
// crossfade state machine, resolves the Mixamo-style bone map, and applies
// procedural overlays AFTER the mixer so poses the clip library lacks
// (aiming, driving, swimming, punches, hit reactions, hands-up, sitting)
// are synthesized on top of real clips.

import * as THREE from 'three';
import { clamp, damp, lerp } from './mathutil.js';

const BONE_ALIASES = {
  hips: ['mixamorigHips', 'mixamorig:Hips', 'Hips'],
  spine: ['mixamorigSpine', 'mixamorig:Spine', 'Spine'],
  spine1: ['mixamorigSpine1', 'mixamorig:Spine1', 'Spine1'],
  spine2: ['mixamorigSpine2', 'mixamorig:Spine2', 'Spine2'],
  neck: ['mixamorigNeck', 'mixamorig:Neck', 'Neck'],
  head: ['mixamorigHead', 'mixamorig:Head', 'Head'],
  armL: ['mixamorigLeftArm', 'mixamorig:LeftArm', 'LeftArm'],
  foreArmL: ['mixamorigLeftForeArm', 'mixamorig:LeftForeArm', 'LeftForeArm'],
  handL: ['mixamorigLeftHand', 'mixamorig:LeftHand', 'LeftHand'],
  armR: ['mixamorigRightArm', 'mixamorig:RightArm', 'RightArm'],
  foreArmR: ['mixamorigRightForeArm', 'mixamorig:RightForeArm', 'RightForeArm'],
  handR: ['mixamorigRightHand', 'mixamorig:RightHand', 'RightHand'],
  upLegL: ['mixamorigLeftUpLeg', 'mixamorig:LeftUpLeg', 'LeftUpLeg'],
  legL: ['mixamorigLeftLeg', 'mixamorig:LeftLeg', 'LeftLeg'],
  footL: ['mixamorigLeftFoot', 'mixamorig:LeftFoot', 'LeftFoot'],
  upLegR: ['mixamorigRightUpLeg', 'mixamorig:RightUpLeg', 'RightUpLeg'],
  legR: ['mixamorigRightLeg', 'mixamorig:RightLeg', 'RightLeg'],
  footR: ['mixamorigRightFoot', 'mixamorig:RightFoot', 'RightFoot'],
};

// overlay pose targets, applied as extra local rotations (radians)
// each entry: bone → [x, y, z]. Exported so tests can inspect/tune poses.
export const OVERLAY_POSES = {
  none: {},
  // NOTE on arm axes (probed empirically on this skeleton, arms hanging):
  // arm +X = raise forward, arm -X = swing back; armR -Z / armL +Z = out to
  // the side, armR +Z / armL -Z = tuck across the body; foreArm -X = elbow flex.
  drive: {
    upLegL: [-1.35, 0, 0.12], upLegR: [-1.35, 0, -0.12],
    legL: [1.2, 0, 0], legR: [1.2, 0, 0],
    armL: [-0.68, 0, -0.12], armR: [0.68, 0, 0.12],
    foreArmL: [0.45, 0, 0], foreArmR: [-0.45, 0, 0],
    spine1: [0.08, 0, 0],
  },
  // motorcycle straddle: knees out and gripping the tank, leaning into the bars
  ride: {
    upLegL: [-0.95, 0, 0.55], upLegR: [-0.95, 0, -0.55],
    legL: [1.15, 0, 0], legR: [1.15, 0, 0],
    armL: [-0.85, 0, -0.08], armR: [0.85, 0, 0.08],
    foreArmL: [0.3, 0, 0], foreArmR: [-0.3, 0, 0],
    spine1: [0.32, 0, 0], head: [-0.2, 0, 0],
  },
  sit: {
    upLegL: [-1.45, 0, 0.1], upLegR: [-1.45, 0, -0.1],
    legL: [1.35, 0, 0], legR: [1.35, 0, 0],
    spine1: [0.05, 0, 0],
  },
  aimPistol: {                         // two-hand isosceles, arms punched out
    armR: [1.25, 0, 0.15], foreArmR: [-0.15, 0, 0],
    armL: [-1.15, 0, 0.35], foreArmL: [0.45, -0.5, 0],
    spine2: [0, -0.12, 0],
  },
  aimRifle: {                          // shouldered, off hand out to the foregrip
    armR: [1.15, 0, 0.15], foreArmR: [-0.4, 0, 0],
    armL: [-1.05, 0, 0.2], foreArmL: [0.4, -0.4, 0],
    spine2: [0, -0.22, 0],
  },
  // ---- per-weapon stances (I3) ----
  // boxing guard: both fists up in front of the chin, bladed stance
  guardFists: {
    armR: [0.55, 0, 0.3], foreArmR: [-1.9, 0, 0],
    armL: [-0.7, 0, 0.25], foreArmL: [2.3, 0, 0],
    spine2: [0, 0.22, 0], head: [0.06, -0.1, 0],
  },
  // bat cocked over the right shoulder, off hand across the chest
  stanceBat: {
    armR: [-0.45, 0, -0.5], foreArmR: [-1.7, 0, 0],
    armL: [-0.75, 0, 0.45], foreArmL: [1.3, 0, 0],
    spine2: [0, 0.35, 0], head: [0, -0.2, 0],
  },
  // SMG: compact grip, elbows tucked into the body
  aimSmg: {
    armR: [0.95, 0, 0.25], foreArmR: [-0.8, 0, 0],
    armL: [-1.0, 0, 0.3], foreArmL: [0.85, -0.35, 0],
    spine2: [0, -0.1, 0],
  },
  // shotgun: shouldered like the rifle but a wider, braced base
  aimShotgun: {
    armR: [1.12, 0, 0.12], foreArmR: [-0.42, 0, 0],
    armL: [-1.05, 0, 0.2], foreArmL: [0.35, -0.4, 0],
    spine1: [0.06, 0, 0], spine2: [0, -0.26, 0],
  },
  // ---- carry poses: weapon out but not aimed ----
  carryPistol: {                       // pistol held low at the thigh
    armR: [0.25, 0, 0.1], foreArmR: [-0.35, 0, 0],
  },
  carryLong: {                         // long gun low-ready across the chest
    armR: [0.35, 0, 0.15], foreArmR: [-1.0, 0, 0],
    armL: [-0.55, 0, 0.2], foreArmL: [1.15, -0.25, 0],
    spine2: [0, 0.1, 0],
  },
  carryBat: {                          // bat resting on the shoulder
    armR: [-0.2, 0, -0.35], foreArmR: [-1.75, 0, 0],
  },
  handsUp: {
    armL: [0, 0, 2.4], armR: [0, 0, -2.4],
    foreArmL: [0, 0, 0.5], foreArmR: [0, 0, -0.5],
  },
  phone: {
    armR: [0.2, 0, 0.2], foreArmR: [-2.35, 0.35, 0],
    head: [0.12, -0.18, 0],
  },
  swim: {
    hipsRotX: true,
    spine1: [-0.2, 0, 0],
    armL: [0, 0, 1.4], armR: [0, 0, -1.4],
  },
  jump: {
    upLegL: [-0.75, 0, 0], legL: [1.2, 0, 0],
    upLegR: [-0.35, 0, 0], legR: [0.7, 0, 0],
    armL: [-0.35, 0, 0.7], armR: [0.35, 0, -0.7],
    spine1: [0.14, 0, 0], head: [-0.1, 0, 0],
  },
  // protective kneel: left foot planted in front, right knee to the ground
  // (hipDrop actually lowers the body), torso curled, forearms shielding
  // the head — replaces a lopsided hanging-arms squat that read as broken
  kneel: {
    hipDrop: 0.45,   // fraction of the hips' rest height (skeleton units vary)
    upLegL: [-1.25, 0, 0.08], legL: [1.25, 0, 0],
    upLegR: [0.25, 0, -0.08], legR: [1.9, 0, 0],
    spine1: [0.3, 0, 0], head: [0.22, 0, 0],
    armR: [0.9, 0, 0.25], foreArmR: [-2.3, 0, 0],
    armL: [-0.9, 0, -0.25], foreArmL: [2.3, 0, 0],
  },
  // leg-shot hobble: the body favours the good (left) leg — hunched and
  // leaning off the injured side, the right knee locked stiff and hip hiked
  // so that leg drags, an arm guarding the wound. A phase-synced vertical
  // hitch (applied below) adds the characteristic limp lurch.
  limp: {
    hipDrop: 0.09,
    hips: [0, 0, -0.1],                  // hike the injured (right) hip up
    upLegR: [0.12, 0, 0.05], legR: [0.28, 0, 0],   // right leg forward + knee locked
    spine1: [0.24, 0, -0.16],            // hunch forward, lean toward the good side
    spine2: [0, 0, -0.07], head: [0.1, 0, 0.09],
    armR: [0.22, 0, 0.16], foreArmR: [-0.5, 0, 0], // right arm guards the hip
    armL: [0.1, 0, 0],
  },
  // belly-crawl for the wounded: body low and pitched forward, arms
  // clawing ahead, legs trailing (walk clip underneath supplies motion)
  crawl: {
    hipDrop: 0.72,
    spine1: [1.05, 0, 0], head: [-0.5, 0, 0],
    armR: [1.35, 0, 0.2], foreArmR: [-0.7, 0, 0],
    armL: [-1.35, 0, -0.2], foreArmL: [0.7, 0, 0],
    upLegL: [0.5, 0, 0], legL: [0.6, 0, 0],
    upLegR: [0.35, 0, 0], legR: [0.75, 0, 0],
  },
  hose: {
    armR: [0.95, 0, 0.15], foreArmR: [-0.4, 0, 0],
    armL: [-0.85, 0, 0.25], foreArmL: [0.6, -0.4, 0],
    spine1: [0.06, 0, 0],
  },
};

export class Animator {
  constructor(root, clips) {
    this.root = root;
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = new Map();
    for (const clip of clips) {
      this.actions.set(clip.name.toLowerCase(), this.mixer.clipAction(clip));
    }
    this.current = null;
    this.currentName = null;

    // resolve bones
    this.bones = {};
    root.traverse((o) => {
      if (!o.isBone) return;
      const plain = o.name.replace(/[:_]/g, '');
      for (const [key, aliases] of Object.entries(BONE_ALIASES)) {
        if (this.bones[key]) continue;
        if (aliases.some((a) => plain === a.replace(/[:_]/g, ''))) this.bones[key] = o;
      }
    });

    // overlay state: name + blend weight, smoothly faded
    this.overlay = 'none';
    this.overlayW = 0;
    this.targetOverlay = 'none';
    this.aimPitch = 0;

    // one-shot gesture (punch etc): { t, dur, apply(t01) }
    this.gesture = null;

    // per-frame additive quats are rebuilt from base pose each update
    this.baseQuats = new Map();
    for (const b of Object.values(this.bones)) this.baseQuats.set(b, b.quaternion.clone());
  }

  has(name) { return this.actions.has(name.toLowerCase()); }

  play(name, { fade = 0.22, timeScale = 1, once = false } = {}) {
    const key = name.toLowerCase();
    const action = this.actions.get(key);
    if (!action) return false;
    if (this.currentName === key && !once) {
      action.timeScale = timeScale;
      return true;
    }
    action.reset();
    action.timeScale = timeScale;
    if (once) { action.setLoop(THREE.LoopOnce); action.clampWhenFinished = true; }
    action.play();
    if (this.current && this.current !== action) this.current.crossFadeTo(action, fade, false);
    this.current = action;
    this.currentName = key;
    return true;
  }

  setOverlay(name) {
    if (OVERLAY_POSES[name] === undefined) name = 'none';
    this.targetOverlay = name;
  }

  startGesture(dur, apply) {
    this.gesture = { t: 0, dur, apply };
  }

  update(dt) {
    this.mixer.update(dt);

    // overlay weight fades toward target; on overlay switch fade out then in
    if (this.overlay !== this.targetOverlay) {
      this.overlayW = Math.max(0, this.overlayW - dt * 7);
      if (this.overlayW <= 0.01) this.overlay = this.targetOverlay;
    } else if (this.overlay !== 'none') {
      this.overlayW = Math.min(1, this.overlayW + dt * 7);
    } else {
      this.overlayW = 0;
    }

    // apply overlay rotations additively on top of the mixer result
    const pose = OVERLAY_POSES[this.overlay];
    if (pose && this.overlayW > 0.01) {
      for (const [key, rot] of Object.entries(pose)) {
        if (key === 'hipsRotX' || key === 'hipDrop') continue;
        const bone = this.bones[key];
        if (!bone) continue;
        const w = this.overlayW;
        _e.set(rot[0] * w, rot[1] * w, rot[2] * w);
        _q.setFromEuler(_e);
        bone.quaternion.multiply(_q);
      }
      // poses like kneeling actually lower the body, not just fold the legs.
      // hipDrop is a fraction of the hips' rest height because the skeleton's
      // native units are normalized away by the rig's height scaling.
      if (pose.hipDrop && this.bones.hips) {
        if (this._hipsRestY === undefined) this._hipsRestY = this.bones.hips.position.y || 1;
        let drop = pose.hipDrop;
        // a limp lurches: sync a vertical hitch to the walk cycle so the body
        // drops and re-rises as weight shifts onto the good leg
        if (this.overlay === 'limp' && this.current) {
          const dur = this.current.getClip?.().duration || 1;
          const phase = ((this.current.time % dur) / dur) * Math.PI * 2;
          drop += 0.07 * (0.5 + 0.5 * Math.sin(phase));
        }
        this.bones.hips.position.y -= drop * this._hipsRestY * this.overlayW;
      }
    }

    // aim pitch bends the upper spine
    if (Math.abs(this.aimPitch) > 0.01 && this.bones.spine1) {
      _e.set(this.aimPitch * 0.55, 0, 0);
      _q.setFromEuler(_e);
      this.bones.spine1.quaternion.multiply(_q);
      if (this.bones.spine2) {
        _e.set(this.aimPitch * 0.45, 0, 0);
        _q.setFromEuler(_e);
        this.bones.spine2.quaternion.multiply(_q);
      }
    }

    // gesture (punch / swing / hit reactions) — parametric overlay
    if (this.gesture) {
      this.gesture.t += dt;
      const t01 = this.gesture.t / this.gesture.dur;
      if (t01 >= 1) this.gesture = null;
      else this.gesture.apply(t01, this.bones, _q, _e);
    }
  }

  stopAll() {
    this.mixer.stopAllAction();
    this.current = null;
    this.currentName = null;
  }
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

// ---------------- shared gesture builders ----------------
export const GESTURES = {
  // right-hand jab: wind up, extend, recover (arm +X = forward)
  punch(bones, q, e, t) {
    const ext = Math.sin(clamp(t, 0, 1) * Math.PI);
    if (bones.armR) {
      e.set(1.5 * ext, 0, 0.15 * ext); q.setFromEuler(e);
      bones.armR.quaternion.multiply(q);
    }
    if (bones.foreArmR) {
      e.set(-0.6 * (1 - ext), 0, 0); q.setFromEuler(e);
      bones.foreArmR.quaternion.multiply(q);
    }
    if (bones.spine2) {
      e.set(0, -0.4 * ext, 0); q.setFromEuler(e);
      bones.spine2.quaternion.multiply(q);
    }
  },
  // left hook follow-up
  hook(bones, q, e, t) {
    const ext = Math.sin(clamp(t, 0, 1) * Math.PI);
    if (bones.armL) {
      e.set(-1.35 * ext, 0.3 * ext, -0.2 * ext); q.setFromEuler(e);
      bones.armL.quaternion.multiply(q);
    }
    if (bones.foreArmL) {
      e.set(0.5 * (1 - ext), 0, 0); q.setFromEuler(e);
      bones.foreArmL.quaternion.multiply(q);
    }
    if (bones.spine2) {
      e.set(0, 0.45 * ext, 0); q.setFromEuler(e);
      bones.spine2.quaternion.multiply(q);
    }
  },
  // horizontal bat swing: coil right, sweep hard across, follow through
  swingBat(bones, q, e, t) {
    const wind = Math.min(t / 0.3, 1);
    const strike = clamp((t - 0.3) / 0.35, 0, 1);
    const ease = strike * strike * (3 - 2 * strike);
    const yaw = 0.7 * wind - 1.9 * ease;
    if (bones.spine2) { e.set(0, yaw * 0.55, 0); q.setFromEuler(e); bones.spine2.quaternion.multiply(q); }
    if (bones.spine1) { e.set(0.08 * ease, yaw * 0.25, 0); q.setFromEuler(e); bones.spine1.quaternion.multiply(q); }
    if (bones.armR) {
      // coil back (-X) then rip through to the front (+X), sweeping across
      e.set(-0.6 * wind + 1.5 * ease, yaw * 0.3, -0.45 * wind + 0.55 * ease);
      q.setFromEuler(e); bones.armR.quaternion.multiply(q);
    }
    if (bones.foreArmR) { e.set(-0.8 * (1 - ease) * wind, 0, 0); q.setFromEuler(e); bones.foreArmR.quaternion.multiply(q); }
    if (bones.armL) { e.set(-0.4 * ease, yaw * 0.25, -0.2 * wind); q.setFromEuler(e); bones.armL.quaternion.multiply(q); }
  },
  // overhead bat smash — the combo finisher
  batOverhead(bones, q, e, t) {
    const up = Math.min(t / 0.4, 1);
    const down = clamp((t - 0.4) / 0.3, 0, 1);
    const ease = down * down;
    const lift = 2.5 * up - 2.7 * ease;    // way up overhead, then crash down
    for (const key of ['armR', 'armL']) {
      if (!bones[key]) continue;
      e.set(key === 'armL' ? -lift : lift, 0, key === 'armL' ? -0.2 * up : 0.2 * up);
      q.setFromEuler(e); bones[key].quaternion.multiply(q);
    }
    if (bones.spine1) { e.set(-0.25 * up + 0.55 * ease, 0, 0); q.setFromEuler(e); bones.spine1.quaternion.multiply(q); }
    if (bones.head) { e.set(-0.15 * up + 0.2 * ease, 0, 0); q.setFromEuler(e); bones.head.quaternion.multiply(q); }
  },
  // overhand throw: wind back, torso counter-twist, whip forward
  throwItem(bones, q, e, t) {
    const wind = Math.min(t / 0.35, 1);
    const whip = clamp((t - 0.35) / 0.3, 0, 1);
    const ease = whip * whip * (3 - 2 * whip);
    const arm = -1.6 * wind + 3.1 * ease;         // back over the shoulder, then rip forward
    if (bones.armR) { e.set(arm, 0, 0.2 * wind); q.setFromEuler(e); bones.armR.quaternion.multiply(q); }
    if (bones.foreArmR) { e.set(-1.1 * wind * (1 - ease), 0, 0); q.setFromEuler(e); bones.foreArmR.quaternion.multiply(q); }
    if (bones.spine2) { e.set(0, 0.5 * wind - 0.9 * ease, 0); q.setFromEuler(e); bones.spine2.quaternion.multiply(q); }
    if (bones.spine1) { e.set(0.12 * ease, 0, 0); q.setFromEuler(e); bones.spine1.quaternion.multiply(q); }
    if (bones.armL) { e.set(-0.5 * ease, 0, 0.2 * ease); q.setFromEuler(e); bones.armL.quaternion.multiply(q); }
  },
  // landing dip: knees give and the torso pitches on touchdown; s scales
  // the depth with fall speed
  landDip(bones, q, e, t, s = 1) {
    const k = Math.sin(clamp(t, 0, 1) * Math.PI) * s;
    if (bones.spine1) { e.set(0.35 * k, 0, 0); q.setFromEuler(e); bones.spine1.quaternion.multiply(q); }
    for (const key of ['upLegL', 'upLegR']) {
      if (bones[key]) { e.set(-0.55 * k, 0, 0); q.setFromEuler(e); bones[key].quaternion.multiply(q); }
    }
    for (const key of ['legL', 'legR']) {
      if (bones[key]) { e.set(0.8 * k, 0, 0); q.setFromEuler(e); bones[key].quaternion.multiply(q); }
    }
    for (const key of ['armL', 'armR']) {
      if (bones[key]) { e.set(key === 'armL' ? -0.4 * k : 0.4 * k, 0, 0); q.setFromEuler(e); bones[key].quaternion.multiply(q); }
    }
  },
  // combat tuck-and-roll: whole-body curl (the tumble itself is the rig
  // group rotating — this gesture just folds the body into a ball)
  roll(bones, q, e, t) {
    const k = Math.sin(clamp(t, 0, 1) * Math.PI);   // tuck in, then release
    if (bones.spine1) { e.set(0.9 * k, 0, 0); q.setFromEuler(e); bones.spine1.quaternion.multiply(q); }
    if (bones.head) { e.set(0.5 * k, 0, 0); q.setFromEuler(e); bones.head.quaternion.multiply(q); }
    for (const key of ['upLegL', 'upLegR']) {
      if (bones[key]) { e.set(-1.6 * k, 0, 0); q.setFromEuler(e); bones[key].quaternion.multiply(q); }
    }
    for (const key of ['legL', 'legR']) {
      if (bones[key]) { e.set(1.8 * k, 0, 0); q.setFromEuler(e); bones[key].quaternion.multiply(q); }
    }
    for (const key of ['armL', 'armR']) {
      if (bones[key]) { e.set(key === 'armL' ? -1.0 * k : 1.0 * k, 0, 0.0); q.setFromEuler(e); bones[key].quaternion.multiply(q); }
    }
    for (const key of ['foreArmL', 'foreArmR']) {
      if (bones[key]) { e.set(key === 'foreArmL' ? 1.4 * k : -1.4 * k, 0, 0); q.setFromEuler(e); bones[key].quaternion.multiply(q); }
    }
  },
  // firearm kick: fast muzzle climb through the arms, quick settle.
  // s scales the kick (pistol 0.7 → shotgun 1.6)
  gunKick(bones, q, e, t, s = 1) {
    const k = Math.sin(Math.min(t * 3, 1) * Math.PI / 2) * (1 - t) * s;
    for (const key of ['armR', 'armL']) {
      if (!bones[key]) continue;
      e.set(key === 'armL' ? -0.24 * k : 0.24 * k, 0, 0); q.setFromEuler(e); bones[key].quaternion.multiply(q);
    }
    for (const key of ['foreArmR', 'foreArmL']) {
      if (!bones[key]) continue;
      e.set(key === 'foreArmL' ? 0.16 * k : -0.16 * k, 0, 0); q.setFromEuler(e); bones[key].quaternion.multiply(q);
    }
    if (bones.spine1) { e.set(-0.06 * k, 0, 0); q.setFromEuler(e); bones.spine1.quaternion.multiply(q); }
  },
  // shotgun pump: off hand racks the fore-end back toward the body and forward
  pumpShotgun(bones, q, e, t) {
    const k = Math.sin(clamp(t, 0, 1) * Math.PI);
    if (bones.armL) { e.set(0.3 * k, 0, 0); q.setFromEuler(e); bones.armL.quaternion.multiply(q); }
    if (bones.foreArmL) { e.set(0.55 * k, 0, 0); q.setFromEuler(e); bones.foreArmL.quaternion.multiply(q); }
    if (bones.spine2) { e.set(0, 0.06 * k, 0); q.setFromEuler(e); bones.spine2.quaternion.multiply(q); }
  },
  // pistol reload: mag drops with the left hand, new one in, slide racked
  reloadPistol(bones, q, e, t) {
    const drop = Math.sin(clamp(t / 0.35, 0, 1) * Math.PI);         // hand to hip
    const insert = Math.sin(clamp((t - 0.35) / 0.35, 0, 1) * Math.PI); // mag up + in
    const rack = Math.sin(clamp((t - 0.72) / 0.28, 0, 1) * Math.PI);   // slide pull
    if (bones.armL) {
      e.set(0.9 * drop - 0.5 * insert - 0.2 * rack, 0, -0.2 * drop);
      q.setFromEuler(e); bones.armL.quaternion.multiply(q);
    }
    if (bones.foreArmL) {
      e.set(0.4 * drop + 0.9 * insert + 0.7 * rack, 0, 0);
      q.setFromEuler(e); bones.foreArmL.quaternion.multiply(q);
    }
    if (bones.armR) { e.set(-0.14 * (drop + insert), 0, 0.12 * insert); q.setFromEuler(e); bones.armR.quaternion.multiply(q); }
    if (bones.head) { e.set(0.18 * (insert + rack) * 0.6, 0, 0); q.setFromEuler(e); bones.head.quaternion.multiply(q); }
  },
  // long-gun mag swap: tilt the gun, strip the mag, seat the new one
  reloadMag(bones, q, e, t) {
    const strip = Math.sin(clamp(t / 0.4, 0, 1) * Math.PI);
    const seat = Math.sin(clamp((t - 0.42) / 0.4, 0, 1) * Math.PI);
    const slap = Math.sin(clamp((t - 0.78) / 0.22, 0, 1) * Math.PI);
    if (bones.armR) { e.set(-0.12 * strip, 0, 0.2 * (strip + seat) * 0.6); q.setFromEuler(e); bones.armR.quaternion.multiply(q); }
    if (bones.armL) {
      e.set(0.7 * strip - 0.35 * seat, 0, -0.15 * strip);
      q.setFromEuler(e); bones.armL.quaternion.multiply(q);
    }
    if (bones.foreArmL) {
      e.set(0.5 * strip + 1.0 * seat + 0.5 * slap, 0, 0);
      q.setFromEuler(e); bones.foreArmL.quaternion.multiply(q);
    }
    if (bones.head) { e.set(0.22 * (strip + seat) * 0.5, 0, 0); q.setFromEuler(e); bones.head.quaternion.multiply(q); }
  },
  // shotgun shell: left hand feeds one shell under the receiver
  loadShell(bones, q, e, t) {
    const k = Math.sin(clamp(t, 0, 1) * Math.PI);
    if (bones.armL) { e.set(0.55 * k, 0, -0.2 * k); q.setFromEuler(e); bones.armL.quaternion.multiply(q); }
    if (bones.foreArmL) { e.set(0.95 * k, 0.25 * k, 0); q.setFromEuler(e); bones.foreArmL.quaternion.multiply(q); }
    if (bones.head) { e.set(0.2 * k, 0, 0); q.setFromEuler(e); bones.head.quaternion.multiply(q); }
  },
  // draw: right hand sweeps up from the hip as the weapon appears
  drawWeapon(bones, q, e, t) {
    const k = Math.sin(clamp(t, 0, 1) * Math.PI);
    if (bones.armR) { e.set(0.85 * k, 0, 0.2 * k); q.setFromEuler(e); bones.armR.quaternion.multiply(q); }
    if (bones.foreArmR) { e.set(-0.55 * k, 0, 0); q.setFromEuler(e); bones.foreArmR.quaternion.multiply(q); }
    if (bones.spine2) { e.set(0, -0.1 * k, 0); q.setFromEuler(e); bones.spine2.quaternion.multiply(q); }
  },
  // reach out with the right hand — door handles, pickups
  reach(bones, q, e, t) {
    const ext = Math.sin(clamp(t, 0, 1) * Math.PI);
    if (bones.armR) {
      e.set(0.95 * ext, 0, 0.15 * ext); q.setFromEuler(e);
      bones.armR.quaternion.multiply(q);
    }
    if (bones.foreArmR) {
      e.set(-0.25 * ext, 0, 0); q.setFromEuler(e);
      bones.foreArmR.quaternion.multiply(q);
    }
    if (bones.spine1) {
      e.set(0.16 * ext, -0.12 * ext, 0); q.setFromEuler(e);
      bones.spine1.quaternion.multiply(q);
    }
  },
  // flinch away from a hit; side (+1/-1) leans the recoil away from the
  // side the blow came from so reactions read directionally
  flinch(bones, q, e, t, side = 1) {
    const k = Math.sin(clamp(t, 0, 1) * Math.PI);
    if (bones.spine1) {
      e.set(-0.3 * k, 0.15 * k * side, 0.12 * k * -side); q.setFromEuler(e);
      bones.spine1.quaternion.multiply(q);
    }
    if (bones.head) {
      e.set(-0.25 * k, 0, 0.14 * k * -side); q.setFromEuler(e);
      bones.head.quaternion.multiply(q);
    }
  },
  // front kick with the right leg: chamber, extend, recover
  kick(bones, q, e, t) {
    const ext = Math.sin(clamp(t, 0, 1) * Math.PI);
    if (bones.upLegR) {
      e.set(-1.35 * ext, 0, 0.05 * ext); q.setFromEuler(e);
      bones.upLegR.quaternion.multiply(q);
    }
    if (bones.legR) {
      // knee stays bent through the chamber, snaps straight at full extension
      const bend = t < 0.45 ? 1.1 * (t / 0.45) : 1.1 * Math.max(0, 1 - (t - 0.45) / 0.25);
      e.set(bend, 0, 0); q.setFromEuler(e);
      bones.legR.quaternion.multiply(q);
    }
    if (bones.spine1) {
      e.set(0.22 * ext, 0, 0); q.setFromEuler(e);   // lean back for balance
      bones.spine1.quaternion.multiply(q);
    }
    if (bones.armL) {
      e.set(0.5 * ext, 0, 0.3 * ext); q.setFromEuler(e);   // guard arm rises
      bones.armL.quaternion.multiply(q);
    }
  },
};
