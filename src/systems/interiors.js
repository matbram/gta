// Enterable interiors: every shopfront door teleports into a store template
// (rooms live far off the island, one instance per template). Includes
// shopkeepers, register robberies, counter shops, the nightclub floor and
// the safehouse bed.

import * as THREE from 'three';
import { Goon } from '../entities/goon.js';
import { dist2d, clamp } from '../core/mathutil.js';
import { rand2i } from '../core/rng.js';

const BASE_X = 2600;            // interior row, far east of the island
const SPACING = 160;

const KEEPER_LOOKS = [
  { skin: 0xc99b72, shirt: 0x6a8a5a, pants: 0x3a4444, hair: 0x2a2018 },
  { skin: 0x8a5a3a, shirt: 0x8a6a4a, pants: 0x2e3440, hair: 0x0e0c0a },
  { skin: 0xe8b88a, shirt: 0x5a6a8a, pants: 0x4a4038, hair: 0x5a4028 },
];

export class Interiors {
  constructor(game) {
    this.game = game;
    this.templates = {};         // key → { origin, spawn, exit, keeper, register, counter, label }
    this.current = null;         // active template key
    this.returnSpot = null;
    this.robbedDoors = new Set();
    this.currentDoorId = null;
    this.robT = 0;
    this.robDrops = 0;
    this.pendingHeat = 0;
    this.fadeT = 0;

    this.buildTemplates();
    this.buildDoorMarkers();
  }

  // ------------------------------------------------------------ rooms
  room(key, i, { w = 12, d = 9, label = 'STORE' }) {
    const game = this.game;
    const g = new THREE.Group();
    const ox = BASE_X + i * SPACING;
    g.position.set(ox, 0, 0);

    const floorMat = game.assets?.pbrMaterial('concrete', { repeat: 3, color: 0xb8b0a4 })
      ?? new THREE.MeshLambertMaterial({ color: 0x8a8078 });
    const wallMat = game.assets?.pbrMaterial('plaster', { repeat: 2, color: 0xcfc8b8 })
      ?? new THREE.MeshLambertMaterial({ color: 0xbfb8a8 });

    const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.2, d), floorMat);
    floor.position.y = -0.1;
    floor.receiveShadow = true;
    g.add(floor);
    const ceil = new THREE.Mesh(new THREE.BoxGeometry(w, 0.2, d), new THREE.MeshLambertMaterial({ color: 0x554f48 }));
    ceil.position.y = 3.2;
    g.add(ceil);

    // walls (+ colliders in world space)
    const mkWall = (ww, wx, wz, horizontal) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? ww : 0.25, 3.2, horizontal ? 0.25 : ww), wallMat);
      wall.position.set(wx, 1.6, wz);
      g.add(wall);
      const hw = horizontal ? ww / 2 : 0.125, hd = horizontal ? 0.125 : ww / 2;
      game.city.addBox(ox + wx - hw, wz - hd, ox + wx + hw, wz + hd, 3.2, 'interior');
    };
    mkWall(w, 0, -d / 2, true);         // back
    mkWall(d, -w / 2, 0, false);        // left
    mkWall(d, w / 2, 0, false);         // right
    // front wall with a 2.4 m doorway gap in the middle for the exit
    const DOOR_GAP = 2.4;
    const seg = (w - DOOR_GAP) / 2;
    mkWall(seg, -(DOOR_GAP / 2 + seg / 2), d / 2, true);
    mkWall(seg, (DOOR_GAP / 2 + seg / 2), d / 2, true);

    // warm ceiling light (only lit while you're inside)
    const light = new THREE.PointLight(0xffe8c0, 0, 14, 2);
    light.position.set(0, 2.8, 0);
    g.add(light);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 1.4),
      new THREE.MeshLambertMaterial({ color: 0xfff4d8, emissive: 0xffe8b0, emissiveIntensity: 0.8 }));
    lamp.position.y = 3.05;
    g.add(lamp);

    game.scene.add(g);
    const tpl = {
      key, group: g, originX: ox, light, label,
      spawn: { x: ox, z: d / 2 - 2.6 },        // a couple steps inside the door
      exitZ: d / 2 - 0.2,                       // in the doorway gap
      w, d,
      keeper: null, register: null, counterAction: null, bed: null,
    };
    this.templates[key] = tpl;
    return tpl;
  }

  addCounter(tpl, x, z, w = 3) {
    const game = this.game;
    const counter = new THREE.Mesh(new THREE.BoxGeometry(w, 1.05, 0.8),
      new THREE.MeshLambertMaterial({ color: 0x6a5a48 }));
    counter.position.set(x, 0.52, z);
    tpl.group.add(counter);
    game.city.addBox(tpl.originX + x - w / 2, z - 0.4, tpl.originX + x + w / 2, z + 0.4, 1.05, 'interior');
    // register on top
    const reg = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.32, 0.4),
      new THREE.MeshLambertMaterial({ color: 0x2e3440 }));
    reg.position.set(x + w * 0.28, 1.2, z);
    tpl.group.add(reg);
    tpl.register = { x: tpl.originX + x + w * 0.28, z };
  }

  addShelves(tpl, rows = 2) {
    const game = this.game;
    const shelfMat = new THREE.MeshLambertMaterial({ color: 0x7a6a58 });
    const goodsMats = [0xb03a2e, 0x4a7fb5, 0xe8c84a, 0x5fae52].map((c) => new THREE.MeshLambertMaterial({ color: c }));
    for (let r = 0; r < rows; r++) {
      const z = -tpl.d / 2 + 2.4 + r * 2.4;
      const shelf = new THREE.Mesh(new THREE.BoxGeometry(tpl.w * 0.55, 1.5, 0.6), shelfMat);
      shelf.position.set(-tpl.w * 0.12, 0.75, z);
      tpl.group.add(shelf);
      game.city.addBox(tpl.originX - tpl.w * 0.12 - tpl.w * 0.275, z - 0.3, tpl.originX - tpl.w * 0.12 + tpl.w * 0.275, z + 0.3, 1.5, 'interior');
      for (let k = 0; k < 6; k++) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.35), goodsMats[(r * 3 + k) % goodsMats.length]);
        box.position.set(-tpl.w * 0.12 - tpl.w * 0.24 + k * (tpl.w * 0.1), 1.66, z);
        tpl.group.add(box);
      }
    }
  }

  addKeeper(tpl, x, z) {
    const look = KEEPER_LOOKS[Math.floor(Math.random() * KEEPER_LOOKS.length)];
    const keeper = new Goon(this.game.city, this.game.scene, {
      health: 60, aggroRange: 0, shootRange: 10, damage: 14, accuracy: 0.55,
      shirt: look.shirt,
    });
    keeper.isKeeper = true;
    keeper.state = 'guard';
    keeper.interiorY = 0;
    keeper.place(tpl.originX + x, z);
    keeper.heading = Math.PI;      // face the door
    keeper.rig.group.rotation.y = Math.PI;
    tpl.keeper = keeper;
  }

  buildTemplates() {
    // convenience store / diner / laundromat — generic robbable stores
    let t = this.room('store', 0, { w: 12, d: 9, label: 'CORNER STORE' });
    this.addCounter(t, 3.4, -2.6);
    this.addShelves(t, 2);
    this.addKeeper(t, 3.4, -3.6);

    t = this.room('diner', 1, { w: 13, d: 10, label: 'DINER' });
    this.addCounter(t, 0, -3.4, 6);
    this.addKeeper(t, 0, -4.4);
    // booths
    for (const sx of [-4.6, 4.6]) {
      for (const sz of [-0.5, 2.2]) {
        const booth = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 1.1),
          new THREE.MeshLambertMaterial({ color: 0x8a3a30 }));
        booth.position.set(sx, 0.45, sz);
        t.group.add(booth);
        this.game.city.addBox(t.originX + sx - 1.2, sz - 0.55, t.originX + sx + 1.2, sz + 0.55, 0.9, 'interior');
      }
    }

    t = this.room('laundry', 2, { w: 11, d: 8, label: 'LAUNDROMAT' });
    this.addCounter(t, 3.6, -2.4, 2.4);
    this.addKeeper(t, 3.6, -3.2);
    const washerMat = new THREE.MeshLambertMaterial({ color: 0xd8d4cc });
    const drumMat = new THREE.MeshLambertMaterial({ color: 0x22262c });
    for (let k = 0; k < 5; k++) {
      const wsh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 0.8), washerMat);
      wsh.position.set(-4.4 + k * 1.1, 0.55, -3.3);
      t.group.add(wsh);
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.06, 12), drumMat);
      drum.rotation.x = Math.PI / 2;
      drum.position.set(-4.4 + k * 1.1, 0.6, -2.88);
      t.group.add(drum);
    }
    this.game.city.addBox(t.originX - 4.9, -3.7, t.originX + 0.6, -2.9, 1.1, 'interior');

    // gun shop — racks + counter that opens the buy menu
    t = this.room('gunshop', 3, { w: 12, d: 9, label: 'BULLSEYE ROUNDS' });
    this.addCounter(t, 0, -2.8, 5);
    this.addKeeper(t, 0, -3.7);
    t.counterAction = 'gunshop';
    const rackMat = new THREE.MeshLambertMaterial({ color: 0x4a4038 });
    const gunMat = new THREE.MeshLambertMaterial({ color: 0x23262b });
    for (let k = 0; k < 6; k++) {
      const rack = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.6, 0.12), rackMat);
      rack.position.set(-5.2 + k * 2.1, 1.7, -4.3);
      t.group.add(rack);
      const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 0.06), gunMat);
      rifle.position.set(-5.2 + k * 2.1, 1.7, -4.2);
      rifle.rotation.z = 0.25;
      t.group.add(rifle);
    }

    // burger shop
    t = this.room('food', 4, { w: 11, d: 9, label: 'PRONTO BURGER' });
    this.addCounter(t, 0, -3, 6);
    this.addKeeper(t, 0, -3.9);
    t.counterAction = 'food';

    // nightclub — bigger, dark, dancers, moving lights
    t = this.room('club', 5, { w: 18, d: 14, label: 'THE VELVET IGUANA' });
    t.light.color.set(0x8844ff);
    this.addCounter(t, -6.5, -4, 4);
    this.addKeeper(t, -6.5, -5);
    t.clubLights = [];
    for (const c of [0xff3366, 0x33aaff, 0xaaff33]) {
      const spot = new THREE.PointLight(c, 0, 16, 1.8);
      spot.position.set(Math.random() * 8 - 4, 2.6, Math.random() * 6 - 3);
      t.group.add(spot);
      t.clubLights.push(spot);
    }
    t.dancers = [];
    for (let k = 0; k < 4; k++) {
      const d = new Goon(this.game.city, this.game.scene, { health: 40, shirt: [0xe84a8a, 0x4ae8d8, 0xe8d84a, 0x8a4ae8][k] });
      d.isKeeper = true;                 // civilians, not hostiles
      d.state = 'guard';
      d.interiorY = 0;
      d.place(t.originX + 2 + (k % 2) * 2.2, 1 - Math.floor(k / 2) * 2.2);
      d.heading = Math.random() * 6.28;
      t.dancers.push(d);
    }

    // safehouse — bed saves the game
    t = this.room('safehouse', 6, { w: 10, d: 8, label: 'SAFEHOUSE' });
    const bed = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 2.4),
      new THREE.MeshLambertMaterial({ color: 0x6a3a3a }));
    bed.position.set(-3.4, 0.28, -2.2);
    t.group.add(bed);
    const pillow = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.18, 0.6),
      new THREE.MeshLambertMaterial({ color: 0xe8e4dc }));
    pillow.position.set(-3.4, 0.62, -3);
    t.group.add(pillow);
    this.game.city.addBox(t.originX - 4.25, -3.4, t.originX - 2.55, -1, 0.55, 'interior');
    const couch = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.8, 1),
      new THREE.MeshLambertMaterial({ color: 0x3e4e3e }));
    couch.position.set(2.8, 0.4, -3.2);
    t.group.add(couch);
    const tv = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 0.12),
      new THREE.MeshLambertMaterial({ color: 0x14161a, emissive: 0x223344, emissiveIntensity: 0.4 }));
    tv.position.set(2.8, 1.4, 0.6);
    t.group.add(tv);
    t.bed = { x: t.originX - 3.4, z: -2.2 };
  }

  // door template mapping: generic stores cycle; POIs get their own room
  templateForDoor(doorId) {
    return ['store', 'diner', 'laundry'][doorId % 3];
  }

  // ------------------------------------------------------------ door markers
  buildDoorMarkers() {
    const game = this.game;
    const doors = game.city.doors;
    // POI doors (gun shop, food, club, safehouse) at their markers
    this.poiDoors = [];
    const poi = game.city.pois;
    const add = (p, key) => { if (p) this.poiDoors.push({ x: p.x, z: p.z, template: key }); };
    add(poi.gunShop, 'gunshop');
    add(poi.foodShop, 'food');
    add(poi.nightclub, 'club');
    add(poi.safehouse, 'safehouse');

    const geo = new THREE.CylinderGeometry(0.75, 0.75, 1.6, 12, 1, true);
    this.doorMat = new THREE.MeshBasicMaterial({
      color: 0xf2d24a, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false,
    });
    const all = [...doors, ...this.poiDoors];
    const im = new THREE.InstancedMesh(geo, this.doorMat, all.length);
    const dummy = new THREE.Object3D();
    all.forEach((d, k) => {
      dummy.position.set(d.x, game.city.groundHeight(d.x, d.z) + 0.8, d.z);
      dummy.updateMatrix();
      im.setMatrixAt(k, dummy.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
    game.scene.add(im);
    this.doorMarkers = im;

    // exit marker (single, moved to the active room)
    this.exitMarker = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x4ad2f2, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.exitMarker.visible = false;
    game.scene.add(this.exitMarker);
  }

  keepers() {
    const t = this.current ? this.templates[this.current] : null;
    if (!t) return [];
    const list = [];
    if (t.keeper && !t.keeper.dead) list.push(t.keeper);
    for (const d of t.dancers ?? []) if (!d.dead) list.push(d);
    return list;
  }

  // ------------------------------------------------------------ enter/exit
  enter(template, doorId = null, returnSpot) {
    const game = this.game;
    const tpl = this.templates[template];
    if (!tpl) return;
    this.current = template;
    this.currentDoorId = doorId;
    this.returnSpot = returnSpot;
    this.robT = 0;
    this.robDrops = 0;
    this.transitionCD = 1.2;
    this.exitArmed = false;
    game.hud.fade(true);
    const place = () => {
      game.player.interiorY = 0;
      game.player.teleport(tpl.spawn.x, tpl.spawn.z, Math.PI);
      game.cameraRig.snapBehind(Math.PI, 0.3);
      tpl.light.intensity = 2.2;
      this.exitMarker.position.set(tpl.spawn.x, 0.8, tpl.exitZ);
      this.exitMarker.visible = true;
      game.hud.showZone(tpl.label);
      document.getElementById('minimap-wrap').style.visibility = 'hidden';
      game.hud.fade(false);
    };
    // instant transition under the headless sim clock; faded transition live
    if (game.headless) place(); else setTimeout(place, 420);
  }

  exit() {
    const game = this.game;
    const tpl = this.templates[this.current];
    this.transitionCD = 1.2;
    game.hud.fade(true);
    const place = () => {
      if (tpl) tpl.light.intensity = 0;
      game.player.interiorY = null;
      const r = this.returnSpot ?? { x: 0, z: 0, heading: 0 };
      game.player.teleport(r.x, r.z, r.heading);
      game.cameraRig.snapBehind(r.heading, 0.24);
      this.exitMarker.visible = false;
      this.current = null;
      this.exitLock = { x: game.player.pos.x, z: game.player.pos.z };
      document.getElementById('minimap-wrap').style.visibility = '';
      // the street heard about the robbery
      if (this.pendingHeat > 0) {
        game.wanted.state.heat = clamp(game.wanted.state.heat + this.pendingHeat, 0, 900);
        game.wanted.recalcStars();
        this.pendingHeat = 0;
      }
      game.hud.fade(false);
    };
    if (game.headless) place(); else setTimeout(place, 420);
  }

  // ------------------------------------------------------------ frame
  update(dt) {
    const game = this.game;
    const player = game.player;
    const t = game.time;
    this.doorMat.opacity = 0.24 + Math.sin(t * 3) * 0.1;
    if (this.transitionCD > 0) this.transitionCD -= dt;

    if (!this.current) {
      // check door proximity (on foot only), never right after a transition
      if (player.vehicle || player.dead || game.state.mode !== 'play' || this.transitionCD > 0) return;
      const px = player.pos.x, pz = player.pos.z;
      // spatial lockout: after exiting you stand on the door — no re-entry
      // until you've stepped clear of where you came out
      if (this.exitLock) {
        if (dist2d(px, pz, this.exitLock.x, this.exitLock.z) > 3.5) this.exitLock = null;
        else return;
      }
      for (const d of this.poiDoors) {
        if (dist2d(px, pz, d.x, d.z) < 1.4) {
          this.enter(d.template, null, { x: d.x, z: d.z + 1.6, heading: 0 });
          return;
        }
      }
      for (const d of game.city.doors) {
        if (Math.abs(d.x - px) < 1.4 && Math.abs(d.z - pz) < 1.4) {
          this.enter(this.templateForDoor(d.id), d.id, { x: d.x, z: d.z + d.face * 1.8, heading: d.face > 0 ? 0 : Math.PI });
          return;
        }
      }
      return;
    }

    // ---- inside ----
    const tpl = this.templates[this.current];
    if (!tpl) return;

    // exit door — only armed once the player has stepped away from it
    const distExit = dist2d(player.pos.x, player.pos.z, tpl.spawn.x, tpl.exitZ);
    if (distExit > 2) this.exitArmed = true;
    if (this.exitArmed && distExit < 1.2) {
      this.exitArmed = false;
      this.exit();
      return;
    }

    // keeper + dancers tick (guard state = stand still; provoked = fight)
    for (const k of this.keepers()) {
      k.update(dt, game);
      // dancers bounce
      if (tpl.dancers?.includes(k) && !k.dead && k.state === 'guard') {
        k.rig.group.position.y = Math.abs(Math.sin(t * 3.2 + k.id)) * 0.12;
        k.rig.group.rotation.y = k.heading + Math.sin(t * 1.1 + k.id) * 0.6;
      }
    }
    if (tpl.keeper?.dead && !tpl.keeperLooted) {
      tpl.keeperLooted = true;
      this.pendingHeat = Math.max(this.pendingHeat, 200);   // killing a clerk is serious
      if (tpl.register) game.worldlife?.dropCash(tpl.register.x, tpl.register.z - 0.8, 60 + Math.random() * 80);
    }

    // club lights swirl
    if (tpl.clubLights) {
      tpl.clubLights.forEach((L, i) => {
        L.intensity = this.current === 'club' ? 2.6 : 0;
        L.position.x = Math.sin(t * 0.9 + i * 2.1) * 5;
        L.position.z = Math.cos(t * 1.3 + i * 1.7) * 4;
      });
    }

    // counter shop
    if (tpl.counterAction && tpl.register &&
        dist2d(player.pos.x, player.pos.z, tpl.register.x, tpl.register.z) < 2.4 &&
        game.state.mode === 'play' && !tpl.keeper?.provoked) {
      if (!this.shopCooldown || t - this.shopCooldown > 4) {
        this.shopCooldown = t;
        game.worldlife.openShop(tpl.counterAction);
      }
    }

    // bed save
    if (tpl.bed && dist2d(player.pos.x, player.pos.z, tpl.bed.x, tpl.bed.z) < 1.6) {
      if (!this.bedCooldown || t - this.bedCooldown > 6) {
        this.bedCooldown = t;
        player.heal(100);
        const ok = game.save?.save();
        game.dayNight.minutes = (game.dayNight.minutes + 360) % 1440;   // nap 6 hours
        game.hud.showToast(ok ? 'Slept and saved. Six hours pass.' : 'Rested — saving failed.', 4);
        game.audio?.pickup();
      }
    }

    // ---- robbery: hold a gun on the keeper ----
    const keeper = tpl.keeper;
    if (keeper && !keeper.dead && !keeper.provoked) {
      const armed = game.combat && !['fists', 'bat'].includes(game.combat.current);
      const aiming = game.input.mouseDown[2] && armed;
      const close = dist2d(player.pos.x, player.pos.z, keeper.pos.x, keeper.pos.z) < 9;
      const doorKey = this.currentDoorId ?? this.current;
      if (aiming && close && !this.robbedDoors.has(doorKey)) {
        keeper.rig.setAnim('handsup');
        keeper.holdup = true;
        this.robT += dt;
        if (this.robT > 1.2 && this.robDrops < 5 && this.robT > 1.2 + this.robDrops * 0.9) {
          this.robDrops++;
          const amt = 25 + Math.floor(rand2i(typeof doorKey === 'number' ? doorKey : 99, this.robDrops, game.city.seed) * 55);
          game.worldlife?.dropCash(tpl.register.x, tpl.register.z - 0.9, amt);
          game.audio?.cash();
          this.pendingHeat = Math.max(this.pendingHeat, 95);   // ~2 stars waiting outside
          if (this.robDrops === 5) {
            this.robbedDoors.add(doorKey);
            game.hud.showToast('Register cleaned out. Now get gone.', 3.5);
          }
        }
        // brave keepers eventually go for the shotgun under the counter
        if (this.robT > 6 && rand2i(typeof doorKey === 'number' ? doorKey : 7, 13, game.city.seed) > 0.6) {
          keeper.provoked = true;
          keeper.state = 'attack';
          game.hud.showToast('The clerk pulled a shotgun!', 3);
        }
      } else if (keeper.holdup && !aiming) {
        keeper.holdup = false;
        keeper.rig.setAnim('idle');
        this.robT = 0;
      }
    }
  }
}
