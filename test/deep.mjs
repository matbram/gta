// Deep integration pass: 6-star police escalation, respray, mission r2 fare
// loop, v9 defend waves, coin pickup, and a long free-roam soak for stability.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.mode === 'menu', null, { timeout: 90000 });
await page.evaluate(() => window.__game.newGame());
await page.waitForTimeout(300);

// ---- 6-star escalation while driving ----
await page.evaluate(() => {
  const g = window.__game.game;
  window.__game.spawnVehicleOnRoad('sports');
  window.__game.enterNearestVehicle();
  window.__game.setWanted(6);
});
await page.keyboard.down('w');
await page.evaluate(() => window.__game.tick(20));
await page.keyboard.up('w');
const escalation = await page.evaluate(() => ({
  stars: window.__game.wanted(),
  foot: window.__game.game.wanted.footCops.length,
  cruisers: window.__game.game.wanted.cruisers.length,
}));
console.log('6-star response:', JSON.stringify(escalation),
  escalation.cruisers >= 2 && escalation.foot >= 2 ? 'ESCALATION OK' : 'ESCALATION FAIL');
await page.screenshot({ path: 'screenshots/11-sixstars.png' });

// ---- respray clears wanted ----
const respray = await page.evaluate(() => {
  const g = window.__game.game;
  g.addMoney(500);
  const m = g.worldlife.markers.find((m) => m.kind === 'respray');
  const v = g.player.vehicle;
  v.pos.set(m.x, 0, m.z);
  v.vel.set(0, 0);
  g.player.pos.set(m.x, 0, m.z);
  window.__game.tick(1);
  return { stars: g.state.wanted.stars, cops: g.wanted.footCops.length + g.wanted.cruisers.length };
});
console.log('after respray:', JSON.stringify(respray),
  respray.stars === 0 && respray.cops === 0 ? 'RESPRAY OK' : 'RESPRAY FAIL');

// ---- mission r2: full 3-fare loop ----
await page.evaluate(() => {
  const g = window.__game.game;
  if (g.player.vehicle) g.vehicles.exitVehicleForced();
  g.missions.passed.add('r1');
  window.__game.startMission('r2');
});
const r2ok = await page.evaluate(async () => {
  const g = window.__game.game;
  const cab = g.missions.active.ctx.data.cab;
  g.player.teleport(cab.pos.x + 2, cab.pos.z);
  g.vehicles.tryEnterExit();
  window.__game.tick(1);
  // run through the 3 fares by teleporting the cab to each target
  for (let i = 0; i < 8; i++) {
    if (!g.missions.active) break;
    const step = g.missions.active.def.steps[g.missions.active.stepIndex];
    const t = step.blipAt?.(g.missions.active.ctx);
    if (t) {
      cab.pos.set(t.x, 0, t.z);
      cab.vel.set(0, 0);
      g.player.pos.set(t.x, 0, t.z);
    }
    window.__game.tick(1.2);
  }
  return { passed: [...g.missions.passed], money: Math.round(g.state.money) };
});
console.log('r2 result:', JSON.stringify(r2ok),
  r2ok.passed.includes('r2') ? 'R2 OK' : 'R2 FAIL');

// ---- mission v9: defend waves ----
const v9 = await page.evaluate(() => {
  const g = window.__game.game;
  if (g.player.vehicle) g.vehicles.exitVehicleForced();
  ['r3', 'd5', 'd6'].forEach((id) => g.missions.passed.add(id));
  const poi = g.city.pois.nightclub;
  g.player.teleport(poi.x, poi.z - 5);
  window.__game.startMission('v9');
  window.__game.tick(0.5);
  // three waves: kill all goons each time
  for (let w = 0; w < 3; w++) {
    for (const goon of g.missions.active?.ctx.goons ?? []) {
      if (!goon.dead) goon.damage(999, g, 'test');
    }
    window.__game.tick(1);
  }
  return { passed: [...g.missions.passed], active: !!g.missions.active };
});
console.log('v9 result:', JSON.stringify(v9), v9.passed.includes('v9') ? 'V9 OK' : 'V9 FAIL');

// ---- coin pickup ----
const coin = await page.evaluate(() => {
  const g = window.__game.game;
  const c = g.worldlife.pickups.find((p) => p.kind === 'coin');
  if (!c) return { found: false };
  g.player.teleport(c.x, c.z);
  window.__game.tick(0.5);
  return { found: true, coins: g.state.stats.coins };
});
console.log('coin pickup:', JSON.stringify(coin), coin.coins === 1 ? 'COIN OK' : 'COIN FAIL');

// ---- free-roam soak: 90 sim-seconds of driving through town with traffic ----
await page.evaluate(() => {
  const g = window.__game.game;
  if (!g.player.vehicle) {
    window.__game.spawnVehicleOnRoad('sedan');
    window.__game.enterNearestVehicle();
  }
});
await page.keyboard.down('w');
await page.evaluate(() => window.__game.tick(45));
await page.keyboard.up('w');
await page.keyboard.down('a');
await page.keyboard.down('w');
await page.evaluate(() => window.__game.tick(45));
await page.keyboard.up('a');
await page.keyboard.up('w');
const soak = await page.evaluate(() => ({
  pos: window.__game.playerPos(),
  vehicles: window.__game.game.vehicles.vehicles.length,
  peds: window.__game.game.peds.peds.length,
  draws: window.__game.drawCalls(),
}));
console.log('soak state:', JSON.stringify(soak), 'SOAK OK');

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 12).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
