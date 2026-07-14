// I4 checks: NPC field of view (no psychic reactions behind their back),
// hearing with a turn-then-react beat, brandish nervousness, corpse
// discovery, sprint-bump stumble + fear memory, gang-corner warnings.
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
await page.evaluate(() => { window.__game.setWeather('clear'); window.__game.setTime(12); });

// helper: spawn a controlled ped at an offset from the player, facing a heading
const plant = `(dx, dz, heading) => {
  const g = window.__game.game;
  const mod = g.peds;
  const ped = mod.peds[0];
  const p = g.player.pos;
  ped.place(p.x + dx, p.z + dz);
  ped.heading = heading;
  ped.rig.group.rotation.y = heading;
  ped.state = 'idle'; ped.stateT = 0;
  ped.panicked = false; ped.alarm = null; ped.loiter = true;
  ped.archetype = 'commuter';
  ped.personality = { bravery: 0.3, curiosity: 0.4, aggression: 0.2, civic: 0.3 };
  return ped;
}`;

// 0) make sure at least one ped exists
await page.evaluate(() => {
  const g = window.__game.game;
  window.__game.tick(3);
  if (!g.peds.peds.length) throw new Error('no peds spawned');
});

// 1) field of view: aiming a gun at a ped facing AWAY does nothing;
//    facing TOWARD the player they get nervous
{
  const r = await page.evaluate((plantSrc) => {
    const g = window.__game.game;
    const plant2 = eval(plantSrc);
    g.combat.give('pistol', 30);
    g.combat.select('pistol');
    // facing away (player is at -dz relative to ped → ped looks +z away)
    const ped = plant2(0, 6, 0);            // ped 6m ahead, facing away from player
    g.input.mouseDown[2] = true;            // brandish/aim
    window.__game.tick(2.5);
    const unaware = !ped.panicked && !ped.alarm;
    // now face the player
    ped.state = 'idle'; ped.stateT = 0; ped.panicked = false; ped.alarm = null;
    ped.heading = Math.PI;                  // facing back toward the player
    window.__game.tick(2.5);
    const noticed = ped.panicked || !!ped.alarm || ped._wary > 0;
    g.input.mouseDown[2] = false;
    return { unaware, noticed };
  }, plant);
  console.log('fov:', JSON.stringify(r), r.unaware && r.noticed ? 'FOV OK' : 'FOV FAIL');
}

// 2) hearing: gunfire behind their back → turn first, react after a beat
{
  const r = await page.evaluate((plantSrc) => {
    const g = window.__game.game;
    const ped = eval(plantSrc)(0, 20, 0);   // 20m ahead, facing away
    g.input.mouseDown[2] = true;
    g.input.mousePressed[0] = true;
    g.combat.cooldown = 0;
    window.__game.tick(1 / 30);             // the shot
    const rightAfter = { alarmed: !!ped.alarm, panicked: ped.panicked };
    window.__game.tick(1.6);                // beat passes
    const later = { panicked: ped.panicked, state: ped.state };
    g.input.mouseDown[2] = false;
    return { rightAfter, later };
  }, plant);
  console.log('hearing:', JSON.stringify(r),
    r.rightAfter.alarmed && !r.rightAfter.panicked && r.later.panicked
      ? 'HEAR OK' : 'HEAR FAIL');
}

// 3) corpse discovery: a ped walking onto a body reacts
{
  const r = await page.evaluate((plantSrc) => {
    const g = window.__game.game;
    window.__game.tick(2);
    const victim = g.peds.peds.find((p) => !p.dead && p !== g.peds.peds[0]);
    if (!victim) return { noVictim: true };
    const p = g.player.pos;
    victim.place(p.x + 30, p.z + 30);
    victim.die(g);
    const witness = eval(plantSrc)(24, 30, Math.PI / 2);  // 6m from corpse, facing it
    witness.panicked = false; witness.state = 'idle'; witness._sawCorpse = null;
    window.__game.tick(3);
    return { reacted: witness.panicked || !!witness.alarm || witness.state !== 'idle', state: witness.state };
  }, plant);
  console.log('corpse:', JSON.stringify(r), !r.noVictim && r.reacted ? 'CORPSE OK' : 'CORPSE FAIL');
}

// 4) sprint bump: stumble + fear memory
{
  const r = await page.evaluate((plantSrc) => {
    const g = window.__game.game;
    const ped = eval(plantSrc)(0.5, 1.0, 0);
    g.player.vel.x = 0; g.player.vel.z = 7;   // sprinting into them
    g.player.speed2d = 7;
    for (let i = 0; i < 20; i++) {
      ped.pos.set(g.player.pos.x + 0.15, ped.pos.y, g.player.pos.z + 0.4);
      g.peds.separate();
      g.peds.update(1 / 30);
    }
    return { fear: (ped.avoidPlayerT ?? 0) > 0 };
  }, plant);
  console.log('bump:', JSON.stringify(r), r.fear ? 'BUMP OK' : 'BUMP FAIL');
}

// 5) gang corner: lingering draws a warning, then aggro
{
  const r = await page.evaluate((plantSrc) => {
    const g = window.__game.game;
    const ped = eval(plantSrc)(0, 2.2, Math.PI);
    ped.archetype = 'gangster';
    ped.loiter = true;
    ped.personality = { bravery: 0.9, curiosity: 0.3, aggression: 0.9, civic: 0 };
    ped._lingerT = 0;
    window.__game.tick(5);
    const warned = ped._warned === true;
    window.__game.tick(6);
    return { warned, aggro: ped.state === 'fight' };
  }, plant);
  console.log('gang:', JSON.stringify(r), r.warned && r.aggro ? 'GANG OK' : 'GANG FAIL');
}

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 8).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
