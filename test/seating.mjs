// I2 checks: per-type driver seats (driver's side, not vehicle center),
// motorcycle straddle pose on top of the saddle, 0.35s mount lerp,
// traffic drivers using the same seat data.
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

// helper evaluated in-page: rig offset in the vehicle's local frame
const localOffset = `(v, rig) => {
  const dx = rig.group.position.x - v.pos.x, dz = rig.group.position.z - v.pos.z;
  const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
  return {
    right: +(dx * fz - dz * fx).toFixed(2),
    fwd: +(dx * fx + dz * fz).toFixed(2),
    up: +(rig.group.position.y - v.pos.y).toFixed(2),
  };
}`;

// 1) mount lerp: right after entering, the rig is still near the door
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    window.__game.spawnVehicleOnRoad('sedan');
    const before = { x: g.player.pos.x, z: g.player.pos.z };
    window.__game.enterNearestVehicle();
    const v = g.player.vehicle;
    if (!v) return { entered: false };
    g.vehicles.update(1 / 60);   // one frame into the mount
    const rig = g.player.rig.group.position;
    const seat = v.seatRigWorld();
    const early = Math.hypot(rig.x - seat.x, rig.z - seat.z);
    window.__game.tick(0.6);     // mount complete
    const late = Math.hypot(g.player.rig.group.position.x - seat.x, g.player.rig.group.position.z - seat.z);
    return { entered: true, early: +early.toFixed(2), late: +late.toFixed(2), from: before };
  });
  console.log('mount:', JSON.stringify(r),
    r.entered && r.early > 0.35 && r.late < 0.3 ? 'MOUNT OK' : 'MOUNT FAIL');
}

// 2) sedan: driver sits on the LEFT side, sunk into the cabin
{
  const r = await page.evaluate((loFn) => {
    const g = window.__game.game;
    const v = g.player.vehicle;
    const lo = eval(loFn)(v, g.player.rig);
    return { ...lo, anim: g.player.rig.anim };
  }, localOffset);
  console.log('sedan seat:', JSON.stringify(r),
    r.right < -0.2 && r.up < 0 && r.anim === 'drive' ? 'SEDAN OK' : 'SEDAN FAIL');
}

// 3) moto: straddle pose ON TOP of the saddle, centered
{
  const r = await page.evaluate((loFn) => {
    const g = window.__game.game;
    g.vehicles.exitVehicleForced();
    window.__game.spawnVehicleOnRoad('moto');
    // stand right next to the bike so it's the nearest vehicle
    const m = g.vehicles.vehicles.find((x) => x.type === 'moto' && !x.dead);
    g.player.teleport(m.pos.x + 1.2, m.pos.z, 0);
    g.vehicles.tryEnterExit();
    if (g.player.vehicle !== m) return { entered: false };
    window.__game.tick(0.6);
    const lo = eval(loFn)(m, g.player.rig);
    return { entered: true, ...lo, anim: g.player.rig.anim };
  }, localOffset);
  console.log('moto seat:', JSON.stringify(r),
    r.entered && Math.abs(r.right) < 0.1 && r.up > -0.1 && r.anim === 'ride'
      ? 'MOTO OK' : 'MOTO FAIL');
}

// 4) traffic drivers use the same seat data (left side of their car)
{
  const r = await page.evaluate((loFn) => {
    const g = window.__game.game;
    window.__game.tick(3);
    const car = g.traffic.cars.find((c) => c.driverPed && c.vehicle.type !== 'moto' && !c.vehicle.dead);
    if (!car) return { noCar: true };
    const lo = eval(loFn)(car.vehicle, car.driverPed.rig);
    return { type: car.vehicle.type, ...lo };
  }, localOffset);
  console.log('traffic seat:', JSON.stringify(r),
    !r.noCar && r.right < -0.2 ? 'TRAFFIC OK' : 'TRAFFIC FAIL');
}

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 8).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
