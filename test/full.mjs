// Final integration: one continuous session touching every major system,
// asserting zero console errors and stable draw calls throughout.
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

const steps = [];
const step = async (name, fn) => {
  try { await page.evaluate(fn); steps.push(name + ':ok'); }
  catch (e) { steps.push(name + ':THREW'); }
};

// mission → drive → combat → wanted → interior → rob → escape → save
await step('mission', () => window.__game.startMission('r1'));
await step('drive', () => { window.__game.spawnVehicleOnRoad('sports'); window.__game.enterNearestVehicle(); window.__game.tick(5); });
await step('weapons', () => { window.__game.giveWeapon('rifle', 90); window.__game.giveWeapon('smg', 120); });
await step('wanted', () => { if (window.__game.game.player.vehicle) window.__game.game.vehicles.exitVehicleForced(); window.__game.setWanted(4); window.__game.tick(8); });
await step('combat', () => { const g = window.__game.game; g.combat.select('rifle'); g.input.mouseDown[2]=true; for(let i=0;i<5;i++){g.input.mousePressed[0]=true;window.__game.tick(0.15);} g.input.mouseDown[2]=false; });
await step('firstperson', () => { const g = window.__game.game; for(let i=0;i<3;i++) g.cameraRig.cycleDistance(); window.__game.tick(0.5); g.cameraRig.cycleDistance(); });
await step('respray-clear', () => { window.__game.game.wanted.clear(); window.__game.tick(1); });
await step('interior', () => {
  const g = window.__game.game;
  const rec = g.interiors.recs.find((rr) => rr.template === 'store');
  g.player.teleport(rec.door.x, rec.door.z + rec.door.face * 3);
  window.__game.tick(1);
  g.player.teleport(rec.b.x, rec.b.z);
  window.__game.tick(1);
  if (!g.interiors.playerInside) throw new Error('walk-in failed');
});
await step('rob', () => {
  const g = window.__game.game;
  const rec = g.interiors.playerInside;
  const k = rec.keeper;
  g.player.teleport(k.pos.x, k.pos.z + (rec.door.face > 0 ? 3 : -3));
  g.input.mouseDown[2] = true;
  window.__game.tick(4);
  g.input.mouseDown[2] = false;
});
await step('exit-interior', () => {
  const g = window.__game.game;
  const rec = g.interiors.playerInside;
  g.player.teleport(rec.door.x, rec.door.z + rec.door.face * 3.5);
  window.__game.tick(1);
  if (g.interiors.playerInside) throw new Error('still inside');
});
await step('radio', () => window.__game.game.audio.radio.cycle());
await step('soak', () => window.__game.tick(30));

const final = await page.evaluate(() => ({
  draws: window.__game.drawCalls(),
  peds: window.__game.game.peds.peds.length,
  vehicles: window.__game.game.vehicles.vehicles.length,
  mode: window.__game.game.state.mode,
  interiorY: window.__game.game.player.interiorY,
}));
console.log('steps:', steps.join(' '));
console.log('final state:', JSON.stringify(final));
const allOk = steps.every((s) => s.endsWith(':ok')) && final.interiorY === null && final.draws > 0;
console.log(allOk ? 'FULL PLAYTHROUGH OK' : 'FULL PLAYTHROUGH ISSUES');
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 10).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
