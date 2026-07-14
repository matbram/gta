// G7 check: audio manifest loads, buffers decode, playback wiring intact.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
await page.goto('http://localhost:8080/?q=low', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.mode === 'menu', null, { timeout: 240000 });

// manifest fetch
const man = await page.evaluate(async () => {
  const r = await fetch('./assets/audio/manifest.json');
  const m = await r.json();
  return { sfx: Object.keys(m.sfx).length, voice: Object.keys(m.voice).length, music: Object.keys(m.music).length };
});
console.log('manifest:', JSON.stringify(man),
  man.sfx > 20 && man.voice > 10 && man.music >= 3 ? 'MANIFEST OK' : 'MANIFEST FAIL');

await page.evaluate(() => window.__game.newGame());
// force audio init + wait for buffers to decode
await page.evaluate(() => window.__game.game.audio.init());
await page.waitForFunction(() => (window.__game.game.audio.buffers?.size ?? 0) > 20, null, { timeout: 30000 }).catch(() => {});
const buffers = await page.evaluate(() => ({
  count: window.__game.game.audio.buffers?.size ?? 0,
  hasPistol: window.__game.game.audio.buffers?.has('gun_pistol'),
  hasBark: window.__game.game.audio.buffers?.has('bark_run'),
}));
console.log('decoded buffers:', JSON.stringify(buffers),
  buffers.count > 20 && buffers.hasPistol ? 'BUFFERS OK' : 'BUFFERS FAIL');

// playback methods don't throw
const play = await page.evaluate(() => {
  const g = window.__game.game;
  try {
    g.audio.gunshot('pistol', g.player.pos.x + 3, g.player.pos.z);
    g.audio.bark('bark_run', g.player.pos.x + 2, g.player.pos.z);
    g.audio.startEngine();
    g.audio.setEngine(0.5, true);
    g.audio.setAmbient('amb_city_day');
    g.audio.stopEngine();
    g.audio.footstep(true);
    return 'ok';
  } catch (e) { return 'THREW: ' + e.message; }
});
console.log('playback:', play, play === 'ok' ? 'PLAYBACK OK' : 'PLAYBACK FAIL');

// radio uses real tracks
const radio = await page.evaluate(() => {
  const g = window.__game.game;
  const name = g.audio.radio.cycle();
  return { name, usingTrack: g.audio.radio.usingTrack };
});
console.log('radio:', JSON.stringify(radio), radio.usingTrack ? 'RADIO-TRACK OK' : 'RADIO FALLBACK');

console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 8).join('\n') : 'NO CONSOLE ERRORS');
await browser.close();
