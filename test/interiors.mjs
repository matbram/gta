// G5 check: interiors — enter/exit, robbery, heat-on-exit, bed save, counter shop.
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

// door count sanity
const doors = await page.evaluate(() => window.__game.game.city.doors.length);
console.log('doors:', doors, doors > 100 ? 'DOORS OK' : 'DOORS FAIL');

// walk into the nearest store door → interior
await page.evaluate(() => {
  const g = window.__game.game;
  const d = g.city.doors[0];
  g.player.teleport(d.x, d.z);
  window.__game.tick(0.5);
});
const inside = await page.evaluate(() => ({
  current: window.__game.game.interiors.current,
  px: Math.round(window.__game.game.player.pos.x),
  interiorY: window.__game.game.player.interiorY,
}));
console.log('inside:', JSON.stringify(inside),
  inside.current && inside.px > 2000 && inside.interiorY === 0 ? 'ENTER OK' : 'ENTER FAIL');

// rob the keeper: aim a pistol nearby
const rob = await page.evaluate(async () => {
  const g = window.__game.game;
  g.combat.give('pistol', 30);
  const tpl = g.interiors.templates[g.interiors.current];
  // stand near the keeper and hold aim
  g.player.teleport(tpl.keeper.pos.x, tpl.keeper.pos.z + 3);
  g.input.mouseDown[2] = true;
  window.__game.tick(4);
  g.input.mouseDown[2] = false;
  return {
    drops: g.interiors.robDrops,
    pendingHeat: g.interiors.pendingHeat,
    keeperAnim: tpl.keeper.rig.anim ?? 'n/a',
    cash: g.worldlife.pickups.filter((p) => p.kind === 'cash').length,
  };
});
console.log('robbery:', JSON.stringify(rob),
  rob.drops > 0 && rob.pendingHeat > 0 ? 'ROB OK' : 'ROB FAIL');

// exit → heat applies
await page.evaluate(() => {
  const g = window.__game.game;
  const tpl = g.interiors.templates[g.interiors.current];
  // walk deeper in first (arms the exit), then step onto the doorway
  g.player.teleport(tpl.spawn.x, tpl.spawn.z - 3);
  window.__game.tick(0.3);
  g.interiors.exitArmed = true;
  g.player.pos.set(tpl.spawn.x, 0, tpl.exitZ);
  window.__game.tick(1.5);
});
const outside = await page.evaluate(() => ({
  current: window.__game.game.interiors.current,
  stars: window.__game.wanted(),
  interiorY: window.__game.game.player.interiorY,
}));
console.log('after exit:', JSON.stringify(outside),
  !outside.current && outside.stars >= 2 && outside.interiorY === null ? 'EXIT+HEAT OK' : 'EXIT FAIL');

// safehouse: bed save
const bed = await page.evaluate(() => {
  const g = window.__game.game;
  g.wanted.clear();
  const p = g.city.pois.safehouse;
  g.player.teleport(p.x, p.z);
  window.__game.tick(1.5);
  return true;
});
const bedSave = await page.evaluate(() => {
  const g = window.__game.game;
  const tpl = g.interiors.templates.safehouse;
  const t0 = g.dayNight.minutes;
  g.player.teleport(tpl.bed.x, tpl.bed.z);
  window.__game.tick(1);
  return {
    current: g.interiors.current,
    slept: ((g.dayNight.minutes - t0) + 1440) % 1440 >= 359,
    hasSave: g.save.hasSave(),
  };
});
console.log('bed save:', JSON.stringify(bedSave),
  bedSave.current === 'safehouse' && bedSave.slept && bedSave.hasSave ? 'BED OK' : 'BED FAIL');

// gun shop counter opens the buy menu (fresh entry)
const shopFinal = await page.evaluate(() => {
  const g = window.__game.game;
  if (g.interiors.current) { g.interiors.exit(); window.__game.tick(1.5); }
  const p = g.city.pois.gunShop;
  g.player.teleport(p.x, p.z);
  window.__game.tick(1.5);
  const tpl = g.interiors.templates.gunshop;
  if (g.interiors.current === 'gunshop') {
    g.player.pos.set(tpl.register.x, 0, tpl.register.z + 1.5);
    window.__game.tick(1);
  }
  return { current: g.interiors.current, mode: g.state.mode };
});
console.log('gun counter:', JSON.stringify(shopFinal),
  shopFinal.current === 'gunshop' && shopFinal.mode === 'shop' ? 'COUNTER OK' : 'COUNTER FAIL');

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 10).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
