// Combat: weapon inventory, switching, aiming, hitscan firing with spread,
// melee, reload, drive-by shooting, and hit resolution against
// peds / cops / vehicles / world geometry.

import * as THREE from 'three';
import { clamp, dist2d } from '../core/mathutil.js';

// animSet drives every arm animation for a weapon: the aiming stance and
// carry overlays, the fire gesture (recoil strength / bat swings), the
// reload class + duration, and the first-person viewmodel rest pose.
export const WEAPONS = {
  fists:   { name: 'FISTS',    icon: '✊', melee: true,  dmg: 12, rate: 0.45, range: 1.5,
    animSet: { aim: 'guardFists', carry: 'none' } },
  bat:     { name: 'BAT',      icon: '🏏', melee: true,  dmg: 30, rate: 0.55, range: 1.9, price: 200,
    animSet: { aim: 'stanceBat', carry: 'carryBat', swing: true } },
  pistol:  { name: 'P9',       icon: '🔫', dmg: 26, rate: 0.34, range: 65, spread: 0.012, mag: 15, auto: false, sfx: 'pistol', price: 400,
    animSet: { aim: 'aimPistol', carry: 'carryPistol', kick: 0.7, reload: 'pistol', reloadTime: 1.4, vm: [0.28, -0.26, -0.55] } },
  smg:     { name: 'HORNET',   icon: '🔫', dmg: 13, rate: 0.085, range: 48, spread: 0.035, mag: 30, auto: true,  sfx: 'smg', price: 1200,
    animSet: { aim: 'aimSmg', carry: 'carryLong', kick: 0.55, reload: 'mag', reloadTime: 1.6, vm: [0.26, -0.25, -0.5] } },
  shotgun: { name: 'MULE 12',  icon: '🔫', dmg: 11, rate: 0.85, range: 24, spread: 0.065, mag: 6, pellets: 7, auto: false, sfx: 'shotgun', price: 900,
    animSet: { aim: 'aimShotgun', carry: 'carryLong', kick: 1.6, reload: 'shell', shellTime: 0.55, pump: true, vm: [0.22, -0.24, -0.52] } },
  rifle:   { name: 'LONGHORN', icon: '🔫', dmg: 32, rate: 0.11, range: 90, spread: 0.02, mag: 30, auto: true,  sfx: 'rifle', price: 2500,
    animSet: { aim: 'aimRifle', carry: 'carryLong', kick: 0.9, reload: 'mag', reloadTime: 1.7, vm: [0.24, -0.23, -0.5] } },
};

const ORDER = ['fists', 'bat', 'pistol', 'smg', 'shotgun', 'rifle'];

// tiny procedural weapon meshes held in the right hand
function buildWeaponMesh(id) {
  const g = new THREE.Group();
  const dark = new THREE.MeshLambertMaterial({ color: 0x23262b });
  const wood = new THREE.MeshLambertMaterial({ color: 0x7a5a38 });
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  switch (id) {
    case 'bat':
      add(new THREE.CylinderGeometry(0.032, 0.05, 0.8, 8), wood, 0, -0.32, 0).rotation.x = Math.PI;
      break;
    case 'pistol':
      add(new THREE.BoxGeometry(0.045, 0.09, 0.06), dark, 0, -0.02, 0.01);
      add(new THREE.BoxGeometry(0.04, 0.05, 0.2), dark, 0, 0.045, -0.07);
      break;
    case 'smg':
      add(new THREE.BoxGeometry(0.05, 0.1, 0.08), dark, 0, -0.02, 0.01);
      add(new THREE.BoxGeometry(0.05, 0.07, 0.3), dark, 0, 0.05, -0.1);
      add(new THREE.BoxGeometry(0.035, 0.12, 0.04), dark, 0, -0.06, -0.08);
      break;
    case 'shotgun':
      add(new THREE.CylinderGeometry(0.025, 0.025, 0.62, 8), dark, 0, 0.05, -0.2).rotation.x = Math.PI / 2;
      add(new THREE.BoxGeometry(0.05, 0.07, 0.3), wood, 0, 0.02, 0.1);
      break;
    case 'rifle':
      add(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8), dark, 0, 0.06, -0.28).rotation.x = Math.PI / 2;
      add(new THREE.BoxGeometry(0.05, 0.08, 0.42), dark, 0, 0.03, 0);
      add(new THREE.BoxGeometry(0.04, 0.14, 0.05), dark, 0, -0.05, 0.05);
      add(new THREE.BoxGeometry(0.04, 0.1, 0.16), wood, 0, 0.02, 0.26);
      break;
  }
  return g;
}

export class CombatSystem {
  constructor(game) {
    this.game = game;
    this.inventory = { fists: { ammo: Infinity, inMag: Infinity } };
    this.current = 'fists';
    this.cooldown = 0;
    this.reloading = 0;
    this.hitmarkT = 0;
    this.weaponMeshes = {};
    this.updateHud();
  }

  // ---------------- inventory ----------------
  give(id, ammo = 0) {
    if (!WEAPONS[id]) return false;
    const spec = WEAPONS[id];
    if (!this.inventory[id]) {
      this.inventory[id] = spec.melee
        ? { ammo: Infinity, inMag: Infinity }
        : { ammo: Math.max(0, ammo - spec.mag), inMag: Math.min(ammo, spec.mag) };
      this.select(id);
    } else if (!spec.melee) {
      this.inventory[id].ammo += ammo;
    }
    this.updateHud();
    return true;
  }

  select(id) {
    if (!this.inventory[id]) return;
    const switching = this.current !== id;
    this.current = id;
    this.reloading = 0;
    this.shellLoading = false;
    // stance + carry overlays for the new weapon
    const anims = WEAPONS[id].animSet ?? {};
    this.game.player?.rig?.setWeaponOverlays?.(anims.aim, anims.carry);
    if (switching && this.game.player?.rig?.drawGesture) {
      // draw: hand sweeps up, the weapon mesh appears mid-motion
      this.game.player.rig.drawGesture();
      for (const k in this.weaponMeshes) this.weaponMeshes[k].visible = false;
      this.drawT = 0.15;
    } else {
      this.attachWeaponMesh();
    }
    this.updateHud();
  }

  cycle(dir) {
    const owned = ORDER.filter((w) => this.inventory[w]);
    const i = owned.indexOf(this.current);
    this.select(owned[(i + dir + owned.length) % owned.length]);
  }

  attachWeaponMesh() {
    const anchor = this.game.player.rig.handAnchor;
    for (const k in this.weaponMeshes) this.weaponMeshes[k].visible = false;
    if (this.current === 'fists') { this.syncViewmodel(); return; }
    if (!this.weaponMeshes[this.current]) {
      const mesh = buildWeaponMesh(this.current);
      this.weaponMeshes[this.current] = mesh;
      anchor.add(mesh);
    }
    this.weaponMeshes[this.current].visible = true;
    this.syncViewmodel();
  }

  // first-person weapon viewmodel: a held gun parented to the camera
  syncViewmodel() {
    const game = this.game;
    if (!this.viewmodels) {
      this.viewmodels = {};
      this.vmGroup = new THREE.Group();
      this.vmGroup.visible = false;   // gateVm() decides — never default-on
      game.camera.add(this.vmGroup);
      game.scene.add(game.camera);
    }
    for (const k in this.viewmodels) this.viewmodels[k].visible = false;
    this.vmActive = null;
    if (this.current !== 'fists') {
      if (!this.viewmodels[this.current]) {
        const m = buildWeaponMesh(this.current);
        m.scale.setScalar(1.8);
        this.viewmodels[this.current] = m;
        this.vmGroup.add(m);
      }
      const vm = this.viewmodels[this.current];
      const rest = WEAPONS[this.current].animSet?.vm ?? [0.28, -0.26, -0.55];
      vm.position.set(rest[0], rest[1], rest[2]);
      vm.rotation.set(0, Math.PI, 0);
      vm.visible = true;              // re-selects used to stay hidden in FP
      this.vmActive = vm;
      this.vmRest = rest;
    }
    // gate immediately: select() runs AFTER update()'s per-frame gate, so
    // without this a weapon switch in 3rd person flashed the viewmodel in
    // the screen corner until the next frame (stretched by wheel slow-mo)
    this.gateVm();
  }

  gateVm() {
    if (!this.vmGroup) return;
    const player = this.game.player;
    const fpFoot = this.game.cameraRig.firstPerson && !player.vehicle && !player.dead;
    this.vmGroup.visible = fpFoot && !!this.vmActive;
    return fpFoot;
  }

  updateHud() {
    const spec = WEAPONS[this.current];
    const inv = this.inventory[this.current];
    const ammoText = spec.melee ? '' : `${inv.inMag} · ${inv.ammo}`;
    this.game.hud?.setWeapon(spec.icon, spec.name, ammoText);
  }

  // ---------------- firing ----------------
  update(dt, aiming) {
    const game = this.game;
    const player = game.player;
    this.cooldown -= dt;
    this.hitmarkT -= dt;
    this.bloom = Math.max(0, (this.bloom || 0) - dt * 2.5);

    // draw in progress: the weapon mesh appears mid-sweep
    if (this.drawT != null) {
      this.drawT -= dt;
      if (this.drawT <= 0) { this.drawT = null; this.attachWeaponMesh(); }
    }
    // shotgun pump cycle lands a beat after the shot
    if (this.pumpAt != null && game.time >= this.pumpAt) {
      this.pumpAt = null;
      if (WEAPONS[this.current].animSet?.pump && !player.vehicle) {
        player.rig.pumpGesture?.();
        this.vmPumpT = 0.32;
      }
    }

    // viewmodel visibility + sway/bob (first-person, on foot)
    if (this.vmGroup) {
      const fpFoot = this.gateVm();
      if (fpFoot && this.vmActive) {
        this.vmBob = (this.vmBob || 0) + dt * (player.speed2d > 0.4 ? 8 : 2);
        const bob = Math.sin(this.vmBob) * (player.speed2d > 0.4 ? 0.015 : 0.004);
        const kick = (game.cameraRig.recoilPitch || 0);
        const rest = this.vmRest ?? [0.28, -0.26, -0.55];
        // reload: gun dips and rolls; pump: fore-end pushes back toward you
        let rx = 0, dy = 0, dz = 0;
        if (this.reloading > 0 && this.reloadTotal) {
          const k = Math.sin((1 - this.reloading / this.reloadTotal) * Math.PI);
          rx = 0.55 * k; dy = -0.14 * k;
        }
        if (this.vmPumpT > 0) {
          this.vmPumpT -= dt;
          dz = 0.1 * Math.sin(clamp(this.vmPumpT / 0.32, 0, 1) * Math.PI);
        }
        this.vmActive.position.set(
          rest[0] + Math.cos(this.vmBob) * 0.004,
          rest[1] + bob - kick * 0.5 + dy,
          rest[2] + kick * 0.8 + dz);
        this.vmActive.rotation.set(rx, Math.PI, 0);
      }
    }
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this.finishReload();
    }
    if (player.dead || game.state.mode !== 'play') return;

    const input = game.input;

    // weapon wheel: hold Q to open (slow-mo), release to pick the highlighted one
    this.updateWeaponWheel(dt);
    // weapon switching (on foot only, wheel closed)
    if (!player.vehicle && !this.wheelOpen) {
      if (input.wheelDelta !== 0) this.cycle(Math.sign(input.wheelDelta));
    }
    if (input.wasPressed('KeyR') && !player.vehicle) this.startReload();

    // lock-on toggle (Tab or middle mouse) — nearest visible enemy
    if (!player.vehicle && (input.wasPressed('Tab') || input.mousePressed[1])) {
      if (this.lockTarget) this.lockTarget = null;
      else this.acquireLock();
    }
    this.updateLock(dt);

    const spec = WEAPONS[this.current];
    const inv = this.inventory[this.current];
    const wantFire = spec.auto ? input.mouseDown[0] : input.mousePressed[0];

    // aim pitch for the rig pose
    player.rig.aimPitch = aiming ? clamp(-game.cameraRig.pitch, -0.8, 0.8) : 0;

    // shell-by-shell reload is interruptible: firing what's loaded cancels it
    if (this.shellLoading && wantFire && inv.inMag > 0 && this.cooldown <= 0) {
      this.shellLoading = false;
      this.reloading = 0;
      this.updateHud();
    }

    if (!wantFire || this.cooldown > 0 || this.reloading > 0) {
      if (this.hitmarkT <= 0) game.hud?.setCrosshair(aiming || (player.vehicle && this.canDriveBy()), false);
      return;
    }

    // --- drive-by: one-handed weapons out the window ---
    if (player.vehicle) {
      if (!this.canDriveBy()) return;
      if (inv.inMag <= 0) { this.startReload(); return; }
      this.cooldown = spec.rate * 1.3;
      inv.inMag--;
      this.fireHitscan(spec, true);
      this.updateHud();
      return;
    }

    // --- melee combo ---
    if (spec.melee) {
      // combo counter: chained hits within the window escalate 1→2→3 (finisher)
      if (game.time - (this.lastMeleeT || -9) < 0.9) this.comboStep = (this.comboStep || 0) % 3 + 1;
      else this.comboStep = 1;
      this.lastMeleeT = game.time;
      const finisher = this.comboStep === 3;
      this.cooldown = finisher ? spec.rate * 1.5 : spec.rate;
      // bat gets its own swings — horizontal, overhead on the finisher;
      // bare fists mix a snap kick into the second combo beat
      if (spec.animSet?.swing && player.rig.batSwing) player.rig.batSwing(finisher);
      else if (this.comboStep === 2 && this.current === 'fists' &&
               Math.random() < 0.5 && player.rig.kickGesture) player.rig.kickGesture();
      else player.rig.startPunch();

      // small lunge toward the aim/lock direction
      const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
      player.vel.x += fx * (finisher ? 4 : 2.2);
      player.vel.z += fz * (finisher ? 4 : 2.2);

      const reachX = player.pos.x + fx * spec.range * 0.7;
      const reachZ = player.pos.z + fz * spec.range * 0.7;
      let target = game.peds?.nearestPed(reachX, reachZ, spec.range, (t) => !t.dead)
        || game.wanted?.nearestCop(reachX, reachZ, spec.range);
      if (!target) {
        let bd = spec.range * spec.range;
        for (const goon of [...(game.missions?.activeGoons?.() || []), ...(game.interiors?.keepers?.() || [])]) {
          if (goon.dead) continue;
          const d = (goon.pos.x - reachX) ** 2 + (goon.pos.z - reachZ) ** 2;
          if (d < bd) { bd = d; target = goon; }
        }
      }
      game.audio?.punch();
      if (target) {
        const dmg = finisher ? spec.dmg * 2.2 : spec.dmg;
        const knock = finisher ? { dx: fx, dz: fz, force: 5, up: 2.5, spin: 4 } : null;
        game.combat?.hitStop?.();
        this.hitStop();
        target.damage(dmg, game, 'melee', target.health - dmg <= 0 ? knock : null, 'player', player);
        game.particles?.blood(target.pos.x, target.pos.y + 1.2, target.pos.z, finisher ? 6 : 3);
        // non-fatal finisher still knocks them down
        if (!target.dead && finisher) target.stagger?.(game, { dx: fx, dz: fz });
        if (!target.isGoon && !target.isKeeper) game.wanted?.crime(target.isCop ? 'copAttack' : 'assault', player.pos.x, player.pos.z);
        this.hitmark();
        game.cameraRig.addShake(finisher ? 0.3 : 0.12);
      } else {
        const v = game.vehicles?.nearestVehicle(reachX, reachZ, spec.range + 0.6, (v) => !v.dead && v.driver !== 'player');
        if (v) {
          v.applyDamage(spec.dmg * 0.7, 'melee', 'player');
          game.particles?.sparks(reachX, player.pos.y + 1, reachZ, 4);
          game.wanted?.crime('crash', player.pos.x, player.pos.z);
          this.hitmark();
        }
      }
      return;
    }

    // --- guns (on foot) ---
    if (!aiming) return;              // must aim to shoot
    if (inv.inMag <= 0) { this.startReload(); return; }
    this.cooldown = spec.rate;
    inv.inMag--;
    this.fireHitscan(spec, false);
    // arms take the kick (camera recoil is added in fireHitscan)
    if (spec.animSet?.kick) player.rig.gunKick?.(spec.animSet.kick);
    if (spec.animSet?.pump) this.pumpAt = game.time + 0.28;
    this.updateHud();
  }

  canDriveBy() {
    return ['pistol', 'smg'].includes(this.current) && !WEAPONS[this.current].melee;
  }

  startReload() {
    const spec = WEAPONS[this.current];
    const inv = this.inventory[this.current];
    if (spec.melee || this.reloading > 0) return;
    if (inv.inMag >= spec.mag || inv.ammo <= 0) return;
    const anims = spec.animSet ?? {};
    const rig = this.game.player?.rig;
    if (anims.reload === 'shell') {
      // shotgun: shells go in one at a time and firing can interrupt
      this.shellLoading = true;
      this.reloading = anims.shellTime;
      rig?.reloadGesture?.('shell', anims.shellTime);
    } else {
      this.reloading = anims.reloadTime ?? 1.4;
      rig?.reloadGesture?.(anims.reload ?? 'mag', this.reloading);
    }
    this.reloadTotal = this.reloading;
    this.game.hud?.setWeapon(spec.icon, spec.name, '· · ·');
  }

  finishReload() {
    const spec = WEAPONS[this.current];
    const inv = this.inventory[this.current];
    if (this.shellLoading) {
      if (inv.ammo > 0 && inv.inMag < spec.mag) { inv.inMag++; inv.ammo--; }
      this.updateHud();
      if (inv.ammo > 0 && inv.inMag < spec.mag) {
        // next shell
        this.reloading = spec.animSet.shellTime;
        this.reloadTotal = this.reloading;
        this.game.player?.rig?.reloadGesture?.('shell', this.reloading);
      } else {
        this.shellLoading = false;
      }
      return;
    }
    const need = spec.mag - inv.inMag;
    const take = Math.min(need, inv.ammo);
    inv.inMag += take;
    inv.ammo -= take;
    this.updateHud();
  }

  fireHitscan(spec, driveBy) {
    const game = this.game;
    const player = game.player;
    const cam = game.camera;

    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    cam.getWorldPosition(origin);
    cam.getWorldDirection(dir);

    // muzzle position for the flash
    const mx = player.vehicle ? player.vehicle.pos.x : player.pos.x + Math.sin(player.heading) * 0.5;
    const mz = player.vehicle ? player.vehicle.pos.z : player.pos.z + Math.cos(player.heading) * 0.5;
    const my = (player.vehicle ? player.vehicle.pos.y + 1.1 : player.pos.y + 1.35);
    game.particles?.muzzleFlash(mx, my, mz, dir.x, dir.z);
    game.particles?.muzzleLight?.(mx, my, mz);
    game.audio?.gunshot(spec.sfx);
    game.wanted?.crime('gunfire', player.pos.x, player.pos.z);
    game.peds?.senseEvent?.(player.pos.x, player.pos.z, 'gunshot');
    game.cameraRig.addShake(spec.sfx === 'shotgun' ? 0.35 : 0.12);
    // recoil kick (stronger for big guns) + crosshair bloom
    const kick = spec.sfx === 'shotgun' ? 0.09 : spec.sfx === 'rifle' ? 0.05 : 0.035;
    game.cameraRig.addRecoil(kick);
    this.bloom = Math.min(1, (this.bloom || 0) + (spec.spread * 8 + 0.2));
    // ejected shell casing
    game.particles?.shell?.(mx, my, mz, player.heading);

    const pellets = spec.pellets || 1;
    let anyHit = false;
    for (let p = 0; p < pellets; p++) {
      const d = dir.clone();
      const spr = spec.spread * (1 + (this.bloom || 0) * 0.6);
      d.x += (Math.random() - 0.5) * spr * 2;
      d.y += (Math.random() - 0.5) * spr * 2;
      d.z += (Math.random() - 0.5) * spr * 2;
      d.normalize();
      const hit = this.raycastWorld(origin, d, spec.range);
      // tracer line from muzzle to impact (or max range)
      const end = hit ? hit.point : new THREE.Vector3(origin.x + d.x * spec.range, origin.y + d.y * spec.range, origin.z + d.z * spec.range);
      game.particles?.tracer?.(mx, my, mz, end.x, end.y, end.z);
      if (!hit) continue;
      if (hit.type === 'static') {
        game.particles?.sparks(hit.point.x, hit.point.y, hit.point.z, 3);
        game.audio?.ricochet(hit.point.x, hit.point.z);
      } else if (hit.type === 'ped' || hit.type === 'cop' || hit.type === 'goon') {
        const imp = { dx: d.x, dz: d.z, force: 2 + spec.dmg * 0.06, up: 0.8, spin: (Math.random() - 0.5) * 3 };
        hit.target.damage(spec.dmg, game, 'gun', imp, 'player', game.player);
        game.gore?.blood.pool(hit.target.pos.x + d.x, hit.target.pos.z + d.z, hit.target.interiorY ?? undefined);
        // shooting mission goons is gang business — no extra police heat beyond the gunfire itself
        if (hit.type !== 'goon') {
          game.wanted?.crime(hit.type === 'cop' ? (hit.target.dead ? 'copKill' : 'copAttack') : (hit.target.dead ? 'kill' : 'assault'), player.pos.x, player.pos.z);
        }
        anyHit = true;
      } else if (hit.type === 'vehicle') {
        hit.target.applyDamage(spec.dmg * 0.55, 'gun', 'player');
        game.particles?.sparks(hit.point.x, hit.point.y, hit.point.z, 4);
        if (hit.target.aiControlled) game.traffic?.panic(hit.target);
        anyHit = true;
      }
    }
    if (anyHit) this.hitmark();
  }

  hitmark() {
    this.hitmarkT = 0.18;
    this.game.hud?.setCrosshair(true, true);
  }

  // brief global slow-mo on a solid melee connect (hit-stop)
  hitStop() {
    this.game.hitStopT = 0.06;
  }

  // ---------------- lock-on ----------------
  allTargets() {
    const game = this.game;
    const out = [];
    for (const p of game.peds?.peds || []) if (!p.dead) out.push(p);
    for (const c of game.wanted?.footCops || []) if (!c.dead) out.push(c);
    for (const g of game.missions?.activeGoons?.() || []) if (!g.dead) out.push(g);
    // shopkeepers only when they're actually in play: provoked, or in the
    // room the player is standing in — never through a closed shopfront
    const inside = game.interiors?.playerInside;
    for (const k of game.interiors?.keepers?.() || []) {
      if (k.provoked || (inside && (inside.keeper === k || inside.dancers?.includes(k)))) out.push(k);
    }
    return out;
  }

  acquireLock() {
    const game = this.game;
    const p = game.player.pos;
    const fx = -Math.sin(game.cameraRig.yaw), fz = -Math.cos(game.cameraRig.yaw);
    let best = null, bestScore = -1;
    for (const t of this.allTargets()) {
      const dx = t.pos.x - p.x, dz = t.pos.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 26 || d < 0.5) continue;
      const dot = (dx / d) * fx + (dz / d) * fz;      // in front of the camera
      if (dot < 0.2) continue;
      const score = dot * 2 - d / 26;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    this.lockTarget = best;
    if (best) game.hud?.showToast('Locked on', 1.2);
  }

  cycleLock(dir) {
    const targets = this.allTargets().filter((t) => {
      const d = dist2d(t.pos.x, t.pos.z, this.game.player.pos.x, this.game.player.pos.z);
      return d < 30;
    }).sort((a, b) => Math.atan2(a.pos.x, a.pos.z) - Math.atan2(b.pos.x, b.pos.z));
    if (!targets.length) return;
    const i = targets.indexOf(this.lockTarget);
    this.lockTarget = targets[(i + dir + targets.length) % targets.length];
  }

  updateLock(dt) {
    const game = this.game;
    if (!this.lockTarget) { game.player.lockHeading = null; return; }
    if (this.lockTarget.dead || game.player.vehicle ||
        dist2d(this.lockTarget.pos.x, this.lockTarget.pos.z, game.player.pos.x, game.player.pos.z) > 34) {
      this.lockTarget = null;
      game.player.lockHeading = null;
      return;
    }
    // cycle targets with scroll while locked
    if (game.input.wheelDelta !== 0) this.cycleLock(Math.sign(game.input.wheelDelta));
    // face the player + camera toward the target
    const t = this.lockTarget;
    const ang = Math.atan2(t.pos.x - game.player.pos.x, t.pos.z - game.player.pos.z);
    game.player.heading = game.player.rig ? ang : ang;
    game.player.lockHeading = ang;
    game.cameraRig.yaw = ang + Math.PI;
  }

  // ---------------- weapon wheel ----------------
  updateWeaponWheel(dt) {
    const game = this.game;
    const wheelEl = document.getElementById('weaponwheel');
    const held = game.input.down('KeyQ') && !game.player.vehicle;
    if (held && !this.wheelOpen) {
      this.wheelOpen = true;
      game.timeScale = 0.25;
      this.buildWheel();
      if (wheelEl) wheelEl.classList.remove('hidden');
    } else if (!held && this.wheelOpen) {
      this.wheelOpen = false;
      game.timeScale = 1;
      if (wheelEl) wheelEl.classList.add('hidden');
      if (this.wheelPick) this.select(this.wheelPick);
    }
    if (this.wheelOpen) {
      // pick by aim direction (mouse dx accumulates an angle) or scroll
      if (game.input.wheelDelta !== 0) {
        const owned = ORDER.filter((w) => this.inventory[w]);
        const i = owned.indexOf(this.wheelPick || this.current);
        this.wheelPick = owned[(i + Math.sign(game.input.wheelDelta) + owned.length) % owned.length];
        this.highlightWheel();
      }
    }
  }

  buildWheel() {
    const el = document.getElementById('weaponwheel');
    if (!el) return;
    const owned = ORDER.filter((w) => this.inventory[w]);
    this.wheelPick = this.current;
    el.innerHTML = '';
    const n = owned.length;
    owned.forEach((id, k) => {
      const ang = (k / n) * Math.PI * 2 - Math.PI / 2;
      const div = document.createElement('div');
      div.className = 'ww-slot' + (id === this.current ? ' sel' : '');
      div.dataset.id = id;
      div.style.left = `calc(50% + ${Math.cos(ang) * 130}px)`;
      div.style.top = `calc(50% + ${Math.sin(ang) * 130}px)`;
      div.innerHTML = `<span class="ww-ic">${WEAPONS[id].icon}</span><span class="ww-nm">${WEAPONS[id].name}</span>`;
      el.appendChild(div);
    });
  }

  highlightWheel() {
    const el = document.getElementById('weaponwheel');
    if (!el) return;
    for (const s of el.children) s.classList.toggle('sel', s.dataset.id === this.wheelPick);
  }

  // shared hitscan against peds, cops, vehicles and static boxes
  raycastWorld(origin, dir, range) {
    const game = this.game;
    let best = null;

    const sphereHit = (cx, cy, cz, r) => {
      // ray-sphere intersection, returns distance or null
      const ox = cx - origin.x, oy = cy - origin.y, oz = cz - origin.z;
      const tca = ox * dir.x + oy * dir.y + oz * dir.z;
      if (tca < 0 || tca > range) return null;
      const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
      if (d2 > r * r) return null;
      return tca - Math.sqrt(Math.max(0, r * r - d2));
    };

    const consider = (t, type, target) => {
      if (t != null && t >= 0 && (best === null || t < best.t)) best = { t, type, target };
    };

    for (const ped of game.peds?.peds || []) {
      if (ped.dead) continue;
      consider(sphereHit(ped.pos.x, ped.pos.y + 1.0, ped.pos.z, 0.55), 'ped', ped);
    }
    for (const cop of game.wanted?.footCops || []) {
      if (cop.dead) continue;
      consider(sphereHit(cop.pos.x, cop.pos.y + 1.0, cop.pos.z, 0.55), 'cop', cop);
    }
    for (const goon of game.missions?.activeGoons?.() || []) {
      if (goon.dead) continue;
      consider(sphereHit(goon.pos.x, goon.pos.y + 1.0, goon.pos.z, 0.55), 'goon', goon);
    }
    for (const keeper of game.interiors?.keepers?.() || []) {
      consider(sphereHit(keeper.pos.x, keeper.pos.y + 1.0, keeper.pos.z, 0.55), 'goon', keeper);
    }
    for (const v of game.vehicles?.vehicles || []) {
      if (v === game.player.vehicle) continue;
      consider(sphereHit(v.pos.x, v.pos.y + 0.8, v.pos.z, v.boundR * 0.8 + 0.35), 'vehicle', v);
    }

    // static: march the ray until inside a collider or below ground
    const step = 1.2;
    const maxT = best ? best.t : range;
    for (let t = 2; t < maxT; t += step) {
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      const z = origin.z + dir.z * t;
      const ground = game.city.groundHeight(x, z);
      if (y <= ground + 0.02) {
        best = { t, type: 'static', target: null };
        break;
      }
      const cols = game.city.queryColliders(x, z, 0.4);
      let inside = false;
      for (const b of cols) {
        if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ && y < ground + b.h) { inside = true; break; }
      }
      if (inside) {
        best = { t, type: 'static', target: null };
        break;
      }
    }

    if (!best) return null;
    return {
      type: best.type, target: best.target,
      point: new THREE.Vector3(
        origin.x + dir.x * best.t,
        origin.y + dir.y * best.t,
        origin.z + dir.z * best.t),
    };
  }
}
