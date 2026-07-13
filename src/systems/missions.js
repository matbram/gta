// MissionSystem — the full framework + story arc lands in phase D.

export class MissionSystem {
  constructor(game) {
    this.game = game;
    this.active = null;
  }
  reset() {}
  update() {}
  debugStart() { return false; }
  debugState() { return { active: null, passed: 0 }; }
}
