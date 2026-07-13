// CombatSystem — full implementation lands in phase C.
// For now: fists only, so the world is already interactive.

export class CombatSystem {
  constructor(game) {
    this.game = game;
    this.punchCooldown = 0;
    game.hud?.setWeapon('👊', 'FISTS', '');
  }

  give() {}

  update(dt) {
    this.punchCooldown -= dt;
    const game = this.game;
    if (game.player.dead || game.player.vehicle) return;
    if (game.input.mousePressed[0] && this.punchCooldown <= 0) {
      this.punchCooldown = 0.45;
      game.player.rig.startPunch();
      const p = game.player;
      const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
      const target = game.peds?.nearestPed(p.pos.x + fx * 1.1, p.pos.z + fz * 1.1, 1.3, (t) => !t.dead);
      if (target) {
        game.audio?.punch();
        target.damage(12, game, 'melee');
        game.wanted?.crime('assault', p.pos.x, p.pos.z);
      }
    }
  }
}
