// The Bayvale story arc — 12 original missions across three contacts.
// Marco Reyes comes home after six years away and works his way up from
// taxi errands to taking the city back from Ray Corvo's crew.

import { Goon } from '../entities/goon.js';
import { dist2d, clamp } from '../core/mathutil.js';

export const CONTACTS = [
  { id: 'rosa',   name: 'Rosa',   poi: 'taxiDepot', color: 0xe8c84a, blip: '#e8c84a', letter: 'R' },
  { id: 'denny',  name: 'Denny',  poi: 'docksWarehouse', color: 0xd87a3a, blip: '#d87a3a', letter: 'D' },
  { id: 'vivian', name: 'Vivian', poi: 'nightclub', color: 0xb06ad8, blip: '#b06ad8', letter: 'V' },
];

// ---------------------------------------------------------------- helpers
function gotoStep(text, getTarget, opts = {}) {
  return {
    text: () => text,
    blipAt: (ctx) => (typeof getTarget === 'function' ? getTarget(ctx) : getTarget),
    marker: opts.marker !== false,
    timeLimit: opts.timeLimit,
    say: opts.say,
    enter: opts.enter,
    update(ctx, dt) {
      const g = ctx.game;
      const t = typeof getTarget === 'function' ? getTarget(ctx) : getTarget;
      if (!t) return null;
      const px = g.player.pos.x, pz = g.player.pos.z;
      if (opts.requireVehicle && !g.player.vehicle) return null;
      if (opts.requireVehicleId && g.player.vehicle !== ctx.data[opts.requireVehicleId]) return null;
      if (dist2d(px, pz, t.x, t.z) < (opts.radius ?? 4)) {
        if (opts.requireStop && g.player.vehicle && Math.abs(g.player.vehicle.speed) > 2) return null;
        return 'done';
      }
      return opts.extraUpdate?.(ctx, dt) ?? null;
    },
  };
}

function enterVehicleStep(text, dataKey, opts = {}) {
  return {
    text: () => text,
    blipAt: (ctx) => ctx.data[dataKey] && !ctx.data[dataKey].dead
      ? { x: ctx.data[dataKey].pos.x, z: ctx.data[dataKey].pos.z } : null,
    say: opts.say,
    update(ctx) {
      const v = ctx.data[dataKey];
      if (!v || v.dead) return 'fail:The vehicle was destroyed.';
      if (ctx.game.player.vehicle === v) return 'done';
      return null;
    },
  };
}

function spawnGoons(ctx, list, onAllDead) {
  const g = ctx.game;
  const spawned = [];
  for (const spec of list) {
    const goon = new Goon(g.city, g.scene, spec);
    goon.place(spec.x, spec.z);
    if (spec.aggro) { goon.provoked = true; goon.state = 'attack'; }
    ctx.goons.push(goon);
    spawned.push(goon);
    ctx.extraBlips.push({
      alive: () => !goon.dead,
      x: () => goon.pos.x, z: () => goon.pos.z, color: '#d84a3a',
    });
  }
  return spawned;
}

function eliminateStep(text, getGoons, opts = {}) {
  return {
    text,
    marker: false,
    say: opts.say,
    enter: opts.enter,
    update(ctx) {
      const goons = getGoons(ctx);
      return goons.every((g) => g.dead) ? 'done' : null;
    },
  };
}

// spawn a mission car on the road near a POI
function spawnMissionCar(ctx, key, type, nearPoi, color = null) {
  const g = ctx.game;
  const poi = g.city.pois[nearPoi];
  const v = g.vehicles.spawnOnRoadNear(poi.x, poi.z, type, color);
  v.missionKeep = true;
  ctx.vehicles.push(v);
  ctx.data[key] = v;
  return v;
}

// ---------------------------------------------------------------- missions
export const MISSIONS = [

  // ============ ROSA ============
  {
    id: 'r1', contact: 'rosa', title: 'Homecoming', reward: 150,
    intro: [
      ['Rosa', 'Marco Reyes. Six years, not one postcard.'],
      ['Marco', 'Prison mail moves slow, prima.'],
      ['Rosa', 'Get in a cab. I want to show you what Corvo has done to this town.'],
    ],
    setup(ctx) { spawnMissionCar(ctx, 'cab', 'taxi', 'taxiDepot'); },
    steps: [
      enterVehicleStep('Get in the ◆ taxi.', 'cab'),
      gotoStep('Drive Rosa to the ◆ safehouse in Old Coronet.',
        (ctx) => ctx.game.city.pois.safehouse && { x: ctx.game.city.pois.safehouse.x, z: ctx.game.city.pois.safehouse.z },
        { requireVehicleId: 'cab', radius: 7, requireStop: true,
          say: [['Rosa', 'Corvo runs protection on every block now. Even papa\'s old depot pays.'],
                ['Marco', 'Then we stop paying.']] }),
    ],
    outro: [['Rosa', 'Keys to the place upstairs. Sleep. Tomorrow you work.']],
  },

  {
    id: 'r2', contact: 'rosa', title: 'Fare Game', reward: 250, requires: ['r1'],
    intro: [
      ['Rosa', 'Every driver I have quit after Corvo torched two cabs.'],
      ['Rosa', 'Take a shift. Three fares, on the clock. Show the street we still run.'],
    ],
    setup(ctx) {
      spawnMissionCar(ctx, 'cab', 'taxi', 'taxiDepot');
      ctx.data.faresDone = 0;
      // three fares around the inner city
      ctx.data.fares = [
        { pickPoi: 'foodShop', dropPoi: 'hospital' },
        { pickPoi: 'gunShop', dropPoi: 'nightclub' },
        { pickPoi: 'hospital', dropPoi: 'taxiDepot' },
      ];
    },
    steps: [
      enterVehicleStep('Get in the ◆ taxi.', 'cab'),
      ...[0, 1, 2].map((i) => ({
        text: (ctx) => `Fare ${i + 1}/3 — pick up the passenger at the ◆ marker.`,
        blipAt: (ctx) => {
          const poi = ctx.game.city.pois[ctx.data.fares[i].pickPoi];
          return { x: poi.x, z: poi.z };
        },
        update(ctx) {
          const g = ctx.game;
          if (!g.player.vehicle || g.player.vehicle !== ctx.data.cab) return null;
          if (ctx.data.cab.dead) return 'fail:The cab is wrecked.';
          const poi = g.city.pois[ctx.data.fares[i].pickPoi];
          if (dist2d(g.player.pos.x, g.player.pos.z, poi.x, poi.z) < 6 && Math.abs(g.player.vehicle.speed) < 2) return 'done';
          return null;
        },
      })).flatMap((pick, i) => [pick, {
        text: () => `Drop them at the ◆ destination.`,
        timeLimit: 75,
        blipAt: (ctx) => {
          const poi = ctx.game.city.pois[ctx.data.fares[i].dropPoi];
          return { x: poi.x, z: poi.z };
        },
        update(ctx) {
          const g = ctx.game;
          if (!g.player.vehicle || g.player.vehicle !== ctx.data.cab) return null;
          if (ctx.data.cab.dead) return 'fail:The cab is wrecked.';
          const poi = g.city.pois[ctx.data.fares[i].dropPoi];
          if (dist2d(g.player.pos.x, g.player.pos.z, poi.x, poi.z) < 6 && Math.abs(g.player.vehicle.speed) < 2) {
            ctx.game.addMoney(40);
            return 'done';
          }
          return null;
        },
      }]),
    ],
    outro: [['Rosa', 'Three fares and the cab still has doors. You are hired, primo.']],
  },

  {
    id: 'r3', contact: 'rosa', title: 'Repo Blues', reward: 400, requires: ['r2'],
    intro: [
      ['Rosa', 'Corvo\'s men impounded my best cab at the docks. "Unpaid dues."'],
      ['Rosa', 'Steal it back. Try not to redecorate it with bullet holes.'],
    ],
    setup(ctx) {
      const g = ctx.game;
      const poi = g.city.pois.respray;
      const v = g.vehicles.spawnOnRoadNear(poi.x + 30, poi.z + 30, 'taxi');
      v.missionKeep = true;
      ctx.vehicles.push(v);
      ctx.data.cab = v;
      spawnGoons(ctx, [
        { x: v.pos.x + 6, z: v.pos.z + 3, health: 50, aggroRange: 18 },
        { x: v.pos.x - 5, z: v.pos.z + 6, health: 50, aggroRange: 18 },
      ]);
    },
    steps: [
      gotoStep('The cab is in an impound lot at ◆ Ironhook Docks. Watch for guards.',
        (ctx) => ({ x: ctx.data.cab.pos.x, z: ctx.data.cab.pos.z }), { radius: 26, marker: false }),
      enterVehicleStep('Get the ◆ taxi. Deal with the guards however you like.', 'cab',
        { say: [['Marco', 'Nice lot. Terrible guards.']] }),
      gotoStep('Bring it back to the ◆ depot.',
        (ctx) => {
          const poi = ctx.game.city.pois.taxiDepot;
          return { x: poi.x, z: poi.z };
        },
        { requireVehicleId: 'cab', radius: 7, requireStop: true }),
    ],
    outro: [['Rosa', 'They will notice this. Good. Denny at Pier 9 wants to meet the man who did it.']],
  },

  {
    id: 'r4', contact: 'rosa', title: 'Smoke Signals', reward: 600, requires: ['r3'],
    intro: [
      ['Rosa', 'Two of Corvo\'s collection cars are parked outside, engines warm.'],
      ['Rosa', 'Send a message. Burn them. Then disappear before the BPD writes you into a report.'],
    ],
    setup(ctx) {
      const g = ctx.game;
      const poi = g.city.pois.taxiDepot;
      for (let i = 0; i < 2; i++) {
        const v = g.vehicles.spawnOnRoadNear(poi.x + 40 + i * 26, poi.z - 20, 'sedan', 0x16181d);
        v.missionKeep = true;
        ctx.vehicles.push(v);
        ctx.data['mark' + i] = v;
        ctx.extraBlips.push({
          alive: () => !v.dead, x: () => v.pos.x, z: () => v.pos.z, color: '#d84a3a',
        });
      }
    },
    steps: [
      {
        text: () => 'Destroy both of Corvo\'s ◆ collection cars.',
        marker: false,
        update(ctx) {
          return ctx.data.mark0.dead && ctx.data.mark1.dead ? 'done' : null;
        },
      },
      {
        text: () => 'Lose the heat. Get your wanted level to zero.',
        marker: false,
        say: [['Marco', 'That smoke says it better than I ever could.']],
        update(ctx) {
          return ctx.game.state.wanted.stars === 0 ? 'done' : null;
        },
      },
      gotoStep('Lay low. Return to the ◆ safehouse.',
        (ctx) => {
          const poi = ctx.game.city.pois.safehouse;
          return { x: poi.x, z: poi.z };
        }, { radius: 5 }),
    ],
    outro: [['Rosa', 'Corvo pulled his collectors off my block this morning. Go see Denny.']],
  },

  // ============ DENNY ============
  {
    id: 'd5', contact: 'denny', title: 'Parts Run', reward: 500, requires: ['r3'],
    intro: [
      ['Denny', 'Marco! The taxi thief. I fix what Corvo breaks — today it is a clinic generator.'],
      ['Denny', 'Van full of parts, St. Aurora waiting. Fast, but keep it in one piece.'],
    ],
    setup(ctx) { spawnMissionCar(ctx, 'van', 'van', 'docksWarehouse'); },
    steps: [
      enterVehicleStep('Take the ◆ parts van.', 'van'),
      gotoStep('Deliver the parts to ◆ St. Aurora Medical before the deadline.',
        (ctx) => {
          const poi = ctx.game.city.pois.hospital;
          return { x: poi.x, z: poi.z };
        },
        { requireVehicleId: 'van', radius: 8, requireStop: true, timeLimit: 100,
          extraUpdate(ctx) {
            if (ctx.data.van.health < 30) return 'fail:The parts are scrap now.';
            return null;
          } }),
    ],
    outro: [['Denny', 'Generator is humming. You drive like you mean it — I like that.']],
  },

  {
    id: 'd6', contact: 'denny', title: 'Shadow', reward: 700, requires: ['d5'],
    intro: [
      ['Denny', 'A courier leaves the depot every day with Corvo\'s take. Nobody knows where it lands.'],
      ['Denny', 'Follow him. Stay close enough to watch, far enough to stay boring.'],
    ],
    setup(ctx) {
      const g = ctx.game;
      const poi = g.city.pois.gunShop;
      const v = g.vehicles.spawnOnRoadNear(poi.x, poi.z, 'sedan', 0x2e3440);
      v.missionKeep = true;
      v.aiControlled = true;
      ctx.vehicles.push(v);
      ctx.data.courier = v;
      // the courier cruises via traffic-style waypoints — simple loop of POIs
      ctx.data.route = ['hospital', 'nightclub', 'respray', 'mansion'];
      ctx.data.leg = 0;
      ctx.data.suspicion = 0;
    },
    steps: [
      gotoStep('Get a car and find the ◆ courier near Bullseye Rounds.',
        (ctx) => ({ x: ctx.data.courier.pos.x, z: ctx.data.courier.pos.z }),
        { radius: 45, requireVehicle: true, marker: false }),
      {
        text: (ctx) => 'Tail the ◆ courier. Don\'t spook him, don\'t lose him.',
        marker: false,
        blipAt: (ctx) => ({ x: ctx.data.courier.pos.x, z: ctx.data.courier.pos.z }),
        update(ctx, dt) {
          const g = ctx.game;
          const c = ctx.data.courier;
          if (c.dead) return 'fail:The courier is dead. The trail is cold.';
          // drive the courier along his route
          const targetPoi = g.city.pois[ctx.data.route[ctx.data.leg]];
          const d2t = dist2d(c.pos.x, c.pos.z, targetPoi.x, targetPoi.z);
          if (d2t < 18) {
            ctx.data.leg++;
            if (ctx.data.leg >= ctx.data.route.length) return 'done';
          }
          // simple road-ish seek
          const want = Math.atan2(targetPoi.x - c.pos.x, targetPoi.z - c.pos.z);
          let err = want - c.heading;
          while (err > Math.PI) err -= Math.PI * 2;
          while (err < -Math.PI) err += Math.PI * 2;
          c.updatePhysics(dt, { throttle: 0.5, steer: clamp(err * 2, -1, 1), handbrake: false });

          const d = dist2d(g.player.pos.x, g.player.pos.z, c.pos.x, c.pos.z);
          if (d > 160) return 'fail:You lost the courier.';
          if (d < 14) {
            ctx.data.suspicion += dt;
            if (ctx.data.suspicion > 4) return 'fail:He made you. The route changes tomorrow.';
            if (!ctx.data.warned) { ctx.data.warned = true; g.hud.showToast('Too close! Back off.', 3); }
          } else {
            ctx.data.suspicion = Math.max(0, ctx.data.suspicion - dt * 0.5);
            if (ctx.data.suspicion < 1) ctx.data.warned = false;
          }
          return null;
        },
      },
    ],
    outro: [
      ['Marco', 'The money sleeps in a mansion up in the Heights.'],
      ['Denny', 'Corvo\'s own house. Vivian needs to hear this — the Velvet Iguana, tonight.'],
    ],
  },

  {
    id: 'd7', contact: 'denny', title: 'Chop Chase', reward: 900, requires: ['d6'],
    intro: [
      ['Denny', 'One of Corvo\'s runners just lifted my toolbox truck. My whole life is in that box.'],
      ['Denny', 'Run him off the road. The truck can take it. He cannot.'],
    ],
    setup(ctx) {
      const g = ctx.game;
      const poi = g.city.pois.respray;
      const v = g.vehicles.spawnOnRoadNear(poi.x, poi.z, 'pickup', 0x5a4632);
      v.missionKeep = true;
      ctx.vehicles.push(v);
      ctx.data.runner = v;
      ctx.data.fleeT = 0;
    },
    steps: [
      gotoStep('Catch the ◆ runner before he reaches the north bridge road.',
        (ctx) => ({ x: ctx.data.runner.pos.x, z: ctx.data.runner.pos.z }),
        { radius: 30, requireVehicle: true, marker: false }),
      {
        text: () => 'Ram the ◆ truck until he gives it up.',
        marker: false,
        blipAt: (ctx) => ({ x: ctx.data.runner.pos.x, z: ctx.data.runner.pos.z }),
        update(ctx, dt) {
          const g = ctx.game;
          const r = ctx.data.runner;
          if (r.dead) return 'fail:The truck is totalled — and the toolbox with it.';
          if (r.health < 45) {
            // driver bails and flees
            return 'done';
          }
          // flee from player
          const dx = r.pos.x - g.player.pos.x, dz = r.pos.z - g.player.pos.z;
          const d = Math.hypot(dx, dz) || 1;
          if (d > 220) return 'fail:He is gone. So is the toolbox.';
          const want = Math.atan2(dx / d, dz / d);
          let err = want - r.heading;
          while (err > Math.PI) err -= Math.PI * 2;
          while (err < -Math.PI) err += Math.PI * 2;
          r.updatePhysics(dt, { throttle: 0.85, steer: clamp(err * 2, -1, 1), handbrake: false });
          return null;
        },
      },
      enterVehicleStep('The runner bailed. Take the ◆ truck.', 'runner',
        { say: [['Marco', 'Left the keys. Considerate.']] }),
      gotoStep('Bring the truck back to ◆ Pier 9.',
        (ctx) => {
          const poi = ctx.game.city.pois.docksWarehouse;
          return { x: poi.x, z: poi.z };
        }, { requireVehicleId: 'runner', radius: 8, requireStop: true }),
    ],
    outro: [['Denny', 'Every wrench accounted for. You are family now, Reyes.']],
  },

  {
    id: 'd8', contact: 'denny', title: 'Convoy', reward: 1200, requires: ['d7'],
    intro: [
      ['Denny', 'I am moving generators to three shelters tonight. Corvo called it "unlicensed charity."'],
      ['Denny', 'His bikes will come for me. Ride shotgun on my route — literally.'],
    ],
    setup(ctx) {
      const g = ctx.game;
      spawnMissionCar(ctx, 'truck', 'van', 'docksWarehouse', 0x4a5a6a);
      ctx.data.wave = 0;
      ctx.data.stops = ['foodShop', 'hospital', 'taxiDepot'];
      ctx.data.stop = 0;
    },
    steps: [
      enterVehicleStep('Get in Denny\'s ◆ van.', 'truck'),
      {
        text: (ctx) => `Deliver to shelter ${ctx.data.stop + 1}/3 — protect the van at the ◆ marker.`,
        blipAt: (ctx) => {
          const poi = ctx.game.city.pois[ctx.data.stops[ctx.data.stop]];
          return { x: poi.x, z: poi.z };
        },
        update(ctx, dt) {
          const g = ctx.game;
          const v = ctx.data.truck;
          if (v.dead) return 'fail:The generators are burning.';
          if (g.player.vehicle !== v) {
            ctx.data.offVanT = (ctx.data.offVanT || 0) + dt;
            if (ctx.data.offVanT > 25) return 'fail:You left Denny to die.';
          } else ctx.data.offVanT = 0;

          // ambush waves of riders while en route
          ctx.data.waveT = (ctx.data.waveT || 0) - dt;
          if (ctx.data.waveT <= 0 && ctx.data.wave < 4) {
            ctx.data.waveT = 22;
            ctx.data.wave++;
            const a = Math.random() * Math.PI * 2;
            const bike = g.vehicles.spawnOnRoadNear(
              v.pos.x + Math.cos(a) * 120, v.pos.z + Math.sin(a) * 120, 'moto', 0x16181d);
            if (bike) {
              bike.missionKeep = true;
              ctx.vehicles.push(bike);
              (ctx.data.bikes = ctx.data.bikes || []).push(bike);
              ctx.extraBlips.push({ alive: () => !bike.dead, x: () => bike.pos.x, z: () => bike.pos.z, color: '#d84a3a' });
              g.hud.showToast('Corvo riders incoming!', 3);
            }
          }
          // riders chase the van and shoot it
          for (const bike of ctx.data.bikes || []) {
            if (bike.dead) continue;
            const dx = v.pos.x - bike.pos.x, dz = v.pos.z - bike.pos.z;
            const d = Math.hypot(dx, dz) || 1;
            const want = Math.atan2(dx / d, dz / d);
            let err = want - bike.heading;
            while (err > Math.PI) err -= Math.PI * 2;
            while (err < -Math.PI) err += Math.PI * 2;
            bike.updatePhysics(dt, { throttle: d > 12 ? 1 : 0.2, steer: clamp(err * 2.4, -1, 1), handbrake: false });
            bike.shootT = (bike.shootT || 0) - dt;
            if (d < 22 && bike.shootT <= 0) {
              bike.shootT = 1.6;
              g.audio?.gunshot('pistol', bike.pos.x, bike.pos.z);
              if (Math.random() < 0.5) v.applyDamage(4, 'rider');
            }
          }

          const poi = g.city.pois[ctx.data.stops[ctx.data.stop]];
          if (g.player.vehicle === v &&
              dist2d(g.player.pos.x, g.player.pos.z, poi.x, poi.z) < 8 && Math.abs(v.speed) < 2) {
            ctx.data.stop++;
            g.addMoney(100);
            if (ctx.data.stop >= 3) return 'done';
            g.hud.showToast(`Shelter ${ctx.data.stop}/3 supplied. +$100`, 3);
            g.hud.setObjective(this.text(ctx));
          }
          return null;
        },
      },
    ],
    outro: [['Denny', 'Three shelters warm tonight. Vivian says Corvo is rattled. Finish it.']],
  },

  // ============ VIVIAN ============
  {
    id: 'v9', contact: 'vivian', title: 'Velvet Rope', reward: 1000, requires: ['d6'],
    intro: [
      ['Vivian', 'Marco Reyes. The Iguana is the only floor in Bayvale Corvo doesn\'t own.'],
      ['Vivian', 'Tonight he sends muscle to fix that. Be my velvet rope.'],
    ],
    setup(ctx) {
      ctx.data.wave = 0;
    },
    steps: [
      {
        text: (ctx) => `Defend the club — wave ${Math.min(ctx.data.wave + 1, 3)}/3.`,
        marker: false,
        enter(ctx) {
          const g = ctx.game;
          const poi = g.city.pois.nightclub;
          ctx.data.spawnWave = () => {
            ctx.data.wave++;
            const n = 2 + ctx.data.wave;
            const list = [];
            for (let i = 0; i < n; i++) {
              const a = (i / n) * Math.PI * 2;
              list.push({
                x: poi.x + Math.cos(a) * 40, z: poi.z + Math.sin(a) * 40,
                health: 55, aggro: true, accuracy: 0.4,
              });
            }
            spawnGoons(ctx, list);
            g.hud.showToast(`Wave ${ctx.data.wave}/3!`, 3);
          };
          ctx.data.spawnWave();
        },
        update(ctx) {
          const g = ctx.game;
          if (dist2d(g.player.pos.x, g.player.pos.z, g.city.pois.nightclub.x, g.city.pois.nightclub.z) > 90)
            return 'fail:You abandoned the door.';
          if (ctx.goons.every((x) => x.dead)) {
            if (ctx.data.wave >= 3) return 'done';
            ctx.data.spawnWave();
            g.hud.setObjective(this.text(ctx));
          }
          return null;
        },
      },
    ],
    outro: [['Vivian', 'Not one of them reached the bar. Drinks are on the house — figuratively. Take cash.']],
  },

  {
    id: 'v10', contact: 'vivian', title: 'Loud Neighbors', reward: 1500, requires: ['v9'],
    intro: [
      ['Vivian', 'Corvo\'s crew chief runs his muscle from a warehouse on Pier 9\'s south lot.'],
      ['Vivian', 'No chief, no muscle. Make it loud — I want the whole harbour to hear the lease end.'],
    ],
    setup(ctx) {
      const g = ctx.game;
      const poi = g.city.pois.respray;   // south docks lot
      const cx = poi.x + 20, cz = poi.z + 40;
      ctx.data.boss = spawnGoons(ctx, [
        { x: cx, z: cz, health: 140, accuracy: 0.6, damage: 12, shirt: 0x1c1024, shootRange: 30 },
      ])[0];
      spawnGoons(ctx, [
        { x: cx + 10, z: cz + 4, health: 60 },
        { x: cx - 8, z: cz + 8, health: 60 },
        { x: cx + 4, z: cz - 9, health: 60 },
        { x: cx - 6, z: cz - 6, health: 60 },
      ]);
    },
    steps: [
      gotoStep('Hit the crew at the ◆ south dock lot.',
        (ctx) => ({ x: ctx.data.boss.pos.x, z: ctx.data.boss.pos.z }), { radius: 40, marker: false }),
      eliminateStep(() => 'Wipe out the crew. The chief wears the dark coat.', (ctx) => ctx.goons,
        { say: [['Marco', 'Evenings like this, I almost miss prison. Almost.']] }),
      {
        text: () => 'Lose the police heat.',
        marker: false,
        update: (ctx) => (ctx.game.state.wanted.stars === 0 ? 'done' : null),
      },
    ],
    outro: [['Vivian', 'The harbour is quiet. Corvo is down to bodyguards and bad options.']],
  },

  {
    id: 'v11', contact: 'vivian', title: 'The Long Tail', reward: 2000, requires: ['v10'],
    intro: [
      ['Vivian', 'Corvo\'s accountant wants out. He will trade the books for a clean exit.'],
      ['Vivian', 'Corvo knows. His hunters are already rolling. Get the accountant to St. Aurora alive.'],
    ],
    setup(ctx) {
      const g = ctx.game;
      spawnMissionCar(ctx, 'car', 'sedan', 'nightclub', 0x8a8a92);
      ctx.data.hunters = [];
    },
    steps: [
      enterVehicleStep('Take the ◆ grey sedan — the accountant is in the back.', 'car'),
      {
        text: () => 'Get him to ◆ St. Aurora. Hunters on your tail — don\'t stop.',
        timeLimit: 150,
        blipAt: (ctx) => {
          const poi = ctx.game.city.pois.hospital;
          return { x: poi.x, z: poi.z };
        },
        enter(ctx) {
          const g = ctx.game;
          for (let i = 0; i < 2; i++) {
            const a = Math.random() * Math.PI * 2;
            const h = g.vehicles.spawnOnRoadNear(
              g.player.pos.x + Math.cos(a) * 150, g.player.pos.z + Math.sin(a) * 150, 'sports', 0x16181d);
            if (h) {
              h.missionKeep = true;
              ctx.vehicles.push(h);
              ctx.data.hunters.push(h);
              ctx.extraBlips.push({ alive: () => !h.dead, x: () => h.pos.x, z: () => h.pos.z, color: '#d84a3a' });
            }
          }
        },
        update(ctx, dt) {
          const g = ctx.game;
          const car = ctx.data.car;
          if (car.dead) return 'fail:The accountant did not make it.';
          if (g.player.vehicle !== car) {
            ctx.data.offT = (ctx.data.offT || 0) + dt;
            if (ctx.data.offT > 20) return 'fail:The hunters found him parked.';
          } else ctx.data.offT = 0;
          // hunters ram the player's car
          for (const h of ctx.data.hunters) {
            if (h.dead) continue;
            const dx = car.pos.x - h.pos.x, dz = car.pos.z - h.pos.z;
            const d = Math.hypot(dx, dz) || 1;
            const want = Math.atan2(dx / d, dz / d);
            let err = want - h.heading;
            while (err > Math.PI) err -= Math.PI * 2;
            while (err < -Math.PI) err += Math.PI * 2;
            h.updatePhysics(dt, { throttle: 1, steer: clamp(err * 2.2, -1, 1), handbrake: false });
          }
          const poi = g.city.pois.hospital;
          if (g.player.vehicle === car &&
              dist2d(g.player.pos.x, g.player.pos.z, poi.x, poi.z) < 8 && Math.abs(car.speed) < 2) return 'done';
          return null;
        },
      },
    ],
    outro: [
      ['Vivian', 'The books name every cop Corvo owns. He is finished — he just doesn\'t know it.'],
      ['Vivian', 'One thing left, Marco. The house on the hill.'],
    ],
  },

  {
    id: 'v12', contact: 'vivian', title: 'Kings of Bayvale', reward: 10000, requires: ['v11'],
    intro: [
      ['Vivian', 'Corvo is burning records at the estate tonight. Everyone he trusts is on that lawn.'],
      ['Marco', 'Then everyone he trusts can watch him fall.'],
      ['Vivian', 'End it, Marco. Bayvale wants its keys back.'],
    ],
    setup(ctx) {
      const g = ctx.game;
      const poi = g.city.pois.mansion;
      ctx.data.corvo = spawnGoons(ctx, [
        { x: poi.x, z: poi.z + 6, health: 220, accuracy: 0.7, damage: 14, shirt: 0x0e0c1e, shootRange: 34, aggroRange: 34 },
      ])[0];
      spawnGoons(ctx, [
        { x: poi.x + 14, z: poi.z + 6, health: 70, accuracy: 0.5 },
        { x: poi.x - 12, z: poi.z + 10, health: 70, accuracy: 0.5 },
        { x: poi.x + 6, z: poi.z - 10, health: 70, accuracy: 0.5 },
        { x: poi.x - 8, z: poi.z - 8, health: 70, accuracy: 0.5 },
        { x: poi.x + 20, z: poi.z - 4, health: 70, accuracy: 0.5 },
      ]);
    },
    steps: [
      gotoStep('Drive up to the ◆ Corvo Estate in the Heights.',
        (ctx) => ({ x: ctx.data.corvo.pos.x, z: ctx.data.corvo.pos.z }), { radius: 45, marker: false }),
      eliminateStep(() => 'Take the compound. Corvo is in the long black coat.', (ctx) => ctx.goons, {
        say: [['Marco', 'Evening, Ray. The city sent me about the rent.']],
      }),
      {
        text: () => 'It\'s done. Escape the Heights and lose the heat.',
        marker: false,
        enter(ctx) { ctx.game.wanted.setStars(Math.max(3, ctx.game.state.wanted.stars)); },
        update: (ctx) => (ctx.game.state.wanted.stars === 0 ? 'done' : null),
      },
      gotoStep('Meet Rosa and the others at the ◆ Velvet Iguana.',
        (ctx) => {
          const poi = ctx.game.city.pois.nightclub;
          return { x: poi.x, z: poi.z };
        }, { radius: 5 }),
    ],
    outro: [
      ['Rosa', 'Papa\'s depot is safe. The block is safe. You did that.'],
      ['Vivian', 'Bayvale has new kings tonight — try to be better ones.'],
      ['Marco', 'No kings. Just neighbors with good aim.'],
    ],
  },
];
