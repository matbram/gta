// H4 checks: real sun/moon discs, procedural PMREM environment (no HDRIs),
// weather → rain + wet roads, skid marks, day/night sky states.
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
await page.evaluate(() => window.__game.setWeather('clear'));

// 1) noon: sun disc up, moon down, environment is procedural (no assets.hdris)
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    window.__game.setTime(12);
    window.__game.tick(1);
    const sun = g.scene.getObjectByName('sundisc');
    const moon = g.scene.getObjectByName('moondisc');
    return {
      sunVisible: sun.visible, sunY: +sun.position.y.toFixed(0),
      moonVisible: moon.visible,
      envSet: !!g.scene.environment,
      hdrisGone: g.assets.hdris === undefined,
      domeUp: !!g.scene.getObjectByName('skydome'),
    };
  });
  console.log('noon:', JSON.stringify(r),
    r.sunVisible && r.sunY > 800 && !r.moonVisible && r.envSet && r.hdrisGone && r.domeUp
      ? 'NOON OK' : 'NOON FAIL');
}

// 2) midnight: moon up + textured, sun hidden, stars lit
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    window.__game.setTime(0.5);
    window.__game.tick(1);
    const sun = g.scene.getObjectByName('sundisc');
    const moon = g.scene.getObjectByName('moondisc');
    return {
      sunVisible: sun.visible,
      moonVisible: moon.visible, moonY: +moon.position.y.toFixed(0),
      moonTextured: !!moon.material.map,
      stars: +g.terrain.stars.material.opacity.toFixed(2),
    };
  });
  console.log('midnight:', JSON.stringify(r),
    !r.sunVisible && r.moonVisible && r.moonY > 300 && r.moonTextured && r.stars > 0.4
      ? 'MIDNIGHT OK' : 'MIDNIGHT FAIL');
}

// 3) environment re-bakes as time jumps (texture identity changes)
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    window.__game.setTime(9);
    window.__game.tick(1);
    const a = g.scene.environment?.uuid;
    window.__game.setTime(18.5);
    window.__game.tick(1);
    const b = g.scene.environment?.uuid;
    return { a: !!a, changed: a !== b };
  });
  console.log('env rebake:', JSON.stringify(r), r.a && r.changed ? 'ENV OK' : 'ENV FAIL');
}

// 4) rain: drops visible, roads gloss up, fog closes in
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    window.__game.setTime(14);
    window.__game.setWeather('rain');
    window.__game.tick(2);
    const ground = g.scene.getObjectByName('terrain');
    return {
      rainVisible: g.weather.rainMesh.visible,
      roughness: +ground.material.roughness.toFixed(2),
      fogFar: Math.round(g.scene.fog.far),
      cloudUniform: +g.sky.uniforms.uCloud.value.toFixed(2),
    };
  });
  console.log('rain:', JSON.stringify(r),
    r.rainVisible && r.roughness < 0.7 && r.fogFar < 600 && r.cloudUniform > 0.6
      ? 'RAIN OK' : 'RAIN FAIL');
}

// 5) back to clear: roads dry out
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    window.__game.setWeather('clear');
    window.__game.tick(2);
    const ground = g.scene.getObjectByName('terrain');
    return { rough: +ground.material.roughness.toFixed(2), rain: g.weather.rainMesh.visible };
  });
  console.log('clear:', JSON.stringify(r), r.rough > 0.85 && !r.rain ? 'CLEAR OK' : 'CLEAR FAIL');
}

// 6) burnout leaves skid marks
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    window.__game.spawnVehicleOnRoad('sports');
    window.__game.enterNearestVehicle();
    return { driving: !!g.player.vehicle };
  });
  await page.keyboard.down('w');
  await page.evaluate(() => window.__game.tick(3));
  await page.keyboard.down('Space');
  await page.evaluate(() => window.__game.tick(2));
  await page.keyboard.up('Space');
  await page.keyboard.up('w');
  const s = await page.evaluate(() => ({
    driving: !!window.__game.game.player.vehicle,
    skids: window.__game.game.particles._skidIdx ?? 0,
  }));
  console.log('skids:', JSON.stringify(s), s.skids > 0 ? 'SKID OK' : 'SKID FAIL');
}

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 8).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
