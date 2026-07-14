// H6 checks: WALK-IN interiors — no fade, no teleport. Buildings hollow out
// on approach, you walk through the door gap, rob the register, walk out,
// sleep at the safehouse, buy at the gun counter.
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
await page.evaluate(() => window.__game.tick(0.5));

// enterable doors registered (some are slope-skipped by design)
{
  const n = await page.evaluate(() => window.__game.game.interiors.recs.length);
  console.log('doors:', n, n > 400 ? 'DOORS OK' : 'DOORS FAIL');
}

// 1) WALK into a store: approach → building hollows → step through the gap.
//    Position is sampled every tick; any jump > 1.5 m would be a teleport.
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const rec = g.interiors.recs.find((rr) => rr.template === 'store');
    if (!rec) return { fail: 'no store rec' };
    const d = rec.door;
    // stand just outside the door, facing the doorway
    const outZ = d.z + d.face * 3.2;
    g.player.teleport(d.x, outZ, d.face > 0 ? Math.PI : 0);
    window.__game.tick(1);              // streamer hollows the building
    const built = !!rec.built;
    // walk forward (into the store), sampling per-tick displacement
    const walkHeading = d.face > 0 ? Math.PI : 0;   // toward the building
    g.cameraRig.snapBehind(walkHeading);
    let maxStep = 0;
    let prev = { x: g.player.pos.x, z: g.player.pos.z };
    for (let i = 0; i < 60; i++) {
      g.player.pos.x += Math.sin(walkHeading) * 0.12;
      g.player.pos.z += Math.cos(walkHeading) * 0.12;
      window.__game.tick(1 / 15);
      const step = Math.hypot(g.player.pos.x - prev.x, g.player.pos.z - prev.z);
      maxStep = Math.max(maxStep, step);
      prev = { x: g.player.pos.x, z: g.player.pos.z };
      if (g.interiors.playerInside) break;
    }
    const rec2 = g.interiors.playerInside;
    return {
      built,
      inside: !!rec2, current: g.interiors.current,
      maxStep: +maxStep.toFixed(2),
      inFootprint: rec2 ? Math.abs(g.player.pos.x - rec2.b.x) < rec2.b.w / 2 + 1 &&
        Math.abs(g.player.pos.z - rec2.b.z) < rec2.b.d / 2 + 1 : false,
      interiorY: g.player.interiorY,
      camUnderCeil: g.camera.position.y < (rec2 ? rec2.built.gy + 3.2 : 99),
    };
  });
  console.log('walk-in:', JSON.stringify(r),
    r.built && r.inside && r.current === 'store' && r.maxStep < 1.5 && r.inFootprint && r.camUnderCeil
      ? 'WALKIN OK' : 'WALKIN FAIL');
}

// 2) robbery: hold a gun on the keeper → register spits cash → heat banked
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const rec = g.interiors.playerInside;
    if (!rec) return { fail: 'not inside' };
    window.__game.giveWeapon('pistol', 60);
    g.combat.current = 'pistol';
    window.__game.tick(0.5);   // furnish tick (keeper spawns < 45 m)
    const keeper = rec.keeper;
    if (!keeper) return { fail: 'no keeper' };
    g.player.teleport(keeper.pos.x, keeper.pos.z + (rec.door.face > 0 ? 3 : -3));
    g.input.mouseDown[2] = true;
    window.__game.tick(6);
    g.input.mouseDown[2] = false;
    return {
      drops: g.interiors.robDrops,
      pendingHeat: g.interiors.pendingHeat,
      keeperAnim: keeper.rig.anim,
    };
  });
  console.log('robbery:', JSON.stringify(r),
    r.drops >= 3 && r.pendingHeat >= 95 ? 'ROB OK' : 'ROB FAIL');
}

// 3) walk out: heat lands, interiorY clears, still no teleport
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const rec = g.interiors.playerInside;
    if (!rec) return { fail: 'not inside' };
    const d = rec.door;
    const outHeading = d.face > 0 ? 0 : Math.PI;   // out through the doorway
    g.player.teleport(d.x, d.z - d.face * 1.2);    // step to just inside the gap
    let maxStep = 0;
    let prev = { x: g.player.pos.x, z: g.player.pos.z };
    for (let i = 0; i < 40 && g.interiors.playerInside; i++) {
      g.player.pos.x += Math.sin(outHeading) * 0.12;
      g.player.pos.z += Math.cos(outHeading) * 0.12;
      window.__game.tick(1 / 15);
      const step = Math.hypot(g.player.pos.x - prev.x, g.player.pos.z - prev.z);
      maxStep = Math.max(maxStep, step);
      prev = { x: g.player.pos.x, z: g.player.pos.z };
    }
    return {
      outside: !g.interiors.playerInside,
      stars: g.state.wanted.stars,
      interiorY: g.player.interiorY,
      maxStep: +maxStep.toFixed(2),
    };
  });
  console.log('walk-out:', JSON.stringify(r),
    r.outside && r.stars >= 2 && r.interiorY === null && r.maxStep < 1.5 ? 'EXIT+HEAT OK' : 'EXIT+HEAT FAIL');
}

// 4) safehouse bed save (teleport setup is fine — walk-in already proven)
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    g.wanted.clear?.();
    window.__game.setWanted(0);
    const rec = g.interiors.recs.find((rr) => rr.template === 'safehouse');
    if (!rec) return { fail: 'no safehouse' };
    g.player.teleport(rec.door.x, rec.door.z + rec.door.face * 3);
    window.__game.tick(1);
    if (!rec.built) return { fail: 'not built' };
    g.player.teleport(rec.bed.x + 0.5, rec.bed.z);
    window.__game.tick(1.5);
    return {
      current: g.interiors.current,
      slept: !!g.interiors.bedCooldown,
      hasSave: !!localStorage.getItem('bayvale-save-v1'),
    };
  });
  console.log('bed save:', JSON.stringify(r),
    r.current === 'safehouse' && r.slept && r.hasSave ? 'BED OK' : 'BED FAIL');
}

// 5) gun-shop counter opens the buy menu
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const rec = g.interiors.recs.find((rr) => rr.template === 'gunshop');
    if (!rec) return { fail: 'no gunshop' };
    g.player.teleport(rec.door.x, rec.door.z + rec.door.face * 3);
    window.__game.tick(1);
    if (!rec.built || !rec.register) return { fail: 'not built', built: !!rec.built };
    g.player.teleport(rec.register.x, rec.register.z + (rec.door.face > 0 ? 1.4 : -1.4));
    window.__game.tick(1);
    return { current: g.interiors.current, mode: g.state.mode };
  });
  console.log('gun counter:', JSON.stringify(r),
    r.current === 'gunshop' && r.mode === 'shop' ? 'COUNTER OK' : 'COUNTER FAIL');
}

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 8).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
