// Emergency dispatch: street fires summon a fire engine whose crew hoses
// them down; deaths summon an ambulance whose medics kneel over the victim
// (and sometimes bring them back). One unit of each type at a time — the
// city has drama pacing.

import { Ped } from '../entities/ped.js';
import { dist2d, clamp, wrapAngle } from '../core/mathutil.js';

const FF_LOOK = { uniform: 'fire', hat: 'helmet', accent: 0xb03a2e };
const MEDIC_LOOK = { uniform: 'medic', hat: 'cap', accent: 0xe8e8ea };

class CrewMember extends Ped {
  constructor(city, scene, look) {
    super(city, scene, look, { health: 80 });
    this.isCrew = true;
    this.job = 'goto';       // goto | work | leave
    this.workT = 0;
  }
  // crew keep working through gunfire — they've seen worse
  panic() {}
}

export class Dispatch {
  constructor(game) {
    this.game = game;
    this.fires = [];          // { x, z, t, wreck, out }
    this.fireUnit = null;     // { vehicle, crew: [], state, target }
    this.medicUnit = null;
    this.deathReports = [];   // { x, z, ped, t }
    this.fxT = 0;
  }

  // opts (molotov fire patches): radius widens the burn/damage circle,
  // dur caps the burn time, dmgPeds burns NPCs too (with the culprit
  // carried into their deaths), strength scales the flame FX
  reportFire(x, z, wreck = null, opts = null) {
    if (this.fires.some((f) => dist2d(f.x, f.z, x, z) < 8)) return;
    this.fires.push({
      x, z, t: 0, wreck, out: false,
      radius: opts?.radius ?? 1.6,
      dur: opts?.dur ?? 100,
      dmgPeds: opts?.dmgPeds ?? false,
      culprit: opts?.culprit ?? 'ai',
      strength: opts?.strength ?? 1,
    });
  }

  reportDeath(ped) {
    if (!ped || ped.isCrew) return;
    if (this.deathReports.some((r) => r.ped === ped)) return;
    this.deathReports.push({ x: ped.pos.x, z: ped.pos.z, ped, t: 0 });
  }

  update(dt) {
    const game = this.game;
    this.fxT -= dt;

    // fires burn + hurt
    for (const f of [...this.fires]) {
      f.t += dt;
      if (f.out || f.t > (f.dur ?? 100) || (f.wreck && !f.wreck.burning && f.t > 5)) {
        this.fires.splice(this.fires.indexOf(f), 1);
        continue;
      }
      const rad = f.radius ?? 1.6;
      if (this.fxT <= 0) {
        game.particles?.fire(f.x, game.city.groundHeight(f.x, f.z) + 0.4, f.z,
          Math.round(2 * (f.strength ?? 1)));
        if (rad > 2) {
          // wide patches (molotov) burn across their whole footprint
          const a = Math.random() * Math.PI * 2, r = Math.random() * rad * 0.8;
          const fx = f.x + Math.cos(a) * r, fz = f.z + Math.sin(a) * r;
          game.particles?.fire(fx, game.city.groundHeight(fx, fz) + 0.3, fz, 1);
        }
      }
      const p = game.player.pos;
      if (!game.player.vehicle && dist2d(p.x, p.z, f.x, f.z) < rad) {
        game.player.damage(14 * dt, 'fire');
      }
      // molotov patches cook anyone standing in them
      if (f.dmgPeds && game.peds) {
        for (const ped of game.peds.nearPeds(f.x, f.z, rad)) {
          if (!ped.dead) ped.damage(11 * dt, game, 'fire', null, f.culprit);
        }
      }
    }
    if (this.fxT <= 0) this.fxT = 0.1;

    // prune stale death reports
    for (const r of [...this.deathReports]) {
      r.t += dt;
      if (r.t > 50 || (!r.ped.dead && !r.ped.wounded)) this.deathReports.splice(this.deathReports.indexOf(r), 1);
    }

    this.runFireUnit(dt);
    this.runMedicUnit(dt);
  }

  // everyone currently on foot for a unit — run-over / explosion targets
  crewPeds() {
    const out = [];
    for (const u of [this.fireUnit, this.medicUnit]) {
      if (u) for (const c of u.crew) if (!c.dead) out.push(c);
    }
    return out;
  }

  // ---------------- shared unit helpers ----------------
  spawnUnit(type, near, crewCount, look) {
    const game = this.game;
    const v = game.vehicles.spawnOnRoadNear(near.x + 120, near.z + 120, type);
    if (!v) return null;
    v.sirenOn = true;
    v.missionKeep = false;
    v.emergency = true;
    game.audio?.startSiren(v.id, () => ({ x: v.pos.x, z: v.pos.z }));
    return { vehicle: v, crew: [], state: 'drive', crewCount, look, workT: 0 };
  }

  driveTo(unit, tx, tz, dt) {
    const v = unit.vehicle;
    const d = dist2d(v.pos.x, v.pos.z, tx, tz);
    if (d < 15 || (d < 26 && Math.abs(v.speed) < 0.6)) {
      v.updatePhysics(dt, { throttle: v.speed > 0.5 ? -1 : 0, steer: 0, handbrake: true });
      return true;
    }
    // guarantee arrival: if the direct route wedged the truck somewhere,
    // it "finds a way through" — snap to the nearest road point to the scene
    unit.driveT = (unit.driveT ?? 0) + dt;
    if (unit.driveT > 20) {
      const ep = this.game.city.nearestEdgePoint(tx, tz);
      if (ep) {
        v.pos.set(ep.x, this.game.city.groundHeight(ep.x, ep.z), ep.z);
        v.vel.set(0, 0);
        v.speed = 0;
        v.syncMesh(0);
      }
      unit.driveT = 0;
      return true;
    }
    const want = Math.atan2(tx - v.pos.x, tz - v.pos.z);
    const err = wrapAngle(want - v.heading);
    let throttle = clamp(1 - Math.abs(err), 0.25, 0.85);
    // reverse out if stuck against a wall
    unit.stuckT = Math.abs(v.speed) < 0.4 ? (unit.stuckT ?? 0) + dt : 0;
    if (unit.stuckT > 1.8) unit.reverseT = 0.8;
    if (unit.reverseT > 0) { unit.reverseT -= dt; throttle = -1; }
    v.updatePhysics(dt, { throttle, steer: clamp(err * 2, -1, 1) * (throttle < 0 ? -1 : 1), handbrake: false });
    return false;
  }

  disbandUnit(unit) {
    const game = this.game;
    game.audio?.stopSiren(unit.vehicle.id);
    if (!unit.vehicle.dead) game.vehicles.remove(unit.vehicle);
    for (const c of unit.crew) if (!c.dead) c.dispose();
  }

  // ---------------- fire engine ----------------
  runFireUnit(dt) {
    const game = this.game;
    const fire = this.fires.find((f) => !f.out);
    if (!this.fireUnit) {
      if (!fire || fire.t < 6) return;      // give the fire a head start
      this.fireUnit = this.spawnUnit('firetruck', fire, 2, FF_LOOK);
      if (this.fireUnit) this.fireUnit.target = fire;
      return;
    }

    const unit = this.fireUnit;
    const v = unit.vehicle;
    if (v.dead) { this.disbandUnit(unit); this.fireUnit = null; return; }
    const target = unit.target;

    if (unit.state === 'drive') {
      v.flashSiren(game.time);
      if (!this.fires.includes(target) || target.out) { unit.state = 'leave'; return; }
      if (this.driveTo(unit, target.x, target.z, dt)) {
        unit.state = 'work';
        for (let k = 0; k < unit.crewCount; k++) {
          const ff = new CrewMember(game.city, game.scene, unit.look);
          const door = v.seatWorldPos();
          ff.place(door.x + k, door.z + k * 0.6);
          unit.crew.push(ff);
        }
      }
    } else if (unit.state === 'work') {
      let allDone = true;
      for (const ff of unit.crew) {
        if (ff.dead) continue;
        const d = dist2d(ff.pos.x, ff.pos.z, target.x, target.z);
        if (ff.job === 'goto') {
          if (d > 5) {
            ff.moveToward(target.x, target.z, 2.6, dt);
            ff.rig.setAnim('run');
            allDone = false;
            // fires against walls / in courtyards: if the approach stalls
            // (no progress for a while) within hose range, spray from here —
            // crews used to jog against a wall forever and never extinguish
            if (d < 14) {
              if (ff._lastD != null && ff._lastD - d < 0.05) ff._stallT = (ff._stallT ?? 0) + dt;
              else ff._stallT = 0;
              ff._lastD = d;
              if (ff._stallT > 2.5) { ff.job = 'work'; ff.workT = 0; }
            }
          } else { ff.job = 'work'; ff.workT = 0; }
        } else if (ff.job === 'work') {
          ff.speed = 0;
          ff.heading = Math.atan2(target.x - ff.pos.x, target.z - ff.pos.z);
          ff.rig.setAnim('hose');
          ff.workT += dt;
          allDone = false;
          // water arc
          const fx = Math.sin(ff.heading), fz = Math.cos(ff.heading);
          game.particles?.waterJet?.(ff.pos.x + fx * 0.6, ff.pos.y + 1.2, ff.pos.z + fz * 0.6, fx, fz);
          if (ff.workT > 7) {
            target.out = true;
            if (target.wreck) target.wreck.burning = false;
            ff.job = 'leave';
          }
        }
        ff.rig.update(dt, ff.speed);
        ff.syncRig();
      }
      if (target.out || allDone) unit.state = 'return';
    } else if (unit.state === 'return' || unit.state === 'leave') {
      let boarded = true;
      for (const ff of unit.crew) {
        if (ff.dead) continue;
        const d = dist2d(ff.pos.x, ff.pos.z, v.pos.x, v.pos.z);
        if (d > 3.2) {
          ff.moveToward(v.pos.x, v.pos.z, 2.4, dt);
          ff.rig.setAnim('walk');
          ff.rig.update(dt, ff.speed);
          ff.syncRig();
          boarded = false;
        } else ff.rig.group.visible = false;
      }
      if (boarded) { this.disbandUnit(unit); this.fireUnit = null; }
    }
  }

  // ---------------- ambulance ----------------
  runMedicUnit(dt) {
    const game = this.game;
    const report = this.deathReports.find((r) => r.ped.dead && r.t > 4);
    if (!this.medicUnit) {
      if (!report) return;
      this.medicUnit = this.spawnUnit('ambulance', report, 2, MEDIC_LOOK);
      if (this.medicUnit) this.medicUnit.target = report;
      return;
    }

    const unit = this.medicUnit;
    const v = unit.vehicle;
    if (v.dead) { this.disbandUnit(unit); this.medicUnit = null; return; }
    const target = unit.target;

    if (unit.state === 'drive') {
      v.flashSiren(game.time);
      if (!target.ped.dead || !this.deathReports.includes(target)) { unit.state = 'leave'; }
      else if (this.driveTo(unit, target.x, target.z, dt)) {
        unit.state = 'work';
        for (let k = 0; k < unit.crewCount; k++) {
          const m = new CrewMember(game.city, game.scene, unit.look);
          const door = v.seatWorldPos();
          m.place(door.x + k, door.z + k * 0.6);
          unit.crew.push(m);
        }
      }
    } else if (unit.state === 'work') {
      unit.workT += dt;
      let near = true;
      for (const m of unit.crew) {
        if (m.dead) continue;
        const d = dist2d(m.pos.x, m.pos.z, target.x, target.z);
        if (d > 1.6) {
          m.moveToward(target.x, target.z, 2.6, dt);
          m.rig.setAnim('run');
          near = false;
          unit.workT = 0;
        } else {
          m.speed = 0;
          m.rig.setAnim('kneel');
        }
        m.rig.update(dt, m.speed);
        m.syncRig();
      }
      if (near && unit.workT > 5.5) {
        // the wounded are always stabilized — back on their feet, shaken
        if (target.ped.wounded && !target.ped.dead) {
          const p = target.ped;
          p.wounded = false;
          p.health = 30;
          p.state = 'flee';
          p.panicked = true;
          p.stateT = 0;
          game.hud?.showToast('The medics patched someone up.', 3);
          this.deathReports.splice(this.deathReports.indexOf(target), 1);
          unit.state = 'return';
        } else
        // sometimes they walk away from the light
        if (Math.random() < 0.35 && target.ped.rig && !target.ped.isCop) {
          const p = target.ped;
          p.dead = false;
          p.health = 25;
          p.rig.dead = false;
          p.rig.deadT = 0;
          p.rig.group.rotation.x = 0;
          p.state = 'flee';
          p.panicked = true;
          p.stateT = 0;
          game.hud?.showToast('The medics brought someone back.', 3);
        } else {
          // covered and carried off
          target.ped.removeTimer = 999;
        }
        this.deathReports.splice(this.deathReports.indexOf(target), 1);
        unit.state = 'return';
      }
    } else if (unit.state === 'return' || unit.state === 'leave') {
      let boarded = true;
      for (const m of unit.crew) {
        if (m.dead) continue;
        const d = dist2d(m.pos.x, m.pos.z, v.pos.x, v.pos.z);
        if (d > 3.2) {
          m.moveToward(v.pos.x, v.pos.z, 2.4, dt);
          m.rig.setAnim('walk');
          m.rig.update(dt, m.speed);
          m.syncRig();
          boarded = false;
        } else m.rig.group.visible = false;
      }
      if (boarded) { this.disbandUnit(unit); this.medicUnit = null; }
    }
  }
}
