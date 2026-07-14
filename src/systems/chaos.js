// Ambient-events director: keeps the city feeling volatile without random
// noise. Runs on a slow tick (like the mugging director), stages every
// event where the player can witness it, rate-limits to one big + one
// small at a time, and drives everything through existing systems with an
// 'ai' culprit so nothing ever touches the player's wanted level.

import { dist2d } from '../core/mathutil.js';

// per-district danger flavour for the chaos knob
const DANGER = {
  docks: 0.25, oldtown: 0.25, heights: 0.2, midtown: 0.1, crown: 0.1,
  beach: 0.05, suburbs: 0, park: 0, farm: -0.1,
};

export class ChaosDirector {
  constructor(game) {
    this.game = game;
    this.events = [];        // running: { key, size, ttl, update(dt), cleanup() }
    this.nextOk = {};        // per-key cooldown gate (game.time)
    this.tickT = 4;
    this.chaos = 0.3;
  }

  // catalogue: weight is a base rate; some events prefer certain districts
  get CATALOG() {
    return {
      npcChase:      { size: 'big',   cd: 150, w: 1.0 },
      gangBrawl:     { size: 'big',   cd: 120, w: 0.9 },
      runawayDriver: { size: 'small', cd: 80,  w: 1.2 },
      streetRace:    { size: 'small', cd: 100, w: 0.9 },
      fireBreak:     { size: 'small', cd: 200, w: 0.6 },
      drunk:         { size: 'small', cd: 60,  w: 1.0, night: true },
      performer:     { size: 'small', cd: 90,  w: 0.8 },
    };
  }

  update(dt) {
    const game = this.game;
    if (game.state.mode !== 'play') return;

    // run + prune live events
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      ev.ttl -= dt;
      let done = ev.ttl <= 0;
      if (!done && ev.update) done = ev.update(dt) === true;
      if (done) { ev.cleanup?.(); this.events.splice(i, 1); }
    }

    this.tickT -= dt;
    if (this.tickT > 0) return;
    this.tickT = 4;

    // hard gates: don't pile chaos onto an active police situation, an
    // indoor player, or a timed mission
    if ((game.wanted?.state.stars ?? 0) >= 2) return;
    if (game.interiors?.playerInside) return;
    if (game.missions?.active?.timed) return;

    // chaos knob
    const p = game.player.pos;
    const district = game.city.districtAt(p.x, p.z);
    const hour = (game.dayNight?.minutes ?? 720) / 60;
    const night = hour >= 22 || hour < 5;
    this.chaos = 0.25 + (DANGER[district] ?? 0) + (night ? 0.25 : 0) +
      Math.min(0.15, game.time / 1500 * 0.15);

    // slot caps: one big + one small concurrently
    const bigLive = this.events.some((e) => e.size === 'big');
    const smallLive = this.events.some((e) => e.size === 'small');

    for (const [key, def] of Object.entries(this.CATALOG)) {
      if (def.size === 'big' && bigLive) continue;
      if (def.size === 'small' && smallLive) continue;
      if (game.time < (this.nextOk[key] ?? 0)) continue;
      if (def.night && !night) continue;
      if (Math.random() > this.chaos * 0.5 * def.w) continue;
      const ev = this['spawn_' + key]?.();
      if (ev) {
        this.events.push(ev);
        this.nextOk[key] = game.time + def.cd + Math.random() * def.cd * 0.5;
        break;   // at most one new event per tick
      }
    }
  }

  // a staged actor location 25-90m from the player, on a road, outdoors
  _stageVehicle() {
    const game = this.game;
    for (const v of game.traffic?.cars ?? []) {
      if (!v.driverPed || v.vehicle.dead) continue;
      const d = dist2d(v.vehicle.pos.x, v.vehicle.pos.z, game.player.pos.x, game.player.pos.z);
      if (d >= 25 && d <= 90) return v;
    }
    return null;
  }

  // ---- events -----------------------------------------------------

  // a fugitive floors it and the police give chase (NPC-vs-NPC, no heat)
  spawn_npcChase() {
    const game = this.game;
    const car = this._stageVehicle();
    if (!car) return null;
    const drv = car.driverPed;
    const v = car.vehicle;
    drv.criminal = { level: 1, t: 120 };
    car.panicT = 999;                 // runs signals + floors it (traffic drive())
    const cr = game.wanted?.spawnNpcCruiser?.(v);
    if (!cr) { drv.criminal = null; car.panicT = 0; return null; }
    game.hud?.showToast?.('Police chase!', 2.2);
    return {
      key: 'npcChase', size: 'big', ttl: 75, cr,
      update() {
        if (v.dead || v.flipped || cr.resolved || drv.dead ||
            dist2d(v.pos.x, v.pos.z, game.player.pos.x, game.player.pos.z) > 160) return true;
        return false;
      },
      cleanup() {
        cr.resolved = true;           // wanted loop drops the cruiser
        if (!v.dead) car.panicT = 0;
      },
    };
  }

  // one reckless driver tears through traffic, honking
  spawn_runawayDriver() {
    const game = this.game;
    const car = this._stageVehicle();
    if (!car) return null;
    car.panicT = 14 + Math.random() * 4;
    return {
      key: 'runawayDriver', size: 'small', ttl: 12,
      update() {
        if (car.vehicle.dead) return true;
        if (game.time - (car._chaosHonk ?? 0) > 1.5) {
          car._chaosHonk = game.time;
          game.audio?.horn?.(car.vehicle.pos.x, car.vehicle.pos.z);
        }
        return false;
      },
      cleanup() {},
    };
  }

  // a stumbling drunk weaves down the sidewalk
  spawn_drunk() {
    const game = this.game;
    const p = game.player.pos;
    let ped = null;
    for (const c of game.peds?.peds ?? []) {
      if (c.dead || c.drunk || c.loiter || c.state !== 'wander') continue;
      if (c.faction !== 'civ') continue;
      const d = dist2d(c.pos.x, c.pos.z, p.x, p.z);
      if (d >= 25 && d <= 70) { ped = c; break; }
    }
    if (!ped) return null;
    ped.drunk = true;
    return {
      key: 'drunk', size: 'small', ttl: 40, ped, stumbleT: 3,
      update(dt) {
        if (ped.dead) return true;
        this.stumbleT -= dt;
        if (this.stumbleT <= 0) {
          this.stumbleT = 4 + Math.random() * 3;
          ped.rig.flinch?.(Math.random() < 0.5 ? 1 : -1);
          if (Math.random() < 0.4) ped.bark?.('bark_crazy');
        }
        return false;
      },
      cleanup() { if (!ped.dead) ped.drunk = false; },
    };
  }

  // two thugs square off — the fight is witnessed and the cops respond
  spawn_gangBrawl() {
    const game = this.game;
    const p = game.player.pos;
    // a spot on the sidewalk 30-70m out
    const a = Math.random() * Math.PI * 2;
    const d = 32 + Math.random() * 35;
    const ep = game.city.nearestEdgePoint?.(p.x + Math.cos(a) * d, p.z + Math.sin(a) * d);
    if (!ep) return null;
    const ax = ep.x, az = ep.z;
    const t1 = game.peds?.spawnPed?.('thug', ax, az);
    const t2 = game.peds?.spawnPed?.('thug', ax + 1.5, az + 1.0);
    if (!t1 || !t2) return null;
    // mutual threat → the existing fight state + alertAllies escalation
    t1.threat = t2; t1.threatT = 30; t1.state = 'fight'; t1.panicked = true;
    t2.threat = t1; t2.threatT = 30; t2.state = 'fight'; t2.panicked = true;
    t1.bark?.('bark_fight');
    game.peds?.senseEvent?.(ax, az, 'scream', 'ai');
    game.peds?.spectacleAt?.(ax, az, 22);
    return {
      key: 'gangBrawl', size: 'big', ttl: 40, t1, t2,
      update() {
        if ((t1.dead || t1.state !== 'fight') && (t2.dead || t2.state !== 'fight')) return true;
        return false;
      },
      cleanup() {},
    };
  }

  // two cars tear down an artery running signals
  spawn_streetRace() {
    const game = this.game;
    const p = game.player.pos;
    const racers = [];
    for (const c of game.traffic?.cars ?? []) {
      if (c.vehicle.dead || !c.driverPed) continue;
      const d = dist2d(c.vehicle.pos.x, c.vehicle.pos.z, p.x, p.z);
      if (d >= 25 && d <= 90) { racers.push(c); if (racers.length >= 2) break; }
    }
    if (racers.length < 2) return null;
    for (const c of racers) { c.panicT = 999; c._racer = true; }
    game.hud?.showToast?.('Street race!', 2);
    return {
      key: 'streetRace', size: 'small', ttl: 50, racers,
      update() {
        if (racers.every((c) => c.vehicle.dead)) return true;
        for (const c of racers) {
          if (!c.vehicle.dead && game.time - (c._raceHonk ?? 0) > 2.2) {
            c._raceHonk = game.time;
            game.audio?.horn?.(c.vehicle.pos.x, c.vehicle.pos.z);
          }
        }
        return false;
      },
      cleanup() { for (const c of racers) { if (!c.vehicle.dead) { c.panicT = 0; c._racer = false; } } },
    };
  }

  // a street fire breaks out — the fire brigade responds (existing theater)
  spawn_fireBreak() {
    const game = this.game;
    const p = game.player.pos;
    const a = Math.random() * Math.PI * 2;
    const d = 30 + Math.random() * 40;
    const ep = game.city.nearestEdgePoint?.(p.x + Math.cos(a) * d, p.z + Math.sin(a) * d);
    if (!ep) return null;
    // offset onto the curb so it's not in the middle of the road
    const fx = ep.x + Math.cos(a) * 2.5, fz = ep.z + Math.sin(a) * 2.5;
    game.dispatch?.reportFire?.(fx, fz, null, { radius: 2.0, dur: 30, dmgPeds: true, culprit: 'ai', strength: 1.4 });
    game.peds?.spectacleAt?.(fx, fz, 20);
    return { key: 'fireBreak', size: 'small', ttl: 32, update() { return false; }, cleanup() {} };
  }

  // a street performer draws a small gawking crowd
  spawn_performer() {
    const game = this.game;
    const p = game.player.pos;
    let ped = null;
    for (const c of game.peds?.peds ?? []) {
      if (c.dead || c.drunk || c.performer || c.state !== 'wander' || c.faction !== 'civ') continue;
      const d = dist2d(c.pos.x, c.pos.z, p.x, p.z);
      if (d >= 25 && d <= 60) { ped = c; break; }
    }
    if (!ped) return null;
    ped.performer = true;
    ped.loiter = true;
    ped.homeX = ped.pos.x; ped.homeZ = ped.pos.z;
    ped.state = 'idle';
    return {
      key: 'performer', size: 'small', ttl: 45, ped, drawT: 0,
      update(dt) {
        if (ped.dead) return true;
        this.drawT -= dt;
        if (this.drawT <= 0) {
          this.drawT = 6;
          game.peds?.spectacleAt?.(ped.pos.x, ped.pos.z, 14);
        }
        return false;
      },
      cleanup() {
        if (!ped.dead) { ped.performer = false; ped.loiter = false; ped.state = 'wander'; }
      },
    };
  }
}
