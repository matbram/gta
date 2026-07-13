// Original procedurally-built human characters, skinned onto the Mixamo
// skeleton that ships inside our animation-source GLB (whose own mesh is
// never rendered). Geometry is authored directly in the skeleton's bind
// space — centimetres, Z-up, character facing +Y, T-pose — using joint
// anchors measured from the bind matrices, so the existing Idle/Walk/Run
// clips and every procedural overlay drive it with zero retargeting.
//
// One SkinnedMesh + one atlas material per character (the old GLB used two).
// Geometry is cached per (body variant, hair, hat); all per-person
// uniqueness comes from the painted atlas (charactertex.js).

import * as THREE from 'three';
import { ATLAS, materialForLook } from './charactertex.js';

// ---- bind-space joint anchors (cm, z-up, +y forward), measured once ------
const J = {
  hips: [0, 1.1, 106.1],
  spine: [0, -0.2, 115.6],
  spine1: [0, -1.9, 126.7],
  spine2: [0, -3.7, 139.3],
  neck: [0, -5.8, 153.6],
  head: [0, -5.5, 156.9],
  shoulder: 6.8,        // |x| of shoulder joints
  armX: 20.85,          // |x| upper-arm joint
  elbowX: 44.0,
  wristX: 68.1,
  armY: -5.8, armZ: 147.9,
  legX: 9.78,
  kneeZ: 57.5,
  ankleZ: 13.2, ankleY: -2.8,
  toeY: 13.1,
};

// body-variant ring radii multipliers
const VARIANTS = {
  male: { torso: 1.0, shoulders: 1.0, hips: 1.0, waist: 1.0, limbs: 1.0, bust: 0 },
  female: { torso: 0.94, shoulders: 0.86, hips: 1.08, waist: 0.82, limbs: 0.86, bust: 2.6 },
  heavy: { torso: 1.24, shoulders: 1.08, hips: 1.22, waist: 1.42, limbs: 1.16, bust: 0 },
};

// ---------------------------------------------------------------- builder

class GeoAccum {
  constructor() {
    this.pos = []; this.uv = []; this.idx = [];
    this.si = []; this.sw = [];
    this.vc = 0;
  }

  // rings: [{x,y,z, rx, ry, t, bones: [[idx,w],[idx,w]?]}]
  // axis 'z': rings in the XY plane (vertical tubes: torso, legs, neck, head)
  // axis 'x': rings in the YZ plane (arms, T-pose along ±x)
  // region: ATLAS entry; aFrom/aTo: angular arc (default full wrap, front centred)
  tube(rings, region, { axis = 'z', segs = 8, aFrom = -Math.PI, aTo = Math.PI, capEnds = false, uMirror = false, uvPoint = false } = {}) {
    const wrap = Math.abs(aTo - aFrom - Math.PI * 2) < 1e-4;
    const cols = segs + 1;
    const first = this.vc;
    const ucc = (region.u0 + region.u1) / 2, vcc = (region.v0 + region.v1) / 2;
    for (const r of rings) {
      for (let s = 0; s <= segs; s++) {
        const a = aFrom + ((aTo - aFrom) * s) / segs;
        let px, py, pz;
        if (axis === 'z') {
          px = r.x + r.rx * Math.sin(a);
          py = r.y + r.ry * Math.cos(a);
          pz = r.z;
        } else {
          px = r.x;
          py = r.y + r.rx * Math.cos(a);
          pz = r.z + r.ry * Math.sin(a);
        }
        this.pos.push(px, py, pz);
        let u = s / segs;
        if (uMirror) u = 1 - u;
        if (uvPoint) {
          // solid-colour patches: sample the centre pixel only so mipmap
          // minification can't wash in the neighbouring patches
          this.uv.push(ucc, vcc);
        } else {
          this.uv.push(
            region.u0 + u * (region.u1 - region.u0),
            region.v0 + r.t * (region.v1 - region.v0),
          );
        }
        this.pushBones(r.bones);
        this.vc++;
      }
    }
    for (let i = 0; i < rings.length - 1; i++) {
      for (let s = 0; s < segs; s++) {
        const a = first + i * cols + s;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        this.idx.push(a, c, b, b, c, d);
      }
    }
    if (capEnds) {
      this.capRing(first, segs, rings[0], region, axis, false);
      this.capRing(first + (rings.length - 1) * cols, segs, rings[rings.length - 1], region, axis, true);
    }
    if (wrap) { /* seam column duplicated on purpose for clean UVs */ }
    return first;
  }

  capRing(ringStart, segs, r, region, axis, top) {
    const centerIdx = this.vc;
    this.pos.push(r.x, axis === 'z' ? r.y : r.y, axis === 'z' ? r.z : r.z);
    this.uv.push((region.u0 + region.u1) / 2, region.v0 + r.t * (region.v1 - region.v0));
    this.pushBones(r.bones);
    this.vc++;
    for (let s = 0; s < segs; s++) {
      const a = ringStart + s, b = ringStart + s + 1;
      if (top) this.idx.push(a, b, centerIdx);
      else this.idx.push(b, a, centerIdx);
    }
  }

  // axis-aligned box, single bone, mapped onto the middle of a small region
  // (inset so linear filtering can't bleed the neighbouring atlas patches)
  box(cx, cy, cz, hx, hy, hz, bones, region) {
    const first = this.vc;
    const corners = [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ];
    for (const [sx, sy, sz] of corners) {
      this.pos.push(cx + sx * hx, cy + sy * hy, cz + sz * hz);
      this.uv.push(
        region.u0 + (sx * 0.3 + 0.5) * (region.u1 - region.u0),
        region.v0 + (sz * 0.3 + 0.5) * (region.v1 - region.v0),
      );
      this.pushBones(bones);
      this.vc++;
    }
    const f = (a, b, c, d) => this.idx.push(first + a, first + b, first + c, first + a, first + c, first + d);
    f(0, 1, 2, 3); f(5, 4, 7, 6); f(4, 0, 3, 7); f(1, 5, 6, 2); f(3, 2, 6, 7); f(4, 5, 1, 0);
  }

  pushBones(bones) {
    const b0 = bones[0], b1 = bones[1] || [0, 0];
    this.si.push(b0[0], b1[0], 0, 0);
    this.sw.push(b0[1], b1[1], 0, 0);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

// ---------------------------------------------------------------- body parts

function buildBody(B, variant, hairStyle, hat) {
  const V = VARIANTS[variant] || VARIANTS.male;
  const g = new GeoAccum();

  // ---- torso: loft pelvis → shoulders, blended across the spine chain
  const tor = (z, rx, ry, t, bones) => ({ x: 0, y: 0.4, z, rx, ry, t, bones });
  const chestBulge = V.bust;
  g.tube([
    tor(99.5, 14.6 * V.hips, 10.2 * V.hips, 0.0, [[B.hips, 1]]),
    tor(106.1, 15.2 * V.hips, 10.6 * V.hips, 0.12, [[B.hips, 1]]),
    tor(115.6, 13.6 * V.waist, 9.6 * V.waist, 0.3, [[B.spine, 0.7], [B.hips, 0.3]]),
    tor(126.7, 14.2 * V.torso, 10.0 * V.torso, 0.5, [[B.spine1, 0.8], [B.spine, 0.2]]),
    { x: 0, y: 0.4 + chestBulge * 0.8, z: 139.3, rx: 15.4 * V.torso, ry: 10.8 * V.torso + chestBulge, t: 0.7, bones: [[B.spine2, 0.85], [B.spine1, 0.15]] },
    tor(148.0, 15.8 * V.shoulders, 10.8 * V.torso, 0.88, [[B.spine2, 1]]),
    tor(152.5, 12.6 * V.shoulders, 8.8, 1.0, [[B.spine2, 0.6], [B.neck, 0.4]]),
  ], ATLAS.torso, { segs: 10, capEnds: false });

  // ---- neck
  g.tube([
    { x: 0, y: -1.5, z: 152.0, rx: 5.4, ry: 5.2, t: 0.02, bones: [[B.neck, 1]] },
    { x: 0, y: -1.8, z: 158.5, rx: 5.0, ry: 4.9, t: 0.10, bones: [[B.head, 0.7], [B.neck, 0.3]] },
  ], ATLAS.head, { segs: 8 });

  // ---- head: lathe with a slightly forward face
  const hd = (z, r, t, yOff = 0) => ({ x: 0, y: -1.0 + yOff, z, rx: r, ry: r * 1.08, t, bones: [[B.head, 1]] });
  g.tube([
    hd(157.5, 5.8, 0.12),
    hd(160.5, 8.3, 0.28, 0.4),
    hd(164.0, 9.5, 0.45, 0.7),
    hd(167.5, 9.8, 0.62, 0.7),
    hd(171.0, 8.9, 0.78, 0.3),
    hd(173.8, 6.7, 0.9),
    hd(175.6, 2.6, 0.985),
  ], ATLAS.head, { segs: 10, capEnds: true });

  // nose wedge
  {
    const nz = 164.5, ny = -1.0 + 9.8 * 1.08 - 0.6;
    const first = g.vc;
    const faceU = (ATLAS.head.u0 + ATLAS.head.u1) / 2;
    const faceV = ATLAS.head.v0 + 0.5 * (ATLAS.head.v1 - ATLAS.head.v0);
    const nverts = [
      [-1.4, ny, nz + 1.6], [1.4, ny, nz + 1.6], [0, ny + 2.4, nz - 0.6], [0, ny + 1.0, nz - 2.6],
    ];
    for (const [x, y, z] of nverts) {
      g.pos.push(x, y, z);
      g.uv.push(faceU, faceV);
      g.pushBones([[B.head, 1]]);
      g.vc++;
    }
    g.idx.push(first, first + 1, first + 2, first, first + 2, first + 3, first + 1, first + 3, first + 2, first, first + 3, first + 1);
  }

  // ---- arms (T-pose along ±x). mirrored tube per side
  for (const side of [-1, 1]) {
    const bones = side < 0
      ? { arm: B.armL, fore: B.foreArmL, hand: B.handL }
      : { arm: B.armR, fore: B.foreArmR, hand: B.handR };
    const ar = (x, r, t, bpairs) => ({ x: x * side, y: J.armY, z: J.armZ, rx: r * V.limbs, ry: r * V.limbs, t, bones: bpairs });
    g.tube([
      { x: 16.4 * side, y: J.armY, z: J.armZ + 0.6, rx: 6.4 * V.shoulders, ry: 6.4 * V.shoulders, t: 0.0, bones: [[bones.arm, 0.75], [B.spine2, 0.25]] },
      ar(21.5, 5.5, 0.08, [[bones.arm, 1]]),
      ar(33, 4.9, 0.32, [[bones.arm, 0.8], [bones.fore, 0.2]]),
      ar(44, 4.2, 0.56, [[bones.arm, 0.5], [bones.fore, 0.5]]),
      ar(56, 3.7, 0.78, [[bones.fore, 1]]),
      ar(68.1, 3.1, 1.0, [[bones.fore, 0.4], [bones.hand, 0.6]]),
    ], ATLAS.arm, { axis: 'x', segs: 8, uMirror: side > 0 });

    // mitt hand
    g.box(side * 72.3, J.armY, J.armZ, 4.2, 1.9 * V.limbs, 3.2, [[bones.hand, 1]], ATLAS.hand);
  }

  // ---- legs
  for (const side of [-1, 1]) {
    const bones = side < 0
      ? { up: B.upLegL, lo: B.legL, foot: B.footL }
      : { up: B.upLegR, lo: B.legR, foot: B.footR };
    const lx = J.legX * side * (V.hips > 1.1 ? 1.12 : 1);
    const lr = (z, r, t, bpairs, y = 0.8) => ({ x: lx, y, z, rx: r * V.limbs, ry: r * V.limbs, t, bones: bpairs });
    g.tube([
      lr(103.5, 8.9 * V.hips, 0.0, [[bones.up, 0.55], [B.hips, 0.45]]),
      lr(93, 8.3, 0.13, [[bones.up, 1]]),
      lr(74, 6.9, 0.36, [[bones.up, 1]]),
      lr(57.5, 5.7, 0.56, [[bones.up, 0.5], [bones.lo, 0.5]]),
      lr(38, 5.0, 0.76, [[bones.lo, 1]]),
      lr(23, 4.3, 0.9, [[bones.lo, 1]]),
      lr(13.2, 3.7, 1.0, [[bones.lo, 0.4], [bones.foot, 0.6]], J.ankleY + 1.5),
    ], ATLAS.leg, { segs: 8, uMirror: side > 0 });

    // shoe
    g.box(lx, 4.2, 5.4, 4.3, 8.6, 4.8, [[bones.foot, 1]], ATLAS.shoe);
  }

  // ---- hair / hats (all weighted to the head)
  const hairRegion = ATLAS.hair;
  const hb = [[B.head, 1]];
  const shell = (zRings, region, { arc = false } = {}) => {
    g.tube(
      zRings.map(([z, r, t, yOff = -1.0]) => ({ x: 0, y: yOff, z, rx: r, ry: r * 1.08, t, bones: hb })),
      region,
      arc
        ? { segs: 9, aFrom: Math.PI * 0.32, aTo: Math.PI * 1.68, uvPoint: true }
        : { segs: 10, capEnds: true, uvPoint: true },
    );
  };

  switch (hat) {
    case 'cap':
      shell([[168.3, 10.6, 0.1], [172.8, 9.6, 0.5], [175.9, 4.5, 0.9], [176.6, 1.2, 0.99]], ATLAS.accent);
      g.box(0, 9.6, 168.6, 6.4, 6.2, 0.7, hb, ATLAS.accent);   // brim
      break;
    case 'helmet':
      shell([[161.5, 13.4, 0.05], [162.5, 11.8, 0.2], [166, 11.4, 0.45], [171.5, 10.6, 0.7], [176.2, 6.9, 0.9], [178, 2.4, 0.99]], ATLAS.accent);
      break;
    case 'beanie':
      shell([[163.5, 10.4, 0.1], [169, 10.2, 0.5], [174.5, 7.9, 0.85], [177, 2.6, 0.99]], ATLAS.accent);
      break;
    default:
      switch (hairStyle) {
        case 'afro':
          shell([[162, 8.5, 0.05], [165, 12.4, 0.3], [170.5, 12.8, 0.6], [176, 9.9, 0.85], [179.5, 4, 0.99]], hairRegion);
          break;
        case 'bob':
          shell([[157.5, 10.9, 0.05], [163, 10.9, 0.3], [169.5, 10.6, 0.6], [174.9, 8.4, 0.85], [177.4, 3, 0.99]], hairRegion, { arc: true });
          shell([[170.5, 10.5, 0.55], [175.2, 7.9, 0.85], [177.5, 2.8, 0.99]], hairRegion);
          break;
        case 'pony':
          shell([[170.3, 10.3, 0.55], [175.2, 7.8, 0.85], [177.5, 2.8, 0.99]], hairRegion);
          shell([[161.5, 10.2, 0.1], [166.5, 10.3, 0.4], [170.5, 10.2, 0.6]], hairRegion, { arc: true });
          g.box(0, -11.5, 164.5, 2.6, 2.6, 6.2, hb, hairRegion);   // tail
          break;
        case 'short':
          shell([[170.3, 10.4, 0.55], [175.3, 8.0, 0.85], [177.6, 2.9, 0.99]], hairRegion);
          shell([[162.5, 10.15, 0.15], [167, 10.3, 0.4], [170.5, 10.3, 0.6]], hairRegion, { arc: true });
          break;
        // 'buzz' and 'bald': painted scalp only, no shell
      }
  }

  return g.build();
}

// ---------------------------------------------------------------- factory

export const characterFactory = {
  ready: false,
  _assets: null,
  _template: null,        // armature-only scene (bones, no meshes)
  _boneOrder: null,       // skeleton bone names in original order
  _boneInverses: null,
  _animations: null,
  _boneIndex: null,       // canonical name → skeleton index
  _geoCache: new Map(),
  builtCount: 0,          // test hook

  init(assets) {
    if (this.ready || !assets?.has('Soldier')) return this.ready;
    const asset = assets.skinned('Soldier');
    let skel = null;
    asset.scene.traverse((o) => { if (o.isSkinnedMesh && !skel) skel = o.skeleton; });
    if (!skel) return false;
    this._boneOrder = skel.bones.map((b) => b.name);
    this._boneInverses = skel.boneInverses.map((m) => m.clone());
    this._animations = asset.animations;

    // strip the GLB's own meshes — we only keep its bone hierarchy
    const doomed = [];
    asset.scene.traverse((o) => { if (o.isSkinnedMesh) doomed.push(o); });
    for (const m of doomed) { m.geometry?.dispose?.(); m.removeFromParent(); }
    this._template = asset.scene;

    const idx = (name) => this._boneOrder.indexOf('mixamorig' + name);
    this._boneIndex = {
      hips: idx('Hips'), spine: idx('Spine'), spine1: idx('Spine1'), spine2: idx('Spine2'),
      neck: idx('Neck'), head: idx('Head'),
      armL: idx('LeftArm'), foreArmL: idx('LeftForeArm'), handL: idx('LeftHand'),
      armR: idx('RightArm'), foreArmR: idx('RightForeArm'), handR: idx('RightHand'),
      upLegL: idx('LeftUpLeg'), legL: idx('LeftLeg'), footL: idx('LeftFoot'),
      upLegR: idx('RightUpLeg'), legR: idx('RightLeg'), footR: idx('RightFoot'),
    };
    this.ready = Object.values(this._boneIndex).every((i) => i >= 0);
    return this.ready;
  },

  geometry(variant, hairStyle, hat) {
    const key = variant + '|' + (hat ? 'hat:' + hat : hairStyle);
    let geo = this._geoCache.get(key);
    if (!geo) {
      geo = buildBody(this._boneIndex, variant, hairStyle, hat);
      this._geoCache.set(key, geo);
    }
    return geo;
  },

  // → { scene, animations } with the same shape assets.skinned() returned
  build(look) {
    const root = this._template.clone(true);

    // collect this clone's bones in original skeleton order
    const byName = new Map();
    root.traverse((o) => { if (o.isBone) byName.set(o.name, o); });
    const bones = this._boneOrder.map((n) => byName.get(n));
    const skeleton = new THREE.Skeleton(bones, this._boneInverses.map((m) => m.clone()));

    const variant = look.female ? 'female' : (look.body === 'heavy' ? 'heavy' : 'male');
    const geo = this.geometry(variant, look.hairStyle ?? 'short', look.hat ?? null);
    const mesh = new THREE.SkinnedMesh(geo, materialForLook(look));
    mesh.castShadow = true;
    mesh.frustumCulled = false;              // skinned bounds lag the skeleton
    mesh.name = 'bayvale_person';

    // same parent + identity bind as the original GLB mesh (the 'Character'
    // node carries the 0.01 cm→m scale)
    const parent = bones[0]?.parent ?? root;
    parent.add(mesh);
    mesh.bind(skeleton, new THREE.Matrix4());

    this.builtCount++;
    return { scene: root, animations: this._animations };
  },
};
