// Save/load via localStorage: money, stats, weapons, mission progress,
// coins, position and time of day.

const KEY = 'bayvale-save-v1';

export class SaveSystem {
  constructor(game) {
    this.game = game;
  }

  hasSave() {
    try { return !!localStorage.getItem(KEY); } catch { return false; }
  }

  save() {
    const game = this.game;
    const inv = {};
    for (const [id, w] of Object.entries(game.combat.inventory)) {
      if (id === 'fists') continue;
      inv[id] = { ammo: w.ammo === Infinity ? -1 : w.ammo, inMag: w.inMag === Infinity ? -1 : w.inMag };
    }
    const data = {
      v: 1,
      money: Math.round(game.state.money),
      stats: game.state.stats,
      maxHealth: game.player.maxHealth,
      armor: Math.round(game.player.armor),
      pos: { x: game.player.pos.x, z: game.player.pos.z },
      heading: game.player.heading,
      timeMin: game.dayNight.minutes,
      weapons: inv,
      current: game.combat.current,
      missions: [...(game.missions?.passed ?? [])],
      coins: [...(game.worldlife?.coinsTaken ?? [])],
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch { return false; }
  }

  autoSave() { this.save(); }

  load() {
    let data;
    try { data = JSON.parse(localStorage.getItem(KEY)); } catch { return false; }
    if (!data || data.v !== 1) return false;
    const game = this.game;

    game.state.money = data.money ?? 250;
    Object.assign(game.state.stats, data.stats || {});
    game.player.maxHealth = data.maxHealth ?? 100;
    game.player.health = game.player.maxHealth;
    game.player.armor = data.armor ?? 0;
    game.dayNight.minutes = data.timeMin ?? 570;

    // weapons
    for (const [id, w] of Object.entries(data.weapons || {})) {
      game.combat.inventory[id] = {
        ammo: w.ammo === -1 ? Infinity : w.ammo,
        inMag: w.inMag === -1 ? Infinity : w.inMag,
      };
    }
    if (data.current && game.combat.inventory[data.current]) game.combat.select(data.current);
    game.combat.updateHud();

    // missions + coins
    if (game.missions) {
      game.missions.passed = new Set(data.missions || []);
      game.missions.refreshContactMarkers();
    }
    game.worldlife?.restoreCoins(data.coins || []);

    game.player.teleport(data.pos?.x ?? 0, data.pos?.z ?? 0, data.heading ?? 0);
    game.cameraRig.snapBehind(game.player.heading);
    return true;
  }
}
