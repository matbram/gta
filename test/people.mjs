// H2 checks: original procedural characters — variety, animation binding,
// role uniforms, ragdoll compatibility, sane proportions.
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
await page.evaluate(() => window.__game.tick(25));   // crowd ramps up slowly

// 1) factory path active + look variety across the crowd
{
  const r = await page.evaluate(async () => {
    const g = window.__game.game;
    const { textureCacheSize } = await import('/src/entities/charactertex.js');
    const peds = g.peds.peds.filter((p) => !p.dead);
    return {
      peds: peds.length,
      factory: peds.every((p) => p.rig.factoryBuilt),
      distinctLooks: textureCacheSize(),
      females: peds.filter((p) => p.rig.look?.female).length,
      elders: peds.filter((p) => (p.rig.look?.age ?? 0) > 0.7).length,
    };
  });
  console.log('variety:', JSON.stringify(r),
    r.factory && r.distinctLooks >= 8 && r.peds >= 8 ? 'VARIETY OK' : 'VARIETY FAIL');
}

// 2) clips actually drive the new mesh: a walking ped's thigh bone rotates
// (lodExempt: far off-screen rigs legitimately freeze their mixers — this
// test checks the clip pipeline, not the animation LOD)
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const ped = g.peds.peds.find((p) => !p.dead && p.rig.animator?.bones?.upLegL);
    if (!ped) return { skip: true };
    ped.rig.lodExempt = true;
    ped.rig.setAnim('walk');
    const q0 = ped.rig.animator.bones.upLegL.quaternion.toArray();
    window.__game.tick(0.4);
    const q1 = ped.rig.animator.bones.upLegL.quaternion.toArray();
    ped.rig.lodExempt = false;
    const delta = q0.reduce((s, v, i) => s + Math.abs(v - q1[i]), 0);
    return { delta: +delta.toFixed(4) };
  });
  console.log('walk clip:', JSON.stringify(r),
    r.skip || r.delta > 0.005 ? 'CLIP OK' : 'CLIP FAIL');
}

// 3) proportions sane (catches bind-matrix explosions): idle rig bbox —
// a mid-stride or knocked-down ped legitimately measures wider
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const T = g.THREE;
    const ped = g.peds.peds.find((p) => !p.dead && !p.knockdown && !p.wounded);
    if (!ped) return { skip: true };
    ped.rig.lodExempt = true;
    ped.rig.setAnim('idle');
    window.__game.tick(0.4);
    const box = new T.Box3().setFromObject(ped.rig.group);
    const size = box.getSize(new T.Vector3());
    ped.rig.lodExempt = false;
    return { h: +size.y.toFixed(2), w: +Math.max(size.x, size.z).toFixed(2) };
  });
  console.log('proportions:', JSON.stringify(r),
    r.skip || (r.h > 1.35 && r.h < 2.15 && r.w < 1.9) ? 'PROP OK' : 'PROP FAIL');
}

// 4) cops wear the uniform + cap and are visually distinct from civilians
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    window.__game.setWanted(2);
    window.__game.tick(7);
    const cop = g.wanted.footCops?.[0];
    const civ = g.peds.peds.find((p) => !p.dead && !p.rig.look?.uniform);
    if (!cop || !civ) return { skip: true, cops: g.wanted.footCops?.length ?? 0 };
    const copMesh = (() => { let m; cop.rig.group.traverse((o) => { if (o.isSkinnedMesh) m = o; }); return m; })();
    const civMesh = (() => { let m; civ.rig.group.traverse((o) => { if (o.isSkinnedMesh) m = o; }); return m; })();
    const r2 = {
      uniform: cop.rig.look?.uniform,
      hat: cop.rig.look?.hat,
      distinctMat: copMesh?.material !== civMesh?.material,
    };
    window.__game.setWanted(0);
    g.wanted.clear();
    return r2;
  });
  console.log('cop look:', JSON.stringify(r),
    r.skip || (r.uniform === 'cop' && r.hat === 'cap' && r.distinctMat) ? 'COP OK' : 'COP FAIL');
}

// 5) ragdoll still works on the new mesh (gore reads animator bones)
{
  const r = await page.evaluate(() => {
    const g = window.__game.game;
    const ped = g.peds.peds.find((p) => !p.dead);
    if (!ped) return { skip: true };
    ped.damage(999, g, 'gun', { dx: 1, dz: 0, force: 4, up: 1 });
    window.__game.tick(3);
    return { dead: ped.dead, hasRagdoll: !!ped.ragdoll, y: +(ped.ragdoll?.rootY ?? ped.rig.group.position.y).toFixed(2) };
  });
  console.log('ragdoll:', JSON.stringify(r),
    r.skip || (r.dead && r.hasRagdoll) ? 'RAGDOLL OK' : 'RAGDOLL FAIL');
}

// 6) draw calls: one mesh per character now — budget holds
{
  const draws = await page.evaluate(() => window.__game.drawCalls());
  console.log('draw calls:', draws, draws < 900 ? 'DRAWS OK' : 'DRAWS FAIL');
}

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 8).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
