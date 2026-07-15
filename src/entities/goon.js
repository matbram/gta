// Goon: armed hostile used by missions. Chases and shoots the player.

import { Ped } from './ped.js';
import { dist2d, clamp, angleDamp } from '../core/mathutil.js';

export class Goon extends Ped {
  constructor(city, scene, opts = {}) {
    super(city, scene, {
      shirt: opts.shirt ?? 0x5a2430,
      pants: 0x23262b,
      topStyle: 'hoodie',
      hat: Math.random() < 0.4 ? 'beanie' : null,
      accent: 0x1a1a20,
      female: false,
      age: 0.25 + Math.random() * 0.3,
    }, { health: opts.health ?? 65 });
    this.isGoon = true;
    this.faction = opts.faction ?? 'gang';
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
    // threat memory decay (goons fight whoever hit them or their faction)
    if (this.threatT > 0) {
      this.threatT -= dt;
      if (this.threatT <= 0 || this.threat?.dead) this.threat = null;
    }
    if (this.criminal) {
      this.criminal.t -= dt;
      if (this.criminal.t <= 0) this.criminal = null;
    }
    const tgt = (this.threat && !this.threat.dead) ? this.threat : player;
    const tgtDead = tgt === player ? player.dead : tgt.dead;
    const d = dist2d(this.pos.x, this.pos.z, tgt.pos.x, tgt.pos.z);
    this.shootCooldown -= dt;

    if (this.state === 'guard') {
      this.speed = 0;
      this.rig.setAnim('idle');
      // keepers/bouncers (aggroRange 0) only ever engage a live threat
      if ((this.aggroRange > 0 && d < this.aggroRange) || this.provoked || this.threat) this.state = 'attack';
    } else if (tgtDead) {
      this.speed = 0;
      this.rig.setAnim('idle');
      if (this.threat?.dead) { this.threat = null; this.state = 'guard'; }
    } else {
      const los = game.wanted.lineOfSight(
        this.pos.x, this.pos.y + 1.5, this.pos.z,
        tgt.pos.x, tgt.pos.y + 1.2, tgt.pos.z);
      if (los && d < this.shootRange) {
        this.speed = 0;
        this.heading = angleDamp(this.heading, Math.atan2(tgt.pos.x - this.pos.x, tgt.pos.z - this.pos.z), 10, dt);
        this.rig.setAnim('aim');
        if (this.shootCooldown <= 0) {
          this.shootCooldown = 0.9 + Math.random() * 0.5;
          this.shoot(game, d, tgt);
        }
      } else {
        this.moveToward(tgt.pos.x, tgt.pos.z, this.runSpeed * 0.9, dt);
        this.rig.setAnim('run');
      }
    }

    this.rig.update(dt, this.speed);
    this.syncRig();
  }

  shoot(game, d, tgt = null) {
    const player = game.player;
    game.audio?.gunshot('pistol', this.pos.x, this.pos.z);
    game.particles?.muzzleFlash(
      this.pos.x + Math.sin(this.heading) * 0.5, this.pos.y + 1.35,
      this.pos.z + Math.cos(this.heading) * 0.5,
      Math.sin(this.heading), Math.cos(this.heading));
    if (tgt && tgt !== player) {
      // firing on another NPC — gunfire on the street is still a crime
      if (Math.random() < this.accuracy * clamp(1 - d / (this.shootRange + 14), 0.15, 1)) {
        tgt.damage?.(this.damagePerShot, game, 'gun', null, 'ai', this);
      } else {
        game.particles?.sparks(tgt.pos.x, tgt.pos.y + 0.5, tgt.pos.z, 2);
      }
      if (!this.criminal) game.peds?.reportNpcCrime?.(this, 'gunfire', this.pos.x, this.pos.z);
      return;
    }
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

  damage(amount, game, source, impact = null, culprit = 'player', attacker = null) {
    this.provoked = true;
    this.state = 'attack';
    if (attacker && !attacker.dead && attacker !== this) {
      this.lastAttacker = attacker;
      this.threat = attacker;
      this.threatT = 12;
      this.alertAllies?.(game, attacker);
    }
    this.killedBy = culprit;
    if (this.dead) return;
    this.health -= amount;
    game.particles?.blood(this.pos.x, this.pos.y + 1.1, this.pos.z, 4);
    if (this.health <= 0) {
      this.dead = true;
      this.rig.die();
      this.rig.interiorY = this.interiorY ?? null;
      const atk = attacker?.pos ?? game.player.pos;
      const dx = this.pos.x - atk.x, dz = this.pos.z - atk.z;
      const l = Math.hypot(dx, dz) || 1;
      this.ragdoll = game.gore?.makeRagdoll(this.rig, { dx: dx / l, dz: dz / l, force: 2.5, up: 1, spin: (Math.random() - 0.5) * 3 });
      game.gore?.blood.pool(this.pos.x, this.pos.z, this.interiorY ?? undefined);
      game.audio?.scream(this.pos.x, this.pos.z);
      if (culprit === 'player') game.state.stats.kills++;
      this.onDeath?.();
    }
  }
}
