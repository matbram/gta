// H1 checks: prop colliders stop cars, OBB car-vs-car, knockables
// (hydrant geyser, falling lamp), ped separation, crash SFX.
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
await page.evaluate(() => window.__game.tick(1));

// helper injected once: find a prop of a kind with a building-free approach
// corridor from the west, then ram it with a fresh sedan
await page.evaluate(() => {
  window.__ram = (kind, speed, fromDist = 14) => {
    const g = window.__game.game;
    const clear = (p) => {
      for (let d = 0; d <= fromDist + 2; d += 1) {
        const x = p.x - d;
        for (const b of g.city.queryColliders(x, p.z, 1.6)) {
          if (b === p.box) continue;
          if (x > b.minX - 1.2 && x < b.maxX + 1.2 && p.z > b.minZ - 1.2 && p.z < b.maxZ + 1.2) return false;
        }
      }
      return true;
    };
    const p = g.city.props.find((pr) =>
      pr.kind === kind && !pr.knocked && pr.box &&
      ['oldtown', 'midtown', 'crown'].includes(g.city.districtAt(pr.x, pr.z)) &&
      Math.abs(g.city.groundHeight(pr.x - fromDist, pr.z) - g.city.groundHeight(pr.x, pr.z)) < 0.4 &&
      clear(pr));
    if (!p) return null;
    const v = g.vehicles.spawn('sedan', p.x - fromDist, p.z, Math.PI / 2); // heading +x
    v.vel.set(speed, 0);
    v.speed = speed;
    window.__ramTarget = p;
    window.__ramCar = v;
    return { px: p.x, pz: p.z };
  };
});

// 1) tree stops a car dead (not knockable)
{
  const ok = await page.evaluate(() => {
    const got = window.__ram('tree', 16);
    if (!got) return { skip: true };
    window.__game.tick(3);
    const g = window.__game.game;
    const v = window.__ramCar, p = window.__ramTarget;
    const stoppedBefore = v.pos.x < p.x - 0.4;
    const slow = Math.hypot(v.vel.x, v.vel.y) < 2.5;
    g.vehicles.remove(v);
    return { stoppedBefore, slow, x: v.pos.x.toFixed(1), tx: p.x.toFixed(1) };
  });
  console.log('tree stop:', JSON.stringify(ok),
    ok.skip || (ok.stoppedBefore && ok.slow) ? 'TREE OK' : 'TREE FAIL');
}

// 2) OBB, not circles: two sedans side-by-side settle at real body width (~1.9m),
//    where the old circle model would shove them ≥3.2m apart
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const px = g.player.pos.x, pz = g.player.pos.z;
    const a = g.vehicles.spawn('sedan', px + 30, pz, 0);
    const b = g.vehicles.spawn('sedan', px + 31.2, pz, 0);
    window.__game.tick(2);
    const sep = Math.abs(b.pos.x - a.pos.x);
    const hw2 = a.hw + b.hw;
    g.vehicles.remove(a); g.vehicles.remove(b);
    return { sep: +sep.toFixed(2), min: +(hw2 * 0.96).toFixed(2), max: +(hw2 + 0.75).toFixed(2) };
  });
  console.log('obb separation:', JSON.stringify(r),
    r.sep >= r.min && r.sep <= r.max ? 'OBB OK' : 'OBB FAIL');
}

// 3) car cannot drive through a parked bus side
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const px = g.player.pos.x, pz = g.player.pos.z;
    const bus = g.vehicles.spawn('bus', px + 50, pz, 0);       // length along +z
    const car = g.vehicles.spawn('sedan', px + 50 - 16, pz, Math.PI / 2);
    car.vel.set(15, 0); car.speed = 15;
    window.__game.tick(3);
    const stopped = car.pos.x < bus.pos.x - bus.hw;   // never reached the far side
    const gap = bus.pos.x - car.pos.x;
    g.vehicles.remove(bus); g.vehicles.remove(car);
    return { stopped, gap: +gap.toFixed(2) };
  });
  console.log('bus block:', JSON.stringify(r), r.stopped ? 'BUS OK' : 'BUS FAIL');
}

// 4) hydrant knock → geyser + collider retired
{
  const r = await page.evaluate(() => {
    const got = window.__ram('hydrant', 12, 10);
    if (!got) return { skip: true };
    window.__game.tick(2);
    const g = window.__game.game;
    const p = window.__ramTarget;
    const colliderGone = !g.city.queryColliders(p.x, p.z, 1).some((b) => b.owner === p);
    const r2 = {
      knocked: !!p.knocked,
      geysers: g.knockables.geysers.length,
      colliderGone,
    };
    g.vehicles.remove(window.__ramCar);
    return r2;
  });
  console.log('hydrant:', JSON.stringify(r),
    r.skip || (r.knocked && r.geysers > 0 && r.colliderGone) ? 'HYDRANT OK' : 'HYDRANT FAIL');
}

// 5) lamp post falls over on a hard hit
{
  const r = await page.evaluate(() => {
    const got = window.__ram('lamp', 18, 10);
    if (!got) return { skip: true };
    window.__game.tick(2.5);
    const g = window.__game.game;
    const p = window.__ramTarget;
    const d = g.knockables.debris.find((dd) => dd.kind === 'lamp');
    const r2 = { knocked: !!p.knocked, fell: !!d && d.mode === 'fall' && d.angle > 1.2 };
    g.vehicles.remove(window.__ramCar);
    return r2;
  });
  console.log('lamp fall:', JSON.stringify(r),
    r.skip || (r.knocked && r.fell) ? 'LAMP OK' : 'LAMP FAIL');
}

// 6) ped separation: colocate 6 peds, they push apart
{
  const r = await page.evaluate(() => {
    window.__game.tick(4);   // let peds spawn
    const g = window.__game.game;
    const peds = g.peds.peds.filter((p) => !p.dead).slice(0, 6);
    if (peds.length < 4) return { skip: true, n: peds.length };
    const cx = g.player.pos.x + 12, cz = g.player.pos.z;
    for (const p of peds) { p.pos.x = cx; p.pos.z = cz; }
    window.__game.tick(2);
    let minD = 99;
    for (let i = 0; i < peds.length; i++)
      for (let j = i + 1; j < peds.length; j++) {
        const d = Math.hypot(peds[i].pos.x - peds[j].pos.x, peds[i].pos.z - peds[j].pos.z);
        if (d < minD) minD = d;
      }
    return { n: peds.length, minD: +minD.toFixed(2) };
  });
  console.log('ped separation:', JSON.stringify(r),
    r.skip || r.minD > 0.5 ? 'SEP OK' : 'SEP FAIL');
}

// 7) crash SFX attempted at least once during all of the above
{
  const n = await page.evaluate(() => window.__game.game.audio.crashCount || 0);
  console.log('crash sfx count:', n, n > 0 ? 'SFX OK' : 'SFX FAIL');
}

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 8).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
