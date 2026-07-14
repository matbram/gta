// PedImpostors: the far crowd tier. Beyond the full-rig bubble (~250 real
// peds), the streets are populated by lightweight walker records — position
// on a sidewalk edge, a look index, a walk phase — rendered as camera-facing
// billboard sprites in 16 InstancedMeshes (one per look cell). No colliders,
// no senses, no skeletons: ~750 extra people for one-ish milliseconds and 16
// draw calls. Walkers entering the live bubble get promoted to real peds;
// real peds strolling out of it get adopted back as impostors.

import * as THREE from 'three';
import { budgetLook } from '../entities/humanoid.js';
import { dist2d, distSq2d } from '../core/mathutil.js';

const CELLS = 16;
const CAP_PER_CELL = 64;          // 16 × 64 = 1024 walkers max
const NEAR = 115, FAR = 470, DROP = 505, PROMOTE = 95;
const TOTAL_TARGET = 1000;        // whole-city crowd = rigs + impostors

// a simple painted person silhouette — at 100m+ through fog this reads as
// a pedestrian; the real rigs take over long before details matter
function paintSprite(look) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const x = c.getContext('2d');
  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  // legs
  x.fillStyle = hex(look.pants);
  x.fillRect(24, 74, 7, 48);
  x.fillRect(33, 74, 7, 48);
  // torso
  x.fillStyle = hex(look.shirt);
  x.beginPath();
  x.roundRect(19, 34, 26, 44, 6);
  x.fill();
  // arms
  x.fillRect(15, 38, 6, 32);
  x.fillRect(43, 38, 6, 32);
  // head
  x.fillStyle = hex(look.skin);
  x.beginPath(); x.arc(32, 22, 10, 0, 7); x.fill();
  // hair
  x.fillStyle = hex(look.hair);
  x.beginPath(); x.arc(32, 18, 10, Math.PI, 0); x.fill();
  return c;
}

export class PedImpostors {
  constructor(game) {
    this.game = game;
    this.recs = [];
    this.spawnT = 0;
    this.edgeT = 0;
    this.nearEdges = null;
    this._dummy = new THREE.Object3D();
    this._night = -1;

    const geo = new THREE.PlaneGeometry(0.62, 1.75);
    geo.translate(0, 0.875, 0);   // origin at the feet
    this.meshes = [];
    for (let i = 0; i < CELLS; i++) {
      const tex = new THREE.CanvasTexture(paintSprite(budgetLook(i * 6 + 1)));
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide,
      });
      const im = new THREE.InstancedMesh(geo, mat, CAP_PER_CELL);
      im.count = 0;
      im.frustumCulled = false;
      game.scene.add(im);
      this.meshes.push(im);
    }
  }

  // a real ped walked out of the rig bubble — keep them alive as a walker
  adopt(ped) {
    if (!ped.sidewalk?.edge || this.recs.length >= CELLS * CAP_PER_CELL) return;
    const e = ped.sidewalk.edge;
    const t = e.horizontal
      ? (ped.pos.x - e.a.x) / ((e.b.x - e.a.x) || 1)
      : (ped.pos.z - e.a.z) / ((e.b.z - e.a.z) || 1);
    this.recs.push({
      edge: e, t: Math.max(0, Math.min(1, t)),
      dir: ped.sidewalk.dir, side: ped.sidewalk.side,
      cell: Math.floor(Math.random() * CELLS),
      speed: 1.1 + Math.random() * 0.7,
      phase: Math.random() * 7,
      x: ped.pos.x, z: ped.pos.z,
    });
  }

  trySpawn(p) {
    const pool = this.nearEdges;
    if (!pool?.length) return;
    for (let a = 0; a < 6; a++) {
      const edge = pool[Math.floor(Math.random() * pool.length)];
      const t = Math.random();
      const side = Math.random() < 0.5 ? 1 : -1;
      const off = edge.width / 2 + this.game.city.SIDEWALK * 0.55;
      const ex = edge.a.x + (edge.b.x - edge.a.x) * t;
      const ez = edge.a.z + (edge.b.z - edge.a.z) * t;
      const x = edge.horizontal ? ex : ex + off * side;
      const z = edge.horizontal ? ez + off * side : ez;
      const d = dist2d(x, z, p.x, p.z);
      if (d < NEAR || d > FAR) continue;
      this.recs.push({
        edge, t, side, dir: Math.random() < 0.5 ? 1 : -1,
        cell: Math.floor(Math.random() * CELLS),
        speed: 1.1 + Math.random() * 0.7,
        phase: Math.random() * 7,
        x, z,
      });
      return;
    }
  }

  update(dt) {
    const game = this.game;
    const p = game.player?.pos;
    if (!p || game.state.mode !== 'play') return;
    const city = game.city;

    // spawn-pool edges refresh occasionally (they cover a wide ring)
    this.edgeT -= dt;
    if (this.edgeT <= 0 || !this.nearEdges) {
      this.edgeT = 2.5;
      this.nearEdges = city.edges.filter((e) => {
        const mx = (e.a.x + e.b.x) / 2, mz = (e.a.z + e.b.z) / 2;
        return dist2d(mx, mz, p.x, p.z) < FAR + e.len / 2;
      });
    }

    // population target: the whole-city crowd minus the live rigs, thinned
    // like the rig tier (night/rain/quality)
    const hour = (game.dayNight?.minutes ?? 720) / 60;
    const nightThin = (hour >= 23 || hour < 5) ? 0.45 : 1;
    const rainThin = game.weather?.state === 'rain' ? 0.65 : 1;
    const want = Math.min(CELLS * CAP_PER_CELL, Math.round(
      (TOTAL_TARGET - (game.peds?.peds.length ?? 0)) * nightThin * rainThin * (game.gfx?.density ?? 1)));
    this.spawnT -= dt;
    if (this.recs.length < want && this.spawnT <= 0) {
      this.spawnT = 0.02;
      for (let i = 0; i < 6 && this.recs.length < want; i++) this.trySpawn(p);
    }

    // impostors obey the same walk phases as real peds (cheap version:
    // one boolean per road orientation per frame, waiters idle at the curb)
    const phH = game.traffic?.pedPhase?.(true);
    const phV = game.traffic?.pedPhase?.(false);
    const walkAcross = {
      // small margin so sprites don't step off right at the flip
      h: !phH || (phH.walk && phH.timeLeft > 1.5),
      v: !phV || (phV.walk && phV.timeLeft > 1.5),
    };

    // walk + lifecycle
    for (let i = this.recs.length - 1; i >= 0; i--) {
      const r = this.recs[i];
      const e = r.edge;
      if (r.wait) {
        // parked at a red crosswalk: idle bob, poll the cached phase
        r.phase += dt * 1.2;
        if (walkAcross[r.wait.crossH ? 'h' : 'v']) {
          r.edge = r.wait.next;
          r.dir = r.wait.dir;
          r.t = r.dir > 0 ? 0.02 : 0.98;
          r.wait = null;
        }
      } else {
        r.t += r.dir * (r.speed * dt) / (e.len || 20);
      }
      if (!r.wait && (r.t > 1 || r.t < 0)) {
        // corner: continue onto a connecting edge
        const node = r.dir > 0 ? e.b : e.a;
        const options = node.edges.filter((n2) => n2 !== e);
        const next = options.length ? options[Math.floor(Math.random() * options.length)] : e;
        const nextDir = next.a === node ? 1 : -1;
        // the road being stepped across: the one NOT walked along next —
        // straight-through crosses the cross street, a turn crosses the
        // street being left behind
        const crossH = next.horizontal === e.horizontal ? !e.horizontal : e.horizontal;
        if (node.hasSignal && !walkAcross[crossH ? 'h' : 'v']) {
          r.t = Math.max(0, Math.min(1, r.t));       // hold the corner
          r.wait = { next, dir: nextDir, crossH };
        } else {
          r.edge = next;
          r.dir = nextDir;
          r.t = r.dir > 0 ? 0.02 : 0.98;
          // no side flips at signal corners — flips model mid-block drift,
          // not a supervised crossing
          if (!node.hasSignal && Math.random() < 0.2) r.side = -r.side;
        }
      }
      const off = r.edge.width / 2 + city.SIDEWALK * 0.55;
      const ex = r.edge.a.x + (r.edge.b.x - r.edge.a.x) * r.t;
      const ez = r.edge.a.z + (r.edge.b.z - r.edge.a.z) * r.t;
      r.x = r.edge.horizontal ? ex : ex + off * r.side;
      r.z = r.edge.horizontal ? ez + off * r.side : ez;
      if (!r.wait) r.phase += dt * 5;   // waiters idle (slow bob set above)

      const d2 = distSq2d(r.x, r.z, p.x, p.z);
      if (d2 > DROP * DROP) { this.recs.splice(i, 1); continue; }
      if (d2 < PROMOTE * PROMOTE) {
        // entering the live bubble: hand over to a real rig (stays an
        // impostor when the rig budget is full)
        if (game.peds?.spawnFromImpostor?.({ x: r.x, z: r.z, edge: r.edge, dir: r.dir, side: r.side, lookIdx: r.cell * 6 + 1 })) {
          this.recs.splice(i, 1);
        }
        continue;
      }
    }

    // render: rebuild instance matrices, cylindrical-billboarded at camera
    const cam = game.camera.position;
    const counts = new Array(CELLS).fill(0);
    const dummy = this._dummy;
    for (const r of this.recs) {
      const im = this.meshes[r.cell];
      const k = counts[r.cell];
      if (k >= CAP_PER_CELL) continue;
      counts[r.cell] = k + 1;
      dummy.position.set(r.x, city.groundHeight(r.x, r.z) + Math.abs(Math.sin(r.phase)) * 0.04, r.z);
      dummy.rotation.set(0, Math.atan2(cam.x - r.x, cam.z - r.z), 0);
      dummy.updateMatrix();
      im.setMatrixAt(k, dummy.matrix);
    }
    for (let i = 0; i < CELLS; i++) {
      this.meshes[i].count = counts[i];
      this.meshes[i].instanceMatrix.needsUpdate = true;
    }

    // day/night shade so sprites don't glow after dark
    const night = game.dayNight?.nightIntensity ?? 0;
    if (Math.abs(night - this._night) > 0.05) {
      this._night = night;
      const shade = 1 - 0.7 * night;
      for (const m of this.meshes) m.material.color.setScalar(shade);
    }
  }
}
