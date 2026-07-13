// Goon: armed hostile used by missions. Chases and shoots the player.

import { Ped } from './ped.js';
import { dist2d, clamp, angleDamp } from '../core/mathutil.js';

export class Goon extends Ped {
  constructor(city, scene, opts = {}) {
    super(city, scene, {
      skin: 0xa9765a,
      shirt: opts.shirt ?? 0x5a2430,
      pants: 0x23262b,
      hair: 0x0e0c0a,
    }, { health: opts.health ?? 65 });
    this.isGoon = true;
    this.aggroRange = opts.aggroRange ?? 60;
    this.shootRange = opts.shootRange ?? 24;
    this.damagePerShot = opts.damage ?? 9;
    this.accuracy = opts.accuracy ?? 0.45;
    this.shootCooldown = 1 + Math.random();
    this.state = 'guard';       // guard | attack
    this.homeX = 0; this.homeZ = 0;
    this.onDeath = null;
  }

  place(x, z) {
    super.place(x, z);
    this.homeX = x; this.homeZ = z;
  }

  update(dt, game) {
    this.game = game;
    if (this.dead) {
      if (this.ragdoll) this.ragdoll.update(dt);
      else this.rig.update(dt, 0);
      this.removeTimer += dt;
      return;
    }
    const player = game.player;
    const d = dist2d(this.pos.x, this.pos.z, player.pos.x, player.pos.z);
    this.shootCooldown -= dt;

    if (this.state === 'guard') {
      this.speed = 0;
      this.rig.setAnim('idle');
      if (d < this.aggroRange || this.provoked) this.state = 'attack';
    } else if (player.dead) {
      this.speed = 0;
      this.rig.setAnim('idle');
    } else {
      const los = game.wanted.lineOfSight(
        this.pos.x, this.pos.y + 1.5, this.pos.z,
        player.pos.x, player.pos.y + 1.2, player.pos.z);
      if (los && d < this.shootRange) {
        this.speed = 0;
        this.heading = angleDamp(this.heading, Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z), 10, dt);
        this.rig.setAnim('aim');
        if (this.shootCooldown <= 0) {
          this.shootCooldown = 0.9 + Math.random() * 0.5;
          this.shoot(game, d);
        }
      } else {
        this.moveToward(player.pos.x, player.pos.z, this.runSpeed * 0.9, dt);
        this.rig.setAnim('run');
      }
    }

    this.rig.update(dt, this.speed);
    this.syncRig();
  }

  shoot(game, d) {
    const player = game.player;
    game.audio?.gunshot('pistol', this.pos.x, this.pos.z);
    game.particles?.muzzleFlash(
      this.pos.x + Math.sin(this.heading) * 0.5, this.pos.y + 1.35,
      this.pos.z + Math.cos(this.heading) * 0.5,
      Math.sin(this.heading), Math.cos(this.heading));
    const speedDodge = clamp((player.vehicle ? Math.abs(player.vehicle.speed) : player.speed2d) / 12, 0, 0.6);
    if (Math.random() < this.accuracy * clamp(1 - d / (this.shootRange + 14), 0.15, 1) * (1 - speedDodge)) {
      if (player.vehicle) player.vehicle.applyDamage(5, 'goonfire');
      else {
        player.damage(this.damagePerShot, 'goon');
        game.particles?.blood(player.pos.x, player.pos.y + 1.1, player.pos.z, 3);
      }
    } else {
      const mx = player.pos.x + (Math.random() - 0.5) * 3;
      const mz = player.pos.z + (Math.random() - 0.5) * 3;
      game.particles?.sparks(mx, game.city.groundHeight(mx, mz) + 0.15, mz, 2);
    }
  }

  damage(amount, game, source) {
    this.provoked = true;
    this.state = 'attack';
    if (this.dead) return;
    this.health -= amount;
    game.particles?.blood(this.pos.x, this.pos.y + 1.1, this.pos.z, 4);
    if (this.health <= 0) {
      this.dead = true;
      this.rig.die();
      this.rig.interiorY = this.interiorY ?? null;
      const dx = this.pos.x - game.player.pos.x, dz = this.pos.z - game.player.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      this.ragdoll = game.gore?.makeRagdoll(this.rig, { dx: dx / l, dz: dz / l, force: 2.5, up: 1, spin: (Math.random() - 0.5) * 3 });
      game.gore?.blood.pool(this.pos.x, this.pos.z, this.interiorY ?? undefined);
      game.audio?.scream(this.pos.x, this.pos.z);
      game.state.stats.kills++;
      this.onDeath?.();
    }
  }
}
