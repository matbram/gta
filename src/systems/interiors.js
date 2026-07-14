// Walk-in interiors: every shopfront door opens into a real room built
// inside its building — you walk through the doorway, no fades and no
// teleports. Nearby buildings hollow out on approach (their solid ground
// floor is an instanced band that gets zeroed and replaced by a shell with
// a real door gap + interior). Includes shopkeepers, register robberies,
// counter shops, the nightclub floor and the safehouse bed.

import * as THREE from 'three';
import { Goon } from '../entities/goon.js';
import { dist2d, clamp, damp } from '../core/mathutil.js';
import { rand2i } from '../core/rng.js';

const BUILD_R = 95, TEARDOWN_R = 125;     // shell + collider bubble
const FURNISH_R = 45, UNFURNISH_R = 62;   // people + lights bubble
const DOOR_GAP = 2.4;
const WALL_T = 0.25;

const KEEPER_LOOKS = [
  { uniform: 'keeper', shirt: 0x6a8a5a },
  { uniform: 'keeper', shirt: 0x8a6a4a },
  { uniform: 'keeper', shirt: 0x5a6a8a },
];

const LABELS = {
  store: 'CORNER STORE', diner: 'DINER', laundry: 'LAUNDROMAT',
  gunshop: 'BULLSEYE ROUNDS', food: 'PRONTO BURGER',
  club: 'THE VELVET IGUANA', safehouse: 'SAFEHOUSE',
};

export class Interiors {
  constructor(game) {
    this.game = game;
    this.recs = [];
    this.builtSet = new Set();
    this.playerInside = null;   // rec while standing in a room
    this.current = null;        // template key of that rec (legacy field)
    this.robbedDoors = new Set();
    this.pendingHeat = 0;
    this.robT = 0;
    this.robDrops = 0;
    this.scanT = 0;
    this.counterArmed = true;

    // shared materials (rooms build/tear down constantly — never disposed)
    this.floorMat = game.assets?.pbrMaterial('concrete', { repeat: 3, color: 0xb8b0a4 })
      ?? new THREE.MeshLambertMaterial({ color: 0x8a8078 });
    this.wallMat = game.assets?.pbrMaterial('plaster', { repeat: 2, color: 0xcfc8b8 })
      ?? new THREE.MeshLambertMaterial({ color: 0xbfb8a8 });
    this.ceilMat = new THREE.MeshLambertMaterial({ color: 0x554f48 });
    this.doorGlassMat = new THREE.MeshLambertMaterial({
      color: 0x4a5a66, transparent: true, opacity: 0.45, side: THREE.DoubleSide,
    });
    this.lampMat = new THREE.MeshLambertMaterial({ color: 0xfff4d8, emissive: 0xffe8b0, emissiveIntensity: 0.8 });
    this.counterMat = new THREE.MeshLambertMaterial({ color: 0x6a5a48 });
    this.registerMat = new THREE.MeshLambertMaterial({ color: 0x2e3440 });
    this.shelfMat = new THREE.MeshLambertMaterial({ color: 0x7a6a58 });
    this.goodsMats = [0xb03a2e, 0x4a7fb5, 0xe8c84a, 0x5fae52].map((c) => new THREE.MeshLambertMaterial({ color: c }));
    this.boothMat = new THREE.MeshLambertMaterial({ color: 0x8a3a30 });
    this.washerMat = new THREE.MeshLambertMaterial({ color: 0xd8d4cc });
    this.rackMat = new THREE.MeshLambertMaterial({ color: 0x4a4038 });
    this.gunMat = new THREE.MeshLambertMaterial({ color: 0x23262b });
    this.bedMat = new THREE.MeshLambertMaterial({ color: 0x6a3a3a });
    this.pillowMat = new THREE.MeshLambertMaterial({ color: 0xe8e4dc });
    this.couchMat = new THREE.MeshLambertMaterial({ color: 0x3e4e3e });
    this.tvMat = new THREE.MeshLambertMaterial({ color: 0x14161a, emissive: 0x223344, emissiveIntensity: 0.4 });

    this.buildRecs();
    this.buildDoorMarkers();
  }

  buildRecs() {
    const city = this.game.city;
    const generic = ['store', 'diner', 'laundry', 'food'];
    for (const d of city.doors) {
      const b = city.buildings[d.b];
      if (!b) continue;
      const rec = {
        id: d.id, door: d, b,
        template: generic[d.id % generic.length],
        built: null, furnished: false,
        keeper: null, dancers: [], keeperDead: false, keeperLooted: false,
      };
      this.recs.push(rec);
    }
    // POIs claim their nearest enterable door; the map marker moves onto it
    const poi = city.pois;
    const claim = (p, key) => {
      if (!p) return;
      let best = null, bd = Infinity;
      for (const r of this.recs) {
        if (r.claimed) continue;
        const dd = dist2d(p.x, p.z, r.door.x, r.door.z);
        if (dd < bd) { bd = dd; best = r; }
      }
      if (best) {
        best.template = key;
        best.claimed = true;
        // map marker sits on the street just outside the claimed door
        p.x = best.door.x;
        p.z = best.door.z + best.door.face * 5;
        p.face = best.door.face;
      }
    };
    claim(poi.gunShop, 'gunshop');
    claim(poi.foodShop, 'food');
    claim(poi.nightclub, 'club');
    claim(poi.safehouse, 'safehouse');
  }

  buildDoorMarkers() {
    const game = this.game;
    const geo = new THREE.CylinderGeometry(0.75, 0.75, 1.6, 12, 1, true);
    this.doorMat = new THREE.MeshBasicMaterial({
      color: 0xf2d24a, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false,
    });
    const im = new THREE.InstancedMesh(geo, this.doorMat, this.recs.length);
    const dummy = new THREE.Object3D();
    this.recs.forEach((r, k) => {
      dummy.position.set(r.door.x, game.city.groundHeight(r.door.x, r.door.z) + 0.8, r.door.z);
      dummy.updateMatrix();
      im.setMatrixAt(k, dummy.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
    game.scene.add(im);
    this.doorMarkers = im;
  }

  // ------------------------------------------------------------ build/teardown
  build(rec) {
    if (rec.built) return;
    const game = this.game, city = game.city;
    const b = rec.b, face = rec.door.face;
    const gy = city.groundHeight(rec.door.x, rec.door.z);
    const w = b.w + 0.5, dep = b.d + 0.5;

    // hide the solid ground-floor band + retire the full-building collider
    if (b._bandSlot) {
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      b._bandSlot.mesh.setMatrixAt(b._bandSlot.idx, zero);
      b._bandSlot.mesh.instanceMatrix.needsUpdate = true;
    }
    if (b.box) { city.removeBox(b.box); b.box = null; }

    const g = new THREE.Group();
    g.position.set(b.x, gy, b.z);
    const boxes = [];
    const meshes = [];
    const mesh = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      g.add(m);
      meshes.push(m);
      return m;
    };
    const solid = (cx, cz, sx, sz, h, mat = this.wallMat, y = null) => {
      mesh(new THREE.BoxGeometry(sx, h, sz), mat, cx, y ?? h / 2, cz);
      boxes.push(city.addBox(b.x + cx - sx / 2, b.z + cz - sz / 2, b.x + cx + sx / 2, b.z + cz + sz / 2, h, 'interior', rec));
    };
    // mirror helper: rooms are authored with the door at +z
    const mz = (z) => (face > 0 ? z : -z);

    // shell — shopfront-style walls with a real doorway gap on the street
    const shopMat = game.cityMeshes && b._bandSlot ? b._bandSlot.mesh.material : this.wallMat;
    solid(0, mz(-(dep / 2 - WALL_T / 2)), w - WALL_T * 2, WALL_T, 3.2, shopMat);      // back
    solid(-(w / 2 - WALL_T / 2), 0, WALL_T, dep, 3.2, shopMat);                       // left
    solid(w / 2 - WALL_T / 2, 0, WALL_T, dep, 3.2, shopMat);                          // right
    const segW = (w - DOOR_GAP) / 2;
    const fz = mz(dep / 2 - WALL_T / 2);
    solid(-(DOOR_GAP / 2 + segW / 2), fz, segW, WALL_T, 3.2, shopMat);                // front L
    solid(DOOR_GAP / 2 + segW / 2, fz, segW, WALL_T, 3.2, shopMat);                   // front R
    // header above the doorway (visual only — you walk under it)
    mesh(new THREE.BoxGeometry(DOOR_GAP + 0.2, 1.0, WALL_T), shopMat, 0, 2.7, fz);

    // swinging glass door hinged at the gap's left edge
    const pivot = new THREE.Group();
    pivot.position.set(-DOOR_GAP / 2, 0, fz);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(DOOR_GAP - 0.12, 2.16, 0.06), this.doorGlassMat);
    leaf.position.set((DOOR_GAP - 0.12) / 2, 1.1, 0);
    pivot.add(leaf);
    g.add(pivot);
    rec.doorPivot = pivot;
    rec.doorOpen = 0;

    // floor + ceiling + light
    const floor = mesh(new THREE.BoxGeometry(w, 0.16, dep), this.floorMat, 0, -0.06, 0);
    floor.receiveShadow = true;
    mesh(new THREE.BoxGeometry(w, 0.14, dep), this.ceilMat, 0, 3.27, 0);
    mesh(new THREE.BoxGeometry(1.4, 0.08, 1.4), this.lampMat, 0, 3.12, 0);
    const light = new THREE.PointLight(0xffe8c0, 0, Math.max(w, dep) + 4, 2);
    light.position.set(0, 2.8, 0);
    g.add(light);

    rec.built = { group: g, boxes, w, dep, gy, light, face };
    rec.register = null;
    rec.bed = null;
    rec.counterAction = null;
    rec.clubLights = null;

    this.furnishStatic(rec, solid, mesh, mz);

    game.scene.add(g);
    this.builtSet.add(rec);
  }

  // fixed furniture per template, scaled into the building footprint
  furnishStatic(rec, solid, mesh, mz) {
    const b = rec.b;
    const w = b.w - 1.2, dep = b.d - 1.2;   // usable interior span
    const hw = w / 2, hd = dep / 2;
    const t = rec.template;

    const addCounter = (cx, cz, cw) => {
      solid(cx, mz(cz), cw, 0.8, 1.05, this.counterMat);
      const rx = cx + cw * 0.28;
      mesh(new THREE.BoxGeometry(0.45, 0.32, 0.4), this.registerMat, rx, 1.2, mz(cz));
      rec.register = { x: b.x + rx, z: b.z + mz(cz) };
    };

    if (t === 'store' || t === 'laundry') {
      addCounter(hw * 0.5, -hd * 0.55, Math.min(3, w * 0.3));
      const rows = dep > 10 ? 2 : 1;
      for (let r = 0; r < rows; r++) {
        const z = -hd * 0.1 + r * Math.min(2.4, hd * 0.5);
        solid(-hw * 0.25, mz(z), Math.min(w * 0.5, 6), 0.6, 1.5, this.shelfMat);
        for (let k = 0; k < 5; k++) {
          mesh(new THREE.BoxGeometry(0.4, 0.3, 0.35), this.goodsMats[(r * 3 + k) % 4],
            -hw * 0.25 - Math.min(w * 0.5, 6) / 2 + 0.5 + k * (Math.min(w * 0.5, 6) / 5), 1.66, mz(z));
        }
      }
      if (t === 'laundry') {
        for (let k = 0; k < Math.min(4, Math.floor(w / 1.4)); k++) {
          mesh(new THREE.BoxGeometry(0.9, 1.1, 0.8), this.washerMat, -hw + 0.8 + k * 1.1, 0.55, mz(-hd + 0.7));
        }
      }
    } else if (t === 'diner' || t === 'food') {
      addCounter(0, -hd * 0.6, Math.min(6, w * 0.5));
      for (const sx of [-hw * 0.6, hw * 0.6]) {
        for (const szf of [0.05, 0.45]) {
          if (Math.abs(sx) + 1.3 > hw) continue;
          solid(sx, mz(hd * szf), Math.min(2.4, hw * 0.5), 1.1, 0.9, this.boothMat);
        }
      }
      if (t === 'food') rec.counterAction = 'food';
    } else if (t === 'gunshop') {
      addCounter(0, -hd * 0.55, Math.min(5, w * 0.5));
      rec.counterAction = 'gunshop';
      const racks = Math.min(5, Math.floor(w / 2.2));
      for (let k = 0; k < racks; k++) {
        const x = -hw + 1.1 + k * 2.1;
        mesh(new THREE.BoxGeometry(0.9, 1.6, 0.12), this.rackMat, x, 1.7, mz(-hd + 0.45));
        const rifle = mesh(new THREE.BoxGeometry(0.08, 1.1, 0.06), this.gunMat, x, 1.7, mz(-hd + 0.55));
        rifle.rotation.z = 0.25;
      }
    } else if (t === 'club') {
      addCounter(-hw * 0.55, -hd * 0.5, Math.min(4, w * 0.35));
      rec.clubLights = [];
      for (const c of [0xff3366, 0x33aaff, 0xaaff33]) {
        const spot = new THREE.PointLight(c, 0, 16, 1.8);
        spot.position.set(Math.random() * 4 - 2, 2.6, Math.random() * 3 - 1.5);
        rec.built.group.add(spot);
        rec.clubLights.push(spot);
      }
    } else if (t === 'safehouse') {
      solid(-hw * 0.55, mz(-hd * 0.5), 1.7, 2.4, 0.55, this.bedMat);
      mesh(new THREE.BoxGeometry(1.5, 0.18, 0.6), this.pillowMat, -hw * 0.55, 0.62, mz(-hd * 0.5 - 0.8));
      solid(hw * 0.5, mz(-hd * 0.6), Math.min(2.6, hw * 0.8), 1.0, 0.8, this.couchMat);
      mesh(new THREE.BoxGeometry(1.6, 0.9, 0.12), this.tvMat, hw * 0.5, 1.4, mz(hd * 0.1));
      rec.bed = { x: b.x - hw * 0.55, z: b.z + mz(-hd * 0.5) };
    }
  }

  furnish(rec) {
    if (rec.furnished || !rec.built) return;
    // the club only comes alive after dark — daytime it's an empty room
    // (left unfurnished so night can still populate it)
    const hour = (this.game.dayNight?.minutes ?? 720) / 60;
    if (rec.template === 'club' && !(hour >= 20 || hour < 5)) return;
    rec.furnished = true;
    const b = rec.b, mzf = rec.built.face;
    const mz = (z) => (mzf > 0 ? z : -z);
    if (rec.template !== 'safehouse' && !rec.keeperDead) {
      const look = KEEPER_LOOKS[rec.id % KEEPER_LOOKS.length];
      const keeper = new Goon(this.game.city, this.game.scene, {
        health: 60, aggroRange: 0, shootRange: 10, damage: 14, accuracy: 0.55,
        shirt: look.shirt,
      });
      keeper.isKeeper = true;
      keeper.state = 'guard';
      keeper.interiorY = rec.built.gy;
      const kx = rec.register ? rec.register.x : b.x;
      const kz = rec.register ? rec.register.z - mz(1.0) : b.z;
      keeper.place(kx - 0.8, kz);
      keeper.heading = mzf > 0 ? Math.PI : 0;
      keeper.rig.group.rotation.y = keeper.heading;
      rec.keeper = keeper;
    }
    if (rec.template === 'club') {
      rec.dancers = [];
      for (let k = 0; k < 4; k++) {
        if (rec.dancerDead?.[k]) continue;
        const d = new Goon(this.game.city, this.game.scene, {
          health: 40, shirt: [0xe84a8a, 0x4ae8d8, 0xe8d84a, 0x8a4ae8][k],
        });
        d._slot = k;
        d.isKeeper = true;
        d.state = 'guard';
        d.interiorY = rec.built.gy;
        d.place(b.x + (k % 2) * 2.2 - 1, b.z + mz(-1 + Math.floor(k / 2) * 2.2));
        d.heading = Math.random() * 6.28;
        rec.dancers.push(d);
      }
    }
  }

  unfurnish(rec) {
    if (!rec.furnished) return;
    rec.furnished = false;
    if (rec.keeper) {
      if (rec.keeper.dead) rec.keeperDead = true;
      rec.keeper.dispose();
      rec.keeper = null;
    }
    // dead dancers stay dead across re-furnishes, like keepers
    for (const d of rec.dancers) {
      if (d.dead) (rec.dancerDead = rec.dancerDead || [])[d._slot] = true;
      d.dispose();
    }
    rec.dancers = [];
  }

  teardown(rec) {
    if (!rec.built) return;
    if (this.playerInside === rec) return;   // never yank the room out from under the player
    this.unfurnish(rec);
    const city = this.game.city;
    for (const box of rec.built.boxes) city.removeBox(box);
    rec.built.group.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
    rec.built.group.removeFromParent();
    // restore the solid band + full-building collider
    const b = rec.b;
    if (b._bandSlot) {
      const d2 = new THREE.Object3D();
      d2.position.set(b.x, city.groundHeight(b.x, b.z) + 1.6, b.z);
      d2.scale.set((b.w + 0.5) / 12, 1, (b.d + 0.5) / 12);
      d2.updateMatrix();
      b._bandSlot.mesh.setMatrixAt(b._bandSlot.idx, d2.matrix);
      b._bandSlot.mesh.instanceMatrix.needsUpdate = true;
    }
    if (!b.box) b.box = city.addBox(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2, b.h, 'building', b);
    rec.built = null;
    this.builtSet.delete(rec);
  }

  stream(px, pz) {
    for (const rec of this.recs) {
      const d = dist2d(px, pz, rec.door.x, rec.door.z);
      if (!rec.built && d < BUILD_R) this.build(rec);
      else if (rec.built && d > TEARDOWN_R) this.teardown(rec);
      if (rec.built) {
        if (!rec.furnished && d < FURNISH_R) this.furnish(rec);
        else if (rec.furnished && d > UNFURNISH_R) {
          // a provoked clerk mid-fight doesn't vanish in plain sight —
          // he stays until the fight ends or the player is truly gone
          const hot = rec.keeper && !rec.keeper.dead && rec.keeper.provoked;
          if (!hot || d > 120) {
            if (hot && this.game.combat?.lockTarget === rec.keeper) {
              this.game.combat.lockTarget = null;
            }
            this.unfurnish(rec);
          }
        }
      }
    }
  }

  keepers() {
    const list = [];
    for (const rec of this.builtSet) {
      if (rec.keeper && !rec.keeper.dead) list.push(rec.keeper);
      for (const d of rec.dancers) if (!d.dead) list.push(d);
    }
    return list;
  }

  // hard reset (death while inside): clear interior state, no teleporting
  forceExit() {
    const game = this.game;
    if (!this.playerInside) return;
    const rec = this.playerInside;
    if (rec.built) rec.built.light.intensity = 0;
    game.player.interiorY = null;
    game.audio?.setIndoors?.(false);
    this.playerInside = null;
    this.current = null;
    this.pendingHeat = 0;
    document.getElementById('minimap-wrap').style.visibility = '';
  }

  enterState(rec) {
    const game = this.game;
    this.playerInside = rec;
    this.current = rec.template;
    this.robT = 0;               // robDrops lives on the rec — stepping out
    this.counterArmed = true;    // and back in can't reset a half-done heist
    game.player.interiorY = rec.built.gy;
    rec.built.light.intensity = 2.2;
    game.audio?.chime?.();
    game.audio?.setIndoors?.(true);
    game.hud.showZone(LABELS[rec.template] ?? 'STORE');
    document.getElementById('minimap-wrap').style.visibility = 'hidden';
  }

  exitState() {
    const game = this.game;
    const rec = this.playerInside;
    if (rec?.built) rec.built.light.intensity = 0.6;
    this.playerInside = null;
    this.current = null;
    game.player.interiorY = null;
    game.audio?.setIndoors?.(false);
    document.getElementById('minimap-wrap').style.visibility = '';
    if (this.pendingHeat > 0) {
      game.wanted.state.heat = clamp(game.wanted.state.heat + this.pendingHeat, 0, 900);
      game.wanted.recalcStars();
      this.pendingHeat = 0;
    }
  }

  // ------------------------------------------------------------ frame
  update(dt) {
    const game = this.game;
    const player = game.player;
    const t = game.time;
    this.doorMat.opacity = 0.24 + Math.sin(t * 3) * 0.1;

    const px = player.pos.x, pz = player.pos.z;
    this.scanT -= dt;
    if (this.scanT <= 0) { this.scanT = 0.4; this.stream(px, pz); }

    // player-inside detection (walking through the doorway, no teleport)
    let inside = null;
    for (const rec of this.builtSet) {
      const b = rec.b;
      if (Math.abs(px - b.x) < (b.w + 0.5) / 2 - 0.2 &&
          Math.abs(pz - b.z) < (b.d + 0.5) / 2 - 0.2) { inside = rec; break; }
    }
    if (inside && this.playerInside !== inside) {
      if (this.playerInside) this.exitState();
      this.enterState(inside);
    } else if (!inside && this.playerInside) {
      this.exitState();
    }

    for (const rec of this.builtSet) {
      // door leaf swings open as anyone approaches the doorway
      if (rec.doorPivot) {
        const near = dist2d(px, pz, rec.door.x, rec.door.z) < 2.6;
        rec.doorOpen = damp(rec.doorOpen ?? 0, near ? 1 : 0, 8, dt);
        rec.doorPivot.rotation.y = rec.doorOpen * -1.9 * rec.door.face;
      }

      // people
      if (rec.furnished) {
        if (rec.keeper) {
          rec.keeper.update(dt, game);
          if (rec.keeper.dead && !rec.keeperLooted) {
            rec.keeperLooted = true;
            rec.keeperDead = true;
            // killing a clerk is serious. If the player is inside, the heat
            // waits for the street; killed from outside, it lands right now.
            if (this.playerInside === rec) {
              this.pendingHeat = Math.max(this.pendingHeat, 200);
            } else {
              game.wanted.state.heat = clamp(game.wanted.state.heat + 200, 0, 900);
              game.wanted.recalcStars();
            }
            if (rec.register) game.worldlife?.dropCash(rec.register.x, rec.register.z - 0.8, 60 + Math.random() * 80);
          }
        }
        for (const d of rec.dancers) {
          if (d.dead) continue;
          d.update(dt, game);
          if (d.state === 'guard') {
            d.rig.group.position.y = rec.built.gy + Math.abs(Math.sin(t * 3.2 + d.id)) * 0.12;
            d.rig.group.rotation.y = d.heading + Math.sin(t * 1.1 + d.id) * 0.6;
          }
        }
      }

      // club lights swirl while anyone's around
      if (rec.clubLights && rec.furnished) {
        rec.clubLights.forEach((L, i) => {
          L.intensity = this.playerInside === rec ? 2.6 : 0.8;
          L.position.x = Math.sin(t * 0.9 + i * 2.1) * 4;
          L.position.z = Math.cos(t * 1.3 + i * 1.7) * 3;
        });
      }
    }

    // ---- gameplay inside the current room ----
    const rec = this.playerInside;
    if (!rec) return;

    // counter shop — opens once per approach; step away to re-arm
    if (rec.counterAction && rec.register) {
      const atCounter = dist2d(px, pz, rec.register.x, rec.register.z) < 2.4;
      if (!atCounter) this.counterArmed = true;
      if (atCounter && this.counterArmed && game.state.mode === 'play' && !rec.keeper?.provoked) {
        this.counterArmed = false;
        game.worldlife.openShop(rec.counterAction);
      }
    }

    // bed save
    if (rec.bed && dist2d(px, pz, rec.bed.x, rec.bed.z) < 2.7) {
      if (!this.bedCooldown || t - this.bedCooldown > 6) {
        this.bedCooldown = t;
        player.heal(100);
        game.dayNight.minutes = (game.dayNight.minutes + 360) % 1440;   // nap 6 hours
        const ok = game.save?.save();     // save AFTER the nap so it's kept
        game.hud.showToast(ok ? 'Slept and saved. Six hours pass.' : 'Rested — saving failed.', 4);
        game.audio?.pickup();
      }
    }

    // ---- robbery: hold a gun on the keeper ----
    const keeper = rec.keeper;
    if (keeper && !keeper.dead && !keeper.provoked) {
      const armed = game.combat && !['fists', 'bat'].includes(game.combat.current);
      const aiming = game.input.mouseDown[2] && armed;
      const close = dist2d(px, pz, keeper.pos.x, keeper.pos.z) < 9;
      if (aiming && close && !this.robbedDoors.has(rec.id)) {
        keeper.rig.setAnim('handsup');
        keeper.holdup = true;
        this.robT += dt;
        rec.robDrops = rec.robDrops ?? 0;
        if (this.robT > 1.2 && rec.robDrops < 5 && this.robT > 1.2 + rec.robDrops * 0.9) {
          rec.robDrops++;
          const amt = 25 + Math.floor(rand2i(rec.id, rec.robDrops, game.city.seed) * 55);
          game.worldlife?.dropCash(rec.register.x, rec.register.z - 0.9, amt);
          game.audio?.cash();
          this.pendingHeat = Math.max(this.pendingHeat, 95);   // ~2 stars waiting outside
          if (rec.robDrops === 5) {
            this.robbedDoors.add(rec.id);
            game.hud.showToast('Register cleaned out. Now get gone.', 3.5);
            game.voice?.say?.('robbery');
          }
        }
        // brave keepers eventually go for the shotgun under the counter
        if (this.robT > 6 && rand2i(rec.id, 13, game.city.seed) > 0.6) {
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
