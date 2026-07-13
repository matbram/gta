// Low-poly articulated human figure with procedural animations.
// Shared by the player, pedestrians and police. ~10 meshes per figure.

import * as THREE from 'three';
import { clamp, lerp, damp } from '../core/mathutil.js';
import { Animator, GESTURES } from '../core/animator.js';
import { characterFactory } from './charactermesh.js';

const GEO = {};
function geo(key, make) {
  if (!GEO[key]) GEO[key] = make();
  return GEO[key];
}

export class BoxHumanoid {
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
const SKINS = [0xc99b72, 0x8a5a3a, 0x6a4530, 0xe8b88a, 0xa9765a, 0xf0c9a0, 0x5a3826];
const SHIRTS = [0xffffff, 0xb03a2e, 0x3a5a8a, 0x4a7a4a, 0xe8c84a, 0x8a4a8a, 0x333a44, 0xd87a3a, 0x88ccc0];
const PANTS = [0x4a5568, 0x2e3440, 0x6a5a48, 0x3e4e3e, 0x8a8a92, 0x252a33];
const HAIRS = [0x2a2018, 0x0e0c0a, 0x5a4028, 0x888078, 0x8a3a1e];
const GRAYS = [0x9a9a98, 0xcfcfcb, 0x77736e];
const SHOES = [0x2c2620, 0xe8e4da, 0x503a28, 0x21242a, 0x8a2a2a];
const EYES = [0x4a3624, 0x2e4a66, 0x3a5a3a, 0x241a12];

export function randomLook(rng) {
  return enrichLook({
    skin: SKINS[Math.floor(rng() * SKINS.length)],
    shirt: SHIRTS[Math.floor(rng() * SHIRTS.length)],
    pants: PANTS[Math.floor(rng() * PANTS.length)],
  }, rng);
}

// Fill any missing "rich" look fields (face, age, hair style, outfit cut)
// so legacy {skin, shirt, pants, hair} colour looks keep working while the
// character factory gets everything it needs. Idempotent.
export function enrichLook(look = {}, rng = Math.random) {
  if (look._rich) return look;
  const female = look.female ?? (look.uniform ? rng() < 0.35 : rng() < 0.46);
  const age = look.age ?? 0.18 + rng() * 0.62;
  const gray = age > 0.74;
  const out = {
    _rich: true,
    ...look,
    female, age,
    skin: look.skin ?? SKINS[(rng() * SKINS.length) | 0],
    shirt: look.shirt ?? SHIRTS[(rng() * SHIRTS.length) | 0],
    pants: look.pants ?? PANTS[(rng() * PANTS.length) | 0],
    hair: look.hair ?? (gray ? GRAYS[(rng() * GRAYS.length) | 0] : HAIRS[(rng() * HAIRS.length) | 0]),
    shoes: look.shoes ?? SHOES[(rng() * SHOES.length) | 0],
    eyes: look.eyes ?? EYES[(rng() * EYES.length) | 0],
    body: look.body ?? (rng() < 0.15 ? 'heavy' : 'avg'),
    hairStyle: look.hairStyle ?? (female
      ? ['bob', 'pony', 'short', 'afro'][(rng() * 4) | 0]
      : (gray && rng() < 0.45 ? 'bald' : ['short', 'buzz', 'afro', 'short'][(rng() * 4) | 0])),
    beard: look.beard ?? (!female && rng() < 0.32 ? (rng() < 0.4 ? 'full' : 'stubble') : null),
    topStyle: look.topStyle ?? ['tee', 'tee', 'shirt', 'hoodie', 'jacket'][(rng() * 5) | 0],
    bottomStyle: look.bottomStyle ?? (rng() < 0.13 ? 'shorts' : rng() < 0.42 ? 'slacks' : 'jeans'),
    sleeves: look.sleeves ?? (rng() < 0.55 ? 'short' : 'long'),
    print: look.print ?? null,
    uniform: look.uniform ?? null,
    hat: look.hat ?? null,
    heightScale: look.heightScale ?? 0.94 + rng() * 0.11,
  };
  if (out.uniform || out.topStyle === 'jacket' || out.topStyle === 'hoodie') out.sleeves = 'long';
  return out;
}

// ====================================================================
// Skinned character path — real GLB rig + AnimationMixer via Animator.
// Same public API as BoxHumanoid so all callers work unchanged.
// ====================================================================

export let humanoidAssets = null;
export function setHumanoidAssets(a) { humanoidAssets = a; }

const WALK_REF = 1.7;   // m/s the walk clip was authored at (tuned by eye)
const RUN_REF = 5.0;

export class SkinnedHumanoid {
  constructor(look = {}, modelKey = 'Soldier') {
    this.group = new THREE.Group();
    this.look = enrichLook(look);

    // our own generated body on the GLB's skeleton; the GLB mesh itself is
    // never rendered. Fallback: raw GLB clone if the factory can't init.
    this.factoryBuilt = characterFactory.init(humanoidAssets);
    const asset = this.factoryBuilt
      ? characterFactory.build(this.look)
      : humanoidAssets.skinned(modelKey);
    this.modelRoot = asset.scene;
    this.modelRoot.rotation.y = Math.PI;      // mixamo rigs face -z; game faces +z
    this.group.add(this.modelRoot);
    this.height = 1.78;
    this.legLen = 0.86;

    this.animator = new Animator(this.modelRoot, asset.animations);

    // bone-based sizing: skinned bounds lie (bind-pose bones carry the scale),
    // so measure rendered height head→feet and normalize to the target height
    this.modelRoot.updateMatrixWorld(true);
    const b = this.animator.bones;
    const vh = new THREE.Vector3(), vf = new THREE.Vector3();
    let s = 1;
    const targetH = 1.78 * (this.look.heightScale ?? 1) * (this.look.age > 0.75 ? 0.97 : 1);
    if (b.head && (b.footL || b.footR)) {
      b.head.getWorldPosition(vh);
      (b.footL ?? b.footR).getWorldPosition(vf);
      const renderedH = (vh.y - vf.y) + 0.22;   // head bone sits at the chin; add skull + sole
      s = targetH / Math.max(renderedH, 0.2);
      this.modelRoot.scale.setScalar(s);
      this.modelRoot.position.y = -(vf.y - 0.08) * s;
    }

    if (!this.factoryBuilt) {
      // legacy tint path for the raw GLB fallback only
      const tint = new THREE.Color(this.look.shirt ?? 0xffffff);
      this.modelRoot.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) {
          o.castShadow = true;
          o.frustumCulled = false;
          o.material = o.material.clone();
          o.material.color = new THREE.Color(0xffffff).lerp(tint, 0.42);
          o.material.envMapIntensity = 0.35;
        }
      });
    }

    // weapon anchor on the right hand bone (scale-compensated)
    this.handAnchor = new THREE.Group();
    const handBone = this.animator.bones.handR;
    if (handBone) {
      handBone.add(this.handAnchor);
      const ws = new THREE.Vector3();
      handBone.getWorldScale(ws);
      this.group.updateMatrixWorld(true);
      handBone.getWorldScale(ws);
      const inv = 1 / Math.max(ws.x, 1e-4);
      this.handAnchor.scale.setScalar(inv);
      this.handAnchor.rotation.set(0, -Math.PI / 2, Math.PI / 2); // grip alignment
    } else {
      this.group.add(this.handAnchor);
    }

    this.anim = 'idle';
    this.aimPitch = 0;
    this.dead = false;
    this.deadT = 0;
    this.punchAlt = false;
    this.swimTilt = 0;
    this.animator.play('idle');
  }

  setAnim(name) {
    if (this.anim === name || this.dead) return;
    this.anim = name;
    const A = this.animator;
    switch (name) {
      case 'idle': A.play('idle'); A.setOverlay('none'); break;
      case 'walk': A.play('walk'); A.setOverlay('none'); break;
      case 'run': A.play('run'); A.setOverlay('none'); break;
      case 'sprint': A.play('run', { timeScale: 1.15 }); A.setOverlay('none'); break;
      case 'jump': A.play('idle', { timeScale: 0.2 }); A.setOverlay('jump'); break;
      case 'swim': A.play('idle', { timeScale: 0.6 }); A.setOverlay('swim'); break;
      case 'drive': A.play('idle', { timeScale: 0.12 }); A.setOverlay('drive'); break;
      case 'aim': A.play('idle', { timeScale: 0.5 }); A.setOverlay('aimPistol'); break;
      case 'aimwalk': A.play('walk'); A.setOverlay('aimPistol'); break;
      // extended poses used by NPC behaviours
      case 'sit': A.play('idle', { timeScale: 0.1 }); A.setOverlay('sit'); break;
      case 'phone': A.play('idle', { timeScale: 0.5 }); A.setOverlay('phone'); break;
      case 'handsup': A.play('idle', { timeScale: 0.3 }); A.setOverlay('handsUp'); break;
      case 'kneel': A.play('idle', { timeScale: 0.1 }); A.setOverlay('kneel'); break;
      case 'hose': A.play('idle', { timeScale: 0.4 }); A.setOverlay('hose'); break;
      default: A.play('idle'); A.setOverlay('none');
    }
  }

  setOverlay(name) { this.animator.setOverlay(name); }

  startPunch() {
    const g = this.punchAlt ? GESTURES.hook : GESTURES.punch;
    this.punchAlt = !this.punchAlt;
    this.animator.startGesture(0.38, (t, bones, q, e) => g(bones, q, e, t));
  }

  flinch() {
    this.animator.startGesture(0.3, (t, bones, q, e) => GESTURES.flinch(bones, q, e, t));
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.deadT = 0;
    this.animator.play('idle', { timeScale: 0 });
    this.animator.setOverlay('none');
  }

  update(dt, speed = 0) {
    if (this.dead) {
      this.deadT += dt;
      // simple fall (verlet ragdoll replaces this in the combat phase)
      const t = clamp(this.deadT * 3.0, 0, 1);
      this.group.rotation.x = lerp(this.group.rotation.x, -Math.PI / 2 * 0.94, t * 0.3);
      this.group.position.y = Math.max(this.group.position.y - dt * 1.4, 0.1);
      this.animator.update(dt * 0.25);
      return;
    }

    // reduce foot slide: scale clip speed to actual velocity
    if (this.anim === 'walk' || this.anim === 'aimwalk') {
      if (this.animator.current) this.animator.current.timeScale = clamp(speed / WALK_REF, 0.5, 1.8);
    } else if (this.anim === 'run' || this.anim === 'sprint') {
      if (this.animator.current) this.animator.current.timeScale = clamp(speed / RUN_REF, 0.6, 1.6);
    }

    // swim body tilt
    const wantTilt = this.anim === 'swim' ? -Math.PI / 2 * 0.8 : 0;
    this.swimTilt = damp(this.swimTilt, wantTilt, 8, dt);
    this.modelRoot.rotation.x = this.swimTilt;

    this.animator.aimPitch = (this.anim === 'aim' || this.anim === 'aimwalk') ? -this.aimPitch : 0;
    this.animator.update(dt);
  }

  dispose() {
    if (!this.factoryBuilt) {
      // factory materials + geometry are cached and shared — never disposed here
      this.modelRoot.traverse((o) => {
        if ((o.isMesh || o.isSkinnedMesh) && o.material) o.material.dispose();
      });
    }
    this.group.removeFromParent();
  }
}

// Humanoid: picks the skinned rig when character assets are loaded,
// falls back to the box rig otherwise. (Constructor-return pattern.)
export class Humanoid {
  constructor(look = {}) {
    if (humanoidAssets?.has('Soldier')) return new SkinnedHumanoid(look);
    return new BoxHumanoid(look);
  }
}
