// Mission engine: contact markers around the city start scripted missions
// built from reusable step primitives (goto / drive / destroy / eliminate /
// tail / chase / defend / escape / timer). Dialogue plays as subtitles.

import * as THREE from 'three';
import { MISSIONS, CONTACTS } from './missiondefs.js';
import { dist2d, clamp } from '../core/mathutil.js';

export class MissionSystem {
  constructor(game) {
    this.game = game;
    this.passed = new Set();
    this.active = null;          // { def, stepIndex, ctx, timer }
    this.dialogueQueue = [];
    this.dialogueT = 0;
    this.markerMeshes = new Map();   // contactId → mesh
    this.objectiveMarker = this.buildMarker(0xe8c84a);
    this.objectiveMarker.visible = false;
    game.scene.add(this.objectiveMarker);
    this.cooldownT = 0;

    game.blipProviders.push((blips) => this.provideBlips(blips));
    this.buildContactMarkers();
  }

  reset() {
    this.abort(true);
    this.passed.clear();
    this.refreshContactMarkers();
  }

  // ---------------- contact markers ----------------
  buildMarker(color) {
    const geo = new THREE.CylinderGeometry(1.6, 1.6, 2.6, 20, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 5;
    return m;
  }

  contactPos(c) {
    const poi = this.game.city.pois[c.poi];
    return poi ? { x: poi.x, z: poi.z } : { x: 0, z: 0 };
  }

  buildContactMarkers() {
    for (const c of CONTACTS) {
      const m = this.buildMarker(c.color);
      const p = this.contactPos(c);
      m.position.set(p.x, this.game.city.groundHeight(p.x, p.z) + 1.3, p.z);
      this.game.scene.add(m);
      this.markerMeshes.set(c.id, m);
    }
    this.refreshContactMarkers();
  }

  contactAvailable(c) {
    if (this.active) return false;
    const next = this.nextMissionFor(c.id);
    return !!next;
  }

  // hostiles from the running mission — combat/vehicles/peds use this for hit tests
  activeGoons() {
    return this.active ? this.active.ctx.goons : [];
  }

  nextMissionFor(contactId) {
    return MISSIONS.find((m) => m.contact === contactId && !this.passed.has(m.id) &&
      (m.requires ? m.requires.every((r) => this.passed.has(r)) : true));
  }

  refreshContactMarkers() {
    for (const c of CONTACTS) {
      const m = this.markerMeshes.get(c.id);
      if (m) m.visible = this.contactAvailable(c);
    }
  }

  provideBlips(blips) {
    if (this.active) {
      const t = this.currentStepTarget();
      if (t) blips.push({ x: t.x, z: t.z, color: '#e8c84a' });
      for (const extra of this.active.ctx.extraBlips || []) {
        if (extra.alive()) blips.push({ x: extra.x(), z: extra.z(), color: extra.color });
      }
    } else {
      for (const c of CONTACTS) {
        if (this.contactAvailable(c)) {
          const p = this.contactPos(c);
          blips.push({ x: p.x, z: p.z, color: c.blip, letter: c.letter });
        }
      }
    }
  }

  currentStepTarget() {
    const a = this.active;
    if (!a) return null;
    const step = a.def.steps[a.stepIndex];
    if (!step) return null;
    if (step.blipAt) return step.blipAt(a.ctx);
    if (step.x !== undefined) return { x: step.x, z: step.z };
    return null;
  }

  // ---------------- dialogue ----------------
  queueDialogue(lines) {
    this.dialogueQueue.push(...lines);
  }

  updateDialogue(dt) {
    if (this.dialogueT > 0) { this.dialogueT -= dt; return; }
    const line = this.dialogueQueue.shift();
    if (line) {
      this.game.hud.say(line[0], line[1], 3.6);
      this.dialogueT = 3.2;
    }
  }

  // ---------------- lifecycle ----------------
  start(def) {
    const game = this.game;
    this.active = {
      def,
      stepIndex: -1,
      timer: null,
      ctx: {
        game,
        vehicles: [], goons: [], extraBlips: [],
        data: {},
      },
    };
    game.hud.showToast(def.title.toUpperCase(), 4);
    if (def.intro) this.queueDialogue(def.intro);
    def.setup?.(this.active.ctx);
    this.refreshContactMarkers();
    this.advance();
  }

  advance() {
    const a = this.active;
    if (!a) return;
    a.stepIndex++;
    const step = a.def.steps[a.stepIndex];
    if (!step) { this.complete(); return; }
    step.enter?.(a.ctx);
    if (step.say) this.queueDialogue(step.say);
    this.game.hud.setObjective(step.text ? step.text(a.ctx) : '');
    a.timer = step.timeLimit ?? null;
  }

  complete() {
    const a = this.active;
    const game = this.game;
    this.passed.add(a.def.id);
    game.state.stats.missionsPassed++;
    game.addMoney(a.def.reward);
    game.hud.showCenter('MISSION PASSED', 'passed', `+$${a.def.reward}`, 4.5);
    game.audio?.missionPassed();
    game.hud.setObjective('');
    game.hud.setTimer(null);
    this.dialogueQueue.length = 0;      // drop unread mid-mission lines
    if (a.def.outro) this.queueDialogue(a.def.outro);
    a.def.cleanup?.(a.ctx);
    this.cleanupCtx(a.ctx);
    this.active = null;
    this.cooldownT = 2;
    this.refreshContactMarkers();
    game.save?.autoSave?.();
    if (this.passed.size === MISSIONS.length) {
      setTimeout(() => {
        game.hud.showCenter('BAYVALE IS YOURS', 'passed', 'Story complete — the city keeps moving. 100% awaits.', 8);
      }, 6000);
    }
  }

  fail(reason = 'You blew it.', quiet = false) {
    const a = this.active;
    if (!a) return;
    const game = this.game;
    // quiet: the WASTED/BUSTED banner owns the screen — a toast arrives after respawn
    if (!quiet) {
      game.hud.showCenter('MISSION FAILED', 'wasted', reason, 4.5);
      game.audio?.missionFailed();
    }
    game.hud.setObjective('');
    game.hud.setTimer(null);
    this.dialogueQueue.length = 0;
    this.dialogueT = 0;
    game.hud.clearSubtitle?.();
    a.def.cleanup?.(a.ctx);
    this.cleanupCtx(a.ctx);
    this.active = null;
    this.cooldownT = 2;
    this.refreshContactMarkers();
  }

  abort(silent = false) {
    if (!this.active) return;
    if (silent) {
      this.active.def.cleanup?.(this.active.ctx);
      this.cleanupCtx(this.active.ctx);
      this.active = null;
      this.game.hud?.setObjective('');
      this.game.hud?.setTimer(null);
    } else this.fail('Mission abandoned.');
  }

  cleanupCtx(ctx) {
    for (const v of ctx.vehicles) {
      if (!v.dead && v !== this.game.player.vehicle) this.game.vehicles.remove(v);
      else v.missionKeep = false;
    }
    // live goons vanish with the mission; dead ones linger briefly as bodies
    const bodies = [];
    for (const g of ctx.goons) {
      if (!g.dead) g.dispose();
      else bodies.push(g);
    }
    if (bodies.length) setTimeout(() => { for (const g of bodies) g.dispose?.(); }, 15000);
    ctx.goons.length = 0;
    ctx.extraBlips.length = 0;
    this.objectiveMarker.visible = false;
  }

  onPlayerDown(kind) {
    if (this.active) this.fail(kind === 'wasted' ? 'You got wasted.' : 'You got busted.', true);
  }

  // ---------------- per-frame ----------------
  update(dt) {
    const game = this.game;
    this.updateDialogue(dt);
    this.cooldownT -= dt;

    // contact marker pulse + mission start trigger
    const t = game.time;
    for (const c of CONTACTS) {
      const m = this.markerMeshes.get(c.id);
      if (!m || !m.visible) continue;
      m.material.opacity = 0.3 + Math.sin(t * 3) * 0.12;
      m.rotation.y = t * 0.8;
      if (this.cooldownT <= 0 && !game.player.vehicle && !game.player.dead) {
        const p = this.contactPos(c);
        if (dist2d(game.player.pos.x, game.player.pos.z, p.x, p.z) < 1.8) {
          const def = this.nextMissionFor(c.id);
          if (def) this.start(def);
        }
      }
    }

    const a = this.active;
    if (!a) return;
    const step = a.def.steps[a.stepIndex];
    if (!step) return;

    // objective marker placement
    const target = this.currentStepTarget();
    if (target && step.marker !== false) {
      this.objectiveMarker.visible = true;
      this.objectiveMarker.position.set(target.x, game.city.groundHeight(target.x, target.z) + 1.3, target.z);
      this.objectiveMarker.material.opacity = 0.3 + Math.sin(t * 3) * 0.12;
    } else this.objectiveMarker.visible = false;

    // goons tick
    for (const g of a.ctx.goons) g.update(dt, game);

    // timer
    if (a.timer != null) {
      a.timer -= dt;
      game.hud.setTimer(a.timer, a.timer < 12);
      if (a.timer <= 0) { this.fail('Out of time.'); return; }
    } else game.hud.setTimer(null);

    // step logic
    const res = step.update?.(a.ctx, dt);
    if (res === 'done') {
      game.audio?.pickup();
      this.advance();
    } else if (typeof res === 'string' && res.startsWith('fail')) {
      this.fail(res.slice(5) || 'You blew it.');
    }
  }

  // ---------------- debug ----------------
  debugStart(id) {
    const def = MISSIONS.find((m) => m.id === id);
    if (!def || this.active) return false;
    this.start(def);
    return true;
  }
  debugState() {
    return {
      active: this.active ? { id: this.active.def.id, step: this.active.stepIndex } : null,
      passed: [...this.passed],
    };
  }
  debugCompleteStep() {
    if (this.active) this.advance();
  }
}
