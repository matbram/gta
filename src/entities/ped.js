// Pedestrian entity: a Humanoid rig plus a small state machine
// (wander / idle / flee / fight / dead). Cops extend the same brain in phase C.

import * as THREE from 'three';
import { Humanoid, randomLook } from './humanoid.js';
import { clamp, angleDamp, circleVsAabb, circleVsObb, dist2d, distSq2d } from '../core/mathutil.js';
import { ARCHETYPES, makePersonality, reactToThreat, reactToMugging } from '../systems/npcmind.js';

const RADIUS = 0.35;
let nextPedId = 1;
const _headQ = new THREE.Quaternion();
const _headAxis = new THREE.Vector3(0, 1, 0);
const _probeObb = { x: 0, z: 0, hw: 0, hl: 0, heading: 0 };

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
    this.threat = null;           // entity this ped is angry at (any NPC or player)
    this.threatT = 0;
    this.faction = opts.faction ?? 'civ';   // civ | cop | gang | keeper | crew

    // mind: role + personality (assigned fully by PedSystem for civilians)
    this.archetype = opts.archetype ?? 'commuter';
    this.personality = opts.personality ?? makePersonality(this.archetype);
    const arch = ARCHETYPES[this.archetype];
    if (arch && opts.archetype) {
      this.walkSpeed = arch.walkSpeed[0] + Math.random() * (arch.walkSpeed[1] - arch.walkSpeed[0]);
      if (arch.runSpeed) this.runSpeed = arch.runSpeed[0] + Math.random() * (arch.runSpeed[1] - arch.runSpeed[0]);
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
    // sidewalk-following: aim for a point further along the current edge —
    // unless a flee/knockback carried us far from it (walking back to a
    // distant edge means cutting across roads mid-block)
    if (this.sidewalk) {
      const e = this.sidewalk.edge;
      const t = Math.max(0, Math.min(1, e.horizontal
        ? (this.pos.x - e.a.x) / (e.b.x - e.a.x)
        : (this.pos.z - e.a.z) / (e.b.z - e.a.z)));
      const px = e.a.x + (e.b.x - e.a.x) * t, pz = e.a.z + (e.b.z - e.a.z) * t;
      if (dist2d(this.pos.x, this.pos.z, px, pz) > 14) this.sidewalk = null;
      else { this.advanceSidewalkTarget(); return; }
    }
    // no sidewalk: snap to the NEAR side of the closest road instead of
    // wandering to a random point — that fallback was the jaywalking source
    // (promoted impostors, ejected passengers, panic survivors)
    const ep = this.city.nearestEdgePoint?.(this.pos.x, this.pos.z);
    if (ep) {
      const e = ep.edge;
      const side = e.horizontal
        ? (this.pos.z >= ep.z ? 1 : -1)
        : (this.pos.x >= ep.x ? 1 : -1);
      this.setSidewalk(e, undefined, side);
      return;
    }
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
    // per-ped lane offset spreads the crowd across the sidewalk width
    // instead of everyone marching a single line
    if (this.laneOff === undefined) this.laneOff = ((this.id % 5) - 2) * 0.2;
    const off = edge.width / 2 + this.city.SIDEWALK * 0.55 + this.laneOff;
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
      // at a signalled corner: if the destination sits in a different
      // quadrant, that's one or two road crossings — queue at the curb
      // and cross inside the crosswalk band on the walk phase
      if (node.hasSignal) this.planCrossing(node, p);
    } else {
      const p = this.sidewalkPoint(e, Math.max(0, Math.min(1, tNext)), sw.side);
      this.target.x = p.x; this.target.z = p.z;
    }
  }

  // corner-to-corner crossing plan: quadrant signs relative to the node
  // decide which roads get crossed (x-flip = the vertical road, z-flip =
  // the horizontal one; both = two legs via the shared corner)
  planCrossing(node, dest) {
    const qx0 = this.pos.x >= node.x ? 1 : -1, qz0 = this.pos.z >= node.z ? 1 : -1;
    const qx1 = dest.x >= node.x ? 1 : -1, qz1 = dest.z >= node.z ? 1 : -1;
    if (qx0 === qx1 && qz0 === qz1) return;      // same corner, no road crossed
    let wH = 0, wV = 0;
    for (const ed of node.edges) {
      if (ed.horizontal) wH = Math.max(wH, ed.width);
      else wV = Math.max(wV, ed.width);
    }
    const lane = (this.laneOff ?? 0) * 0.5;
    const cx = (wV || wH) / 2 + this.city.SIDEWALK * 0.55 + lane;
    const cz = (wH || wV) / 2 + this.city.SIDEWALK * 0.55 + lane;
    const corner = (qx, qz) => ({ x: node.x + qx * cx, z: node.z + qz * cz });
    const steps = [];
    if (qx0 !== qx1) steps.push({ from: corner(qx0, qz0), to: corner(qx1, qz0), roadHorizontal: false });
    if (qz0 !== qz1) steps.push({ from: corner(qx1, qz0), to: corner(qx1, qz1), roadHorizontal: true });
    this.crossing = { node, steps, leg: 0, phase: 'queue', counted: false };
  }

  _clearCrossing() {
    if (this.crossing?.counted) this.game?.traffic?.crossingDone?.(this.crossing.node);
    this.crossing = null;
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
  hearThreat(x, z, kind, culprit = 'player') {
    if (this.dead || this.state === 'driver' || this.panicked || this.alarm) return;
    const b = this.personality?.bravery ?? 0.4;
    this.alarm = { x, z, kind, culprit, t: 0.25 + (1 - b) * 0.45 + Math.random() * 0.25 };
  }

  // kind: what actually scared them ('gunshot'|'brandish'|'runover'|'crash'|
  // 'scream'|'explosion'|null). Barks are kind-aware — "He's got a gun!"
  // only ever follows an actual gun event, not any random fright.
  // culprit: who's to blame ('player'|'ai') — carried into a police call.
  panic(fromX, fromZ, directlyTargeted = false, kind = null, culprit = 'player') {
    if (this.dead || this.state === 'driver') return;
    this._panicCulprit = culprit;
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
    this._clearCrossing();   // fleeing peds cross anywhere — that's fine
    const gun = kind === 'gunshot' || kind === 'brandish';
    const fleeBark = gun ? (Math.random() < 0.5 ? 'bark_run' : 'bark_help')
      : (kind === 'runover' || kind === 'crash')
        ? (Math.random() < 0.5 ? 'bark_crazy' : 'bark_help')
        : 'bark_help';
    // NOTE: use this.game (set every update) — a bare `game` here would resolve
    // to the <canvas id="game"> element via named-global access, not the game.
    switch (reaction) {
      case 'fight': this.state = 'fight'; this.bark(Math.random() < 0.5 ? 'bark_backoff' : 'bark_fight'); break;
      case 'cower': this.state = 'cower'; this.rig.setAnim?.('kneel'); this.bark('bark_help'); break;
      case 'film': this.state = 'film'; this.bark('bark_photo'); break;
      case 'call': this.state = 'call'; this.callT = 0; this.bark('bark_help'); break;
      default: this.state = 'flee'; this.bark(fleeBark);
    }
  }

  bark(name) {
    if (this.game && Math.random() < 0.6) this.game.audio?.bark(name, this.pos.x, this.pos.z);
  }

  // attacker: the entity that dealt this hit (player, ped, cop, goon…).
  // Threading it through lets ANY NPC fight or be fought by any other,
  // and keeps blame (culprit) separate from targeting.
  damage(amount, game, source = 'player', impact = null, culprit = 'player', attacker = null) {
    if (this.dead) return;
    this.killedBy = culprit;   // remembered by the corpse for witness calls
    if (attacker && !attacker.dead) {
      this.lastAttacker = attacker;
      if (attacker !== this) { this.threat = attacker; this.threatT = 12; }
      this.alertAllies(game, attacker);
    }
    const atk = attacker?.pos ?? game.player.pos;
    this.health -= amount;
    game.particles?.blood(this.pos.x, this.pos.y + 1.1, this.pos.z, 4);
    if (this.health <= 0) {
      if (!impact) {
        const dx = this.pos.x - atk.x, dz = this.pos.z - atk.z;
        const l = Math.hypot(dx, dz) || 1;
        impact = { dx: dx / l, dz: dz / l, force: source === 'runover' ? 6 : 2.5, up: 1 };
      }
      this.die(game, impact);
      return;
    }
    // a hard non-fatal hit can leave them wounded on the ground, crawling
    if (!this.wounded && !this.isCop && this.health < 12 &&
        (source === 'gun' || source === 'melee') && Math.random() < 0.55) {
      this.wounded = true;
      this.state = 'wounded';
      this.woundT = 0;
      this.stateT = 0;
      this.panicked = true;
      this.fleeFrom.x = atk.x; this.fleeFrom.z = atk.z;
      game.gore?.blood.pool(this.pos.x, this.pos.z, this.interiorY ?? undefined);
      game.dispatch?.reportDeath?.(this);   // medics respond to the wounded too
      return;
    }
    // flinch away from the side the hit came from (skinned rig)
    const rel = Math.atan2(atk.x - this.pos.x, atk.z - this.pos.z) - this.heading;
    this.rig.flinch?.(Math.sin(rel) >= 0 ? 1 : -1);
    const kind = source === 'gun' ? 'gunshot' : source === 'runover' ? 'runover' : null;
    this.panic(atk.x, atk.z, source === 'melee' || source === 'gun', kind, culprit);
  }

  // a bullet in the leg slows them for good (this life, anyway): speeds
  // cut hard and the limp overlay takes over their gait
  legWound() {
    if (this.legWounded || this.dead) return;
    this.legWounded = true;
    this.walkSpeed *= 0.45;
    this.runSpeed *= 0.4;
    this.rig.limp = true;
    this.rig.anim = null;   // force the overlay to refresh mid-stride
  }

  // faction loyalty: allies who see one of their own get hit adopt the
  // attacker as a threat (generalizes the old gang-corner buddy jump).
  // Civilians have no such loyalty — they just panic like before.
  alertAllies(game, attacker) {
    if (this.faction === 'civ' || !game.peds?.nearTargets) return;
    if ((this._assistT ?? 0) > game.time) return;
    this._assistT = game.time + 0.5;
    for (const ally of game.peds.nearTargets(this.pos.x, this.pos.z, 15)) {
      if (ally === this || ally === attacker || ally.dead || ally.faction !== this.faction) continue;
      if (!ally.seePoint?.(this.pos.x, this.pos.z, { range: 15 })) continue;
      ally.threat = attacker;
      ally.threatT = 10;
      if (ally.isCop) continue;               // cops keep their own rules
      ally.state = ally.isGoon ? 'attack' : 'fight';
      ally.panicked = true;
      ally.stateT = 0;
      ally.bark?.('bark_fight');
    }
  }

  // knocked down but alive: brief ragdoll-style topple, then get up
  stagger(game, dir = null) {
    if (this.dead || this.knockdown) return;
    this.knockdown = { t: 0, dur: 2.2 };
    this.rig.interiorY = this.interiorY ?? null;
    const d = dir ?? { dx: this.pos.x - game.player.pos.x, dz: this.pos.z - game.player.pos.z };
    const l = Math.hypot(d.dx, d.dz) || 1;
    // cheap topple only: the get-up needs a pose it can spring back from
    this.knockRag = game.gore?.makeRagdoll(this.rig,
      { dx: d.dx / l, dz: d.dz / l, force: 3, up: 1.5, spin: (Math.random() - 0.5) * 4 },
      { cheap: true });
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
    // the kill counter and Marco's guilt line are the PLAYER's — deaths the
    // AI causes (traffic accidents, crossfire) don't belong on either
    if ((this.killedBy ?? 'player') === 'player') {
      game.state.stats.kills++;
      if (!this.isGoon && !this.isCop) game.voice?.say?.('kill', 0.2);
    }
    // the death scream carries — those who see it panic, others turn to look
    game.peds?.senseEvent?.(this.pos.x, this.pos.z, 'scream', this.killedBy ?? 'player');
    // an NPC murderer with witnesses gets the police called on THEM —
    // unless the deceased was a flagged criminal (a mugging victim who
    // drops their mugger acted in self-defense)
    const atk = this.lastAttacker;
    if (atk && atk !== game.player && !atk.isCop && !atk.dead && !this.criminal &&
        game.wanted?.hasWitness?.(this.pos.x, this.pos.z)) {
      game.peds?.reportNpcCrime?.(atk, 'kill', this.pos.x, this.pos.z);
    }
    // drop some cash (plus anything mugged off others); medics may respond
    game.worldlife?.dropCash?.(this.pos.x, this.pos.z,
      10 + Math.floor(Math.random() * 30) + (this.lootCash ?? 0));
    game.dispatch?.reportDeath(this);
  }

  // cheap between-ticks frame for staggered AI: keep moving on the current
  // heading and keep the rig/ragdoll animating, but skip the brain, the
  // collision query and the head-tracking — those run on tick frames
  integrate(dt) {
    if (this.dead) {
      if (this.ragdoll) this.ragdoll.update(dt);
      else this.rig.update(dt, 0);
      this.removeTimer += dt;
      return;
    }
    if (this.knockdown || this.inVehicle || this.state === 'driver') return;
    if (this.speed > 0.01) {
      this.pos.x += Math.sin(this.heading) * this.speed * dt;
      this.pos.z += Math.cos(this.heading) * this.speed * dt;
      this.pos.y = this.interiorY ?? this.city.groundHeight(this.pos.x, this.pos.z);
    }
    this.rig.update(dt, this.speed);
    this.syncRig();
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

    // promoted impostors scale in over a beat
    if (this._grow) {
      this._grow.t += dt;
      const k = Math.min(1, this._grow.t / this._grow.dur);
      this.rig.group.scale.setScalar(this._grow.target * (0.6 + 0.4 * k));
      if (k >= 1) this._grow = null;
    }

    // threat memory + criminal-flag decay
    if (this.threatT > 0) {
      this.threatT -= dt;
      if (this.threatT <= 0 || this.threat?.dead) this.threat = null;
    }
    if (this.criminal) {
      this.criminal.t -= dt;
      if (this.criminal.t <= 0) this.criminal = null;
    }

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
        this.panic(a.x, a.z, false, a.kind, a.culprit);
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
        // active crossing: queue at the curb for the walk phase, then take
        // the crosswalk band briskly, leg by leg
        if (this.crossing) {
          const c = this.crossing;
          const leg = c.steps[c.leg];
          if (!leg) { this._clearCrossing(); break; }
          if (c.phase === 'queue') {
            const dq = dist2d(this.pos.x, this.pos.z, leg.from.x, leg.from.z);
            if (dq > 0.6) {
              this.moveToward(leg.from.x, leg.from.z, this.walkSpeed, dt);
              this.rig.setAnim(this.speed > 0.2 ? 'walk' : 'idle');
            } else {
              this.speed = 0;
              this.rig.setAnim('idle');
              this.heading = angleDamp(this.heading,
                Math.atan2(leg.to.x - this.pos.x, leg.to.z - this.pos.z), 5, dt);
            }
            const ph = this.game?.traffic?.pedPhase?.(leg.roadHorizontal);
            // don't start with the flip imminent (stragglers caught mid-road)
            if (!ph || (ph.walk && ph.timeLeft > 2.5)) {
              c.phase = 'walk';
              c.counted = true;
              this.game?.traffic?.crossingEnter?.(c.node);
            }
          } else {
            const dw = dist2d(this.pos.x, this.pos.z, leg.to.x, leg.to.z);
            if (dw < 0.7) {
              this.game?.traffic?.crossingDone?.(c.node);
              c.counted = false;
              c.leg++;
              c.phase = 'queue';
              if (c.leg >= c.steps.length) this.crossing = null;
            } else {
              this.moveToward(leg.to.x, leg.to.z, this.walkSpeed * 1.4, dt);
              this.rig.setAnim(this.speed > 2.6 ? 'run' : 'walk');
            }
          }
          break;
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
          // the caller reports what they actually witnessed — AI-caused
          // mayhem sends a cop to the scene but adds no player heat
          const culprit = this._panicCulprit ?? 'player';
          game.wanted?.reportCrime?.(this.fleeFrom.x, this.fleeFrom.z, culprit);
          if (culprit === 'player') game.hud?.showToast('Someone called the police!', 3);
          this.state = 'flee';
          this.stateT = 0;
        }
        break;
      }
      case 'wounded': {
        // dragging themselves away from the shooter, bleeding
        this.woundT = (this.woundT ?? 0) + dt;
        const wdx = this.pos.x - this.fleeFrom.x, wdz = this.pos.z - this.fleeFrom.z;
        const wl = Math.hypot(wdx, wdz) || 1;
        this.moveToward(this.pos.x + (wdx / wl) * 6, this.pos.z + (wdz / wl) * 6, 0.5, dt);
        this.rig.setAnim('crawl');
        this._dripT = (this._dripT ?? 0) - dt;
        if (this._dripT <= 0) {
          this._dripT = 1.6;
          game.particles?.blood(this.pos.x, this.pos.y + 0.4, this.pos.z, 2);
          if (Math.random() < 0.4) game.gore?.blood.pool(this.pos.x, this.pos.z, this.interiorY ?? undefined);
        }
        if (this.woundT > 30) this.die(game);
        break;
      }
      case 'fight': {
        // brave ped charges their threat (any entity — player or NPC) and swings
        const tgt = (this.threat && !this.threat.dead) ? this.threat : player;
        const tgtDead = tgt === player ? player.dead : tgt.dead;
        const tp = tgt.pos;
        const d = dist2d(this.pos.x, this.pos.z, tp.x, tp.z);
        if (tgtDead || d > 30 || this.stateT > 25) { this.state = 'wander'; this.stateT = 0; break; }
        if (d > 1.4) {
          this.moveToward(tp.x, tp.z, this.runSpeed * 0.85, dt);
          this.rig.setAnim('run');
        } else {
          this.speed = 0;
          this.rig.setAnim('idle');
          this.heading = Math.atan2(tp.x - this.pos.x, tp.z - this.pos.z);
          this.attackCooldown -= dt;
          if (this.attackCooldown <= 0) {
            this.attackCooldown = 1.1;
            this.rig.startPunch();
            if (tgt === player) {
              if (!player.vehicle) {
                player.damage(6, 'ped', this.pos);
                game.audio?.punch();
              }
            } else if (!tgt.inVehicle) {
              tgt.damage?.(6, game, 'melee', null, 'ai', this);
              game.audio?.punch();
            }
          }
        }
        break;
      }
      case 'mug': {
        // thug street crime: stalk a lone mark → intimidate → take → flee.
        // Witnesses go through the normal 'ai'-culprit pipeline: films,
        // panics, police calls and a cop response — zero player heat.
        const m = this.mug;
        const v = m?.victim;
        const abortMug = () => {
          this.mug = null;
          this.state = 'wander';
          this.stateT = 0;
          this.pickWanderTarget();
        };
        if (!m || !v || v.dead) { abortMug(); break; }
        const dv = dist2d(this.pos.x, this.pos.z, v.pos.x, v.pos.z);
        if (m.phase === 'stalk') {
          m.t += dt;
          if (m.t > 6 || dv > 20 || v.panicked ||
              game.wanted?.nearestCop?.(this.pos.x, this.pos.z, 25)) { abortMug(); break; }
          if (dv > 1.3) {
            this.moveToward(v.pos.x, v.pos.z, this.walkSpeed * 1.6, dt);
            this.rig.setAnim('walk');
          } else {
            m.phase = 'intimidate';
            m.t = 0;
            m.armed = Math.random() < 0.4;
            this.criminal = this.criminal ?? { level: 1, t: 60 };
            this.bark('bark_backoff');
            if (!m.armed) this.rig.startPunch?.();   // brandished fist
            // the yelp carries: witnesses film/flee/call on the THUG
            game.peds?.senseEvent?.(this.pos.x, this.pos.z, 'scream', 'ai');
            game.peds?.spectacleAt?.(this.pos.x, this.pos.z);
            const r = reactToMugging(v);
            if (r === 'fight') {
              v.threat = this; v.threatT = 12;
              v.state = 'fight'; v.panicked = true; v.stateT = 0;
              v.bark?.('bark_fight');
            } else if (r === 'flee') {
              v.panic(this.pos.x, this.pos.z, false, null, 'ai');
              m.fled = true;
            } else {
              v.state = 'handsup'; v.mugBy = this;
              v.panicked = true; v.stateT = 0; v.speed = 0;
            }
          }
        } else if (m.phase === 'intimidate') {
          m.t += dt;
          this.speed = 0;
          this.rig.setAnim(m.armed ? 'aim' : 'idle');
          this.heading = angleDamp(this.heading,
            Math.atan2(v.pos.x - this.pos.x, v.pos.z - this.pos.z), 10, dt);
          if (v.state === 'fight') {
            // the mark swings back — brawl instead of payday
            this.threat = v; this.threatT = 12;
            this.state = 'fight'; this.stateT = 0; this.mug = null;
            break;
          }
          // mark bolted (their choice, or something else spooked them)
          if ((m.fled || v.state === 'flee') && dv > 10) { abortMug(); break; }
          if (m.t > 2.5) { m.phase = 'take'; m.t = 0; }
        } else if (m.phase === 'take') {
          m.t += dt;
          this.speed = 0;
          this.rig.setAnim('idle');
          if (m.t > 1.5) {
            this.lootCash = (this.lootCash ?? 0) + 30 + Math.floor(Math.random() * 40);
            // someone saw it (or the victim reports it): cops come for HIM
            game.peds?.reportNpcCrime?.(this, 'mug', this.pos.x, this.pos.z);
            if (v.state === 'handsup') {
              v.mugBy = null;
              v.state = 'flee'; v.panicked = true; v.stateT = 0;
              v.fleeFrom.x = this.pos.x; v.fleeFrom.z = this.pos.z;
            }
            this.mug = null;
            this.stateT = 0;
            if (Math.random() < 0.75) {
              this.state = 'flee';
              this.panicked = true;
              this.fleeFrom.x = v.pos.x; this.fleeFrom.z = v.pos.z;
            } else {
              this.state = 'wander';   // cold-blooded: strolls off
              this.pickWanderTarget();
            }
          }
        }
        break;
      }
      case 'handsup': {
        // mugging victim complying: hands up, facing the mugger
        this.speed = 0;
        this.rig.setAnim('handsup');
        if (this.mugBy && !this.mugBy.dead) {
          this.heading = angleDamp(this.heading,
            Math.atan2(this.mugBy.pos.x - this.pos.x, this.mugBy.pos.z - this.pos.z), 8, dt);
        }
        if (this.stateT > 8 || !this.mugBy || this.mugBy.dead || this.mugBy.state !== 'mug') {
          const from = this.mugBy?.pos ?? this.pos;
          this.fleeFrom.x = from.x; this.fleeFrom.z = from.z;
          this.mugBy = null;
          this.state = 'flee'; this.panicked = true; this.stateT = 0;
        }
        break;
      }
      case 'gawk': {
        // rubbernecking: stand at a distance and watch the drama
        this.speed = 0;
        this.rig.setAnim('idle');
        if (this.gawkPt) {
          this.heading = angleDamp(this.heading,
            Math.atan2(this.gawkPt.x - this.pos.x, this.gawkPt.z - this.pos.z), 5, dt);
          if (dist2d(this.pos.x, this.pos.z, this.gawkPt.x, this.gawkPt.z) < 8) {
            // too close for comfort now
            this.fleeFrom.x = this.gawkPt.x; this.fleeFrom.z = this.gawkPt.z;
            this.gawkPt = null;
            this.state = 'flee'; this.panicked = true; this.stateT = 0;
            break;
          }
        }
        if (this.stateT > (this.gawkDur ?? 10)) {
          this.gawkPt = null;
          this.state = 'wander';
          this.stateT = 0;
          this.pickWanderTarget();
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

  // is a probe point ~a body-width blocked by a wall, prop or vehicle?
  _probeBlocked(ang, dist) {
    const px = this.pos.x + Math.sin(ang) * dist;
    const pz = this.pos.z + Math.cos(ang) * dist;
    for (const b of this.city.queryColliders(px, pz, RADIUS + 0.05)) {
      if (b.gone) continue;
      if (circleVsAabb(px, pz, RADIUS + 0.05, b.minX, b.minZ, b.maxX, b.maxZ)) return true;
    }
    const vehicles = this.game?.vehicles?.vehicles;
    if (vehicles) {
      for (const v of vehicles) {
        // only path around stationary/slow traffic — nobody sidesteps a
        // speeding car; fast movers are the run-over system's business
        if (Math.hypot(v.vel.x, v.vel.y) > 6) continue;
        if (distSq2d(px, pz, v.pos.x, v.pos.z) > (v.boundR + 0.6) * (v.boundR + 0.6)) continue;
        _probeObb.x = v.pos.x; _probeObb.z = v.pos.z;
        _probeObb.hw = v.hw; _probeObb.hl = v.hl; _probeObb.heading = v.heading;
        if (circleVsObb(px, pz, RADIUS + 0.05, _probeObb)) return true;
      }
    }
    return false;
  }

  moveToward(tx, tz, speed, dt) {
    const dx = tx - this.pos.x, dz = tz - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.2) { this.speed = 0; return; }
    let want = Math.atan2(dx, dz);
    // look-ahead avoidance: probe a step ahead a few times a second and
    // steer around lamp posts, hydrants, walls and parked cars instead of
    // walking face-first into them and sliding
    this._avoidT = (this._avoidT ?? 0) - dt;
    if (this._avoidT <= 0) {
      this._avoidT = 0.12 + Math.random() * 0.08;
      this._avoid = 0;
      if (this._probeBlocked(want, 1.3)) {
        const s = Math.random() < 0.5 ? 1 : -1;   // vary preferred side
        if (!this._probeBlocked(want - 0.75 * s, 1.2)) this._avoid = -0.75 * s;
        else if (!this._probeBlocked(want + 0.75 * s, 1.2)) this._avoid = 0.75 * s;
        else this._avoid = 1.5 * s;               // boxed in: turn hard
      }
    }
    want += this._avoid ?? 0;
    // a drunk weaves — a slow sine wobble on the heading and a lurch now and then
    if (this.drunk) {
      want += Math.sin(this.stateT * 1.7 + this.id) * 0.55;
      speed *= 0.7;
    }
    this.heading = angleDamp(this.heading, want, 8, dt);
    this.speed = speed;
    const mx = Math.sin(this.heading) * speed * dt;
    const mz = Math.cos(this.heading) * speed * dt;
    this.pos.x += mx;
    this.pos.z += mz;
    // static collision: slide along buildings
    const cols = this.city.queryColliders(this.pos.x, this.pos.z, RADIUS + 0.6);
    for (const b of cols) {
      if (b.baseY != null && (this.pos.y > b.baseY + b.h - 0.2 || this.pos.y + 1.7 < b.baseY)) continue;
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
    this.ragdoll?.dispose?.();
    this.knockRag?.dispose?.();
    this.rig.dispose();
  }
}

export { randomLook, RADIUS as PED_RADIUS };
