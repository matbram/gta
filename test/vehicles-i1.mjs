// I1 checks: torque launch, 3-gear rpm, brake/reverse lights, windshield
// panes, speedometer + money ticks, run-over covers cops (cop heat),
// low-speed nudge, gloomy-weather headlights, locked cars + alarms.
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

// 1) windshield + reverse lamps exist and sit on the right ends
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    window.__game.spawnVehicleOnRoad('sedan');
    const v = g.vehicles.vehicles.find((x) => x.parked !== true && !x.aiControlled);
    let frontGlass = 0, rearLamps = 0;
    v.group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox?.();
      const bb = o.geometry.boundingBox;
      // merged reverse-lamp pair sits at the rear
      if (o.material === v.reverseMat && bb && bb.max.z < -v.spec.l * 0.4) rearLamps += 2;
      // merged window panes: bright transparent glass reaching the windshield
      if (o.material?.transparent && o.material.opacity === 0.55 &&
          bb && bb.max.z > v.spec.l * 0.15) frontGlass++;
    });
    return { hasReverseMat: !!v.reverseMat, rearLamps, frontGlass };
  });
  console.log('mesh:', JSON.stringify(r),
    r.hasReverseMat && r.rearLamps >= 2 && r.frontGlass >= 1 ? 'MESH OK' : 'MESH FAIL');
}

// 2) torque launch + gears + speedometer
{
  await page.evaluate(() => window.__game.enterNearestVehicle());
  await page.keyboard.down('w');
  const launch = await page.evaluate(() => {
    const g = window.__game.game;
    const v = g.player.vehicle;
    window.__game.tick(1);
    return { speed1s: +v.speed.toFixed(1), accel: v.spec.accel, gear1s: v.gear };
  });
  const topEnd = await page.evaluate(() => {
    const g = window.__game.game;
    const v = g.player.vehicle;
    // gear mapping is deterministic in speed: sample low/mid/high directly
    const gearAt = (frac) => {
      const f = { x: Math.sin(v.heading), z: Math.cos(v.heading) };
      const s = v.spec.maxSpeed * v.maxHealthSpeedFactor * frac;
      v.vel.set(f.x * s, f.z * s);
      v.updatePhysics(1 / 60, { throttle: 0, steer: 0, handbrake: false });
      return v.gear;
    };
    const gears = `${gearAt(0.1)}${gearAt(0.5)}${gearAt(0.92)}`;
    v.vel.set(0, 0);
    window.__game.tick(0.1);
    return {
      gears,
      rpmOk: v.rpm >= 0 && v.rpm <= 1,
      speedoShown: !document.getElementById('speedo').classList.contains('hidden'),
    };
  });
  const punchy = launch.speed1s > launch.accel * 0.8;
  console.log('drive:', JSON.stringify({ ...launch, ...topEnd }),
    punchy && topEnd.gears === '012' && topEnd.rpmOk && topEnd.speedoShown
      ? 'DRIVE OK' : 'DRIVE FAIL');
}

// 3) brake + reverse lights
{
  await page.keyboard.down('w');
  await page.evaluate(() => window.__game.tick(1.2));   // get rolling forward
  await page.keyboard.up('w');
  await page.keyboard.down('s');
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const v = g.player.vehicle;
    window.__game.tick(0.12);   // sample mid-brake, before the reverse swing
    const braking = { flag: v.braking, tail: v.tailMat.emissiveIntensity, speed: +v.speed.toFixed(1) };
    window.__game.tick(4);      // keep holding S: come to rest, then reverse
    const reversing = { flag: v.reversing, rev: v.reverseMat.emissiveIntensity, speed: +v.speed.toFixed(1) };
    return { braking, reversing };
  });
  await page.keyboard.up('s');
  console.log('lights:', JSON.stringify(r),
    r.braking.flag && r.braking.tail > 1 && r.reversing.flag && r.reversing.rev > 1
      ? 'LIGHTS OK' : 'LIGHTS FAIL');
}

// 4) headlights come on in rain at noon, off again when clear
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    window.__game.setWeather('rain');
    window.__game.tick(0.5);
    const v = g.player.vehicle;
    const rainOn = v.lightsOn && v.headMat.emissiveIntensity > 0;
    window.__game.setWeather('clear');
    window.__game.tick(0.5);
    const clearOff = !v.lightsOn;
    return { rainOn, clearOff };
  });
  console.log('gloom lights:', JSON.stringify(r), r.rainOn && r.clearOff ? 'GLOOM OK' : 'GLOOM FAIL');
}

// 5) running over a cop applies cop heat; crews are valid targets
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const v = g.player.vehicle;
    window.__game.setWanted(1);
    window.__game.tick(2);   // let a foot cop spawn
    const cop = g.wanted.footCops[0];
    if (!cop) return { noCop: true };
    const heat0 = g.wanted.state.heat;
    const hp0 = cop.health;
    cop.pos.set(v.pos.x, cop.pos.y, v.pos.z);   // stand him on the bumper
    g.peds.checkRunOver(v, 10);
    return {
      hp0, hp1: cop.health, dead: cop.dead,
      heatGain: +(g.wanted.state.heat - heat0).toFixed(0),
      crewFn: Array.isArray(g.dispatch?.crewPeds?.()),
      inTargets: g.peds.hitTargets().includes(cop),
    };
  });
  console.log('cop runover:', JSON.stringify(r),
    !r.noCop && r.hp1 < r.hp0 && r.heatGain >= 25 && r.crewFn && r.inTargets
      ? 'COP OK' : 'COP FAIL');
  await page.evaluate(() => { window.__game.game.wanted.clear(); window.__game.game.state.wanted.stars = 0; });
}

// 6) low-speed nudge pushes a ped out instead of leaving them inside the car
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const v = g.player.vehicle;
    const ped = g.peds.peds.find((p) => !p.dead);
    if (!ped) return { noPed: true };
    ped.pos.set(v.pos.x + 0.5, ped.pos.y, v.pos.z);
    ped.loiter = true; ped.state = 'idle';       // hold still
    v.vel.set(0.8, 0);                            // slow roll
    for (let i = 0; i < 45; i++) g.vehicles.update(1 / 30);
    const d = Math.hypot(ped.pos.x - v.pos.x, ped.pos.z - v.pos.z);
    v.vel.set(0, 0);
    return { d: +d.toFixed(2), need: +(v.radius + 0.4).toFixed(2), alive: !ped.dead };
  });
  console.log('nudge:', JSON.stringify(r),
    !r.noPed && r.alive && r.d >= r.need - 0.15 ? 'NUDGE OK' : 'NUDGE FAIL');
}

// 7) money tick appears on a pickup
{
  const r = await page.evaluate(() => {
    window.__game.addMoney(50);
    window.__game.tick(0.2);
    return { ticks: document.querySelectorAll('#moneyticks .mtick.gain').length };
  });
  console.log('money tick:', JSON.stringify(r), r.ticks >= 1 ? 'TICK OK' : 'TICK FAIL');
}

// 8) locked parked cars exist; breaking in takes a beat, adds heat, can trip the alarm
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    g.vehicles.exitVehicleForced();
    const locked = g.vehicles.vehicles.find((v) => v.parked && v.locked && !v.dead);
    const lockedCount = g.vehicles.vehicles.filter((v) => v.parked && v.locked).length;
    if (!locked) return { lockedCount };
    locked.alarmed = true;                        // force the alarm branch
    g.player.teleport(locked.pos.x + 2.0, locked.pos.z, 0);
    const heat0 = g.wanted.state.heat;
    g.vehicles.tryEnterExit();
    const started = !!g.vehicles._breakIn;
    const before = g.player.vehicle;
    window.__game.tick(1.2);
    return {
      lockedCount, started, enteredEarly: !!before,
      entered: g.player.vehicle === locked,
      unlocked: !locked.locked,
      alarmOn: locked.alarmT > 0,
      heatGain: +(g.wanted.state.heat - heat0).toFixed(1),
    };
  });
  console.log('locked:', JSON.stringify(r),
    r.lockedCount > 0 && r.started && !r.enteredEarly && r.entered && r.unlocked &&
    r.alarmOn && r.heatGain > 0
      ? 'LOCKED OK' : 'LOCKED FAIL');
}

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 8).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
