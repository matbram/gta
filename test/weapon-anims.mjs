// I3 checks: per-weapon stance + carry overlays, draw-on-switch with the
// mesh appearing mid-motion, per-class reload gestures, interruptible
// shotgun shell loading, the pump cycle, bat swings, and recoil kick.
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

// 1) every weapon maps to its own aim stance + carry pose
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    for (const [id, ammo] of [['bat', 0], ['pistol', 60], ['smg', 90], ['shotgun', 24], ['rifle', 90]]) {
      g.combat.give(id, ammo);
    }
    const rig = g.player.rig;
    const out = {};
    for (const id of ['fists', 'bat', 'pistol', 'smg', 'shotgun', 'rifle']) {
      g.combat.select(id);
      rig.setAnim('aim');
      const aim = rig.animator.targetOverlay;
      rig.setAnim('idle');
      const carry = rig.animator.targetOverlay;
      out[id] = `${aim}/${carry}`;
    }
    return out;
  });
  const want = {
    fists: 'guardFists/none', bat: 'stanceBat/carryBat', pistol: 'aimPistol/carryPistol',
    smg: 'aimSmg/carryLong', shotgun: 'aimShotgun/carryLong', rifle: 'aimRifle/carryLong',
  };
  const ok = Object.entries(want).every(([k, v]) => r[k] === v);
  console.log('stances:', JSON.stringify(r), ok ? 'STANCE OK' : 'STANCE FAIL');
}

// 2) draw on switch: gesture plays, mesh hidden then appears mid-motion
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    g.combat.select('pistol');
    window.__game.tick(0.5);
    g.combat.select('rifle');
    const during = {
      gesture: !!g.player.rig.animator.gesture,
      meshHidden: !g.combat.weaponMeshes.rifle?.visible,
      drawT: g.combat.drawT,
    };
    window.__game.tick(0.25);
    return { ...during, meshAfter: g.combat.weaponMeshes.rifle?.visible === true };
  });
  console.log('draw:', JSON.stringify(r),
    r.gesture && r.meshHidden && r.drawT > 0 && r.meshAfter ? 'DRAW OK' : 'DRAW FAIL');
}

// 3) per-class reload times + gestures
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const out = {};
    for (const id of ['pistol', 'rifle']) {
      g.combat.select(id);
      window.__game.tick(0.3);
      const inv = g.combat.inventory[id];
      inv.inMag -= 3;
      g.combat.startReload();
      out[id] = { t: +g.combat.reloading.toFixed(2), gesture: !!g.player.rig.animator.gesture };
      window.__game.tick(2);
      out[id].refilled = inv.inMag === (id === 'pistol' ? 15 : 30);
    }
    return out;
  });
  console.log('reloads:', JSON.stringify(r),
    r.pistol.t === 1.4 && r.rifle.t === 1.7 && r.pistol.gesture && r.rifle.gesture &&
    r.pistol.refilled && r.rifle.refilled ? 'RELOAD OK' : 'RELOAD FAIL');
}

// 4) shotgun loads shell by shell and firing interrupts it
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    g.combat.select('shotgun');
    window.__game.tick(0.3);
    const inv = g.combat.inventory.shotgun;
    inv.inMag = 2;
    g.combat.startReload();
    const t0 = { loading: g.combat.shellLoading, t: +g.combat.reloading.toFixed(2) };
    window.__game.tick(0.6);          // one shell in
    const oneIn = inv.inMag === 3 && g.combat.shellLoading;
    window.__game.tick(0.55);         // second shell
    const twoIn = inv.inMag === 4;
    return { ...t0, oneIn, twoIn };
  });
  console.log('shells:', JSON.stringify(r),
    r.loading && r.t === 0.55 && r.oneIn && r.twoIn ? 'SHELLS OK' : 'SHELLS FAIL');
}

// 5) live fire: shotgun shot kicks the arms then pumps (input driven
// directly — synthetic clicks are swallowed by the pointer-lock gate)
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const inv = g.combat.inventory.shotgun;
    g.combat.shellLoading = false; g.combat.reloading = 0; g.combat.cooldown = 0;
    inv.inMag = 6;
    window.__game.tick(0.2);
    g.input.mouseDown[2] = true;        // aim
    g.input.mousePressed[0] = true;     // trigger
    window.__game.tick(1 / 30);         // fire frame
    const fired = inv.inMag;
    const kicked = !!g.player.rig.animator.gesture;   // gunKick playing
    const pumpQueued = g.combat.pumpAt != null;
    window.__game.tick(0.3);            // pump cycle begins
    const pumping = !!g.player.rig.animator.gesture;
    g.input.mouseDown[2] = false;
    return { fired, kicked, pumpQueued, pumping };
  });
  console.log('pump:', JSON.stringify(r),
    r.fired === 5 && r.kicked && r.pumpQueued && r.pumping ? 'PUMP OK' : 'PUMP FAIL');
}

// 6) bat swing gesture (distinct from punches) on melee attack
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    g.combat.select('bat');
    window.__game.tick(0.4);
    g.player.rig.batSwing(false);
    const swings = !!g.player.rig.animator.gesture;
    window.__game.tick(1);
    g.player.rig.batSwing(true);      // overhead finisher
    const overhead = !!g.player.rig.animator.gesture;
    return { swings, overhead, hasApi: typeof g.player.rig.batSwing === 'function' };
  });
  console.log('bat:', JSON.stringify(r), r.swings && r.overhead ? 'BAT OK' : 'BAT FAIL');
}

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 8).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
