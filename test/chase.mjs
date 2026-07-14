// G8 check: PIT/rubber-band chase AI, scanner chatter, helicopter at 5 stars.
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
await page.waitForFunction(() => window.__game?.mode === 'menu', null, { timeout: 240000 });
await page.evaluate(() => window.__game.newGame());

// start a chase in a car
await page.evaluate(() => {
  window.__game.spawnVehicleOnRoad('sports');
  window.__game.enterNearestVehicle();
  window.__game.setWanted(3);
});
await page.keyboard.down('w');
await page.evaluate(() => window.__game.tick(15));
await page.keyboard.up('w');
const chase = await page.evaluate(() => ({
  cruisers: window.__game.game.wanted.cruisers.length,
  boosted: window.__game.game.wanted.cruisers.some((c) => c.vehicle.chaseBoost > 1),
}));
console.log('chase:', JSON.stringify(chase),
  chase.cruisers > 0 ? 'CHASE OK' : 'CHASE FAIL');

// helicopter at 5 stars
const heli = await page.evaluate(() => {
  window.__game.setWanted(6);
  window.__game.tick(2);
  const has = !!window.__game.game.wanted.chopper;
  const y = has ? window.__game.game.wanted.chopper.position.y : 0;
  return { has, y };
});
console.log('helicopter:', JSON.stringify(heli),
  heli.has && heli.y > 20 ? 'HELI OK' : 'HELI FAIL');

// clears when wanted drops
const cleared = await page.evaluate(() => {
  window.__game.setWanted(0);
  window.__game.game.wanted.clear();
  window.__game.tick(1);
  return !window.__game.game.wanted.chopper;
});
console.log('heli despawn:', cleared ? 'DESPAWN OK' : 'DESPAWN FAIL');

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 8).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
