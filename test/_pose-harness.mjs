// Pose tuning harness v2: frozen player controller, manually-driven rig,
// fixed world-yaw camera. node test/_pose-harness.mjs poses.json outdir
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const outdir = process.argv[3];
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 880, height: 660 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:8080/?q=med', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.mode === 'menu', null, { timeout: 240000 });
await page.evaluate(() => {
  window.__game.newGame();
  window.__game.setWeather('clear');
  window.__game.setTime(15);
  const g = window.__game.game;
  for (const [id, ammo] of [['bat', 0], ['pistol', 60], ['smg', 90], ['shotgun', 24], ['rifle', 90]]) g.combat.give(id, ammo);
  const ep = g.city.nearestEdgePoint(g.player.pos.x + 60, g.player.pos.z + 45);
  if (ep) g.player.teleport(ep.x, ep.z, 0);
  g.player.update = () => {};              // freeze the controller
  g.player.heading = 0;
  g.player.rig.group.rotation.y = 0;
  window.__camAng = Math.PI * 0.78;
  window.__iv = setInterval(() => {
    g.player.rig.update(1 / 30, 0);        // keep the mixer + overlays running
    g.cameraRig.snapBehind(window.__camAng, 0.05);
  }, 30);
});
for (const [poseName, cfg] of Object.entries(spec)) {
  await page.evaluate(async ([name, pose, wpn, aim, overlay]) => {
    const m = await import('/src/core/animator.js');
    if (pose && overlay) m.OVERLAY_POSES[overlay] = pose;
    const g = window.__game.game;
    g.combat.select(wpn);
    g.combat.drawT = null;
    g.combat.attachWeaponMesh();
    const rig = g.player.rig;
    rig.setAnim('walk');
    rig.setAnim(aim ? 'aim' : 'idle');
    rig.animator.overlayW = 1;             // snap to full pose
    rig.animator.gesture = null;
  }, [poseName, cfg.pose ?? null, cfg.weapon, cfg.aim ? 1 : 0, cfg.overlay ?? null]);
  await page.evaluate(() => { window.__camAng = Math.PI * 0.78; });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outdir}/p-${poseName}-front.png`, clip: { x: 250, y: 120, width: 380, height: 420 } });
  await page.evaluate(() => { window.__camAng = Math.PI * 0.45; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outdir}/p-${poseName}-side.png`, clip: { x: 250, y: 120, width: 380, height: 420 } });
}
await browser.close();
console.log('done');
