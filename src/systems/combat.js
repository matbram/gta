// Combat: weapon inventory, switching, aiming, hitscan firing with spread,
// melee, reload, drive-by shooting, and hit resolution against
// peds / cops / vehicles / world geometry.

import * as THREE from 'three';
import { clamp, dist2d } from '../core/mathutil.js';

export const WEAPONS = {
  fists:   { name: 'FISTS',    icon: '✊', melee: true,  dmg: 12, rate: 0.45, range: 1.5 },
  bat:     { name: 'BAT',      icon: '🏏', melee: true,  dmg: 30, rate: 0.55, range: 1.9, price: 200 },
  pistol:  { name: 'P9',       icon: '🔫', dmg: 26, rate: 0.34, range: 65, spread: 0.012, mag: 15, auto: false, sfx: 'pistol', price: 400 },
  smg:     { name: 'HORNET',   icon: '🔫', dmg: 13, rate: 0.085, range: 48, spread: 0.035, mag: 30, auto: true,  sfx: 'smg', price: 1200 },
  shotgun: { name: 'MULE 12',  icon: '🔫', dmg: 11, rate: 0.85, range: 24, spread: 0.065, mag: 6, pellets: 7, auto: false, sfx: 'shotgun', price: 900 },
  rifle:   { name: 'LONGHORN', icon: '🔫', dmg: 32, rate: 0.11, range: 90, spread: 0.02, mag: 30, auto: true,  sfx: 'rifle', price: 2500 },
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
    this.current = id;
    this.reloading = 0;
    this.attachWeaponMesh();
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
    if (this.current === 'fists') return;
    if (!this.weaponMeshes[this.current]) {
      const mesh = buildWeaponMesh(this.current);
      this.weaponMeshes[this.current] = mesh;
      anchor.add(mesh);
    }
    this.weaponMeshes[this.current].visible = true;
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
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this.finishReload();
    }
    if (player.dead || game.state.mode !== 'play') return;

    const input = game.input;

    // weapon switching (on foot only)
    if (!player.vehicle) {
      if (input.wasPressed('KeyQ')) this.cycle(1);
      if (input.wheelDelta !== 0) this.cycle(Math.sign(input.wheelDelta));
    }
    if (input.wasPressed('KeyR') && !player.vehicle) this.startReload();

    const spec = WEAPONS[this.current];
    const inv = this.inventory[this.current];
    const wantFire = spec.auto ? input.mouseDown[0] : input.mousePressed[0];

    // aim pitch for the rig pose
    player.rig.aimPitch = aiming ? clamp(-game.cameraRig.pitch, -0.8, 0.8) : 0;

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

    // --- melee ---
    if (spec.melee) {
      this.cooldown = spec.rate;
      player.rig.startPunch();
      const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
      const reachX = player.pos.x + fx * spec.range * 0.7;
      const reachZ = player.pos.z + fz * spec.range * 0.7;
      const target = game.peds?.nearestPed(reachX, reachZ, spec.range, (t) => !t.dead)
        || game.wanted?.nearestCop(reachX, reachZ, spec.range);
      game.audio?.punch();
      if (target) {
        target.damage(spec.dmg, game, 'melee');
        game.particles?.blood(target.pos.x, target.pos.y + 1.2, target.pos.z, 3);
        game.wanted?.crime(target.isCop ? 'copAttack' : 'assault', player.pos.x, player.pos.z);
        this.hitmark();
      } else {
        // smack vehicles too
        const v = game.vehicles?.nearestVehicle(reachX, reachZ, spec.range + 0.6, (v) => !v.dead && v.driver !== 'player');
        if (v) {
          v.applyDamage(spec.dmg * 0.7, 'melee');
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
    this.reloading = 1.4;
    this.game.hud?.setWeapon(spec.icon, spec.name, '· · ·');
  }

  finishReload() {
    const spec = WEAPONS[this.current];
    const inv = this.inventory[this.current];
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
    game.audio?.gunshot(spec.sfx);
    game.wanted?.crime('gunfire', player.pos.x, player.pos.z);
    game.peds?.panicAt(player.pos.x, player.pos.z, 34);
    game.cameraRig.addShake(spec.sfx === 'shotgun' ? 0.35 : 0.12);

    const pellets = spec.pellets || 1;
    let anyHit = false;
    for (let p = 0; p < pellets; p++) {
      const d = dir.clone();
      d.x += (Math.random() - 0.5) * spec.spread * 2;
      d.y += (Math.random() - 0.5) * spec.spread * 2;
      d.z += (Math.random() - 0.5) * spec.spread * 2;
      d.normalize();
      const hit = this.raycastWorld(origin, d, spec.range);
      if (!hit) continue;
      if (hit.type === 'static') {
        game.particles?.sparks(hit.point.x, hit.point.y, hit.point.z, 3);
        game.audio?.ricochet(hit.point.x, hit.point.z);
      } else if (hit.type === 'ped' || hit.type === 'cop') {
        hit.target.damage(spec.dmg, game, 'gun');
        game.wanted?.crime(hit.type === 'cop' ? (hit.target.dead ? 'copKill' : 'copAttack') : (hit.target.dead ? 'kill' : 'assault'), player.pos.x, player.pos.z);
        anyHit = true;
      } else if (hit.type === 'vehicle') {
        hit.target.applyDamage(spec.dmg * 0.55, 'gun');
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
    for (const v of game.vehicles?.vehicles || []) {
      if (v === game.player.vehicle) continue;
      consider(sphereHit(v.pos.x, v.pos.y + 0.8, v.pos.z, v.radius + 0.35), 'vehicle', v);
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
