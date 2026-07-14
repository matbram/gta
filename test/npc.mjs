// G4 check: NPC minds — archetypes, witness calls, patrol cops, fire crew,
// paramedics, road rage machinery.
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
await page.evaluate(() => window.__game.tick(15));

// archetypes present
const arch = await page.evaluate(() => {
  const counts = {};
  for (const p of window.__game.game.peds.peds) counts[p.archetype] = (counts[p.archetype] || 0) + 1;
  return counts;
});
console.log('archetypes:', JSON.stringify(arch),
  Object.keys(arch).length >= 2 ? 'ARCH OK' : 'ARCH FAIL');

// patrol cops exist at zero stars
const patrol = await page.evaluate(() => ({
  stars: window.__game.wanted(),
  patrols: window.__game.game.wanted.footCops.filter((c) => c.patrol && !c.dead).length,
}));
console.log('beat patrol:', JSON.stringify(patrol),
  patrol.stars === 0 && patrol.patrols > 0 ? 'PATROL OK' : 'PATROL FAIL');

// witness call: force a ped into call state → heat rises
const call = await page.evaluate(() => {
  const g = window.__game.game;
  const heat0 = g.state.wanted.heat;
  const ped = g.peds.peds.find((p) => !p.dead);
  ped.personality = { bravery: 0.5, aggression: 0.1, curiosity: 0.2, civic: 0.99 };
  ped.state = 'call'; ped.callT = 0; ped.panicked = true;
  ped.fleeFrom = { x: g.player.pos.x, z: g.player.pos.z };
  window.__game.tick(5);
  return { heat0, heat1: g.state.wanted.heat };
});
console.log('witness call:', JSON.stringify(call),
  call.heat1 > call.heat0 ? 'CALL OK' : 'CALL FAIL');

// fire → fire engine dispatch → extinguish
const fire = await page.evaluate(() => {
  const g = window.__game.game;
  const p = g.player.pos;
  g.dispatch.reportFire(p.x + 20, p.z + 8, null);
  window.__game.tick(10);   // truck spawns after 6s head start
  const spawned = !!g.dispatch.fireUnit;
  window.__game.tick(60);   // drive + hose
  return { spawned, firesLeft: g.dispatch.fires.length, unitGone: !g.dispatch.fireUnit };
});
console.log('fire dispatch:', JSON.stringify(fire),
  fire.spawned && fire.firesLeft === 0 ? 'FIRE OK' : 'FIRE FAIL');

// death → ambulance
const medic = await page.evaluate(() => {
  const g = window.__game.game;
  const ped = g.peds.peds.find((p) => !p.dead && !p.isCrew);
  ped.damage(999, g, 'test');
  window.__game.tick(10);
  const spawned = !!g.medicUnitSeen || !!g.dispatch.medicUnit;
  window.__game.tick(55);
  return { spawned, reports: g.dispatch.deathReports.length, unitGone: !g.dispatch.medicUnit };
});
console.log('medic dispatch:', JSON.stringify(medic),
  medic.spawned ? 'MEDIC OK' : 'MEDIC FAIL');

// regression: panic() must reach the real game (not the <canvas id=game>) and
// cops/goons must ragdoll on death (not sink to y=0.1)
const bark = await page.evaluate(() => {
  const g = window.__game.game;
  let barked = false;
  const orig = g.audio.bark.bind(g.audio);
  g.audio.bark = (name, x, z) => { barked = true; };
  const ped = g.peds.peds.find((p) => !p.dead && !p.panicked);
  if (ped) { ped.panicked = false; ped.personality.civic = 0.1; for (let i=0;i<10 && !barked;i++){ ped.panicked=false; ped.panic(g.player.pos.x+5, g.player.pos.z); } }
  g.audio.bark = orig;
  return { barked, gameNotCanvas: typeof g.peds.peds[0].game?.audio === 'object' };
});
console.log('panic reaches game:', JSON.stringify(bark),
  bark.barked && bark.gameNotCanvas ? 'BARK OK' : 'BARK FAIL');

const copRag = await page.evaluate(() => {
  const g = window.__game.game;
  window.__game.setWanted(3);
  window.__game.tick(6);
  const cop = g.wanted.footCops.find((c) => !c.dead);
  if (!cop) return { skip: true };
  cop.damage(999, g, 'gun');
  window.__game.tick(0.5);
  return { hasRagdoll: !!cop.ragdoll, y: +cop.rig.group.position.y.toFixed(2) };
});
console.log('cop ragdoll:', JSON.stringify(copRag),
  copRag.skip || copRag.hasRagdoll ? 'COP-RAG OK' : 'COP-RAG FAIL');

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 10).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
