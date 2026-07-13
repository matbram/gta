// Wanted system: heat → stars, escalating police response
// (foot cops → cruisers → roadblocks → tactical units), line-of-sight
// evasion decay, and the arrest hand-off to the busted flow.

import { Cop } from '../entities/cop.js';
import { clamp, dist2d, distSq2d, lerp } from '../core/mathutil.js';

const CRIME_HEAT = {
  assault: 6, kill: 34, carjack: 12, crash: 1.5, explosion: 60,
  gunfire: 3, copAttack: 55, copKill: 95,
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
  }

  // ---------------- heat ----------------
  crime(kind, x, z) {
    const heat = CRIME_HEAT[kind] ?? 4;
    // witnesses matter less out in the countryside
    const district = this.game.city.districtAt(x, z);
    const mult = ({ farm: 0.5, heights: 0.7 })[district] ?? 1;
    this.state.heat = clamp(this.state.heat + heat * mult, 0, 900);
    this.recalcStars();
  }

  setStars(n) {
    this.state.heat = STAR_TH[clamp(n, 0, 6)] + 1;
    this.recalcStars(true);
  }

  // a civilian phoned it in: heat bump + a unit sent to look at the spot
  reportCrime(x, z) {
    this.state.heat = clamp(this.state.heat + 16, 0, 900);
    this.recalcStars();
    // point an existing patrol/foot cop at the scene, or spawn one nearby
    let cop = this.nearestCop(x, z, 240);
    if (!cop) cop = this.spawnFootCop(false, true);
    if (cop) cop.investigate = { x, z, t: 0 };
  }

  clear() {
    this.state.heat = 0;
    this.state.stars = 0;
    this.despawnAll(true);
  }

  recalcStars(silent = false) {
    const h = this.state.heat;
    let stars = 0;
    for (let i = 6; i >= 1; i--) if (h >= STAR_TH[i]) { stars = i; break; }
    if (stars > this.state.stars && !silent) {
      this.game.audio?.wantedUp();
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
    const steps = Math.max(2, Math.floor(dist / 5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = x1 + dx * t, y = y1 + dy * t, z = z1 + dz * t;
      const cols = city.queryColliders(x, z, 0.3);
      const ground = city.groundHeight(x, z);
      for (const b of cols) {
        if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ && y < ground + b.h) return false;
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
    // ducking into a store breaks line of sight: hiding indoors works
    const indoors = !!game.interiors?.playerInside;
    let seen = false;
    if (!indoors) for (const c of this.footCops) {
      if (!c.dead && distSq2d(c.pos.x, c.pos.z, player.pos.x, player.pos.z) < 70 * 70 &&
          this.lineOfSight(c.pos.x, c.pos.y + 1.5, c.pos.z, player.pos.x, player.pos.y + 1, player.pos.z)) { seen = true; break; }
    }
    if (!seen && !indoors) for (const cr of this.cruisers) {
      const v = cr.vehicle;
      if (v.dead) continue;
      const d2 = distSq2d(v.pos.x, v.pos.z, player.pos.x, player.pos.z);
      // parked roadblocks only spot you up close; pursuers need line of sight
      const range = cr.state === 'block' ? 30 : 90;
      if (d2 < range * range &&
          this.lineOfSight(v.pos.x, v.pos.y + 1.6, v.pos.z, player.pos.x, player.pos.y + 1.2, player.pos.z)) {
        seen = true; break;
      }
    }
    if (stars > 0) {
      if (seen) {
        this.unseenT = 0;
        // sustained pressure: heat stays put while seen
      } else {
        this.unseenT += dt;
        // out of sight: decay a star roughly every 7 seconds unseen
        if (this.unseenT > 6) {
          this.state.heat = Math.max(0, this.state.heat - dt * (14 + stars * 4));
          this.recalcStars(true);
          if (this.state.stars < stars) this.unseenT = 3;   // partial reset per star lost
        }
      }
      // slow passive decay even when seen (crimes must continue to sustain 6★)
      this.state.heat = Math.max(0, this.state.heat - dt * 0.8);
      this.recalcStars(true);
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

    // pursue: intercept-lead the player's car, PIT when alongside
    let aimX = px, aimZ = pz;
    if (player.vehicle) {
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
    const spot = new game.THREE.SpotLight(0xffffff, 0, 120, 0.35, 0.4, 1.5);
    spot.position.set(0, 0, 0);
    g.add(spot); g.add(spot.target);
    this.chopperSpot = spot;
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
    // searchlight tracks the player
    this.chopperSpot.intensity = game.dayNight?.nightIntensity > 0.3 ? 8 : 2;
    this.chopperSpot.target.position.set(p.x, 0, p.z);
    this.chopperSpot.target.updateMatrixWorld();
  }

  despawnChopper() {
    if (!this.chopper) return;
    this.game.audio?.stopSiren?.('chopper');
    this.chopper.removeFromParent();
    this.chopper = null;
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
