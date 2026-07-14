// BAYVALE — main game bootstrap and loop.

import * as THREE from 'three';
import { generateCity } from './world/citygen.js';
import { buildTerrain } from './world/terrain.js';
import { buildCityMeshes } from './world/citymesh.js';
import { DayNight } from './world/daynight.js';
import { districtName } from './world/districts.js';
import { Input } from './core/input.js';
import { CameraRig } from './core/camera.js';
import { Player } from './entities/player.js';
import { Hud } from './ui/hud.js';
import { Minimap } from './ui/minimap.js';
import { clamp } from './core/mathutil.js';

const SEED = 20260713;

const $ = (id) => document.getElementById(id);

class Game {
  constructor() {
    this.state = {
      mode: 'loading',        // loading | menu | play | pause | map | shop | over
      money: 250,
      wanted: { stars: 0, heat: 0 },
      zone: '',
      waypoint: null,
      stats: { missionsPassed: 0, kills: 0, vehiclesJacked: 0, distanceDriven: 0, coins: 0 },
    };
    this.systems = [];
    this.blipProviders = [];
    this.time = 0;
  }

  async boot() {
    const canvas = $('game');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(innerWidth, innerHeight);

    this.THREE = THREE;            // shared reference for systems that build meshes
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 3200);

    const { Graphics } = await import('./core/graphics.js');
    this.gfx = new Graphics(this.renderer, this.scene, this.camera);
    // headless tests force ?q=low for speed
    const params = new URLSearchParams(location.search);
    if (params.get('q')) this.gfx.setQuality(params.get('q'));

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.gfx.resize(innerWidth, innerHeight);
    });

    const prog = async (pct, msg) => {
      $('loadbar').firstElementChild.style.width = pct + '%';
      $('loadmsg').textContent = msg;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    };

    await prog(5, 'unpacking the moving truck…');
    const { Assets } = await import('./core/assets.js');
    this.assets = new Assets();
    await this.assets.load((f) => {
      $('loadbar').firstElementChild.style.width = (5 + f * 18) + '%';
    });

    // entities pull their models from the shared registry
    const vehMod = await import('./entities/vehicle.js');
    vehMod.setPaintQuality(this.gfx.quality !== 'low');
    const humMod = await import('./entities/humanoid.js');
    humMod.setHumanoidAssets(this.assets);
    this._updateAnimLod = humMod.updateAnimLod;

    await prog(24, 'surveying the bay…');
    this.city = generateCity(SEED);

    await prog(28, 'paving 400 miles of road…');
    this.terrain = buildTerrain(this.city, this.scene, this.assets);

    await prog(55, 'raising the skyline…');
    this.cityMeshes = buildCityMeshes(this.city, this.scene, SEED, this.assets);

    await prog(74, 'wiring the streetlights…');
    this.dayNight = new DayNight(this.scene, this.gfx);

    // real sun/moon sky dome; its PMREM bake replaces the old HDRIs as the
    // scene environment and re-bakes as the light changes
    const { SkyDome } = await import('./world/sky.js');
    this.sky = new SkyDome(this.scene);
    this.dayNight.sky = this.sky;

    await prog(84, 'waking up the city…');
    this.input = new Input(canvas);
    this.cameraRig = new CameraRig(this.camera, this.city);
    this.player = new Player(this.city, this.scene);
    this.hud = new Hud();
    this.minimap = new Minimap(this.city);

    await prog(92, 'casting the extras…');
    // pre-warm the generated-asset caches so first encounters don't hitch:
    // body geometry variants + a spread of atlas looks
    try {
      const { characterFactory } = await import('./entities/charactermesh.js');
      if (characterFactory.init(this.assets)) {
        for (const v of ['male', 'female', 'heavy']) {
          for (const h of ['short', 'buzz', 'bob', 'afro', 'pony']) characterFactory.geometry(v, h, null);
        }
        for (const hat of ['cap', 'helmet', 'beanie']) characterFactory.geometry('male', 'short', hat);
      }
      const { materialForLook } = await import('./entities/charactertex.js');
      const { enrichLook } = await import('./entities/humanoid.js');
      for (let i = 0; i < 10; i++) materialForLook(enrichLook({}));
      for (const uniform of ['cop', 'fire', 'medic', 'keeper']) materialForLook(enrichLook({ uniform }));
    } catch (e) { console.warn('[boot] pre-warm skipped:', e.message); }

    // lazy-loaded gameplay systems land here in later phases
    await this.loadSystems(prog);

    await prog(99, 'warming up the shaders…');
    // every light the game will ever use is in the scene by now (pooled —
    // adding one later would recompile every material). Pay the full shader
    // compile cost here on the loading screen instead of as in-game freezes.
    try { this.renderer.compile(this.scene, this.camera); } catch {}

    await prog(100, 'done');
    this.showMenu();

    this.timer = new THREE.Timer();
    this.renderer.setAnimationLoop(() => this.frame());

    this.exposeDebug();
  }

  async loadSystems(prog) {
    // phase B+: vehicles/traffic/peds; phase C+: combat/wanted; phase D+: missions
    const load = async (path) => (await import(path)).default ?? (await import(path));
    try {
      await prog(88, 'shipping in vehicles…');
      const veh = await import('./systems/vehicles.js');
      this.vehicles = new veh.VehicleSystem(this);
      const traffic = await import('./systems/traffic.js');
      this.traffic = new traffic.TrafficSystem(this);
      const peds = await import('./systems/peds.js');
      this.peds = new peds.PedSystem(this);
      await prog(92, 'arming the citizens…');
      const combat = await import('./systems/combat.js');
      this.combat = new combat.CombatSystem(this);
      const wanted = await import('./systems/wanted.js');
      this.wanted = new wanted.WantedSystem(this);
      this.state.wanted = this.wanted.state;
      await prog(96, 'writing the story…');
      const missions = await import('./systems/missions.js');
      this.missions = new missions.MissionSystem(this);
      const world = await import('./systems/worldlife.js');
      this.worldlife = new world.WorldLife(this);
      const audio = await import('./core/audio.js');
      this.audio = new audio.AudioEngine(this);
      const radio = await import('./core/radio.js');
      this.audio.radio = new radio.Radio(this.audio);
      const fx = await import('./systems/particles.js');
      this.particles = new fx.ParticleSystem(this);
      const gore = await import('./systems/gore.js');
      this.gore = new gore.Gore(this);
      const save = await import('./core/save.js');
      this.save = new save.SaveSystem(this);
      const parked = await import('./systems/parkedcars.js');
      this.parkedCars = new parked.ParkedCars(this);
      const dispatch = await import('./systems/dispatch.js');
      this.dispatch = new dispatch.Dispatch(this);
      const interiors = await import('./systems/interiors.js');
      this.interiors = new interiors.Interiors(this);
      // interiors moved some POIs onto their claimed doors — re-sync the
      // markers that copied positions at construction time
      this.worldlife?.refreshPoiMarkers?.();
      this.missions?.refreshContactMarkers?.();
      const knock = await import('./systems/knockables.js');
      this.knockables = new knock.Knockables(this);
      const weather = await import('./systems/weather.js');
      this.weather = new weather.Weather(this);
      const voice = await import('./core/voice.js');
      this.voice = new voice.Voice(this);
    } catch (e) {
      // during phase A some modules don't exist yet — keep booting
      console.warn('[boot] optional system missing:', e.message);
    }
  }

  // ------------------------------------------------------------- menu / states
  showMenu() {
    this.setMode('menu');
    $('loading').classList.add('hidden');
    $('menu').classList.remove('hidden');
    const canCont = this.save?.hasSave?.();
    $('btn-continue').classList.toggle('disabled', !canCont);

    $('btn-new').onclick = () => this.newGame();
    $('btn-continue').onclick = () => { if (canCont) this.continueGame(); };
    $('btn-controls').onclick = () => $('helpbox').classList.toggle('hidden');
    $('btn-resume').onclick = () => this.resume();
    $('btn-pause-controls').onclick = () => $('helpbox').classList.toggle('hidden');
    $('btn-quit').onclick = () => location.reload();
    const qBtn = $('btn-quality');
    const syncQ = () => { qBtn.textContent = 'QUALITY: ' + this.gfx.quality.toUpperCase(); };
    syncQ();
    qBtn.onclick = () => {
      const order = ['low', 'medium', 'high'];
      const next = order[(order.indexOf(this.gfx.quality) + 1) % order.length];
      this.gfx.autoDrop = false;      // manual choice wins over auto-degrade
      this.gfx.setQuality(next);
      syncQ();
    };

    // idle menu camera drifting over downtown
    this.menuCamAngle = 0;
  }

  newGame() {
    const sp = this.city.pois.safehouse;
    const face = sp?.face ?? -1;
    // spawn on the sidewalk outside the safehouse door, facing it
    // (sp sits 5 m out from the door; step 2 m back toward it, clear of the
    // parking lane)
    this.player.teleport(sp ? sp.x : 0, sp ? sp.z - face * 2 : 0, face > 0 ? Math.PI : 0);
    this.cameraRig.snapBehind(this.player.heading);
    this.player.health = 100;
    this.state.money = 250;
    this.dayNight.minutes = 9 * 60 + 30;
    // a fresh start owes the law nothing — without this, heat, stars and
    // live cops from the previous session walk right into the new game
    this.wanted?.clear?.();
    this.missions?.reset?.();
    // starter loadout: the weapon system should be visible from minute one
    this.combat?.give?.('bat');
    this.combat?.give?.('pistol', 48);
    this.combat?.select?.('fists');
    this.startPlay();
    this.hud.showToast('Welcome to Bayvale. Find the yellow marker to start working.', 6);
    this.hud.say('Marco', 'Six years away… and the old city still smells like trouble.', 6);
    // staged control tips while the player finds their feet
    setTimeout(() => this.state.mode === 'play' && this.hud.showToast('Scroll or hold Q for your weapons — RMB aims, LMB swings or fires.', 5), 9000);
    setTimeout(() => this.state.mode === 'play' && this.hud.showToast('F enters cars. V changes camera. M opens the map.', 5), 22000);
  }

  continueGame() {
    this.save?.load?.();
    this.startPlay();
    this.hud.showToast('Game loaded.', 3);
  }

  startPlay() {
    $('menu').classList.add('hidden');
    $('helpbox').classList.add('hidden');
    this.hud.show();
    this.hud.fade(false);
    this.setMode('play');
    // death / arrest hooks
    this.player.onDied = () => this.beginDeathFlow('wasted');
    this.player.onDamaged = (amount, source, from) => this.hud.damageFlash(
      from ? Math.atan2(from.x - this.player.pos.x, from.z - this.player.pos.z) : null);
    this.player._audio = this.audio;
    this.player._gore = this.gore;
    this.deathFlow = null;
  }

  onBusted() {
    if (this.deathFlow || this.player.dead) return;
    this.beginDeathFlow('busted');
  }

  beginDeathFlow(kind) {
    if (this.deathFlow) return;
    this.deathFlow = { kind, t: 0, failedMission: this.missions?.active?.def.title ?? null };
    this.missions?.onPlayerDown?.(kind);
    // clean up transient states that a death would otherwise strand
    this.timeScale = 1;
    if (this.combat?.wheelOpen) { this.combat.wheelOpen = false; $('weaponwheel')?.classList.add('hidden'); }
    if (this.interiors?.current) this.interiors.forceExit();
    if (kind === 'wasted') {
      this.hud.showCenter('WASTED', 'wasted', '', 5);
      this.audio?.missionFailed?.();
    } else {
      this.hud.showCenter('BUSTED', 'busted', '', 5);
      this.player.dead = true;   // freeze controls during arrest
    }
  }

  updateDeathFlow(dt) {
    const f = this.deathFlow;
    if (!f) return;
    f.t += dt;
    if (f.t > 2.2 && !f.faded) {
      f.faded = true;
      this.hud.fade(true);
    }
    if (f.t > 3.2 && !f.done) {
      f.done = true;
      // respawn
      if (this.player.vehicle) this.vehicles?.exitVehicleForced();
      const poi = f.kind === 'wasted' ? this.city.pois.hospital : this.city.pois.policeHQ;
      const cost = f.kind === 'wasted'
        ? Math.min(100, Math.floor(this.state.money * 0.1))
        : Math.min(500, Math.floor(this.state.money * 0.15));
      this.state.money = Math.max(0, this.state.money - cost);
      this.wanted?.clear();
      this.player.dead = false;
      this.player.health = this.player.maxHealth;
      this.player.rig.dead = false;
      this.player.rig.deadT = 0;
      this.player.rig.group.rotation.x = 0;
      this.player.teleport(poi.x, poi.z - 3, 0);
      this.cameraRig.snapBehind(this.player.heading);
      this.hud.showToast(
        f.kind === 'wasted'
          ? `St. Aurora patched you up. -$${cost}`
          : `They took a cut and let you walk. -$${cost}`, 5);
      if (f.failedMission) {
        setTimeout(() => this.hud.showToast(`Mission failed — ${f.failedMission}. Return to the contact to retry.`, 5), 1800);
      }
    }
    if (f.t > 4.0) {
      this.hud.fade(false);
      this.deathFlow = null;
    }
  }

  setMode(m) {
    this.state.mode = m;
    if (m !== 'play') this.input?.releasePointer?.();
  }

  pause() {
    if (this.state.mode !== 'play') return;
    this.setMode('pause');
    const s = this.state.stats;
    $('pause-stats').innerHTML =
      `MISSIONS PASSED&nbsp; ${s.missionsPassed}<br>` +
      `KILLS&nbsp; ${s.kills}<br>` +
      `VEHICLES JACKED&nbsp; ${s.vehiclesJacked}<br>` +
      `LUCKY COINS&nbsp; ${s.coins} / 30<br>` +
      `CASH&nbsp; $${Math.round(this.state.money)}`;
    $('pause').classList.remove('hidden');
  }

  resume() {
    $('pause').classList.add('hidden');
    $('helpbox').classList.add('hidden');
    this.setMode('play');
  }

  // ------------------------------------------------------------- main loop
  frame() {
    this.timer.update();
    let dt = clamp(this.timer.getDelta(), 0, 0.05);
    if (this.timeScale && this.timeScale !== 1) dt *= this.timeScale;   // weapon-wheel slow-mo
    if (this.hitStopT > 0) { this.hitStopT -= dt; dt *= 0.15; }         // melee hit-stop
    this.time += dt;
    const mode = this.state.mode;

    // global hotkeys
    if (this.input) {
      if (this.input.wasPressed('Escape') || this.input.wasPressed('KeyP')) {
        if (mode === 'play') this.pause();
        else if (mode === 'pause') this.resume();
        else if (mode === 'map') this.toggleMap();
        else if (mode === 'shop') this.worldlife?.closeShop?.();
      }
      if (this.input.wasPressed('KeyM') && (mode === 'play' || mode === 'map')) this.toggleMap();
    }

    if (mode === 'play') this.updatePlay(dt);
    else if (mode === 'menu') this.updateMenu(dt);
    else if (mode === 'map') this.worldlife?.updateBigMap?.();

    // silence engine/siren/radio while paused or in menus
    this.audio?.setActive(mode === 'play');

    // day/night always ticks (freezes visuals in pause but cheap either way)
    if (mode === 'play' || mode === 'menu') {
      const focus = this.player?.pos ?? new THREE.Vector3();
      const night = this.dayNight.update(dt, focus);
      this.weather?.update(dt);
      if (this.weather) this.dayNight.cloud = this.weather.cloud;
      this.cityMeshes.setNight(night);
      this.terrain.setStarAlpha(night * 0.9 * (1 - (this.weather?.cloud ?? 0)));
      this.terrain.update(dt, this.time);
      this.vehicles?.setNight?.(night);
      this.refreshEnv();
    }

    this.gfx.render(dt);
    this.input?.endFrame();
  }

  // re-bake the procedural sky into scene.environment when the light or
  // weather moves enough. Each bake is a synchronous GPU stall, so it's
  // gated hard: coarse buckets (2 game-hours / half-cloud steps) plus a
  // real-time floor of one bake per minute. Direct sun/hemi light still
  // updates every frame — only the ambient env map steps coarsely.
  refreshEnv() {
    if (!this.sky) return;
    const now = performance.now() / 1000;
    if (this._envBakedAt && now - this._envBakedAt < 60) return;
    const key = Math.floor(this.dayNight.minutes / 120) + '|' +
      Math.round((this.weather?.cloud ?? 0) * 2);
    if (this.sky.refreshEnv(this.gfx, key)) this._envBakedAt = now;
  }

  updateMenu(dt) {
    this.menuCamAngle += dt * 0.05;
    const r = 260;
    const cx = Math.sin(this.menuCamAngle) * r;
    const cz = Math.cos(this.menuCamAngle) * r - 100;
    this.camera.position.set(cx, 130, cz);
    this.camera.lookAt(0, 20, -100);
  }

  updatePlay(dt) {
    const driving = !!this.player.vehicle;
    const aiming = !driving && this.input.mouseDown[2] && !this.player.dead;

    // camera snapshot for character animation LOD (uses last frame's
    // matrices — one frame of lag is invisible at these thresholds)
    this._updateAnimLod?.(this.camera);

    // camera control
    this.cameraRig.applyMouse(this.input.mouseDX, this.input.mouseDY);
    if (this.input.wasPressed('KeyV')) this.cameraRig.cycleDistance();

    // gameplay systems
    this.updateDeathFlow(dt);
    this.player.update(dt, this.input, this.cameraRig.yaw, aiming);
    this.vehicles?.update(dt);
    this.traffic?.update(dt);
    this.parkedCars?.update(dt);
    this.peds?.update(dt);
    this.combat?.update(dt, aiming);
    this.wanted?.update(dt);
    this.dispatch?.update(dt);
    this.interiors?.update(dt);
    this.missions?.update(dt);
    this.worldlife?.update(dt);
    this.particles?.update(dt);
    this.gore?.update(dt);
    this.knockables?.update(dt);
    this.voice?.update(dt);
    this.audio?.update(dt);

    // camera follows player or vehicle (re-read: enter/exit can happen mid-frame)
    const veh = this.player.vehicle;
    const camTarget = veh ? veh.pos : this.player.pos;
    const speed = veh ? veh.speed : this.player.speed2d;
    const insideRec = this.interiors?.playerInside;
    this.cameraRig.update(dt, camTarget, veh ? 2.1 : 1.55, {
      driving: !!veh, speed, aimMode: aiming,
      ceilY: insideRec ? insideRec.built.gy + 2.95 : null,   // stay under the room ceiling
    });
    // hide the player body in on-foot first-person so it doesn't clip the camera
    if (!veh && !this.player.dead) {
      this.player.rig.group.visible = !this.cameraRig.firstPerson;
    }

    // zone popups (streets only)
    const zone = this.interiors?.current ? this.state.zone
      : districtName(this.city.districtAt(this.player.pos.x, this.player.pos.z));
    if (zone && zone !== this.state.zone) {
      this.state.zone = zone;
      this.hud.showZone(zone);
    }

    // lock-on screen marker
    const lockEl = $('lockon');
    const lt = this.combat?.lockTarget;
    if (lt && !lt.dead) {
      const v = new THREE.Vector3(lt.pos.x, lt.pos.y + 1.1, lt.pos.z).project(this.camera);
      if (v.z < 1) {
        lockEl.classList.remove('hidden');
        lockEl.style.left = ((v.x * 0.5 + 0.5) * innerWidth) + 'px';
        lockEl.style.top = ((-v.y * 0.5 + 0.5) * innerHeight) + 'px';
      } else lockEl.classList.add('hidden');
    } else lockEl.classList.add('hidden');

    // HUD + minimap
    this.hud.update(dt, this);
    this.hud.setCrosshair(aiming, false, this.combat?.bloom || 0);
    const blips = [];
    for (const bp of this.blipProviders) bp(blips);
    this.minimap.draw(
      this.player.pos.x, this.player.pos.z,
      this.cameraRig.yaw,
      blips, this.state.waypoint, this.worldlife?.route
    );
  }

  toggleMap() {
    if (this.state.mode === 'map') {
      $('bigmap').classList.add('hidden');
      this.setMode('play');
    } else if (this.state.mode === 'play') {
      this.setMode('map');
      this.worldlife?.openBigMap?.();
      $('bigmap').classList.remove('hidden');
    }
  }

  // money helpers
  addMoney(n) { this.state.money += n; }
  spendMoney(n) {
    if (this.state.money < n) return false;
    this.state.money -= n;
    return true;
  }

  exposeDebug() {
    window.__game = {
      game: this,
      get mode() { return game.state.mode; },
      playerPos: () => ({ x: game.player.pos.x, y: game.player.pos.y, z: game.player.pos.z }),
      teleport: (x, z) => game.player.teleport(x, z),
      setTime: (h) => game.dayNight.setTime(h),
      money: () => game.state.money,
      addMoney: (n) => game.addMoney(n),
      wanted: () => game.state.wanted.stars,
      setWanted: (n) => game.wanted?.setStars(n),
      giveWeapon: (id, ammo) => game.combat?.give(id, ammo),
      spawnVehicle: (type) => game.vehicles?.debugSpawnNear(type),
      spawnVehicleOnRoad: (type) => {
        const v = game.vehicles?.spawnOnRoadNear(game.player.pos.x, game.player.pos.z, type);
        if (v) game.player.teleport(v.pos.x + 2.2, v.pos.z, v.heading);
        return v?.id;
      },
      enterNearestVehicle: () => game.vehicles?.tryEnterExit(true),
      startMission: (id) => game.missions?.debugStart(id),
      missionState: () => game.missions?.debugState(),
      drawCalls: () => game.renderer.info.render.calls,
      // fast-forward simulation without rendering (headless tests)
      tick: (seconds, step = 1 / 30) => {
        game.headless = true;    // interiors transition instantly under the sim clock
        const n = Math.floor(seconds / step);
        for (let i = 0; i < n; i++) {
          game.time += step;
          if (game.state.mode === 'play') game.updatePlay(step);
          const night = game.dayNight.update(step, game.player.pos);
          game.weather?.update(step);
          if (game.weather) game.dayNight.cloud = game.weather.cloud;
          game.cityMeshes.setNight(night);
          game.terrain.setStarAlpha(night * 0.9 * (1 - (game.weather?.cloud ?? 0)));
          game.vehicles?.setNight?.(night);
          game.input.endFrame();
        }
        game._envBakedAt = 0;   // tests fast-forward hours; skip the real-time floor
        game.refreshEnv();
      },
      setWeather: (s) => {
        const w = game.weather;
        if (!w) return;
        w.set(s);   // snap for tests: skip the gradual transition
        w.cloud = s === 'rain' ? 1 : s === 'overcast' ? 0.72 : 0.08;
        w.rain = s === 'rain' ? 1 : 0;
      },
      newGame: () => game.newGame(),
      city: () => ({ nodes: game.city.nodes.size, edges: game.city.edges.length, buildings: game.city.buildings.length }),
    };
  }
}

const game = new Game();
game.boot().catch((e) => {
  console.error('BOOT FAILED', e);
  const el = document.getElementById('loadmsg');
  if (el) { el.textContent = 'BOOT FAILED: ' + e.message; el.style.color = '#ff6a5e'; }
});
