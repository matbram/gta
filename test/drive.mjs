// Phase B check: spawn a car, enter it, drive; verify traffic + peds populate.
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
await page.waitForTimeout(500);

// spawn a sports car on the nearest road (aligned with it) and enter
await page.evaluate(() => window.__game.spawnVehicleOnRoad('sports'));
await page.waitForTimeout(300);
await page.evaluate(() => window.__game.enterNearestVehicle());
await page.waitForTimeout(300);
const driving = await page.evaluate(() => !!window.__game.game.player.vehicle);
console.log('entered vehicle:', driving ? 'OK' : 'FAIL');

// drive forward using the sim fast-forward (immune to slow headless rendering)
const p0 = await page.evaluate(() => window.__game.playerPos());
await page.keyboard.down('w');
await page.evaluate(() => window.__game.tick(6));
await page.keyboard.up('w');
const p1 = await page.evaluate(() => window.__game.playerPos());
const dist = Math.hypot(p1.x - p0.x, p1.z - p0.z);
console.log(`drove ${dist.toFixed(1)}m in 6s sim (${(dist / 6).toFixed(1)} m/s)`,
  dist / 6 > 8 ? 'DRIVE OK' : 'DRIVE FAIL');
await page.waitForTimeout(400);
if (process.env.SHOTS === '1') await page.screenshot({ path: 'screenshots/05-driving.png' });

// let the world simulate 25s so traffic/peds populate
await page.evaluate(() => window.__game.tick(25));
const life = await page.evaluate(() => ({
  traffic: window.__game.game.traffic.cars.length,
  peds: window.__game.game.peds.peds.length,
  vehicles: window.__game.game.vehicles.vehicles.length,
}));
console.log('world life:', JSON.stringify(life),
  life.traffic > 0 && life.peds > 0 ? 'LIFE OK' : 'LIFE FAIL');

// exit vehicle (tick consumes the keypress deterministically — headless
// frames can be seconds long with skinned characters on SwiftShader)
await page.keyboard.down('f');
await page.evaluate(() => window.__game.tick(0.3));
await page.keyboard.up('f');
const out = await page.evaluate(() => !window.__game.game.player.vehicle);
console.log('exited vehicle:', out ? 'OK' : 'FAIL');
if (process.env.SHOTS === '1') await page.screenshot({ path: 'screenshots/06-street.png' });

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 10).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
