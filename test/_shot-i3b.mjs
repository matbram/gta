import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:8080/?q=med', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.mode === 'menu', null, { timeout: 240000 });
await page.evaluate(() => {
  window.__game.newGame();
  window.__game.setWeather('clear');
  window.__game.setTime(15);
  const g = window.__game.game;
  for (const [id, ammo] of [['bat', 0], ['pistol', 60], ['shotgun', 24], ['rifle', 90]]) g.combat.give(id, ammo);
  // freeze the player controller so forced poses stick; drive the rig by hand
  g.player.update = () => {};
  window.__i3cam = setInterval(() => {
    g.player.rig.update(1 / 30, 0);
    g.cameraRig.snapBehind(g.player.heading + Math.PI * 0.72, 1);
    g.cameraRig.pitch = 0.06;
  }, 33);
});
for (const [wpn, anim] of [['rifle', 'aim'], ['shotgun', 'aim'], ['bat', 'aim'], ['fists', 'aim'], ['rifle', 'idle'], ['pistol', 'idle']]) {
  await page.evaluate(([w, a]) => {
    const g = window.__game.game;
    g.combat.select(w);
    g.combat.drawT = 0; g.combat.update(0.01, false);   // attach mesh now
    g.player.rig.setAnim('walk');                        // force a real switch
    g.player.rig.setAnim(a);
  }, [wpn, anim]);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${process.argv[2]}/i3b-${wpn}-${anim}.png`, clip: { x: 420, y: 140, width: 440, height: 460 } });
}
await browser.close();
