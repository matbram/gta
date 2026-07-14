// Real light at night from a FIXED pool (the scene's light count must stay
// constant — adding/removing lights recompiles every shader). A handful of
// PointLights are assigned to the streetlamps nearest the player each scan,
// and one SpotLight rides the player's vehicle as working headlights. All
// other lamps/headlights stay emissive like before — the pool just makes the
// space around you actually lit.

import * as THREE from 'three';
import { distSq2d } from '../core/mathutil.js';

const LAMP_RANGE = 26;      // metres of throw per streetlamp
const SCAN_EVERY = 0.6;

export class NightLights {
  constructor(game) {
    this.game = game;
    const q = game.gfx?.quality ?? 'high';
    const count = q === 'low' ? 4 : q === 'medium' ? 7 : 10;

    this.lamps = [];
    for (let i = 0; i < count; i++) {
      const L = new THREE.PointLight(0xffd9a0, 0, LAMP_RANGE, 2);
      game.scene.add(L);
      this.lamps.push(L);
    }

    // player headlight: one wide spot reads like a pair and halves the
    // per-pixel lighting cost vs two
    this.head = new THREE.SpotLight(0xfff4d8, 0, 46, 0.46, 0.55, 1.2);
    game.scene.add(this.head);
    game.scene.add(this.head.target);
    this.headOn = q !== 'low';

    // streetlamp positions (the head arm reaches +1.42 over the road, same
    // offset the emissive ground pools use)
    this.lampProps = (game.city?.props ?? []).filter((p) => p.kind === 'lamp');
    this.scanT = 0;
    this.night = 0;
  }

  update(dt, night) {
    this.night = night;
    const game = this.game;
    const p = game.player?.pos;
    if (!p) return;

    // ---- streetlamps: reassign the pool to the nearest lamps ----
    this.scanT -= dt;
    if (this.scanT <= 0 && night > 0.03 && this.lampProps.length) {
      this.scanT = SCAN_EVERY;
      // nearest N lamp props (partial selection — the list is city-wide)
      const N = this.lamps.length;
      const best = [];
      for (const lp of this.lampProps) {
        const d = distSq2d(lp.x + 1.42, lp.z, p.x, p.z);
        if (d > 130 * 130) continue;
        if (best.length < N) { best.push([d, lp]); best.sort((a, b) => a[0] - b[0]); }
        else if (d < best[N - 1][0]) { best[N - 1] = [d, lp]; best.sort((a, b) => a[0] - b[0]); }
      }
      for (let i = 0; i < N; i++) {
        const L = this.lamps[i];
        const hit = best[i];
        if (!hit) { L.intensity = 0; L._prop = null; continue; }
        const lp = hit[1];
        if (L._prop !== lp) {
          L._prop = lp;
          const gy = this.game.city.groundHeight(lp.x, lp.z);
          L.position.set(lp.x + 1.42, gy + 6.4, lp.z);
        }
      }
    }
    for (const L of this.lamps) {
      L.intensity = L._prop ? 2.4 * Math.min(1, night * 1.4) : 0;
    }

    // ---- player headlight beam ----
    const v = game.player.vehicle;
    if (this.headOn && v && !v.dead && v.lightsOn) {
      const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
      this.head.position.set(v.pos.x + fx * v.hl, v.pos.y + 0.85, v.pos.z + fz * v.hl);
      this.head.target.position.set(v.pos.x + fx * (v.hl + 18), v.pos.y + 0.2, v.pos.z + fz * (v.hl + 18));
      this.head.target.updateMatrixWorld();
      // headlights matter at night and in gloom, fade with daylight
      const gloom = game.weather && game.weather.state !== 'clear' ? 0.5 : 0;
      this.head.intensity = 26 * Math.max(night, gloom);
    } else {
      this.head.intensity = 0;
    }
  }
}
