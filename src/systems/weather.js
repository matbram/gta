// Weather: clear ↔ overcast ↔ rain with seeded transitions. Drives cloud
// coverage, sun dimming, fog squeeze, a camera-following rain volume, wet
// glossy roads and night lightning. One game hour ≈ one real minute.

import * as THREE from 'three';
import { clamp, lerp } from '../core/mathutil.js';

const STATES = { clear: { cloud: 0.08, rain: 0 }, overcast: { cloud: 0.72, rain: 0 }, rain: { cloud: 1, rain: 1 } };
const RAIN_COUNT = 420;

export class Weather {
  constructor(game) {
    this.game = game;
    this.state = 'clear';
    this.cloud = 0.08;
    this.rain = 0;
    this.nextChange = 150 + Math.random() * 150;   // seconds (≈ game hours)
    this.flashT = 0;
    this.baseFog = { near: 180, far: 950 };
    this._buildRain();
  }

  _buildRain() {
    const geo = new THREE.BoxGeometry(0.02, 0.85, 0.02);
    const mat = new THREE.MeshBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.4, fog: false });
    this.rainMesh = new THREE.InstancedMesh(geo, mat, RAIN_COUNT);
    this.rainMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.visible = false;
    this.game.scene.add(this.rainMesh);
    this.drops = [];
    for (let i = 0; i < RAIN_COUNT; i++) {
      this.drops.push({
        x: (Math.random() - 0.5) * 50, y: Math.random() * 26, z: (Math.random() - 0.5) * 50,
      });
    }
    this._dummy = new THREE.Object3D();
  }

  set(state) {
    if (!STATES[state]) return;
    this.state = state;
    this.nextChange = 150 + Math.random() * 150;
  }

  update(dt) {
    const game = this.game;
    this.nextChange -= dt;
    if (this.nextChange <= 0) {
      // clear-biased weather chain
      const roll = Math.random();
      this.set(this.state === 'clear'
        ? (roll < 0.55 ? 'overcast' : 'clear')
        : this.state === 'overcast'
          ? (roll < 0.4 ? 'rain' : roll < 0.85 ? 'clear' : 'overcast')
          : (roll < 0.7 ? 'overcast' : 'clear'));
    }

    const target = STATES[this.state];
    this.cloud = lerp(this.cloud, target.cloud, clamp(dt * 0.12, 0, 1));
    this.rain = lerp(this.rain, target.rain, clamp(dt * 0.16, 0, 1));

    const night = game.dayNight?.nightIntensity ?? 0;

    // dim the sun, flatten ambient, squeeze fog
    if (game.dayNight) {
      game.dayNight.sun.intensity *= 1 - this.cloud * 0.62;
      game.dayNight.hemi.intensity *= 1 - this.cloud * 0.25;
    }
    if (game.scene.fog) {
      game.scene.fog.near = lerp(this.baseFog.near, 85, this.rain);
      game.scene.fog.far = lerp(this.baseFog.far, 430, this.rain);
    }
    game.terrain?.setCloudCover?.(this.cloud, this.rain);
    game.terrain?.setWet?.(this.rain);

    // rain volume follows the camera (hidden while inside a building)
    const raining = this.rain > 0.06 && !game.interiors?.playerInside;
    this.rainMesh.visible = raining;
    if (raining) {
      const c = game.camera.position;
      const wind = 3.5;
      for (let i = 0; i < RAIN_COUNT; i++) {
        const d = this.drops[i];
        d.y -= dt * 24;
        d.x += dt * wind;
        if (d.y < -2) { d.y += 26; d.x = (Math.random() - 0.5) * 50; d.z = (Math.random() - 0.5) * 50; }
        this._dummy.position.set(c.x + d.x, c.y + d.y - 8, c.z + d.z);
        this._dummy.rotation.set(0, 0, -0.12);
        this._dummy.updateMatrix();
        this.rainMesh.setMatrixAt(i, this._dummy.matrix);
      }
      this.rainMesh.instanceMatrix.needsUpdate = true;
      this.rainMesh.material.opacity = 0.16 + this.rain * 0.3;
    }

    // night lightning during a storm
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (game.dayNight) game.dayNight.hemi.intensity += this.flashT * 6;
      if (this.flashT <= 0) game.audio?.thunder?.();
    } else if (this.rain > 0.85 && night > 0.4 && Math.random() < dt * 0.08) {
      this.flashT = 0.14;
    }
  }
}
