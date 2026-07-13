// WantedSystem — police response arrives in phase C.
// This phase only tracks heat → stars so the HUD works.

import { clamp } from '../core/mathutil.js';

const CRIME_HEAT = {
  assault: 6, kill: 30, carjack: 12, crash: 2, explosion: 45,
  gunfire: 4, copAttack: 60, copKill: 90,
};

export class WantedSystem {
  constructor(game) {
    this.game = game;
    this.state = { stars: 0, heat: 0 };
  }

  crime(kind, x, z) {
    const heat = CRIME_HEAT[kind] ?? 4;
    this.state.heat = clamp(this.state.heat + heat, 0, 700);
    this.recalcStars();
  }

  setStars(n) {
    const TH = [0, 25, 80, 180, 320, 480, 620];
    this.state.heat = TH[clamp(n, 0, 6)];
    this.recalcStars();
  }

  recalcStars() {
    const h = this.state.heat;
    const stars = h >= 620 ? 6 : h >= 480 ? 5 : h >= 320 ? 4 : h >= 180 ? 3 : h >= 80 ? 2 : h >= 25 ? 1 : 0;
    if (stars > this.state.stars) this.game.audio?.wantedUp();
    this.state.stars = stars;
  }

  update(dt) {
    // passive decay (phase C adds line-of-sight rules + cops)
    this.state.heat = Math.max(0, this.state.heat - dt * 1.4);
    this.recalcStars();
  }
}
