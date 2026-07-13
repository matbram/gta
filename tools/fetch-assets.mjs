#!/usr/bin/env node
// Downloads the two things Bayvale still fetches from the internet:
//  - ambientCG PBR surface textures (CC0) for ground/facade materials
//  - the three.js example Soldier.glb (MIT), used ONLY as the animation +
//    skeleton source for our own generated characters (never rendered)
// Everything else in the game — characters, vehicles, props, vegetation,
// sky — is generated at runtime. Run: node tools/fetch-assets.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, renameSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const A = (p) => join(ROOT, 'assets', p);

function dl(url, dest, tries = 2) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && fs.statSync(dest).size > 500) { ok++; return true; }
  for (let i = 0; i < tries; i++) {
    try {
      execFileSync('curl', ['-sL', '--fail', '--max-time', '120', '-o', dest, url], { stdio: 'pipe' });
      if (fs.statSync(dest).size > 500) { ok++; console.log('  ✓', path.relative(ROOT, dest)); return true; }
    } catch {}
  }
  fail++;
  console.log('  ✗ FAILED', url);
  try { fs.rmSync(dest, { force: true }); } catch {}
  return false;
}

function unzip(zipPath, outDir, wanted = null) {
  fs.mkdirSync(outDir, { recursive: true });
  const script = `
import zipfile, sys, os, fnmatch
z = zipfile.ZipFile(sys.argv[1])
out = sys.argv[2]
pats = sys.argv[3].split('|') if len(sys.argv) > 3 and sys.argv[3] else None
for n in z.namelist():
    base = os.path.basename(n)
    if not base: continue
    if pats and not any(fnmatch.fnmatch(base, p) for p in pats): continue
    with z.open(n) as src, open(os.path.join(out, base), 'wb') as dst:
        dst.write(src.read())
`;
  execFileSync('python3', ['-c', script, zipPath, outDir, wanted ? wanted.join('|') : ''], { stdio: 'pipe' });
}

// ---------------------------------------------------------------- ambientCG PBR textures (CC0)
console.log('\n[ambientCG PBR textures — CC0]');
const TEXTURES = {
  asphalt: 'Asphalt008', sidewalk: 'PavingStones128', brick: 'Bricks059',
  concrete: 'Concrete016', plaster: 'Plaster001', grass: 'Grass004',
  sand: 'Ground054', metal: 'CorrugatedSteel005',
};
for (const [name, id] of Object.entries(TEXTURES)) {
  const zip = A(`_tmp/${id}.zip`);
  if (dl(`https://ambientcg.com/get?file=${id}_1K-JPG.zip`, zip)) {
    try {
      unzip(zip, A('textures/' + name), ['*Color.jpg', '*NormalGL.jpg', '*Roughness.jpg']);
      // normalize names
      const dir = A('textures/' + name);
      for (const f of fs.readdirSync(dir)) {
        const to = f.includes('Color') ? 'color.jpg' : f.includes('NormalGL') ? 'normal.jpg' : f.includes('Roughness') ? 'rough.jpg' : null;
        if (to) fs.renameSync(path.join(dir, f), path.join(dir, to));
      }
      console.log('  ✓ textures/' + name);
    } catch (e) { console.log('  ✗ unzip failed', id, e.message); }
  }
}


// ---------------------------------------------------------------- animation source (MIT)
console.log('\n[three.js Soldier.glb — MIT — animation/skeleton source only]');
{
  const dest = A('anim/soldier-rig.glb');
  mkdirSync(dirname(dest), { recursive: true });
  if (!existsSync(dest)) {
    dl('https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Soldier.glb', dest);
  } else console.log('  soldier-rig.glb already present');
}

console.log('\nDone. Manifest is checked in at assets/manifest.json.');
