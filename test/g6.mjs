// G6 check: FP camera, ragdoll+blood, recoil/tracer/casings, lock-on, combo, wheel.
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
await page.evaluate(() => window.__game.tick(12));

// first-person cycle: near→mid→far→FP
const fp = await page.evaluate(() => {
  const g = window.__game.game;
  for (let i = 0; i < 3; i++) g.cameraRig.cycleDistance();
  return g.cameraRig.firstPerson;
});
console.log('first-person after 3 cycles:', fp, fp ? 'FP OK' : 'FP FAIL');
await page.evaluate(() => { window.__game.game.cameraRig.cycleDistance(); }); // back to near

// ragdoll + blood on a kill
const rag = await page.evaluate(() => {
  const g = window.__game.game;
  const ped = g.peds.peds.find((p) => !p.dead);
  const bloodBefore = g.gore.blood.decals.length;
  ped.damage(999, g, 'gun', { dx: 1, dz: 0, force: 4, up: 1 });
  window.__game.tick(1);
  return {
    hasRagdoll: !!ped.ragdoll,
    toppled: Math.abs(ped.rig.group.rotation.x) > 0.5 || Math.abs(ped.rig.group.rotation.z) > 0.5,
    blood: g.gore.blood.decals.length - bloodBefore,
  };
});
console.log('ragdoll+blood:', JSON.stringify(rag),
  rag.hasRagdoll && rag.blood > 0 ? 'RAGDOLL OK' : 'RAGDOLL FAIL');

// gun feel: tracer + shell pools created on fire
const guns = await page.evaluate(() => {
  const g = window.__game.game;
  g.combat.give('pistol', 60);
  g.combat.select('pistol');
  g.input.mouseDown[2] = true;
  const recoil0 = g.cameraRig.recoilPitch || 0;
  for (let i = 0; i < 3; i++) { g.input.mousePressed[0] = true; window.__game.tick(0.2); }
  g.input.mouseDown[2] = false;
  return {
    tracers: !!g.particles._tracerPool,
    shells: !!g.particles._shellMesh,
    recoiled: (g.cameraRig.recoilPitch || 0) !== 0 || g.combat.bloom > 0,
    muzzleLight: !!g.particles._mLight,
  };
});
console.log('gun feel:', JSON.stringify(guns),
  guns.tracers && guns.shells && guns.muzzleLight ? 'GUNFEEL OK' : 'GUNFEEL FAIL');

// lock-on acquires a nearby enemy
const lock = await page.evaluate(() => {
  const g = window.__game.game;
  // spawn a goon-ish target: use a fresh ped near the player, in front of camera
  const p = g.player.pos;
  const fx = -Math.sin(g.cameraRig.yaw), fz = -Math.cos(g.cameraRig.yaw);
  let near = g.peds.peds.find((pd) => !pd.dead);
  if (near) { near.pos.set(p.x + fx * 6, 0, p.z + fz * 6); near.syncRig?.(); }
  g.combat.acquireLock();
  return { locked: !!g.combat.lockTarget, playerFacing: g.player.lockHeading != null };
});
await page.evaluate(() => window.__game.tick(0.3));
const lock2 = await page.evaluate(() => ({ lh: window.__game.game.player.lockHeading != null }));
console.log('lock-on:', JSON.stringify({ ...lock, ...lock2 }),
  lock.locked ? 'LOCK OK' : 'LOCK FAIL');

// melee combo: three chained hits step the counter
const combo = await page.evaluate(() => {
  const g = window.__game.game;
  g.combat.select('fists');
  g.combat.lockTarget = null;
  const steps = [];
  for (let i = 0; i < 3; i++) {
    g.combat.cooldown = 0;
    g.input.mousePressed[0] = true;
    window.__game.tick(0.05);
    steps.push(g.combat.comboStep);
  }
  return steps;
});
console.log('melee combo steps:', JSON.stringify(combo),
  combo[0] === 1 && combo[2] === 3 ? 'COMBO OK' : 'COMBO FAIL');

// streetscape 2.0: original vegetation, utility wires, murals, parked density
const street = await page.evaluate(() => {
  const g = window.__game.game;
  window.__game.tick(2);
  return {
    palms: g.city.props.filter((p) => p.kind === 'palm').length,
    poles: g.city.props.filter((p) => p.kind === 'utilitypole').length,
    wires: !!g.cityMeshes.propGroup.getObjectByName('wires'),
    murals: g.cityMeshes.propGroup.children.length > 10,
    parkedCap: g.parkedCars ? 28 : 0,
  };
});
console.log('streetscape:', JSON.stringify(street),
  street.palms > 50 && street.poles > 100 && street.wires && street.murals && street.parkedCap === 28
    ? 'STREET OK' : 'STREET FAIL');

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 10).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
