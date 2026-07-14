// Wanted system: heat → stars, escalating police response
// (foot cops → cruisers → roadblocks → tactical units), line-of-sight
// evasion decay, and the arrest hand-off to the busted flow.

import { Cop } from '../entities/cop.js';
import { clamp, dist2d, distSq2d, lerp } from '../core/mathutil.js';

const CRIME_HEAT = {
  assault: 6, kill: 34, carjack: 12, crash: 1.5, explosion: 60,
  gunfire: 3, copAttack: 55, copKill: 95, breakin: 5,
};

const STAR_TH = [0, 25, 80, 180, 330, 500, 650];

// per star: max foot cops, max cruisers, cruiser aggression, tough cops
const RESPONSE = [
  { foot: 0, cars: 0 },
  { foot: 2, cars: 0 },
  { foot: 3, cars: 1 },
  { foot: 4, cars: 2, roadblocks: true },
  { foot: 5, cars: 3, roadblocks: true },
  { foot: 6, cars: 4, roadblocks: true, tough: true },
  { foot: 8, cars: 5, roadblocks: true, tough: true },
];

export class WantedSystem {
  constructor(game) {
    this.game = game;
    this.state = { stars: 0, heat: 0 };
    this.footCops = [];
    this.cruisers = [];        // { vehicle, state, unloadT, cops }
    this.unseenT = 0;
    this.spawnT = 0;
    this.roadblockT = 20;
    this.decayT = 0;
    // police intelligence: where they last saw you, which car they think
    // you're in, and whether you've slipped their description
    this.lastKnown = null;
    this.knownVehicle = null;
    this.incognito = false;
    this.playerSeen = false;
    this._proxT = 0;
    // chopper searchlight lives in the scene permanently (intensity 0 when
    // grounded) — adding a light mid-game forces every material in the scene
    // to recompile its shader, which reads as a multi-second freeze at 5★
    if (game.THREE && game.scene) {
      const spot = new game.THREE.SpotLight(0xffffff, 0, 120, 0.35, 0.4, 1.5);
      game.scene.add(spot);
      game.scene.add(spot.target);
      this.chopperSpot = spot;
    }
  }

  // ---------------- heat ----------------
  // culprit: 'player' (default) or 'ai'. Wanted heat is the PLAYER's rap
  // sheet — AI-caused mayhem must never raise it. AI crimes still get a
  // police response (a unit investigates) but add zero heat.
  crime(kind, x, z, culprit = 'player') {
    if (culprit !== 'player') {
      let cop = this.nearestCop(x, z, 240);
      if (!cop) cop = this.spawnFootCop(false, true);
      if (cop && !cop.investigate) cop.investigate = { x, z, t: 0 };
      return;
    }
    const heat = CRIME_HEAT[kind] ?? 4;
    // quiet crimes need a witness; a lonely street keeps your secrets
    const quiet = ['carjack', 'assault', 'kill', 'breakin'].includes(kind);
    if (quiet && !this.hasWitness(x, z)) {
      if (kind === 'kill') {
        // no witness, but a body will be found eventually — half heat
        this.state.heat = clamp(this.state.heat + CRIME_HEAT.kill * 0.5, 0, 900);
        this.recalcStars(true);
      }
      return;
    }
    // a witnessed/loud crime marks the spot and blows any disguise
    this.incognito = false;
    this.lastKnown = { x, z };
    const nearCop = this.nearestCop(x, z, 45);
    if (nearCop) nearCop.provoked = true;
    // witnesses matter less out in the countryside
    const district = this.game.city.districtAt(x, z);
    const mult = ({ farm: 0.5, heights: 0.7 })[district] ?? 1;
    this.state.heat = clamp(this.state.heat + heat * mult, 0, 900);
    this.recalcStars();
  }

  // is anyone actually watching this spot? civilians use their real sight
  // cones; cops, cruisers and passing drivers count too
  hasWitness(x, z) {
    const g = this.game;
    const gy = g.city.groundHeight(x, z);
    for (const ped of g.peds?.peds ?? []) {
      if (!ped.dead && ped.state !== 'driver' && ped.seePoint?.(x, z, { range: 24 })) return true;
    }
    for (const c of this.footCops) {
      if (!c.dead && distSq2d(c.pos.x, c.pos.z, x, z) < 45 * 45 &&
          this.lineOfSight(c.pos.x, c.pos.y + 1.5, c.pos.z, x, gy + 1.2, z)) return true;
    }
    for (const cr of this.cruisers) {
      if (!cr.vehicle.dead && distSq2d(cr.vehicle.pos.x, cr.vehicle.pos.z, x, z) < 50 * 50) return true;
    }
    for (const car of g.traffic?.cars ?? []) {
      if (car.driverPed && distSq2d(car.vehicle.pos.x, car.vehicle.pos.z, x, z) < 20 * 20) return true;
    }
    return false;
  }

  // player got into a different car — if nobody watched the switch, the
  // description the police are working from is now wrong
  onPlayerVehicleChange(v) {
    if (this.state.stars === 0) { this.knownVehicle = v.id; return; }
    if (this.knownVehicle != null && v.id !== this.knownVehicle && !this.incognito &&
        this.unseenT > 1.2 && !this.hasWitness(v.pos.x, v.pos.z)) {
      this.incognito = true;
      this.game.voice?.say?.('incognito', 0.8);
      this.game.hud?.showToast('Nobody saw the switch — they’re still looking for the old car.', 3.5);
      setTimeout(() => this.game.audio?.bark?.('scanner2', v.pos.x, v.pos.z), 300);
    } else if (this.unseenT <= 1.2) {
      this.knownVehicle = v.id;   // they watched you get in
    }
  }

  setStars(n) {
    this.state.heat = STAR_TH[clamp(n, 0, 6)] + 1;
    this.recalcStars(true);
  }

  // a civilian phoned it in: a unit is sent to look at the spot. Only
  // reports about the PLAYER bump the player's heat — someone calling in
  // an AI driver's hit-and-run sends a cop, not stars.
  reportCrime(x, z, culprit = 'player') {
    if (culprit === 'player') {
      this.state.heat = clamp(this.state.heat + 16, 0, 900);
      this.recalcStars();
    }
    // point an existing patrol/foot cop at the scene, or spawn one nearby
    let cop = this.nearestCop(x, z, 240);
    if (!cop) cop = this.spawnFootCop(false, true);
    if (cop) cop.investigate = { x, z, t: 0 };
  }

  clear() {
    this.state.heat = 0;
    this.state.stars = 0;
    this.lastKnown = null;
    this.knownVehicle = null;
    this.incognito = false;
    this.playerSeen = false;
    this.unseenT = 0;
    this.despawnAll(true);
  }

  recalcStars(silent = false) {
    const h = this.state.heat;
    let stars = 0;
    for (let i = 6; i >= 1; i--) if (h >= STAR_TH[i]) { stars = i; break; }
    if (stars > this.state.stars && !silent) {
      this.game.audio?.wantedUp();
      this.game.voice?.say?.('cops', 0.7);
      // police scanner call-out on first wanted + escalations
      if (this.state.stars === 0) {
        const p = this.game.player.pos;
        setTimeout(() => this.game.audio?.bark?.('scanner1', p.x, p.z), 400);
      }
    }
    if (stars > this.state.stars) this.unseenT = 0;
    this.state.stars = stars;
  }

  // ---------------- helpers ----------------
  lineOfSight(x1, y1, z1, x2, y2, z2) {
    const city = this.game.city;
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.5) return true;
    // exact segment-vs-AABB tests on colliders gathered along the corridor —
    // point sampling missed the 0.25m interior walls of hollowed shopfronts
    const seen = new Set();
    const strides = Math.max(1, Math.ceil(dist / 8));
    for (let i = 0; i <= strides; i++) {
      const ts = i / strides;
      for (const b of city.queryColliders(x1 + dx * ts, z1 + dz * ts, 5.2)) {
        if (seen.has(b) || b.gone) continue;
        seen.add(b);
        let t0 = 0, t1 = 1;
        if (Math.abs(dx) < 1e-9) {
          if (x1 < b.minX || x1 > b.maxX) continue;
        } else {
          let ta = (b.minX - x1) / dx, tb = (b.maxX - x1) / dx;
          if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        }
        if (Math.abs(dz) < 1e-9) {
          if (z1 < b.minZ || z1 > b.maxZ) continue;
        } else {
          let ta = (b.minZ - z1) / dz, tb = (b.maxZ - z1) / dz;
          if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        }
        if (t1 <= t0 || t1 <= 0.02 || t0 >= 0.98) continue;
        const tm = (Math.max(t0, 0) + Math.min(t1, 1)) / 2;
        const ground = city.groundHeight(x1 + dx * tm, z1 + dz * tm);
        if (y1 + dy * tm < ground + b.h) return false;
      }
    }
    return true;
  }

  // player took this cruiser — hand it over as a normal car
  releaseCruiser(vehicle) {
    const cr = this.cruisers.find((c) => c.vehicle === vehicle);
    if (!cr) return;
    this.game.audio?.stopSiren(vehicle.id);
    vehicle.sirenOn = false;
    vehicle.flashSiren(0);
    this.cruisers.splice(this.cruisers.indexOf(cr), 1);
  }

  nearestCop(x, z, maxDist) {
    let best = null, bd = maxDist * maxDist;
    for (const c of this.footCops) {
      if (c.dead) continue;
      const d = distSq2d(c.pos.x, c.pos.z, x, z);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  // ---------------- update ----------------
  update(dt) {
    const game = this.game;
    const player = game.player;
    const stars = this.state.stars;
    const resp = RESPONSE[stars];

    // ---- evasion / decay ----
    // ducking into a store breaks line of sight: hiding indoors works.
    // Incognito (unseen car switch) shrinks every sight range; an authority
    // vehicle while incognito makes you effectively one of them.
    const indoors = !!game.interiors?.playerInside;
    const authority = this.incognito &&
      ['police', 'ambulance', 'firetruck'].includes(player.vehicle?.type);
    const copRange = this.incognito ? 22 : 70;
    const cruiserRange = this.incognito ? 28 : 90;
    let seen = false;
    if (!indoors && !authority) for (const c of this.footCops) {
      if (!c.dead && distSq2d(c.pos.x, c.pos.z, player.pos.x, player.pos.z) < copRange * copRange &&
          this.lineOfSight(c.pos.x, c.pos.y + 1.5, c.pos.z, player.pos.x, player.pos.y + 1, player.pos.z)) { seen = true; break; }
    }
    if (!seen && !indoors && !authority) for (const cr of this.cruisers) {
      const v = cr.vehicle;
      if (v.dead) continue;
      const d2 = distSq2d(v.pos.x, v.pos.z, player.pos.x, player.pos.z);
      // parked roadblocks only spot you up close; pursuers need line of sight
      const range = cr.state === 'block' ? (this.incognito ? 14 : 30) : cruiserRange;
      if (d2 < range * range &&
          this.lineOfSight(v.pos.x, v.pos.y + 1.6, v.pos.z, player.pos.x, player.pos.y + 1.2, player.pos.z)) {
        seen = true; break;
      }
    }
    // the uniform only holds up from a distance — loiter next to a real
    // officer for a few seconds and the game is up
    if (authority) {
      let near = false;
      for (const c of this.footCops) {
        if (!c.dead && distSq2d(c.pos.x, c.pos.z, player.pos.x, player.pos.z) < 100) { near = true; break; }
      }
      if (!near) for (const cr of this.cruisers) {
        if (!cr.vehicle.dead && distSq2d(cr.vehicle.pos.x, cr.vehicle.pos.z, player.pos.x, player.pos.z) < 144) { near = true; break; }
      }
      this._proxT = near ? this._proxT + dt : 0;
      if (this._proxT > 4) {
        this._proxT = 0;
        this.incognito = false;
        game.hud?.showToast("Your cover's blown!", 3);
      }
    } else this._proxT = 0;

    this.playerSeen = seen;
    if (seen) {
      this.lastKnown = { x: player.pos.x, z: player.pos.z };
      if (this.incognito) this.incognito = false;
      if (player.vehicle) this.knownVehicle = player.vehicle.id;
    }
    if (stars > 0) {
      if (seen) {
        this.unseenT = 0;
        // sustained pressure: heat stays put while seen
      } else {
        this.unseenT += dt;
        // out of sight: decay a star roughly every 7 seconds unseen —
        // twice as fast when they're chasing the wrong car
        if (this.unseenT > (this.incognito ? 3 : 6)) {
          this.state.heat = Math.max(0, this.state.heat - dt * (14 + stars * 4) * (this.incognito ? 2 : 1));
          this.recalcStars(true);
          if (this.state.stars < stars) this.unseenT = 3;   // partial reset per star lost
        }
      }
      // slow passive decay even when seen (crimes must continue to sustain 6★)
      this.state.heat = Math.max(0, this.state.heat - dt * 0.8);
      this.recalcStars(true);
      // you actually lost them
      if (this.state.stars === 0) {
        game.hud?.showCenter('EVADED', 'passed', '', 3);
        game.audio?.pickup?.();
        game.voice?.say?.('evaded', 0.9);
        this.incognito = false;
        this.knownVehicle = null;
        this.lastKnown = null;
      }
    } else {
      this.state.heat = Math.max(0, this.state.heat - dt * 3);
    }

    // ---- spawn response ----
    this.spawnT -= dt;
    if (stars >= 1 && this.spawnT <= 0) {
      this.spawnT = clamp(6 - stars, 1.5, 6);
      const aliveFoot = this.footCops.filter((c) => !c.dead).length;
      if (aliveFoot < resp.foot) this.spawnFootCop(resp.tough && Math.random() < 0.5);
      const aliveCars = this.cruisers.filter((c) => !c.vehicle.dead).length;
      if (aliveCars < resp.cars) this.spawnCruiser();
    }

    // ---- beat patrol: the city always has a couple of cops walking around ----
    if (stars === 0 && this.spawnT <= 0) {
      this.spawnT = 4;
      const patrols = this.footCops.filter((c) => !c.dead && c.patrol).length;
      if (patrols < 2) {
        const cop = this.spawnFootCop(false, true);
        if (cop) {
          // walk a sidewalk beat like a civilian
          const ep = game.city.nearestEdgePoint(cop.pos.x, cop.pos.z);
          if (ep) cop.setSidewalk(ep.edge);
        }
      }
    }

    // roadblocks ahead of a driving player
    if (resp.roadblocks && player.vehicle && Math.abs(player.vehicle.speed) > 8) {
      this.roadblockT -= dt;
      if (this.roadblockT <= 0) {
        this.roadblockT = 16 - stars;
        this.spawnRoadblock();
      }
    }

    // helicopter from 5 stars: circles overhead with a searchlight
    // (hysteresis: stays airborne until you drop below 4 so it doesn't flicker)
    if (stars >= 5 && !this.chopper) this.spawnChopper();
    else if (stars < 4 && this.chopper) this.despawnChopper();
    if (this.chopper) this.updateChopper(dt);

    // ---- run cops ----
    for (const cop of [...this.footCops]) {
      cop.update(dt, game);
      const d = dist2d(cop.pos.x, cop.pos.z, player.pos.x, player.pos.z);
      const cullDist = cop.patrol ? 230 : (stars === 0 ? 60 : 260);
      if ((cop.dead && cop.removeTimer > 20) || d > cullDist) {
        cop.dispose();
        this.footCops.splice(this.footCops.indexOf(cop), 1);
      }
    }

    // ---- run cruisers ----
    for (const cr of [...this.cruisers]) {
      this.driveCruiser(cr, dt);
      const v = cr.vehicle;
      const d = dist2d(v.pos.x, v.pos.z, player.pos.x, player.pos.z);
      if (v.dead || d > 320 || (stars === 0 && d > 80)) {
        game.audio?.stopSiren(v.id);
        if (!v.dead) game.vehicles.remove(v);
        this.cruisers.splice(this.cruisers.indexOf(cr), 1);
      }
    }

    // periodic police-scanner chatter while actively wanted
    if (stars >= 1) {
      this.scannerT = (this.scannerT ?? 12) - dt;
      if (this.scannerT <= 0) {
        this.scannerT = 14 + Math.random() * 12;
        const p = player.pos;
        this.game.audio?.playBuffer?.(Math.random() < 0.5 ? 'scanner1' : 'scanner2', { gain: 0.5 });
      }
    } else this.scannerT = 8;

    // stars gone → stand down
    if (stars === 0 && (this.footCops.length || this.cruisers.length)) {
      // cops walk off / cruisers drive away handled by distance culls above;
      // also stop sirens
      for (const cr of this.cruisers) { cr.vehicle.sirenOn = false; this.game.audio?.stopSiren(cr.vehicle.id); }
    }
  }

  // ---------------- spawning ----------------
  spawnFootCop(tough = false, patrol = false) {
    const game = this.game;
    const p = game.player.pos;
    // spawn just off-screen on a sidewalk
    for (let tries = 0; tries < 8; tries++) {
      const a = Math.random() * Math.PI * 2;
      const d = patrol ? 70 + Math.random() * 80 : 45 + Math.random() * 45;
      const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
      if (!game.city.landAt(x, z)) continue;
      const cop = new Cop(game.city, game.scene, tough);
      cop.place(x, z);
      cop.patrol = patrol;
      this.footCops.push(cop);
      return cop;
    }
    return null;
  }

  spawnCruiser() {
    const game = this.game;
    const p = game.player.pos;
    for (let tries = 0; tries < 8; tries++) {
      const a = Math.random() * Math.PI * 2;
      const d = 100 + Math.random() * 80;
      const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
      const v = game.vehicles.spawnOnRoadNear(x, z, 'police');
      if (!v) continue;
      if (dist2d(v.pos.x, v.pos.z, p.x, p.z) < 60) { game.vehicles.remove(v); continue; }
      v.sirenOn = true;
      v.aiControlled = true;
      game.audio?.startSiren(v.id, () => ({ x: v.pos.x, z: v.pos.z }));
      const cr = { vehicle: v, state: 'pursue', unloaded: false, stuckT: 0 };
      this.cruisers.push(cr);
      return cr;
    }
    return null;
  }

  spawnRoadblock() {
    const game = this.game;
    const player = game.player;
    const v = player.vehicle;
    if (!v) return;
    // project ahead along velocity
    const sp = Math.hypot(v.vel.x, v.vel.y) || 1;
    const px = v.pos.x + (v.vel.x / sp) * 130;
    const pz = v.pos.z + (v.vel.y / sp) * 130;
    const ep = game.city.nearestEdgePoint(px, pz);
    if (!ep || dist2d(ep.x, ep.z, player.pos.x, player.pos.z) < 70) return;
    // two cruisers parked across the road
    const e = ep.edge;
    const across = e.horizontal ? 0 : Math.PI / 2;
    for (const off of [-2.6, 2.6]) {
      const bx = e.horizontal ? ep.x + off : ep.x;
      const bz = e.horizontal ? ep.z : ep.z + off;
      const car = game.vehicles.spawn('police', bx, bz, across);
      car.sirenOn = true;
      const cr = { vehicle: car, state: 'block', unloaded: false, stuckT: 0 };
      this.cruisers.push(cr);
    }
    // pair of cops at the block
    for (let i = 0; i < 2; i++) {
      const cop = new Cop(game.city, game.scene, this.state.stars >= 5);
      cop.place(ep.x + (Math.random() - 0.5) * 6, ep.z + (Math.random() - 0.5) * 6);
      this.footCops.push(cop);
    }
  }

  // ---------------- cruiser AI ----------------
  driveCruiser(cr, dt) {
    const game = this.game;
    const v = cr.vehicle;
    if (v.dead) return;
    const player = game.player;
    const px = player.pos.x, pz = player.pos.z;
    const d = dist2d(v.pos.x, v.pos.z, px, pz);
    v.flashSiren(game.time);

    if (cr.state === 'block') {
      // parked across the road; unload cops if the player is close
      if (!cr.unloaded && d < 55) this.unloadCops(cr);
      v.updatePhysics(dt, { throttle: 0, steer: 0, handbrake: true });
      return;
    }

    // pursue: intercept-lead the player's car, PIT when alongside.
    // If nobody can actually see the player, converge on the last known
    // position and prowl there instead of psychically tracking them.
    let aimX = px, aimZ = pz;
    const blind = !this.playerSeen && this.lastKnown;
    if (blind) {
      aimX = this.lastKnown.x; aimZ = this.lastKnown.z;
      const dl = dist2d(v.pos.x, v.pos.z, aimX, aimZ);
      if (dl < 14) {
        // circle the area slowly, scanning
        v.updatePhysics(dt, { throttle: 0.35, steer: 0.55, handbrake: false });
        return;
      }
    } else if (player.vehicle) {
      // lead the target by its velocity for a proper intercept
      const lead = clamp(d / 30, 0, 1.4);
      aimX = px + player.vehicle.vel.x * lead;
      aimZ = pz + player.vehicle.vel.y * lead;
    }
    const wantHeading = Math.atan2(aimX - v.pos.x, aimZ - v.pos.z);
    let err = wantHeading - v.heading;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    let steer = clamp(err * 2, -1, 1);

    // rubber-band: cruisers a bit faster when far behind so chases stay tense
    v.chaseBoost = player.vehicle ? clamp(1 + (d - 20) / 120, 0.9, 1.25) : 1;

    let throttle = 1;
    if (!player.vehicle) {
      // player on foot: stop nearby and unload
      if (d < 16) {
        throttle = v.speed > 1 ? -1 : 0;
        if (!cr.unloaded && d < 20) this.unloadCops(cr);
      }
    } else {
      // PIT maneuver: when close and roughly alongside, swerve into the rear quarter
      const relX = px - v.pos.x, relZ = pz - v.pos.z;
      const fwd = Math.sin(v.heading) * relX + Math.cos(v.heading) * relZ;
      const side = Math.cos(v.heading) * relX - Math.sin(v.heading) * relZ;
      if (d < 6.5 && Math.abs(fwd) < 3 && Math.abs(side) < 3.5 && Math.abs(v.speed) > 8) {
        steer = clamp(side * 0.9, -1, 1);       // nudge into their side
        cr.pitT = 0.5;
      } else if (d < 7) throttle = 1;
      else if (d < 30 && Math.abs(err) > 1.2) throttle = 0.3;
    }

    // reverse out when stuck against walls
    if (Math.abs(v.speed) < 0.5 && throttle > 0.5) {
      cr.stuckT += dt;
      if (cr.stuckT > 1.6) {
        cr.reverseT = 0.9;
        cr.stuckT = 0;
      }
    } else cr.stuckT = 0;
    if (cr.reverseT > 0) {
      cr.reverseT -= dt;
      throttle = -1;
    }

    v.updatePhysics(dt, { throttle, steer: cr.reverseT > 0 ? -steer : steer, handbrake: false });

    // refresh unload when player breaks away
    if (cr.unloaded && d > 60) cr.unloaded = false;
  }

  unloadCops(cr) {
    cr.unloaded = true;
    const v = cr.vehicle;
    const tough = this.state.stars >= 5;
    for (const side of [-1, 1]) {
      const lx = -Math.cos(v.heading) * side, lz = Math.sin(v.heading) * side;
      const cop = new Cop(this.game.city, this.game.scene, tough);
      cop.place(v.pos.x + lx * 1.6, v.pos.z + lz * 1.6);
      cop.provoked = this.state.stars >= 2;
      this.footCops.push(cop);
    }
  }

  // ---------------- helicopter (5★+) ----------------
  spawnChopper() {
    const game = this.game;
    if (!game.THREE) return;
    // build a simple chopper from primitives
    const g = new game.THREE.Group();
    const body = new game.THREE.Mesh(new game.THREE.BoxGeometry(1.4, 1.3, 4),
      new game.THREE.MeshStandardMaterial({ color: 0x16181d, metalness: 0.5, roughness: 0.5 }));
    g.add(body);
    const tail = new game.THREE.Mesh(new game.THREE.BoxGeometry(0.4, 0.4, 3), body.material);
    tail.position.set(0, 0.2, -3); g.add(tail);
    const rotor = new game.THREE.Mesh(new game.THREE.BoxGeometry(9, 0.08, 0.4), new game.THREE.MeshBasicMaterial({ color: 0x333333 }));
    rotor.position.y = 1; g.add(rotor);
    this.chopperRotor = rotor;
    game.scene.add(g);
    this.chopper = g;
    this.chopperAngle = 0;
    game.audio?.startSiren?.('chopper', () => ({ x: this.chopper.position.x, z: this.chopper.position.z }));
  }

  updateChopper(dt) {
    const game = this.game;
    const p = game.player.pos;
    this.chopperAngle += dt * 0.5;
    const r = 32;
    const cx = p.x + Math.cos(this.chopperAngle) * r;
    const cz = p.z + Math.sin(this.chopperAngle) * r;
    this.chopper.position.set(cx, 45, cz);
    this.chopper.lookAt(p.x, 45, p.z);
    this.chopperRotor.rotation.y += dt * 40;
    // searchlight tracks the player (scene-level light, follows the chopper)
    if (this.chopperSpot) {
      this.chopperSpot.position.set(cx, 45, cz);
      this.chopperSpot.intensity = game.dayNight?.nightIntensity > 0.3 ? 8 : 2;
      this.chopperSpot.target.position.set(p.x, 0, p.z);
      this.chopperSpot.target.updateMatrixWorld();
    }
  }

  despawnChopper() {
    if (!this.chopper) return;
    this.game.audio?.stopSiren?.('chopper');
    this.chopper.removeFromParent();
    this.chopper = null;
    if (this.chopperSpot) this.chopperSpot.intensity = 0;   // light stays in scene
  }

  despawnAll(instant = false) {
    this.despawnChopper();
    for (const c of this.footCops) c.dispose();
    this.footCops.length = 0;
    for (const cr of [...this.cruisers]) {
      // never delete the car out from under the player (e.g. respray in a stolen cruiser)
      if (this.game.player.vehicle === cr.vehicle) {
        this.releaseCruiser(cr.vehicle);
        continue;
      }
      this.game.audio?.stopSiren(cr.vehicle.id);
      this.game.vehicles.remove(cr.vehicle);
    }
    this.cruisers.length = 0;
  }
}
