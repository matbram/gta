// Foot cop: pursues the player, shoots when in range with line of sight,
// attempts an arrest when the player is slow and on foot.

import { Ped } from './ped.js';
import { dist2d, clamp, angleDamp } from '../core/mathutil.js';

// uniform + cap; face/age/build randomize per officer
const COP_LOOK = { uniform: 'cop', hat: 'cap', bottomStyle: 'slacks' };

export class Cop extends Ped {
  constructor(city, scene, tough = false) {
    // decide gender up front so voice barks can be matched to it (tough riot
    // units are male); a regular officer is female ~35% of the time
    const female = tough ? false : Math.random() < 0.35;
    super(city, scene, tough ? { ...COP_LOOK, body: 'heavy', female: false } : { ...COP_LOOK, female }, { health: tough ? 110 : 60 });
    this.female = female;
    this.isCop = true;
    this.faction = 'cop';
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

  // shout a police line in this officer's own (gendered) voice. audio.bark is
  // globally throttled, so a crowd of cops won't talk over each other. Female
  // officers fall back to the base take if their `_f` clip isn't loaded yet,
  // so they're never silent before the gendered voices have been generated.
  say(line) {
    const audio = this.game?.audio;
    if (!audio?.bark) return;
    const gendered = line + (this.female ? '_f' : '');
    const name = (this.female && !audio.buffers?.has(gendered)) ? line : gendered;
    audio.bark(name, this.pos.x, this.pos.z);
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

    // commandeering a vehicle to join the chase takes precedence
    if (this.commandeer && this.runCommandeer(dt, game)) return;

    // no heat: police NPC criminals, walk the beat, investigate reports
    if (game.wanted.state.stars === 0 && !this.provoked) {
      this.arrestT = 0;
      // engagement is over — re-arm the one-shot voice lines
      this._barkedArrest = this._barkedSpot = this._barkedBackup = false;
      if (this.npcTarget && this.pursueNpc(dt, game)) return;
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
      if (!this._barkedArrest) { this._barkedArrest = true; this.say(Math.random() < 0.5 ? 'cop_freeze' : 'cop_stop'); }
      this.arrestT += dt;
      if (this.arrestT > 1.15) game.onBusted?.();
    } else if (canShoot && los && d < (this.tough ? 30 : 22) && d > 3.5) {
      // stop and shoot
      this.arrestT = 0;
      this._barkedArrest = false;
      this.speed = 0;
      this.heading = angleDamp(this.heading, Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z), 10, dt);
      this.rig.setAnim('aim');
      if (this.shootCooldown <= 0) {
        this.shootCooldown = this.tough ? 0.75 : 1.1;
        this.shoot(game, d);
      }
    } else {
      this.arrestT = 0;
      this._barkedArrest = false;
      // chase what they KNOW: the player when someone can see them, the
      // last known position otherwise — then search the area on foot
      const known = game.wanted.playerSeen || (los && d < 45) || !game.wanted.lastKnown;
      if (known) {
        // call the suspect out once when we actually have eyes on them
        if (los && d < 45 && !this._barkedSpot) { this._barkedSpot = true; this.say('cop_suspect'); }
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

  // run to a nearby car, pull the driver if needed, and drive off as a
  // headless pursuit cruiser. Returns true while the beat is playing so
  // update() skips the normal chase logic. `boarded` marks this officer
  // for removal by the wanted loop (his body is now "in the car").
  runCommandeer(dt, game) {
    const cm = this.commandeer;
    const v = cm.vehicle;
    const abort = () => {
      if (v) v._commandeerBy = null;
      const car0 = game.traffic?.cars?.find((c) => c.vehicle === v);
      if (car0) car0.pulledOver = false;
      this.commandeer = null;
      if (game.wanted) game.wanted._commandeers = Math.max(0, (game.wanted._commandeers ?? 1) - 1);
    };
    cm.t += dt;
    if (!v || v.dead || v.driver === 'player' || game.player.vehicle === v ||
        game.wanted.state.stars === 0 || cm.t > 25) { abort(); return false; }
    const door = v.seatWorldPos();
    const d = dist2d(this.pos.x, this.pos.z, door.x, door.z);
    if (d > 55) { abort(); return false; }
    const car = game.traffic?.cars?.find((c) => c.vehicle === v);

    if (cm.phase === 'approach') {
      // wave a moving target over to the curb once we're close
      if (car && d < 25 && !car.pulledOver) car.pulledOver = true;
      if (d > 1.6) {
        this.moveToward(door.x, door.z, this.runSpeed, dt);
        this.rig.setAnim('run');
      } else if (car?.driverPed) {
        cm.phase = 'yank';
        cm.yankT = 0;
      } else if (Math.abs(v.speed) < 1.5) {
        cm.phase = 'enter';
      }
    }
    if (cm.phase === 'yank') {
      // gun on the window: "out of the car"
      this.speed = 0;
      this.heading = angleDamp(this.heading,
        Math.atan2(v.pos.x - this.pos.x, v.pos.z - this.pos.z), 12, dt);
      this.rig.setAnim('aim');
      if (!cm.barked) { cm.barked = true; game.audio?.bark?.('bark_moveit', this.pos.x, this.pos.z); }
      cm.yankT += dt;
      if (cm.yankT > 0.9) {
        const ped = car?.driverPed;
        if (ped) {
          game.peds.ejectDriver(ped, v);
          game.audio?.bark?.('bark_mycar', ped.pos.x, ped.pos.z);
        }
        if (car) car.driverPed = null;
        v.driver = null;
        game.traffic?.releaseVehicle(v);
        cm.phase = 'enter';
      }
    }
    if (cm.phase === 'enter') {
      v._commandeerBy = null;
      if (game.wanted) {
        game.wanted._commandeers = Math.max(0, (game.wanted._commandeers ?? 1) - 1);
        game.wanted.convertToCruiser(v, 1);
      }
      this.commandeer = null;
      this.boarded = true;   // wanted loop disposes + removes us this frame
      return true;
    }
    this.rig.update(dt, this.speed);
    this.syncRig();
    return true;
  }

  // chase / arrest / shoot an NPC criminal (0★ police work). Returns true
  // while handling one so the caller skips the player logic this frame.
  pursueNpc(dt, game) {
    const t = this.npcTarget;
    if (!t || t.dead || !t.criminal) { this.npcTarget = null; return false; }
    const d = dist2d(this.pos.x, this.pos.z, t.pos.x, t.pos.z);
    if (d > 120) { this.npcTarget = null; return false; }
    this.shootCooldown -= dt;   // the 0★ branch returns before the shared tick
    // a crowd gathers to watch the arrest / shootout (throttled)
    if (d < 30 && (this._spectT ?? 0) < game.time) {
      this._spectT = game.time + 2;
      game.peds?.spectacleAt?.(t.pos.x, t.pos.z);
    }
    const los = game.wanted.lineOfSight(this.pos.x, this.pos.y + 1.5, this.pos.z,
      t.pos.x, t.pos.y + 1.2, t.pos.z);
    if (t.criminal.level >= 2) {
      // killer: lethal response
      if (los && d < 22 && d > 2) {
        this.speed = 0;
        this.heading = angleDamp(this.heading, Math.atan2(t.pos.x - this.pos.x, t.pos.z - this.pos.z), 10, dt);
        this.rig.setAnim('aim');
        if (this.shootCooldown <= 0) {
          this.shootCooldown = 1.1;
          this.shoot(game, d, t);
        }
      } else {
        this.moveToward(t.pos.x, t.pos.z, this.runSpeed, dt);
        this.rig.setAnim('run');
      }
    } else {
      // minor crime: close in and make the arrest
      if (d > 1.9) {
        this.moveToward(t.pos.x, t.pos.z, this.runSpeed * 0.9, dt);
        this.rig.setAnim('run');
      } else {
        this.speed = 0;
        this.heading = angleDamp(this.heading, Math.atan2(t.pos.x - this.pos.x, t.pos.z - this.pos.z), 12, dt);
        this.rig.setAnim('aim');
        this._npcArrestT = (this._npcArrestT ?? 0) + dt;
        if (this._npcArrestT > 1.15) {
          this._npcArrestT = 0;
          t.criminal = null;
          t.threat = null;
          t.state = t.isGoon ? 'guard' : 'cower';   // hands up / stand down
          t.panicked = !t.isGoon;
          t.stateT = 0;
          this.npcTarget = null;
          this.investigate = { x: t.pos.x, z: t.pos.z, t: 0 };
        }
      }
    }
    this.rig.update(dt, this.speed);
    this.syncRig();
    return true;
  }

  shoot(game, d, tgt = null) {
    const player = game.player;
    game.audio?.gunshot('pistol', this.pos.x, this.pos.z);
    game.particles?.muzzleFlash(
      this.pos.x + Math.sin(this.heading) * 0.5, this.pos.y + 1.35,
      this.pos.z + Math.cos(this.heading) * 0.5,
      Math.sin(this.heading), Math.cos(this.heading));
    if (tgt && tgt !== player) {
      // firing on an NPC criminal
      if (Math.random() < this.accuracy * clamp(1 - d / 34, 0.15, 1)) {
        tgt.damage?.(this.tough ? 12 : 8, game, 'gun', null, 'ai', this);
      } else {
        game.particles?.sparks(tgt.pos.x, tgt.pos.y + 0.5, tgt.pos.z, 2);
      }
      return;
    }
    // opening fire on the player: radio it in once per engagement
    if (!this._barkedBackup) { this._barkedBackup = true; if (Math.random() < 0.6) this.say('cop_backup'); }
    // hit chance falls with distance and player speed
    const speedDodge = clamp((player.vehicle ? Math.abs(player.vehicle.speed) : player.speed2d) / 14, 0, 0.55);
    const chance = this.accuracy * clamp(1 - d / 34, 0.15, 1) * (1 - speedDodge);
    if (Math.random() < chance) {
      if (player.vehicle) player.vehicle.applyDamage(6, 'copfire');
      else {
        player.damage(this.tough ? 12 : 8, 'cop', this.pos);
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

  damage(amount, game, source, impact = null, culprit = 'player', attacker = null) {
    // a stray AI car clipping a beat cop must not put him in execution
    // mode — only a direct player attack provokes lethal response at 0★
    if (culprit === 'player') this.provoked = true;
    else if (attacker && !attacker.dead && !attacker.isCop && attacker !== game.player) {
      // attacked by an NPC: they're now a lethal-response criminal
      attacker.criminal = { level: 2, t: 60 };
      this.npcTarget = attacker;
    }
    this.killedBy = culprit;
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
    const culprit = this.killedBy ?? 'player';
    if (culprit === 'player') { game.state.stats.kills++; game.voice?.say?.('copkill', 0.6); game.voice?.notifyKill?.(); }
    game.peds?.panicAt(this.pos.x, this.pos.z, 26, null, culprit);
    game.worldlife?.dropCash?.(this.pos.x, this.pos.z, 20 + Math.floor(Math.random() * 30));
    // his sidearm skitters loose — anyone can grab it (tough units carry rifles)
    game.worldlife?.dropWeapon?.(this.pos.x + 0.7, this.pos.z + 0.4,
      this.tough ? 'rifle' : 'pistol', this.tough ? 24 : 12);
    this._clearCommandeer();
  }

  // any removal path (death, cull, stand-down) must release a car we were
  // in the middle of grabbing, or it stays flagged/stopped forever
  _clearCommandeer() {
    if (!this.commandeer) return;
    const v = this.commandeer.vehicle;
    if (v) v._commandeerBy = null;
    const car = this.game?.traffic?.cars?.find((c) => c.vehicle === v);
    if (car) car.pulledOver = false;
    this.commandeer = null;
    const w = this.game?.wanted;
    if (w) w._commandeers = Math.max(0, (w._commandeers ?? 1) - 1);
  }

  dispose() {
    this._clearCommandeer();
    super.dispose();
  }
}
