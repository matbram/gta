// Traffic AI: civilian cars drive the road graph with lane offsets,
// car-following, intersection yielding, honking and panic behaviour.

import { Ped, randomLook } from '../entities/ped.js';
import { clamp, dist2d, distSq2d, wrapAngle, lerp } from '../core/mathutil.js';

const TARGET_CARS = 14;
const SPAWN_MIN = 90, SPAWN_MAX = 200, DESPAWN = 280;
const LANE = 0.24;            // lane offset as fraction of road width

const CIVILIAN_TYPES = [
  ['sedan', 0.34], ['taxi', 0.14], ['pickup', 0.14], ['van', 0.12],
  ['sports', 0.1], ['moto', 0.06], ['bus', 0.06], ['ambulance', 0.04],
];

function pickType(r) {
  let acc = 0;
  for (const [t, w] of CIVILIAN_TYPES) { acc += w; if (r < acc) return t; }
  return 'sedan';
}

export class TrafficSystem {
  constructor(game) {
    this.game = game;
    this.cars = [];              // { vehicle, edge, dir, t, targetSpeed, waitT, honkT, panicT }
    this.spawnTimer = 0;
  }

  update(dt) {
    const p = this.game.player.pos;

    this.spawnTimer -= dt;
    if (this.cars.length < TARGET_CARS && this.spawnTimer <= 0) {
      this.spawnTimer = 0.4;
      this.trySpawn(p);
    }

    for (const car of [...this.cars]) {
      this.drive(car, dt);
      const v = car.vehicle;
      if (dist2d(v.pos.x, v.pos.z, p.x, p.z) > DESPAWN || v.dead) {
        if (v.dead) {
          // wreck stays (vehicle system culls it later); free the driver rig
          // unless the explosion path already handed the ped to the ped system
          this.forget(car);
          if (car.driverPed && !this.game.peds.peds.includes(car.driverPed)) {
            car.driverPed.dispose();
          }
        } else {
          this.game.vehicles.remove(v);
          this.forget(car);
          if (car.driverPed && !this.game.peds.peds.includes(car.driverPed)) {
            car.driverPed.dispose();
          }
        }
      }
    }
  }

  forget(car) {
    const i = this.cars.indexOf(car);
    if (i >= 0) this.cars.splice(i, 1);
    car.vehicle.aiControlled = false;
  }

  releaseVehicle(vehicle) {
    const car = this.cars.find((c) => c.vehicle === vehicle);
    if (car) this.forget(car);
  }

  panic(vehicle) {
    const car = this.cars.find((c) => c.vehicle === vehicle);
    if (car) car.panicT = 8 + Math.random() * 5;
  }

  trySpawn(p) {
    const city = this.game.city;
    const edge = city.edges[Math.floor(Math.random() * city.edges.length)];
    const t = 0.2 + Math.random() * 0.6;
    const ex = lerp(edge.a.x, edge.b.x, t);
    const ez = lerp(edge.a.z, edge.b.z, t);
    const d = dist2d(ex, ez, p.x, p.z);
    if (d < SPAWN_MIN || d > SPAWN_MAX) return;

    // don't spawn on top of another car
    for (const c of this.game.vehicles.vehicles) {
      if (distSq2d(c.pos.x, c.pos.z, ex, ez) < 100) return;
    }

    const type = pickType(Math.random());
    const dir = Math.random() < 0.5 ? 1 : -1;
    const v = this.game.vehicles.spawn(type, ex, ez, 0);
    const car = {
      vehicle: v, edge, dir, t,
      targetSpeed: edge.artery ? 12 : 8.5,
      waitT: 0, honkT: 0, panicT: 0, stuckT: 0,
    };
    v.aiControlled = true;

    // put an AI driver figure in the car (visible through glass, used on carjack)
    const ped = new Ped(city, this.game.scene, randomLook(Math.random));
    ped.state = 'driver';
    ped.inVehicle = v;
    ped.rig.group.visible = false;
    car.driverPed = ped;
    v.driver = ped;

    this.placeOnLane(car);
    v.syncMesh(0);
    this.cars.push(car);
  }

  laneTarget(car, tAhead) {
    // point on the edge at parameter t, offset to the right-hand lane
    const e = car.edge;
    const t = clamp(tAhead, 0, 1);
    const x = lerp(e.a.x, e.b.x, t);
    const z = lerp(e.a.z, e.b.z, t);
    const off = e.width * LANE * car.dir;
    return e.horizontal ? { x, z: z + off } : { x: x - off, z };
  }

  placeOnLane(car) {
    const pos = this.laneTarget(car, car.t);
    car.vehicle.pos.x = pos.x;
    car.vehicle.pos.z = pos.z;
    const e = car.edge;
    car.vehicle.heading = e.horizontal
      ? (car.dir > 0 ? Math.PI / 2 : -Math.PI / 2)
      : (car.dir > 0 ? 0 : Math.PI);
  }

  drive(car, dt) {
    const v = car.vehicle;
    const game = this.game;
    if (v.dead) return;

    const e = car.edge;
    // advance parameter along edge based on actual position projection
    car.t = e.horizontal
      ? (v.pos.x - e.a.x) / (e.b.x - e.a.x)
      : (v.pos.z - e.a.z) / (e.b.z - e.a.z);

    // reached the end of the edge → choose the next one
    if ((car.dir > 0 && car.t >= 0.94) || (car.dir < 0 && car.t <= 0.06)) {
      const node = car.dir > 0 ? e.b : e.a;
      const options = node.edges.filter((n) => n !== e);
      let next;
      if (options.length === 0) next = e;               // dead end: U-turn
      else {
        // prefer continuing straight
        const straight = options.filter((n) => n.horizontal === e.horizontal);
        next = (straight.length && Math.random() < 0.55)
          ? straight[Math.floor(Math.random() * straight.length)]
          : options[Math.floor(Math.random() * options.length)];
      }
      car.edge = next;
      car.dir = next.a === node ? 1 : -1;
      car.t = car.dir > 0 ? 0.02 : 0.98;
      car.targetSpeed = (next.artery ? 12 : 8.5) * (car.panicT > 0 ? 1.6 : 1);
    }

    // steer toward a look-ahead point on the lane
    const look = this.laneTarget(car, car.t + car.dir * (0.10 + Math.abs(v.speed) * 0.008));
    const dx = look.x - v.pos.x, dz = look.z - v.pos.z;
    const wantHeading = Math.atan2(dx, dz);
    const err = wrapAngle(wantHeading - v.heading);
    const steer = clamp(err * 2.2, -1, 1);

    // desired speed with obstacle checks
    let want = car.targetSpeed * (car.panicT > 0 ? 1.5 : 1);

    // slow near intersections
    const distToEnd = (car.dir > 0 ? (1 - car.t) : car.t) * e.len;
    if (distToEnd < 14 && car.panicT <= 0) want = Math.min(want, 5.5);

    // car-following: check ahead for vehicles / player / peds
    const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
    let blocked = false;
    const aheadDist = 4 + Math.abs(v.speed) * 0.8;
    for (const o of game.vehicles.vehicles) {
      if (o === v) continue;
      const ox = o.pos.x - v.pos.x, oz = o.pos.z - v.pos.z;
      const along = ox * fx + oz * fz;
      const side = Math.abs(ox * -fz + oz * fx);
      if (along > 0 && along < aheadDist && side < 2.2) {
        const oSpeed = Math.hypot(o.vel.x, o.vel.y);
        if (along < 6) { want = 0; blocked = true; }
        else want = Math.min(want, oSpeed * 0.9);
      }
    }
    // player on foot in the road
    const pp = game.player.pos;
    if (!game.player.vehicle && !game.player.dead) {
      const ox = pp.x - v.pos.x, oz = pp.z - v.pos.z;
      const along = ox * fx + oz * fz;
      const side = Math.abs(ox * -fz + oz * fx);
      if (along > 0 && along < aheadDist + 2 && side < 2 && car.panicT <= 0) {
        want = 0; blocked = true;
      }
    }
    // pedestrians crossing
    if (car.panicT <= 0) {
      for (const ped of game.peds.peds) {
        if (ped.dead) continue;
        const ox = ped.pos.x - v.pos.x, oz = ped.pos.z - v.pos.z;
        if (ox * ox + oz * oz > 200) continue;
        const along = ox * fx + oz * fz;
        const side = Math.abs(ox * -fz + oz * fx);
        if (along > 0 && along < 9 && side < 1.8) { want = Math.min(want, 1); blocked = true; }
      }
    }

    if (blocked) {
      car.waitT += dt;
      if (car.waitT > 2.5 && car.honkT <= 0) {
        car.honkT = 3 + Math.random() * 4;
        game.audio?.horn(v.pos.x, v.pos.z);
      }
    } else car.waitT = 0;
    car.honkT -= dt;
    car.panicT = Math.max(0, car.panicT - dt);

    // throttle toward wanted speed
    const speedNow = v.speed;
    let throttle = 0;
    if (want > speedNow + 0.4) throttle = clamp((want - speedNow) / 6, 0.2, 1);
    else if (want < speedNow - 0.6) throttle = clamp((want - speedNow) / 8, -1, -0.2);

    v.updatePhysics(dt, { throttle, steer, handbrake: false });

    // unstick: if barely moving against a wall for a while, nudge to lane
    if (Math.abs(v.speed) < 0.4 && !blocked && want > 2) {
      car.stuckT += dt;
      if (car.stuckT > 3) {
        this.placeOnLane(car);
        car.stuckT = 0;
      }
    } else car.stuckT = 0;
  }
}
