// Pedestrian entity: a Humanoid rig plus a small state machine
// (wander / idle / flee / fight / dead). Cops extend the same brain in phase C.

import * as THREE from 'three';
import { Humanoid, randomLook } from './humanoid.js';
import { clamp, angleDamp, circleVsAabb, dist2d } from '../core/mathutil.js';
import { ARCHETYPES, makePersonality, reactToThreat } from '../systems/npcmind.js';

const RADIUS = 0.35;
let nextPedId = 1;
const _headQ = new THREE.Quaternion();
const _headAxis = new THREE.Vector3(0, 1, 0);

export class Ped {
  constructor(city, scene, look, opts = {}) {
    this.id = nextPedId++;
    this.city = city;
    this.scene = scene;
    this.rig = new Humanoid(look);
    scene.add(this.rig.group);

    this.pos = new THREE.Vector3();
    this.heading = Math.random() * Math.PI * 2;
    this.speed = 0;
    this.health = opts.health ?? 35;
    this.dead = false;
    this.state = 'wander';        // wander | idle | flee | fight | dead | driver
    this.stateT = 0;
    this.target = { x: 0, z: 0 };
    this.fleeFrom = { x: 0, z: 0 };
    this.walkSpeed = 1.15 + Math.random() * 0.6;
    this.runSpeed = 5.2 + Math.random() * 0.9;
    this.brave = Math.random() < (opts.braveChance ?? 0.08);   // fights back instead of fleeing
    this.attackCooldown = 0;
    this.removeTimer = 0;         // counts up after death
    this.isCop = false;
    this.inVehicle = null;

    // mind: role + personality (assigned fully by PedSystem for civilians)
    this.archetype = opts.archetype ?? 'commuter';
    this.personality = opts.personality ?? makePersonality(this.archetype);
    const arch = ARCHETYPES[this.archetype];
    if (arch && opts.archetype) {
      this.walkSpeed = arch.walkSpeed[0] + Math.random() * (arch.walkSpeed[1] - arch.walkSpeed[0]);
      this.brave = Math.random() < (arch.braveChance ?? 0.08);
      const sc = arch.scale[0] + Math.random() * (arch.scale[1] - arch.scale[0]);
      this.rig.group.scale.setScalar(sc);
    }
  }

  place(x, z) {
    this.pos.set(x, this.interiorY ?? this.city.groundHeight(x, z), z);
    this.homeX = x;
    this.homeZ = z;
    this.pickWanderTarget();
    this.syncRig();
  }

  pickWanderTarget() {
    // loiterers shuffle around their home spot
    if (this.loiter && this.homeX !== undefined) {
      const a = Math.random() * Math.PI * 2;
      const d = 1.5 + Math.random() * 5;
      this.target.x = this.homeX + Math.cos(a) * d;
      this.target.z = this.homeZ + Math.sin(a) * d;
      return;
    }
    // sidewalk-following: aim for a point further along the current edge
    if (this.sidewalk) { this.advanceSidewalkTarget(); return; }
    const a = Math.random() * Math.PI * 2;
    const d = 15 + Math.random() * 28;
    this.target.x = this.pos.x + Math.cos(a) * d;
    this.target.z = this.pos.z + Math.sin(a) * d;
  }

  // assign a sidewalk lane: edge + travel direction + side of the road
  setSidewalk(edge, dir = Math.random() < 0.5 ? 1 : -1, side = Math.random() < 0.5 ? 1 : -1) {
    this.sidewalk = { edge, dir, side };
    this.advanceSidewalkTarget();
  }

  sidewalkPoint(edge, t, side) {
    const off = edge.width / 2 + this.city.SIDEWALK * 0.55;
    const x = edge.a.x + (edge.b.x - edge.a.x) * t;
    const z = edge.a.z + (edge.b.z - edge.a.z) * t;
    return edge.horizontal ? { x, z: z + off * side } : { x: x + off * side, z };
  }

  advanceSidewalkTarget() {
    const sw = this.sidewalk;
    if (!sw) return;
    const e = sw.edge;
    // project current position onto the edge
    let t = e.horizontal
      ? (this.pos.x - e.a.x) / (e.b.x - e.a.x)
      : (this.pos.z - e.a.z) / (e.b.z - e.a.z);
    t = Math.max(0, Math.min(1, t));
    const tNext = t + sw.dir * 0.3;
    if (tNext > 1 || tNext < 0) {
      // reached the corner: pick a connecting edge, occasionally cross the street
      const node = sw.dir > 0 ? e.b : e.a;
      const options = node.edges.filter((n2) => n2 !== e);
      const next = options.length ? options[Math.floor(Math.random() * options.length)] : e;
      // turning onto a cross street at a signalled corner: wait for green
      if (node.hasSignal && next.horizontal !== e.horizontal) this.crossWait = next.horizontal;
      sw.edge = next;
      sw.dir = next.a === node ? 1 : -1;
      if (Math.random() < 0.18) sw.side = -sw.side;
      const p = this.sidewalkPoint(next, sw.dir > 0 ? 0.15 : 0.85, sw.side);
      this.target.x = p.x; this.target.z = p.z;
    } else {
      const p = this.sidewalkPoint(e, Math.max(0, Math.min(1, tNext)), sw.side);
      this.target.x = p.x; this.target.z = p.z;
    }
  }

  // ---- senses ----------------------------------------------------
  // sight: ~110° cone, limited range, real line of sight through walls
  seePoint(x, z, { fov = 1.92, range = 28 } = {}) {
    const dx = x - this.pos.x, dz = z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > range) return false;
    if (d > 1.2) {
      let rel = Math.atan2(dx, dz) - this.heading;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      if (Math.abs(rel) > fov / 2) return false;
    }
    return this.game?.wanted?.lineOfSight(
      this.pos.x, this.pos.y + 1.5, this.pos.z, x, this.pos.y + 1.2, z) ?? true;
  }

  // hearing: something loud happened out of view — turn toward it, take a
  // beat to understand, THEN react. No more psychic instant panics.
  hearThreat(x, z, kind) {
    if (this.dead || this.state === 'driver' || this.panicked || this.alarm) return;
    const b = this.personality?.bravery ?? 0.4;
    this.alarm = { x, z, kind, t: 0.25 + (1 - b) * 0.45 + Math.random() * 0.25 };
  }

  panic(fromX, fromZ, directlyTargeted = false) {
    if (this.dead || this.state === 'driver') return;
    // already reacting? repeated scares escalate to flat-out fleeing
    if (this.panicked && this.state !== 'fight') {
      this.state = 'flee';
      this.stateT = 0;
      this.fleeFrom.x = fromX; this.fleeFrom.z = fromZ;
      return;
    }
    this.fleeFrom.x = fromX;
    this.fleeFrom.z = fromZ;
    const d = dist2d(this.pos.x, this.pos.z, fromX, fromZ);
    const reaction = this.brave && directlyTargeted
      ? 'fight'
      : reactToThreat(this, d, directlyTargeted);
    this.panicked = true;
    this.stateT = 0;
    this.idleMode = null;
    this.crossWait = null;
    // NOTE: use this.game (set every update) — a bare `game` here would resolve
    // to the <canvas id="game"> element via named-global access, not the game.
    switch (reaction) {
      case 'fight': this.state = 'fight'; this.bark('bark_backoff'); break;
      case 'cower': this.state = 'cower'; this.rig.setAnim?.('kneel'); this.bark('bark_help'); break;
      case 'film': this.state = 'film'; this.bark('bark_photo'); break;
      case 'call': this.state = 'call'; this.callT = 0; this.bark('bark_help'); break;
      default: this.state = 'flee'; this.bark(Math.random() < 0.5 ? 'bark_run' : 'bark_help');
    }
  }

  bark(name) {
    if (this.game && Math.random() < 0.6) this.game.audio?.bark(name, this.pos.x, this.pos.z);
  }

  damage(amount, game, source = 'player', impact = null) {
    if (this.dead) return;
    this.health -= amount;
    game.particles?.blood(this.pos.x, this.pos.y + 1.1, this.pos.z, 4);
    if (this.health <= 0) {
      // impact from the player if not otherwise supplied
      if (!impact) {
        const dx = this.pos.x - game.player.pos.x, dz = this.pos.z - game.player.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        impact = { dx: dx / l, dz: dz / l, force: source === 'runover' ? 6 : 2.5, up: 1 };
      }
      this.die(game, impact);
      return;
    }
    // flinch on non-fatal hits (skinned rig)
    this.rig.flinch?.();
    this.panic(game.player.pos.x, game.player.pos.z, source === 'melee' || source === 'gun');
  }

  // knocked down but alive: brief ragdoll-style topple, then get up
  stagger(game, dir = null) {
    if (this.dead || this.knockdown) return;
    this.knockdown = { t: 0, dur: 2.2 };
    this.rig.interiorY = this.interiorY ?? null;
    const d = dir ?? { dx: this.pos.x - game.player.pos.x, dz: this.pos.z - game.player.pos.z };
    const l = Math.hypot(d.dx, d.dz) || 1;
    this.knockRag = game.gore?.makeRagdoll(this.rig, { dx: d.dx / l, dz: d.dz / l, force: 3, up: 1.5, spin: (Math.random() - 0.5) * 4 });
  }

  die(game, impact = null) {
    if (this.dead) return;
    this.dead = true;
    this.state = 'dead';
    this.rig.die();
    // ragdoll launched by the killing impulse
    this.rig.interiorY = this.interiorY ?? null;
    this.ragdoll = game.gore?.makeRagdoll(this.rig, impact);
    game.audio?.scream(this.pos.x, this.pos.z);
    game.gore?.blood.pool(this.pos.x, this.pos.z, this.interiorY ?? undefined);
    game.state.stats.kills++;
    if (!this.isGoon && !this.isCop) game.voice?.say?.('kill', 0.2);
    // the death scream carries — those who see it panic, others turn to look
    game.peds?.senseEvent?.(this.pos.x, this.pos.z, 'scream');
    // drop some cash; an ambulance may come for the body
    game.worldlife?.dropCash?.(this.pos.x, this.pos.z, 10 + Math.floor(Math.random() * 30));
    game.dispatch?.reportDeath(this);
  }

  update(dt, game) {
    this.game = game;             // panic()/bark() reach the game through this
    if (this.dead) {
      if (this.ragdoll) this.ragdoll.update(dt);
      else this.rig.update(dt, 0);
      this.removeTimer += dt;
      return;
    }
    // knockdown: ragdoll on the ground, then spring back up
    if (this.knockdown) {
      this.knockdown.t += dt;
      this.knockRag?.update(dt);
      if (this.knockdown.t >= this.knockdown.dur) {
        // reset the rig upright
        this.rig.group.rotation.set(0, this.heading, 0);
        this.rig.group.position.y = this.pos.y;
        this.knockdown = null;
        this.knockRag = null;
        this.state = 'flee';
        this.panicked = true;
        this.stateT = 0;
      }
      return;
    }
    this.stateT += dt;
    const player = game.player;

    // heard something: freeze, turn toward the sound, then react
    if (this.alarm && this.state !== 'fight' && this.state !== 'driver') {
      const a = this.alarm;
      this.speed = 0;
      this.rig.setAnim('idle');
      this.heading = angleDamp(this.heading,
        Math.atan2(a.x - this.pos.x, a.z - this.pos.z), 7, dt);
      a.t -= dt;
      if (a.t <= 0) {
        this.alarm = null;
        this.panic(a.x, a.z);
      }
      this.rig.update(dt, 0);
      this.syncRig();
      return;
    }

    // fear memory: someone who barrelled into you keeps their distance
    if (this.avoidPlayerT > 0) {
      this.avoidPlayerT -= dt;
      const dxp = this.pos.x - player.pos.x, dzp = this.pos.z - player.pos.z;
      const dp = Math.hypot(dxp, dzp);
      if (dp < 3.5 && dp > 0.01 && !player.vehicle) {
        this.pos.x += (dxp / dp) * dt * 1.6;
        this.pos.z += (dzp / dp) * dt * 1.6;
      }
    }

    // gang corners are owned turf: linger and you get warned, then jumped
    if (this.archetype === 'gangster' && this.loiter && !this.dead &&
        !player.dead && !player.vehicle && this.state !== 'fight') {
      const dg = dist2d(this.pos.x, this.pos.z, player.pos.x, player.pos.z);
      if (dg < 6) {
        this._lingerT = (this._lingerT ?? 0) + dt;
        if (this._lingerT > 4 && !this._warned) {
          this._warned = true;
          this.bark('bark_backoff');
          this.heading = Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
        }
        if (this._lingerT > 9) {
          // the whole corner jumps you
          this.state = 'fight';
          this.panicked = true;
          this.stateT = 0;
          for (const buddy of game.peds?.peds ?? []) {
            if (buddy !== this && !buddy.dead && buddy.archetype === 'gangster' &&
                dist2d(buddy.pos.x, buddy.pos.z, this.pos.x, this.pos.z) < 15) {
              buddy.state = 'fight';
              buddy.panicked = true;
              buddy.stateT = 0;
            }
          }
        }
      } else if (dg > 8) {
        this._lingerT = 0;
        this._warned = false;
      }
    }

    switch (this.state) {
      case 'wander': {
        // wait for the light before crossing at a signalled corner
        if (this.crossWait != null) {
          const green = this.game?.traffic?.signalGreenFor?.(this.crossWait);
          if (!green) { this.speed = 0; this.rig.setAnim('idle'); break; }
          this.crossWait = null;
        }
        const d = dist2d(this.pos.x, this.pos.z, this.target.x, this.target.z);
        if (d < 1.6 || this.stateT > 40) {
          this.state = Math.random() < 0.25 ? 'idle' : 'wander';
          this.stateT = 0;
          this.pickWanderTarget();
        }
        // rain sends everyone scurrying
        const rainy = this.game?.weather?.state === 'rain' && !this.loiter;
        this.moveToward(this.target.x, this.target.z, this.walkSpeed * (rainy ? 1.9 : 1), dt);
        this.rig.setAnim(this.speed > 2.6 ? 'run' : this.speed > 0.2 ? 'walk' : 'idle');
        break;
      }
      case 'idle': {
        this.speed = 0;
        // archetype flavor: commuters check phones, tourists take photos,
        // the elderly sit on benches
        if (!this.idleMode) {
          const idles = ARCHETYPES[this.archetype]?.idles ?? [];
          this.idleMode = 'stand';
          this.idleDur = 2 + Math.random() * 4;
          if (idles.includes('phone') && Math.random() < 0.4) {
            this.idleMode = 'phone'; this.idleDur = 5 + Math.random() * 6;
          }
          if (idles.includes('photo') && Math.random() < 0.35) {
            this.idleMode = 'photo'; this.idleDur = 4 + Math.random() * 4;
          }
          if (idles.includes('bench')) {
            for (const b of this.city.queryColliders(this.pos.x, this.pos.z, 4)) {
              if (b.kind === 'prop' && b.owner?.kind === 'bench' && !b.gone) {
                this.pos.x = b.owner.x;
                this.pos.z = b.owner.z;
                this.heading = b.owner.rot ?? 0;
                this.idleMode = 'sit';
                this.idleDur = 12 + Math.random() * 14;
                break;
              }
            }
          }
        }
        this.rig.setAnim(this.idleMode === 'sit' ? 'sit'
          : (this.idleMode === 'phone' || this.idleMode === 'photo') ? 'phone' : 'idle');
        if (this.stateT > (this.idleDur ?? 3)) {
          this.idleMode = null;
          this.state = 'wander';
          this.stateT = 0;
          this.pickWanderTarget();
        }
        break;
      }
      case 'flee': {
        // run directly away from the threat
        const dx = this.pos.x - this.fleeFrom.x, dz = this.pos.z - this.fleeFrom.z;
        const len = Math.hypot(dx, dz) || 1;
        this.moveToward(this.pos.x + (dx / len) * 30, this.pos.z + (dz / len) * 30, this.runSpeed, dt);
        this.rig.setAnim('run');
        if (this.stateT > 9) { this.state = 'wander'; this.panicked = false; this.stateT = 0; }
        break;
      }
      case 'cower': {
        // crouch down, hands over head, until the danger passes
        this.speed = 0;
        this.rig.setAnim('kneel');
        if (this.stateT > 6 + this.personality.bravery * 6) {
          this.state = 'flee'; this.stateT = 0;
        }
        break;
      }
      case 'film': {
        // stand at a distance and film with the phone — until it gets too close
        this.speed = 0;
        this.rig.setAnim('phone');
        this.heading = angleDamp(this.heading,
          Math.atan2(this.fleeFrom.x - this.pos.x, this.fleeFrom.z - this.pos.z), 6, dt);
        const d = dist2d(this.pos.x, this.pos.z, this.fleeFrom.x, this.fleeFrom.z);
        if (d < 8 || this.stateT > 14) { this.state = 'flee'; this.stateT = 0; }
        break;
      }
      case 'call': {
        // phone the police: takes a few seconds, then heat goes up
        this.speed = 0;
        this.rig.setAnim('phone');
        this.callT = (this.callT ?? 0) + dt;
        if (this.callT > 4) {
          game.wanted?.reportCrime?.(this.fleeFrom.x, this.fleeFrom.z);
          game.hud?.showToast('Someone called the police!', 3);
          this.state = 'flee';
          this.stateT = 0;
        }
        break;
      }
      case 'fight': {
        // brave ped charges the player and swings
        const d = dist2d(this.pos.x, this.pos.z, player.pos.x, player.pos.z);
        if (player.dead || d > 30 || this.stateT > 25) { this.state = 'wander'; this.stateT = 0; break; }
        if (d > 1.4) {
          this.moveToward(player.pos.x, player.pos.z, this.runSpeed * 0.85, dt);
          this.rig.setAnim('run');
        } else {
          this.speed = 0;
          this.rig.setAnim('idle');
          this.heading = Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
          this.attackCooldown -= dt;
          if (this.attackCooldown <= 0) {
            this.attackCooldown = 1.1;
            this.rig.startPunch();
            if (!player.vehicle) {
              player.damage(6, 'ped');
              game.audio?.punch();
            }
          }
        }
        break;
      }
    }

    this.rig.update(dt, this.speed);

    // curious glance: heads turn toward the player walking by (post-mixer)
    const headBone = this.rig.animator?.bones?.head;
    if (headBone && !this.panicked && this.state !== 'driver') {
      const dx = game.player.pos.x - this.pos.x;
      const dz = game.player.pos.z - this.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 49 && d2 > 1) {
        let rel = Math.atan2(dx, dz) - this.heading;
        while (rel > Math.PI) rel -= Math.PI * 2;
        while (rel < -Math.PI) rel += Math.PI * 2;
        if (Math.abs(rel) < 1.25) {
          const look = rel * clamp(this.personality?.curiosity ?? 0.5, 0.25, 0.85);
          _headQ.setFromAxisAngle(_headAxis, clamp(look, -0.65, 0.65));
          headBone.quaternion.multiply(_headQ);
        }
      }
    }

    this.syncRig();
  }

  moveToward(tx, tz, speed, dt) {
    const dx = tx - this.pos.x, dz = tz - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.2) { this.speed = 0; return; }
    const want = Math.atan2(dx, dz);
    this.heading = angleDamp(this.heading, want, 8, dt);
    this.speed = speed;
    const mx = Math.sin(this.heading) * speed * dt;
    const mz = Math.cos(this.heading) * speed * dt;
    this.pos.x += mx;
    this.pos.z += mz;
    // static collision: slide along buildings
    const cols = this.city.queryColliders(this.pos.x, this.pos.z, RADIUS + 0.6);
    for (const b of cols) {
      const hit = circleVsAabb(this.pos.x, this.pos.z, RADIUS, b.minX, b.minZ, b.maxX, b.maxZ);
      if (hit) {
        this.pos.x = hit.x;
        this.pos.z = hit.z;
        if (this.state === 'wander' && Math.random() < 0.05) this.pickWanderTarget();
      }
    }
    // stay out of deep water
    if (this.city.groundHeight(this.pos.x, this.pos.z) < this.city.WATER_Y - 0.1) {
      this.pos.x -= mx * 2;
      this.pos.z -= mz * 2;
      this.pickWanderTarget();
    }
    this.pos.y = this.interiorY ?? this.city.groundHeight(this.pos.x, this.pos.z);
  }

  syncRig() {
    this.rig.group.position.copy(this.pos);
    this.rig.group.rotation.y = this.heading;
  }

  dispose() {
    this.rig.dispose();
  }
}

export { randomLook, RADIUS as PED_RADIUS };
