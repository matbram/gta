// One-time asset fetcher. Downloads free game assets into assets/ (committed).
// Sources: KayKit City Builder Bits (CC0), Kenney starter kits (MIT/CC0),
// three.js example models, ambientCG PBR textures (CC0), Poly Haven HDRIs (CC0).
// Every category is optional — the game falls back to procedural assets for
// anything missing. Uses curl so the environment proxy is honoured.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const A = (p) => path.join(ROOT, 'assets', p);

let ok = 0, fail = 0;
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

// ---------------------------------------------------------------- KayKit city bits (CC0)
console.log('\n[KayKit City Builder Bits — CC0]');
const KAYKIT_BASE = 'https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-City-Builder-Bits/main/addons/kaykit_city_builder_bits/Assets/gltf/';
const KAYKIT_ITEMS = [
  'car_sedan', 'car_taxi', 'car_police', 'car_hatchback', 'car_stationwagon',
  'trafficlight_A', 'trafficlight_C', 'streetlight', 'firehydrant', 'dumpster',
  'bench', 'trash_A', 'trash_B', 'bush', 'watertower',
];
for (const item of KAYKIT_ITEMS) {
  dl(KAYKIT_BASE + item + '.gltf', A('models/kaykit/' + item + '.gltf'));
  dl(KAYKIT_BASE + item + '.bin', A('models/kaykit/' + item + '.bin'));
}
dl(KAYKIT_BASE + 'citybits_texture.png', A('models/kaykit/citybits_texture.png'));

// ---------------------------------------------------------------- Kenney kits (MIT/CC0)
console.log('\n[Kenney starter kits]');
const KENNEY_RACING = 'https://raw.githubusercontent.com/KenneyNL/Starter-Kit-Racing/main/models/';
for (const m of ['vehicle-truck-red', 'vehicle-truck-green', 'vehicle-motorcycle'])
  dl(KENNEY_RACING + m + '.glb', A('models/kenney-racing/' + m + '.glb'));
dl(KENNEY_RACING + 'Textures/colormap.png', A('models/kenney-racing/Textures/colormap.png'));
const KENNEY_CITY = 'https://raw.githubusercontent.com/KenneyNL/Starter-Kit-City-Builder/main/models/';
for (const m of ['grass-trees', 'grass-trees-tall', 'pavement-fountain'])
  dl(KENNEY_CITY + m + '.glb', A('models/kenney-city/' + m + '.glb'));
dl(KENNEY_CITY + 'Textures/colormap.png', A('models/kenney-city/Textures/colormap.png'));

// ---------------------------------------------------------------- three.js example models
console.log('\n[three.js example models]');
const THREE_BASE = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/';
dl(THREE_BASE + 'Soldier.glb', A('models/chars/Soldier.glb'));
dl(THREE_BASE + 'Xbot.glb', A('models/chars/Xbot.glb'));
dl(THREE_BASE + 'ferrari.glb', A('models/vehicles/sports.glb'));

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

// ---------------------------------------------------------------- Poly Haven HDRIs (CC0)
console.log('\n[Poly Haven HDRIs — CC0]');
const HDRIS = {
  day: 'kloofendal_48d_partly_cloudy_puresky',
  dusk: 'kiara_1_dawn',
  night: 'moonless_golf',
};
for (const [name, id] of Object.entries(HDRIS)) {
  try {
    const meta = JSON.parse(execFileSync('curl', ['-sL', '--max-time', '30', `https://api.polyhaven.com/files/${id}`], { encoding: 'utf8' }));
    const url = meta?.hdri?.['1k']?.hdr?.url;
    if (url) dl(url, A(`hdri/${name}.hdr`));
    else console.log('  ✗ no 1k hdr for', id);
  } catch (e) { console.log('  ✗ polyhaven meta failed', id); }
}

// ---------------------------------------------------------------- manifest
console.log('\n[manifest]');
const manifest = { generated: new Date().toISOString(), models: {}, textures: [], hdri: [] };
const walk = (dir, cb) => {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, cb);
    else cb(p);
  }
};
walk(A('models'), (p) => {
  if (/\.(glb|gltf)$/.test(p)) {
    const rel = path.relative(A(''), p).replace(/\\/g, '/');
    manifest.models[path.basename(p).replace(/\.(glb|gltf)$/, '')] = 'assets/' + rel;
  }
});
walk(A('textures'), (p) => { if (p.endsWith('color.jpg')) manifest.textures.push(path.basename(path.dirname(p))); });
walk(A('hdri'), (p) => { if (p.endsWith('.hdr')) manifest.hdri.push(path.basename(p, '.hdr')); });
fs.rmSync(A('_tmp'), { recursive: true, force: true });
fs.writeFileSync(A('manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nDone: ${ok} downloaded, ${fail} failed`);
console.log('models:', Object.keys(manifest.models).length, '| texture sets:', manifest.textures.length, '| hdris:', manifest.hdri.length);
