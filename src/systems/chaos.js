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
      runawayDriver: { size: 'small', cd: 80,  w: 1.2 },
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
