// Foot cop: pursues the player, shoots when in range with line of sight,
// attempts an arrest when the player is slow and on foot.

import { Ped } from './ped.js';
import { dist2d, clamp, angleDamp } from '../core/mathutil.js';

// uniform + cap; face/age/build randomize per officer
const COP_LOOK = { uniform: 'cop', hat: 'cap', bottomStyle: 'slacks' };

export class Cop extends Ped {
  constructor(city, scene, tough = false) {
    super(city, scene, tough ? { ...COP_LOOK, body: 'heavy', female: false } : { ...COP_LOOK }, { health: tough ? 110 : 60 });
    this.isCop = true;
    this.tough = tough;
    this.walkSpeed = 1.25;
    this.state = 'chase';
    this.shootCooldown = 1 + Math.random();
    this.arrestT = 0;
    this.runSpeed = tough ? 6.4 : 5.9;
    this.accuracy = tough ? 0.75 : 0.5;
  }

  // cops don't scatter from gunfire — they engage
  panic(fromX, fromZ) {
    this.provoked = true;
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
    if (player.dead) {
      this.speed = 0;
      this.rig.setAnim('idle');
      this.rig.update(dt, 0);
      this.syncRig();
      return;
    }

    // no heat: walk the beat / investigate reports instead of chasing
    if (game.wanted.state.stars === 0 && !this.provoked) {
      this.arrestT = 0;
      if (this.investigate) {
        const inv = this.investigate;
        const dd = dist2d(this.pos.x, this.pos.z, inv.x, inv.z);
        if (dd > 3) {
          this.moveToward(inv.x, inv.z, this.runSpeed * 0.75, dt);
          this.rig.setAnim('run');
        } else {
          // look around the scene
          inv.t += dt;
          this.speed = 0;
          this.heading += dt * 0.9;
          this.rig.setAnim('idle');
          if (inv.t > 7) this.investigate = null;
        }
        this.rig.update(dt, this.speed);
        this.syncRig();
        return;
      }
      // sidewalk patrol uses the shared pedestrian wander brain
      if (this.patrol) {
        if (this.state === 'chase' || this.state === 'fight') this.state = 'wander';
        super.update(dt, game);
        return;
      }
      this.speed = 0;
      this.rig.setAnim('idle');
      this.rig.update(dt, 0);
      this.syncRig();
      return;
    }

    const d = dist2d(this.pos.x, this.pos.z, player.pos.x, player.pos.z);
    const los = game.wanted.lineOfSight(this.pos.x, this.pos.y + 1.5, this.pos.z, player.pos.x, player.pos.y + 1.2, player.pos.z);
    this.shootCooldown -= dt;

    const playerInCar = !!player.vehicle;
    const canShoot = game.wanted.state.stars >= 2 || this.provoked;

    if (d < 1.9 && !playerInCar && player.speed2d < 1.2 && los) {
      // arrest attempt — needs actual line of sight (no busts through walls)
      this.speed = 0;
      this.heading = angleDamp(this.heading, Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z), 12, dt);
      this.rig.setAnim('aim');
      this.arrestT += dt;
      if (this.arrestT > 1.15) game.onBusted?.();
    } else if (canShoot && los && d < (this.tough ? 30 : 22) && d > 3.5) {
      // stop and shoot
      this.arrestT = 0;
      this.speed = 0;
      this.heading = angleDamp(this.heading, Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z), 10, dt);
      this.rig.setAnim('aim');
      if (this.shootCooldown <= 0) {
        this.shootCooldown = this.tough ? 0.75 : 1.1;
        this.shoot(game, d);
      }
    } else {
      this.arrestT = 0;
      // chase what they KNOW: the player when someone can see them, the
      // last known position otherwise — then search the area on foot
      const known = game.wanted.playerSeen || (los && d < 45) || !game.wanted.lastKnown;
      if (known) {
        this.moveToward(player.pos.x, player.pos.z, this.runSpeed, dt);
        this.rig.setAnim('run');
      } else {
        const lk = game.wanted.lastKnown;
        const dl = dist2d(this.pos.x, this.pos.z, lk.x, lk.z);
        if (dl > 6) {
          this.moveToward(lk.x, lk.z, this.runSpeed * 0.9, dt);
          this.rig.setAnim('run');
        } else {
          this._searchT = (this._searchT ?? 0) - dt;
          if (this._searchT <= 0) {
            this._searchT = 2.5;
            const a = Math.random() * Math.PI * 2;
            this._searchPt = { x: lk.x + Math.cos(a) * 10, z: lk.z + Math.sin(a) * 10 };
          }
          this.moveToward(this._searchPt?.x ?? lk.x, this._searchPt?.z ?? lk.z, this.walkSpeed * 2, dt);
          this.rig.setAnim(this.speed > 0.2 ? 'walk' : 'idle');
        }
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
    // hit chance falls with distance and player speed
    const speedDodge = clamp((player.vehicle ? Math.abs(player.vehicle.speed) : player.speed2d) / 14, 0, 0.55);
    const chance = this.accuracy * clamp(1 - d / 34, 0.15, 1) * (1 - speedDodge);
    if (Math.random() < chance) {
      if (player.vehicle) player.vehicle.applyDamage(6, 'copfire');
      else {
        player.damage(this.tough ? 12 : 8, 'cop');
        game.particles?.blood(player.pos.x, player.pos.y + 1.1, player.pos.z, 3);
      }
    } else {
      // miss: spark near the player
      const mx = player.pos.x + (Math.random() - 0.5) * 3;
      const mz = player.pos.z + (Math.random() - 0.5) * 3;
      game.particles?.sparks(mx, game.city.groundHeight(mx, mz) + 0.15, mz, 2);
      game.audio?.ricochet(mx, mz);
    }
  }

  damage(amount, game, source) {
    this.provoked = true;
    if (this.dead) return;
    this.health -= amount;
    game.particles?.blood(this.pos.x, this.pos.y + 1.1, this.pos.z, 4);
    if (this.health <= 0) this.die(game);
  }

  die(game) {
    if (this.dead) return;
    this.dead = true;
    this.state = 'dead';
    this.rig.die();
    // ragdoll honors ground/interior height (plain rig.die sinks to y≈0.1)
    this.rig.interiorY = this.interiorY ?? null;
    const dx = this.pos.x - game.player.pos.x, dz = this.pos.z - game.player.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    this.ragdoll = game.gore?.makeRagdoll(this.rig, { dx: dx / l, dz: dz / l, force: 2.5, up: 1, spin: (Math.random() - 0.5) * 3 });
    game.gore?.blood.pool(this.pos.x, this.pos.z, this.interiorY ?? undefined);
    game.audio?.scream(this.pos.x, this.pos.z);
    game.state.stats.kills++;
    game.peds?.panicAt(this.pos.x, this.pos.z, 26);
    game.worldlife?.dropCash?.(this.pos.x, this.pos.z, 20 + Math.floor(Math.random() * 30));
  }
}
