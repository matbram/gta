// Quick boot check: loads the game, reports console errors, takes screenshots.
import { chromium } from 'playwright';

const shots = process.env.SHOTS !== '0';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:8080/?q=low', { waitUntil: 'domcontentloaded' });

// wait for menu (boot finished) or failure
try {
  await page.waitForFunction(() => window.__game && window.__game.mode === 'menu', null, { timeout: 60000 });
  console.log('BOOT OK — menu reached');
} catch {
  const msg = await page.locator('#loadmsg').textContent().catch(() => '??');
  console.log('BOOT TIMEOUT — loadmsg:', msg);
}

if (shots) await page.screenshot({ path: 'screenshots/01-menu.png' });

// start a new game and walk around
const started = await page.evaluate(() => {
  if (!window.__game) return false;
  window.__game.newGame();
  return true;
});
if (started) {
  await page.waitForTimeout(1500);
  const pos = await page.evaluate(() => window.__game.playerPos());
  console.log('player at', JSON.stringify(pos));
  if (shots) await page.screenshot({ path: 'screenshots/02-spawn.png' });

  // hold W and measure against *simulated* time (headless renderer can be slow)
  const t0 = await page.evaluate(() => window.__game.game.time);
  await page.keyboard.down('w');
  await page.waitForTimeout(4000);
  await page.keyboard.up('w');
  const t1 = await page.evaluate(() => window.__game.game.time);
  const pos2 = await page.evaluate(() => window.__game.playerPos());
  console.log('player moved to', JSON.stringify(pos2));
  const dist = Math.hypot(pos2.x - pos.x, pos2.z - pos.z);
  const simT = t1 - t0;
  const rate = dist / Math.max(simT, 0.01);
  console.log(`walked ${dist.toFixed(1)}m in ${simT.toFixed(2)} sim-seconds (${rate.toFixed(1)} m/s)`,
    rate > 2 ? 'MOVE OK' : 'MOVE FAIL');
  if (shots) await page.screenshot({ path: 'screenshots/03-walk.png' });

  // night view
  await page.evaluate(() => window.__game.setTime(22));
  await page.waitForTimeout(800);
  if (shots) await page.screenshot({ path: 'screenshots/04-night.png' });

  const info = await page.evaluate(() => ({ calls: window.__game.drawCalls(), city: window.__game.city() }));
  console.log('draw calls:', info.calls, 'city:', JSON.stringify(info.city));
}

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 12).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
