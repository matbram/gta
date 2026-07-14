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
    const count = q === 'low' ? 4 : q === 'medium' ? 8 : 12;

    this.lamps = [];
    for (let i = 0; i < count; i++) {
      const L = new THREE.PointLight(0xffd9a0, 0, LAMP_RANGE, 2);
      game.scene.add(L);
      this.lamps.push(L);
    }

    // vehicle-headlight pool: the player's car always gets the first spot,
    // the rest ride the nearest lit AI vehicles. One wide spot per vehicle
    // reads like a pair (the emissive lamp meshes show 1 vs 2 per type) and
    // halves the per-pixel cost vs two real cones each. Constant count.
    const headCount = q === 'low' ? 1 : q === 'medium' ? 3 : 5;
    this.heads = [];
    for (let i = 0; i < headCount; i++) {
      const s = new THREE.SpotLight(0xfff4d8, 0, 46, 0.46, 0.55, 1.2);
      game.scene.add(s);
      game.scene.add(s.target);
      this.heads.push(s);
    }

    // streetlamp positions (the head arm reaches +1.42 over the road, same
    // offset the emissive ground pools use)
    this.lampProps = (game.city?.props ?? []).filter((p) => p.kind === 'lamp');
    this.scanT = 0;
    this.headScanT = 0;
    this._litVehicles = [];
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

    // ---- vehicle headlight beams ----
    const gloom = game.weather && game.weather.state !== 'clear' ? 0.5 : 0;
    const lit = Math.max(night, gloom);
    if (lit < 0.02) {
      for (const s of this.heads) s.intensity = 0;
      return;
    }
    // pick which vehicles get a real beam: player first, then nearest lit
    // AI vehicles (refreshed on the scan cadence, with the player always
    // re-evaluated live so their beam never lags)
    this.headScanT -= dt;
    if (this.headScanT <= 0) {
      this.headScanT = SCAN_EVERY;
      const N = this.heads.length;
      const best = [];
      for (const v of game.vehicles?.vehicles ?? []) {
        if (v.dead || !v.lightsOn || v === game.player.vehicle) continue;
        const d = distSq2d(v.pos.x, v.pos.z, p.x, p.z);
        if (d > 120 * 120) continue;
        if (best.length < N) { best.push([d, v]); best.sort((a, b) => a[0] - b[0]); }
        else if (d < best[N - 1][0]) { best[N - 1] = [d, v]; best.sort((a, b) => a[0] - b[0]); }
      }
      this._litVehicles = best.map((b) => b[1]);
    }

    const pv = game.player.vehicle;
    let idx = 0;
    const aim = (spot, v) => {
      const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
      spot.position.set(v.pos.x + fx * v.hl, v.pos.y + 0.85, v.pos.z + fz * v.hl);
      spot.target.position.set(v.pos.x + fx * (v.hl + 18), v.pos.y + 0.2, v.pos.z + fz * (v.hl + 18));
      spot.target.updateMatrixWorld();
      // a motorbike throws one tighter cone; cars a wide pair-like wash
      spot.angle = v.type === 'moto' ? 0.3 : 0.46;
      spot.intensity = 26 * lit;
    };
    if (pv && !pv.dead && pv.lightsOn && this.heads[idx]) aim(this.heads[idx++], pv);
    for (const v of this._litVehicles) {
      if (idx >= this.heads.length) break;
      if (v.dead || !v.lightsOn) continue;
      aim(this.heads[idx++], v);
    }
    for (; idx < this.heads.length; idx++) this.heads[idx].intensity = 0;
  }
}
