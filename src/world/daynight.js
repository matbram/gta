// Day/night cycle: sun, sky colour, fog, window/lamp emissives, stars.
// One game minute = one real second → full day in 24 minutes.

import * as THREE from 'three';
import { clamp, lerp } from '../core/mathutil.js';

const SKY_STOPS = [
  // [gameHour, skyColor, fogColor, sunIntensity, ambient]
  [0,  0x0a1224, 0x0a1020, 0.00, 0.16],
  [4,  0x0c1428, 0x0c1222, 0.00, 0.16],
  [5.5, 0x3a3050, 0x483850, 0.10, 0.24],
  [6.5, 0xc9784a, 0xb98a68, 0.45, 0.40],
  [8,  0x86b4d8, 0xa8c4d8, 0.95, 0.62],
  [12, 0x8ec2e8, 0xbcd4e4, 1.15, 0.72],
  [16, 0x88b8dd, 0xb4ccdd, 1.00, 0.66],
  [18.5, 0xd8834a, 0xc98a5a, 0.55, 0.46],
  [19.8, 0x51345c, 0x4a3450, 0.15, 0.28],
  [21, 0x101832, 0x101626, 0.00, 0.18],
  [24, 0x0a1224, 0x0a1020, 0.00, 0.16],
];

export class DayNight {
  constructor(scene, renderer) {
    this.scene = scene;
    this.minutes = 10 * 60;            // start 10:00
    this.speed = 1;                    // game-minutes per real second

    this.sun = new THREE.DirectionalLight(0xfff2dd, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = 90;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 500;
    this.sun.shadow.bias = -0.0004;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.moon = new THREE.DirectionalLight(0x8899cc, 0);
    scene.add(this.moon);
    scene.add(this.moon.target);

    this.hemi = new THREE.HemisphereLight(0xbcd4e4, 0x54503e, 0.6);
    scene.add(this.hemi);

    this.skyColor = new THREE.Color();
    this.fogColor = new THREE.Color();
    scene.fog = new THREE.Fog(0xbcd4e4, 180, 950);
    scene.background = this.skyColor;

    this.nightIntensity = 0;   // 0 day → 1 night, consumed by citymesh/vehicles
  }

  get hours() { return (this.minutes / 60) % 24; }

  setTime(h) { this.minutes = ((h * 60) % 1440 + 1440) % 1440; }

  update(dt, focus) {
    this.minutes = (this.minutes + dt * this.speed) % 1440;
    const h = this.hours;

    // interpolate stops
    let i = 0;
    while (i < SKY_STOPS.length - 1 && SKY_STOPS[i + 1][0] < h) i++;
    const a = SKY_STOPS[i], b = SKY_STOPS[Math.min(i + 1, SKY_STOPS.length - 1)];
    const t = b[0] === a[0] ? 0 : clamp((h - a[0]) / (b[0] - a[0]), 0, 1);

    this.skyColor.set(a[1]).lerp(new THREE.Color(b[1]), t);
    this.fogColor.set(a[2]).lerp(new THREE.Color(b[2]), t);
    const sunI = lerp(a[3], b[3], t);
    const amb = lerp(a[4], b[4], t);

    this.scene.fog.color.copy(this.fogColor);
    this.hemi.intensity = amb;
    this.sun.intensity = sunI;

    // sun path: rises 6h, sets 20h
    const dayT = clamp((h - 6) / 14, 0, 1);
    const ang = dayT * Math.PI;
    const sx = Math.cos(ang), sy = Math.sin(ang) * 0.9 + 0.06, sz = 0.35;
    if (focus) {
      this.sun.position.set(focus.x + sx * 220, sy * 260, focus.z + sz * 220);
      this.sun.target.position.set(focus.x, 0, focus.z);
      this.sun.target.updateMatrixWorld();
    }

    // moonlight fills the night so it's never pitch black
    const night = clamp((this.nightCurve(h)), 0, 1);
    this.moon.intensity = night * 0.22;
    if (focus) {
      this.moon.position.set(focus.x - 150, 200, focus.z - 80);
      this.moon.target.position.set(focus.x, 0, focus.z);
      this.moon.target.updateMatrixWorld();
    }

    this.nightIntensity = night;
    return night;
  }

  nightCurve(h) {
    // 1 at deep night, 0 during day, smooth ramps at dusk/dawn
    if (h >= 21 || h < 5) return 1;
    if (h >= 5 && h < 7) return 1 - (h - 5) / 2;
    if (h >= 19 && h < 21) return (h - 19) / 2;
    return 0;
  }
}
