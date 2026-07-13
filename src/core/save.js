// SaveSystem — full save/load lands in phase D.

export class SaveSystem {
  constructor(game) {
    this.game = game;
  }
  hasSave() { return false; }
  load() {}
  save() {}
}
