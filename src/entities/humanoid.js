// Low-poly articulated human figure with procedural animations.
// Shared by the player, pedestrians and police. ~10 meshes per figure.

import * as THREE from 'three';
import { clamp, lerp, damp } from '../core/mathutil.js';

const GEO = {};
function geo(key, make) {
  if (!GEO[key]) GEO[key] = make();
  return GEO[key];
}

export class Humanoid {
  constructor(look = {}) {
    const skin = look.skin ?? 0xc99b72;
    const shirt = look.shirt ?? 0xffffff;
    const pants = look.pants ?? 0x4a5568;
    const hair = look.hair ?? 0x2a2018;

    this.group = new THREE.Group();

    this.matSkin = new THREE.MeshLambertMaterial({ color: skin });
    this.matShirt = new THREE.MeshLambertMaterial({ color: shirt });
    this.matPants = new THREE.MeshLambertMaterial({ color: pants });
    this.matHair = new THREE.MeshLambertMaterial({ color: hair });

    // dimensions (metres)
    const legUp = 0.44, legLo = 0.42, torsoH = 0.60, headS = 0.23;
    this.legLen = legUp + legLo;
    this.height = this.legLen + torsoH + headS + 0.06;

    // hips root sits at leg length
    this.hips = new THREE.Group();
    this.hips.position.y = this.legLen;
    this.group.add(this.hips);

    // torso
    const torso = new THREE.Mesh(geo('torso', () => new THREE.BoxGeometry(0.42, torsoH, 0.24)), this.matShirt);
    torso.position.y = torsoH / 2;
    torso.castShadow = true;
    this.hips.add(torso);
    this.torso = torso;

    // head
    this.headPivot = new THREE.Group();
    this.headPivot.position.y = torsoH + 0.03;
    this.hips.add(this.headPivot);
    const head = new THREE.Mesh(geo('head', () => new THREE.BoxGeometry(headS, headS, headS)), this.matSkin);
    head.position.y = headS / 2;
    head.castShadow = true;
    this.headPivot.add(head);
    const hairMesh = new THREE.Mesh(geo('hair', () => new THREE.BoxGeometry(headS + 0.02, headS * 0.45, headS + 0.02)), this.matHair);
    hairMesh.position.y = headS * 0.85;
    this.headPivot.add(hairMesh);

    // limbs: pivot groups so they rotate at the joint
    const armW = 0.11, armUp = 0.30, armLo = 0.28;
    const legW = 0.15;

    const mkLimb = (w, upLen, loLen, upMat, loMat) => {
      const shoulder = new THREE.Group();
      const up = new THREE.Mesh(geo('limbUp' + w + upLen, () => new THREE.BoxGeometry(w, upLen, w)), upMat);
      up.position.y = -upLen / 2;
      up.castShadow = true;
      shoulder.add(up);
      const elbow = new THREE.Group();
      elbow.position.y = -upLen;
      shoulder.add(elbow);
      const lo = new THREE.Mesh(geo('limbLo' + w + loLen, () => new THREE.BoxGeometry(w * 0.88, loLen, w * 0.88)), loMat);
      lo.position.y = -loLen / 2;
      lo.castShadow = true;
      elbow.add(lo);
      return { shoulder, elbow };
    };

    this.armL = mkLimb(armW, armUp, armLo, this.matShirt, this.matSkin);
    this.armL.shoulder.position.set(-0.265, torsoH - 0.05, 0);
    this.hips.add(this.armL.shoulder);
    this.armR = mkLimb(armW, armUp, armLo, this.matShirt, this.matSkin);
    this.armR.shoulder.position.set(0.265, torsoH - 0.05, 0);
    this.hips.add(this.armR.shoulder);

    this.legL = mkLimb(legW, legUp, legLo, this.matPants, this.matPants);
    this.legL.shoulder.position.set(-0.115, 0, 0);
    this.hips.add(this.legL.shoulder);
    this.legR = mkLimb(legW, legUp, legLo, this.matPants, this.matPants);
    this.legR.shoulder.position.set(0.115, 0, 0);
    this.hips.add(this.legR.shoulder);

    // weapon anchor in the right hand
    this.handAnchor = new THREE.Group();
    this.handAnchor.position.y = -armLo;
    this.armR.elbow.add(this.handAnchor);

    this.phase = Math.random() * 10;
    this.anim = 'idle';
    this.animBlend = 0;      // used for pose transitions
    this.aimPitch = 0;
    this.punchT = -1;
    this.dead = false;
    this.deadT = 0;
  }

  setAnim(name) {
    if (this.anim !== name) { this.anim = name; }
  }

  startPunch() { this.punchT = 0; }

  // speed in m/s drives the gait
  update(dt, speed = 0) {
    if (this.dead) {
      this.deadT += dt;
      const t = clamp(this.deadT * 3.2, 0, 1);
      this.group.rotation.x = lerp(this.group.rotation.x, -Math.PI / 2, t * 0.25);
      this.group.position.y = Math.max(this.group.position.y - dt * 1.2, 0.12);
      return;
    }

    const H = this.hips;
    let targetLegSwing = 0, rate = 0, lean = 0, bob = 0, armSwing = 0;

    switch (this.anim) {
      case 'idle': {
        this.phase += dt * 1.6;
        H.position.y = this.legLen + Math.sin(this.phase) * 0.006;
        this.setLimbs(Math.sin(this.phase) * 0.03, 0.05, 0, 0.06);
        this.torso.rotation.x = 0;
        H.rotation.x = 0;
        break;
      }
      case 'walk': case 'run': case 'sprint': {
        const stride = this.anim === 'walk' ? 0.55 : this.anim === 'run' ? 0.85 : 1.0;
        rate = 2.2 + speed * 1.55;
        this.phase += dt * rate;
        targetLegSwing = stride;
        armSwing = stride * 0.8;
        lean = this.anim === 'sprint' ? 0.22 : this.anim === 'run' ? 0.12 : 0.03;
        bob = 0.03 * stride;
        const s = Math.sin(this.phase);
        const legA = s * targetLegSwing;
        const kneeA = Math.max(0, -Math.sin(this.phase + 0.7)) * targetLegSwing * 1.1;
        const kneeB = Math.max(0, Math.sin(this.phase + 0.7)) * targetLegSwing * 1.1;
        this.legL.shoulder.rotation.x = legA;
        this.legR.shoulder.rotation.x = -legA;
        this.legL.elbow.rotation.x = kneeA * 0.9 + 0.08;
        this.legR.elbow.rotation.x = kneeB * 0.9 + 0.08;
        this.armL.shoulder.rotation.x = -s * armSwing;
        this.armR.shoulder.rotation.x = s * armSwing;
        this.armL.elbow.rotation.x = -0.35 - Math.max(0, s) * 0.4;
        this.armR.elbow.rotation.x = -0.35 - Math.max(0, -s) * 0.4;
        H.rotation.x = lean;
        H.position.y = this.legLen + Math.abs(Math.cos(this.phase)) * bob;
        break;
      }
      case 'jump': {
        this.legL.shoulder.rotation.x = -0.5;
        this.legR.shoulder.rotation.x = 0.25;
        this.legL.elbow.rotation.x = 0.9;
        this.legR.elbow.rotation.x = 0.5;
        this.armL.shoulder.rotation.x = -1.4;
        this.armR.shoulder.rotation.x = -1.2;
        H.rotation.x = 0.1;
        break;
      }
      case 'swim': {
        this.phase += dt * 5;
        H.rotation.x = Math.PI / 2 - 0.25;
        const s = Math.sin(this.phase);
        this.armL.shoulder.rotation.x = -2.4 + s * 0.9;
        this.armR.shoulder.rotation.x = -2.4 - s * 0.9;
        this.legL.shoulder.rotation.x = s * 0.5;
        this.legR.shoulder.rotation.x = -s * 0.5;
        this.legL.elbow.rotation.x = 0.3;
        this.legR.elbow.rotation.x = 0.3;
        break;
      }
      case 'drive': {
        H.rotation.x = 0;
        this.legL.shoulder.rotation.x = -1.35;
        this.legR.shoulder.rotation.x = -1.35;
        this.legL.elbow.rotation.x = 1.25;
        this.legR.elbow.rotation.x = 1.25;
        this.armL.shoulder.rotation.x = -0.85;
        this.armR.shoulder.rotation.x = -0.85;
        this.armL.elbow.rotation.x = -0.35;
        this.armR.elbow.rotation.x = -0.35;
        H.position.y = this.legLen * 0.55;
        break;
      }
      case 'aim': {
        // two-handed pistol stance, pitch follows camera
        this.phase += dt * 1.4;
        this.armR.shoulder.rotation.x = -Math.PI / 2 - this.aimPitch;
        this.armR.shoulder.rotation.z = 0.06;
        this.armR.elbow.rotation.x = 0;
        this.armL.shoulder.rotation.x = -Math.PI / 2 - this.aimPitch + 0.12;
        this.armL.shoulder.rotation.z = -0.5;
        this.armL.elbow.rotation.x = -0.25;
        this.legL.shoulder.rotation.x = 0.06;
        this.legR.shoulder.rotation.x = -0.1;
        this.legL.elbow.rotation.x = 0.05;
        this.legR.elbow.rotation.x = 0.12;
        H.rotation.x = 0.05;
        H.position.y = this.legLen;
        break;
      }
      case 'aimwalk': {
        rate = 2.2 + speed * 1.6;
        this.phase += dt * rate;
        const s = Math.sin(this.phase);
        this.legL.shoulder.rotation.x = s * 0.45;
        this.legR.shoulder.rotation.x = -s * 0.45;
        this.legL.elbow.rotation.x = Math.max(0, -Math.sin(this.phase + 0.7)) * 0.5 + 0.08;
        this.legR.elbow.rotation.x = Math.max(0, Math.sin(this.phase + 0.7)) * 0.5 + 0.08;
        this.armR.shoulder.rotation.x = -Math.PI / 2 - this.aimPitch;
        this.armL.shoulder.rotation.x = -Math.PI / 2 - this.aimPitch + 0.12;
        this.armL.shoulder.rotation.z = -0.5;
        this.armR.elbow.rotation.x = 0;
        this.armL.elbow.rotation.x = -0.25;
        H.position.y = this.legLen + Math.abs(Math.cos(this.phase)) * 0.02;
        break;
      }
    }

    // punch overlay
    if (this.punchT >= 0) {
      this.punchT += dt * 6;
      const t = this.punchT;
      if (t < 1) {
        const ext = Math.sin(Math.min(t, 1) * Math.PI);
        this.armR.shoulder.rotation.x = -1.5 * ext;
        this.armR.elbow.rotation.x = -0.4 * (1 - ext);
        this.torso.rotation.y = -0.35 * ext;
      } else {
        this.torso.rotation.y = 0;
        this.punchT = -1;
      }
    }
  }

  setLimbs(swing, elbows, kneeL, kneeR) {
    this.legL.shoulder.rotation.x = swing;
    this.legR.shoulder.rotation.x = -swing;
    this.legL.elbow.rotation.x = kneeL;
    this.legR.elbow.rotation.x = kneeR;
    this.armL.shoulder.rotation.x = -swing;
    this.armR.shoulder.rotation.x = swing;
    this.armL.shoulder.rotation.z = 0.06;
    this.armR.shoulder.rotation.z = -0.06;
    this.armL.elbow.rotation.x = -elbows;
    this.armR.elbow.rotation.x = -elbows;
  }

  die() {
    this.dead = true;
    this.deadT = 0;
  }

  dispose() {
    // geometries are shared via the GEO cache — only free this figure's materials
    this.matSkin.dispose();
    this.matShirt.dispose();
    this.matPants.dispose();
    this.matHair.dispose();
    this.group.removeFromParent();
  }
}

// Random pedestrian looks (deterministic variety comes from Math.random of spawner's rng)
const SKINS = [0xc99b72, 0x8a5a3a, 0x6a4530, 0xe8b88a, 0xa9765a];
const SHIRTS = [0xffffff, 0xb03a2e, 0x3a5a8a, 0x4a7a4a, 0xe8c84a, 0x8a4a8a, 0x333a44, 0xd87a3a, 0x88ccc0];
const PANTS = [0x4a5568, 0x2e3440, 0x6a5a48, 0x3e4e3e, 0x8a8a92, 0x252a33];
const HAIRS = [0x2a2018, 0x0e0c0a, 0x5a4028, 0x888078, 0xc8b088];

export function randomLook(rng) {
  return {
    skin: SKINS[Math.floor(rng() * SKINS.length)],
    shirt: SHIRTS[Math.floor(rng() * SHIRTS.length)],
    pants: PANTS[Math.floor(rng() * PANTS.length)],
    hair: HAIRS[Math.floor(rng() * HAIRS.length)],
  };
}
