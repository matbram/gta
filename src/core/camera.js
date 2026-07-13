// Third-person orbit camera with collision, smoothing, FOV kick and shake.

import * as THREE from 'three';
import { clamp, damp, lerp, wrapAngle } from './mathutil.js';

const DISTANCES = [4.6, 7.0, 10.5];

export class CameraRig {
  constructor(camera, city) {
    this.camera = camera;
    this.city = city;
    this.yaw = Math.PI;          // orbit angle around target
    this.pitch = 0.22;
    this.distIndex = 0;
    this.dist = DISTANCES[0];
    this.curDist = DISTANCES[0];
    this.aim = false;
    this.baseFov = 62;
    this.fovKick = 0;
    this.shakeAmp = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.smoothTarget = new THREE.Vector3();
    this.initialized = false;
  }

  cycleDistance() {
    this.distIndex = (this.distIndex + 1) % DISTANCES.length;
    this.dist = DISTANCES[this.distIndex];
  }

  snapBehind(heading, pitch = 0.22) {
    this.yaw = heading + Math.PI;
    this.pitch = pitch;
    this.initialized = false;
  }

  addShake(amount) { this.shakeAmp = Math.min(1.4, this.shakeAmp + amount); }

  applyMouse(dx, dy, sensitivity = 0.0026) {
    this.yaw -= dx * sensitivity;
    this.pitch = clamp(this.pitch + dy * sensitivity, -0.55, 1.15);
  }

  // target: Vector3 (feet), targetHeight: metres above feet to look at
  update(dt, target, targetHeight = 1.55, opts = {}) {
    const { driving = false, speed = 0, aimMode = false } = opts;
    this.aim = aimMode;

    const lookAt = this.smoothTarget;
    if (!this.initialized) {
      lookAt.set(target.x, target.y + targetHeight, target.z);
      this.initialized = true;
    } else {
      const l = driving ? 10 : 16;
      lookAt.x = damp(lookAt.x, target.x, l, dt);
      lookAt.y = damp(lookAt.y, target.y + targetHeight, 10, dt);
      lookAt.z = damp(lookAt.z, target.z, l, dt);
    }

    let wantDist = aimMode ? 2.2 : (driving ? this.dist + 1.6 : this.dist);
    this.curDist = damp(this.curDist, wantDist, 6, dt);

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const dirX = Math.sin(this.yaw) * cp;
    const dirZ = Math.cos(this.yaw) * cp;

    // shoulder offset while aiming
    let ox = 0, oy = 0;
    if (aimMode) {
      ox = Math.cos(this.yaw) * -0.55;
      oy = 0.15;
    }

    let px = lookAt.x + dirX * this.curDist + ox;
    let py = lookAt.y + sp * this.curDist + oy;
    let pz = lookAt.z + dirZ * this.curDist + (aimMode ? Math.sin(this.yaw) * 0.55 * 0 : 0);

    // keep camera out of buildings: march along the ray and shorten on hit
    const steps = 8;
    let bestT = 1;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const sx = lerp(lookAt.x, px, t);
      const sy = lerp(lookAt.y, py, t);
      const sz = lerp(lookAt.z, pz, t);
      const cols = this.city.queryColliders(sx, sz, 0.5);
      let hit = false;
      for (const b of cols) {
        if (sx > b.minX - 0.3 && sx < b.maxX + 0.3 && sz > b.minZ - 0.3 && sz < b.maxZ + 0.3) {
          const groundY = this.city.groundHeight(sx, sz);
          if (sy < groundY + b.h) { hit = true; break; }
        }
      }
      if (hit) { bestT = Math.max(0.12, (s - 1) / steps); break; }
    }
    px = lerp(lookAt.x, px, bestT);
    py = lerp(lookAt.y, py, bestT);
    pz = lerp(lookAt.z, pz, bestT);

    // stay above terrain
    const g = this.city.groundHeight(px, pz);
    if (py < g + 0.45) py = g + 0.45;

    // shake
    if (this.shakeAmp > 0.001) {
      const t = performance.now() * 0.045;
      px += Math.sin(t * 1.3) * this.shakeAmp * 0.18;
      py += Math.sin(t * 1.7 + 1) * this.shakeAmp * 0.14;
      pz += Math.cos(t * 1.1) * this.shakeAmp * 0.18;
      this.shakeAmp = Math.max(0, this.shakeAmp - dt * 2.4);
    }

    this.camera.position.set(px, py, pz);
    this.camera.lookAt(lookAt);

    // FOV kick with vehicle speed
    const targetKick = driving ? clamp(speed / 40, 0, 1) * 14 : 0;
    this.fovKick = damp(this.fovKick, targetKick, 3, dt);
    const fov = this.baseFov + this.fovKick + (aimMode ? -12 : 0);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
