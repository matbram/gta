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
// each entry: bone → [x, y, z]
const OVERLAY_POSES = {
  none: {},
  drive: {
    upLegL: [-1.35, 0, 0.12], upLegR: [-1.35, 0, -0.12],
    legL: [1.2, 0, 0], legR: [1.2, 0, 0],
    armL: [-0.75, 0, 0.2], armR: [-0.75, 0, -0.2],
    foreArmL: [-0.55, 0, 0], foreArmR: [-0.55, 0, 0],
    spine1: [0.08, 0, 0],
  },
  sit: {
    upLegL: [-1.45, 0, 0.1], upLegR: [-1.45, 0, -0.1],
    legL: [1.35, 0, 0], legR: [1.35, 0, 0],
    spine1: [0.05, 0, 0],
  },
  aimPistol: {
    armR: [-1.3, 0, -0.18], foreArmR: [-0.1, 0, 0],
    armL: [-1.05, 0, 0.28], foreArmL: [-0.35, 0.75, 0],
    spine2: [0, -0.12, 0],
  },
  aimRifle: {
    armR: [-1.2, 0, -0.3], foreArmR: [-0.25, 0, 0],
    armL: [-1.1, 0, 0.45], foreArmL: [-0.5, 0.9, 0],
    spine2: [0, -0.22, 0],
  },
  handsUp: {
    armL: [0, 0, 2.4], armR: [0, 0, -2.4],
    foreArmL: [0, 0, 0.5], foreArmR: [0, 0, -0.5],
  },
  phone: {
    armR: [-0.35, 0, -0.35], foreArmR: [-2.35, 0.35, 0],
    head: [0.12, -0.18, 0],
  },
  swim: {
    hipsRotX: true,
    spine1: [-0.2, 0, 0],
    armL: [0, 0, 1.4], armR: [0, 0, -1.4],
  },
  jump: {
    upLegL: [-0.6, 0, 0], legL: [1.0, 0, 0],
    upLegR: [-0.25, 0, 0], legR: [0.55, 0, 0],
    armL: [0, 0, 0.6], armR: [0, 0, -0.6],
  },
  kneel: {
    upLegL: [-1.5, 0, 0], legL: [1.6, 0, 0],
    upLegR: [-0.5, 0, 0], legR: [1.9, 0, 0],
    spine1: [0.25, 0, 0],
  },
  hose: {
    armR: [-1.0, 0, -0.2], foreArmR: [-0.4, 0, 0],
    armL: [-0.9, 0, 0.35], foreArmL: [-0.6, 0.7, 0],
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
        if (key === 'hipsRotX') continue;
        const bone = this.bones[key];
        if (!bone) continue;
        const w = this.overlayW;
        _e.set(rot[0] * w, rot[1] * w, rot[2] * w);
        _q.setFromEuler(_e);
        bone.quaternion.multiply(_q);
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
  // right-hand jab: wind up, extend, recover
  punch(bones, q, e, t) {
    const ext = Math.sin(clamp(t, 0, 1) * Math.PI);
    if (bones.armR) {
      e.set(-1.55 * ext, 0, -0.15 * ext); q.setFromEuler(e);
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
      e.set(-1.45 * ext, 0.35 * ext, 0.15 * ext); q.setFromEuler(e);
      bones.armL.quaternion.multiply(q);
    }
    if (bones.spine2) {
      e.set(0, 0.45 * ext, 0); q.setFromEuler(e);
      bones.spine2.quaternion.multiply(q);
    }
  },
  // flinch away from a hit
  flinch(bones, q, e, t) {
    const k = Math.sin(clamp(t, 0, 1) * Math.PI);
    if (bones.spine1) {
      e.set(-0.3 * k, 0.15 * k, 0); q.setFromEuler(e);
      bones.spine1.quaternion.multiply(q);
    }
    if (bones.head) {
      e.set(-0.25 * k, 0, 0.1 * k); q.setFromEuler(e);
      bones.head.quaternion.multiply(q);
    }
  },
};
