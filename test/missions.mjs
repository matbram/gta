// Phase D check: mission 1 end-to-end, shop purchase, save/load, taxi gig.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:8080/?q=low', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.mode === 'menu', null, { timeout: 90000 });
await page.evaluate(() => window.__game.newGame());
await page.waitForTimeout(400);

// ---- mission r1: Homecoming ----
const started = await page.evaluate(() => window.__game.startMission('r1'));
console.log('mission r1 start:', started ? 'OK' : 'FAIL');

// step 0: enter the cab
await page.evaluate(() => {
  const g = window.__game.game;
  const cab = g.missions.active.ctx.data.cab;
  g.player.teleport(cab.pos.x + 2, cab.pos.z);
  g.vehicles.tryEnterExit();
  window.__game.tick(1);
});
let ms = await page.evaluate(() => window.__game.missionState());
console.log('after entering cab: step', ms.active?.step, ms.active?.step === 1 ? 'STEP OK' : 'STEP FAIL');

// step 1: drive to safehouse — teleport the cab there and stop
await page.evaluate(() => {
  const g = window.__game.game;
  const sp = g.city.pois.safehouse;
  const cab = g.missions.active.ctx.data.cab;
  cab.pos.set(sp.x, 0, sp.z);
  cab.vel.set(0, 0);
  g.player.pos.set(sp.x, 0, sp.z);
  window.__game.tick(1.5);
});
ms = await page.evaluate(() => window.__game.missionState());
const money = await page.evaluate(() => window.__game.money());
console.log('mission r1 passed:', JSON.stringify(ms.passed), 'money:', money,
  ms.passed.includes('r1') && money >= 350 ? 'MISSION OK' : 'MISSION FAIL');

// r2 should now be available from Rosa's contact marker
const r2avail = await page.evaluate(() => {
  const g = window.__game.game;
  return g.missions.nextMissionFor('rosa')?.id;
});
console.log('next rosa mission:', r2avail, r2avail === 'r2' ? 'CHAIN OK' : 'CHAIN FAIL');

// ---- shop ----
const shop = await page.evaluate(() => {
  const g = window.__game.game;
  g.addMoney(2000);
  g.worldlife.openShop('gunshop');
  const count = document.querySelectorAll('.shop-item').length;
  // buy the first item (bat)
  document.querySelector('.shop-item')?.click();
  return { count, hasBat: !!g.combat.inventory.bat, mode: g.state.mode };
});
console.log('shop:', JSON.stringify(shop),
  shop.count >= 5 && shop.hasBat && shop.mode === 'play' ? 'SHOP OK' : 'SHOP FAIL');

// ---- save / load ----
const saved = await page.evaluate(() => {
  const g = window.__game.game;
  g.state.money = 7777;
  return g.save.save();
});
await page.evaluate(() => {
  const g = window.__game.game;
  g.state.money = 0;
  g.save.load();
});
const loadedMoney = await page.evaluate(() => window.__game.money());
console.log('save/load money:', loadedMoney, saved && loadedMoney === 7777 ? 'SAVE OK' : 'SAVE FAIL');

// ---- taxi gig ----
const gig = await page.evaluate(() => {
  const g = window.__game.game;
  if (g.player.vehicle) g.vehicles.exitVehicleForced();   // leave the mission cab first
  const v = g.vehicles.spawnOnRoadNear(g.player.pos.x, g.player.pos.z, 'taxi');
  g.player.teleport(v.pos.x + 2, v.pos.z);
  g.vehicles.tryEnterExit();
  g.worldlife.startTaxiGig();
  return !!g.worldlife.taxiGig;
});
console.log('taxi gig started:', gig ? 'TAXI OK' : 'TAXI FAIL');

// ---- waypoint routing ----
const route = await page.evaluate(() => {
  const g = window.__game.game;
  const poi = g.city.pois.mansion;
  g.worldlife.computeRoute(poi.x, poi.z);
  return g.worldlife.route ? g.worldlife.route.length : 0;
});
console.log('A* route nodes:', route, route > 3 ? 'ROUTE OK' : 'ROUTE FAIL');

if (process.env.SHOTS === '1') await page.screenshot({ path: 'screenshots/08-missions.png' });
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 10).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
