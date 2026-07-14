// Phase C check: weapons, gunfire → wanted stars, police response, busted/wasted.
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

// give weapons
const gave = await page.evaluate(() => {
  window.__game.giveWeapon('pistol', 60);
  window.__game.giveWeapon('smg', 120);
  return Object.keys(window.__game.game.combat.inventory);
});
console.log('inventory:', gave.join(','), gave.includes('pistol') ? 'GIVE OK' : 'GIVE FAIL');

// crime → stars
await page.evaluate(() => {
  const g = window.__game.game;
  g.wanted.crime('kill', g.player.pos.x, g.player.pos.z);
  g.wanted.crime('kill', g.player.pos.x, g.player.pos.z);
  g.wanted.crime('explosion', g.player.pos.x, g.player.pos.z);
});
const stars1 = await page.evaluate(() => window.__game.wanted());
console.log('stars after crimes:', stars1, stars1 >= 2 ? 'WANTED OK' : 'WANTED FAIL');

// simulate 12s → police should arrive
await page.evaluate(() => window.__game.tick(12));
const police = await page.evaluate(() => ({
  foot: window.__game.game.wanted.footCops.filter((c) => !c.dead).length,
  cars: window.__game.game.wanted.cruisers.length,
}));
console.log('police response:', JSON.stringify(police),
  police.foot > 0 || police.cars > 0 ? 'POLICE OK' : 'POLICE FAIL');
if (process.env.SHOTS === '1') await page.screenshot({ path: 'screenshots/07-wanted.png' });

// shoot: aim (RMB) + fire (LMB) — ammo should drop
const ammoBefore = await page.evaluate(() => window.__game.game.combat.inventory.pistol.inMag);
await page.evaluate(() => {
  const g = window.__game.game;
  g.combat.select('pistol');
  // deterministic input injection (real mouse events race with slow headless frames)
  g.input.mouseDown[2] = true;       // hold aim
  g.input.mousePressed[0] = true;    // click fire
  window.__game.tick(0.2);
  g.input.mouseDown[2] = false;
});
const ammoAfter = await page.evaluate(() => window.__game.game.combat.inventory.pistol.inMag);
console.log(`pistol mag ${ammoBefore} -> ${ammoAfter}`, ammoAfter < ammoBefore ? 'SHOOT OK' : 'SHOOT FAIL');

// wasted flow: kill the player
await page.evaluate(() => window.__game.game.player.damage(500, 'test'));
await page.evaluate(() => window.__game.tick(5));
const revived = await page.evaluate(() => ({
  dead: window.__game.game.player.dead,
  hp: window.__game.game.player.health,
  wanted: window.__game.wanted(),
}));
console.log('after wasted flow:', JSON.stringify(revived),
  !revived.dead && revived.hp === 100 && revived.wanted === 0 ? 'WASTED OK' : 'WASTED FAIL');

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 10).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
