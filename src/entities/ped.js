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
    this.pos.set(x, this.city.groundHeight(x, z), z);
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
    switch (reaction) {
      case 'fight': this.state = 'fight'; break;
      case 'cower': this.state = 'cower'; this.rig.setAnim?.('kneel'); break;
      case 'film': this.state = 'film'; break;
      case 'call': this.state = 'call'; this.callT = 0; break;
      default: this.state = 'flee';
    }
  }

  damage(amount, game, source = 'player') {
    if (this.dead) return;
    this.health -= amount;
    game.particles?.blood(this.pos.x, this.pos.y + 1.1, this.pos.z, 4);
    if (this.health <= 0) {
      this.die(game);
      return;
    }
    this.panic(game.player.pos.x, game.player.pos.z);
  }

  die(game) {
    if (this.dead) return;
    this.dead = true;
    this.state = 'dead';
    this.rig.die();
    game.audio?.scream(this.pos.x, this.pos.z);
    game.state.stats.kills++;
    // panic everyone nearby
    game.peds?.panicAt(this.pos.x, this.pos.z, 26);
    // drop some cash; an ambulance may come for the body
    game.worldlife?.dropCash?.(this.pos.x, this.pos.z, 10 + Math.floor(Math.random() * 30));
    game.dispatch?.reportDeath(this);
  }

  update(dt, game) {
    if (this.dead) {
      this.rig.update(dt, 0);
      this.removeTimer += dt;
      return;
    }
    this.stateT += dt;
    const player = game.player;

    switch (this.state) {
      case 'wander': {
        const d = dist2d(this.pos.x, this.pos.z, this.target.x, this.target.z);
        if (d < 1.6 || this.stateT > 40) {
          this.state = Math.random() < 0.25 ? 'idle' : 'wander';
          this.stateT = 0;
          this.pickWanderTarget();
        }
        this.moveToward(this.target.x, this.target.z, this.walkSpeed, dt);
        this.rig.setAnim(this.speed > 0.2 ? 'walk' : 'idle');
        break;
      }
      case 'idle': {
        this.speed = 0;
        this.rig.setAnim('idle');
        if (this.stateT > 2 + Math.random() * 4) {
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
    this.pos.y = this.city.groundHeight(this.pos.x, this.pos.z);
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
