// One-time audio generator using ElevenLabs. Reads the key from the
// ELEVENLABS_API_KEY env var (never hard-coded / committed). Generates SFX
// (sound-generation), voice barks (TTS), and radio/menu music (music API)
// into assets/audio/ + a manifest. All voice scripts are profanity-free.
//
//   ELEVENLABS_API_KEY=... node tools/gen-audio.mjs [--sfx] [--voice] [--music] [--all]
//
// Re-running skips files that already exist, so it resumes safely and never
// re-spends quota. A hard character/credit budget guard stops runaway spend.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('Set ELEVENLABS_API_KEY in the environment.'); process.exit(1); }

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = path.join(ROOT, 'assets', 'audio');
fs.mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const want = (k) => args.includes('--all') || args.includes(k) || args.length === 0;

let spentChars = 0;
const BUDGET_CHARS = 120000;   // safety cap for TTS/music prompt characters

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request('https://api.elevenlabs.io' + pathname, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 180000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${buf.toString().slice(0, 200)}`));
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.elevenlabs.io' + pathname, {
      method: 'GET',
      headers: { 'xi-api-key': KEY },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: buf.toString() });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const manifest = { sfx: {}, voice: {}, music: {} };
function manifestPath(kind, name) {
  return `assets/audio/${kind}/${name}.mp3`;
}

async function genSound(name, text, dur, { influence = 0.4 } = {}) {
  const dest = path.join(OUT, 'sfx', name + '.mp3');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  manifest.sfx[name] = manifestPath('sfx', name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 800) { console.log('  · sfx', name, '(cached)'); return; }
  try {
    const buf = await post('/v1/sound-generation', {
      text, duration_seconds: dur, prompt_influence: influence,
    });
    fs.writeFileSync(dest, buf);
    console.log('  ✓ sfx', name, `(${buf.length}b)`);
  } catch (e) { console.log('  ✗ sfx', name, e.message); }
}

async function genVoice(name, text, voiceId) {
  const dest = path.join(OUT, 'voice', name + '.mp3');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  manifest.voice[name] = manifestPath('voice', name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 800) { console.log('  · voice', name, '(cached)'); return; }
  if (spentChars + text.length > BUDGET_CHARS) { console.log('  ! budget reached, skipping', name); return; }
  spentChars += text.length;
  try {
    const buf = await post(`/v1/text-to-speech/${voiceId}`, {
      text, model_id: 'eleven_turbo_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.7 },
    });
    fs.writeFileSync(dest, buf);
    console.log('  ✓ voice', name);
  } catch (e) { console.log('  ✗ voice', name, e.message); }
}

async function genMusic(name, prompt, lengthMs) {
  const dest = path.join(OUT, 'music', name + '.mp3');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  manifest.music[name] = manifestPath('music', name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 5000) { console.log('  · music', name, '(cached)'); return; }
  try {
    const buf = await post('/v1/music', { prompt, music_length_ms: lengthMs });
    fs.writeFileSync(dest, buf);
    console.log('  ✓ music', name, `(${(buf.length / 1024 | 0)}kb)`);
  } catch (e) { console.log('  ✗ music', name, e.message); }
}

// ------------------------------------------------------------------ SFX list
const SFX = [
  // weapons — one distinct sound per gun, with a second take each so
  // rapid fire rotates via playVar instead of sounding identical
  // realistic, source-specific single shots — dry close-mic so each gun's own
  // character reads (action snap, muzzle crack, low pressure, report tail)
  ['gun_pistol', 'realistic 9mm handgun single gunshot, dry close mic, sharp slide snap and mid crack, tight report', 0.9, { influence: 0.6 }],
  ['gun_pistol_2', 'realistic 9mm pistol shot, punchy crack with brass ejection ping, dry indoor', 0.9, { influence: 0.6 }],
  ['gun_smg', 'realistic 9mm submachine gun three-round burst, fast tinny mechanical rattle, dry', 1.0, { influence: 0.6 }],
  ['gun_smg_2', 'realistic compact smg rapid burst, tight metallic cyclic rounds, dry', 1.0, { influence: 0.6 }],
  ['gun_shotgun', 'realistic 12 gauge pump shotgun blast, deep wide boom then pump-action shell rack', 1.2, { influence: 0.6 }],
  ['gun_shotgun_2', 'realistic heavy 12 gauge shotgun single blast, thick low boom, big report', 1.1, { influence: 0.6 }],
  ['gun_rifle', 'realistic 5.56 assault rifle single shot, sharp supersonic crack and snap, slap-back tail', 0.9, { influence: 0.6 }],
  ['gun_rifle_2', 'realistic high-velocity rifle shot, cracking supersonic whip and metallic action', 0.9, { influence: 0.6 }],
  ['gun_revolver', 'realistic 44 magnum revolver single gunshot, thunderous deep boom, huge report', 1.0, { influence: 0.6 }],
  ['gun_revolver_2', 'realistic big-bore magnum revolver single shot, cannon-like low boom and echo', 1.0, { influence: 0.6 }],
  ['reload', 'gun magazine reload, clip out clip in, metallic click', 1.4],
  // melee / body
  ['punch', 'fist punch impact on body, dull thud', 0.5],
  ['whoosh', 'fast arm swing whoosh through air', 0.5],
  ['bat_hit', 'baseball bat hitting body, heavy whack', 0.6],
  // vehicle
  ['car_door', 'car door open and close, single clunk', 0.9],
  ['car_horn', 'car horn honk, single medium tone', 0.8],
  ['car_crash', 'two cars colliding, metal crunch and glass', 1.3],
  ['skid', 'car tires screeching on asphalt, hard braking', 1.4],
  ['engine_idle', 'car engine idling low rumble loop, steady', 2.0],
  ['engine_rev', 'car engine revving up high rpm', 1.5],
  ['explosion', 'large fuel explosion, deep boom with debris and fire', 2.2],
  ['siren', 'police siren wail loop, two-tone', 3.0],
  // world / ui
  ['splash', 'body falling into water splash', 1.0],
  ['register', 'cash register drawer opening with bell ding', 0.9],
  ['pickup', 'positive item pickup chime, short', 0.5],
  ['cash', 'coins and cash reward sound, bright', 0.7],
  ['ui_click', 'soft ui button click, subtle', 0.5],
  ['wanted_up', 'tense alert sting, wanted level increase', 0.9],
  ['mission_pass', 'triumphant short success fanfare', 1.6],
  ['mission_fail', 'somber short failure sting', 1.4],
  // ambient beds (looped)
  ['amb_city_day', 'busy city street ambience, distant traffic and people, loop', 6.0, { influence: 0.3 }],
  ['amb_city_night', 'quiet night city ambience, distant hum and crickets, loop', 6.0, { influence: 0.3 }],
  ['amb_beach', 'ocean waves and seagulls beach ambience, loop', 6.0, { influence: 0.3 }],
  ['amb_park', 'peaceful park birdsong and light wind, loop', 6.0, { influence: 0.3 }],
  ['amb_club', 'muffled nightclub interior crowd and bass, loop', 6.0, { influence: 0.3 }],
];

// ------------------------------------------------------------------ voice barks (profanity-free)
// Using two default ElevenLabs voices for variety.
const VOICE_A = '21m00Tcm4TlvDq8ikWAM';   // female
const VOICE_B = 'pNInz6obpgDQGcFmaJgB';   // male
const VOICE_M = 'iglCbBShWrdr0JEW8MLx';   // Marco ("Marcus" voice)
const BARKS = [
  // civilians — all clean
  ['bark_hey', 'Hey! Watch where you\'re going!', VOICE_B],
  ['bark_help', 'Somebody help! Call the police!', VOICE_A],
  ['bark_run', 'He\'s got a gun! Run!', VOICE_A],
  ['bark_crazy', 'You\'re out of your mind!', VOICE_B],
  ['bark_mycar', 'That\'s my car! Get out!', VOICE_B],
  ['bark_photo', 'Are you seeing this? Get it on camera!', VOICE_A],
  ['bark_moveit', 'Come on, move it, some of us have jobs!', VOICE_B],
  ['bark_nice_day', 'Beautiful day out here in Bayvale.', VOICE_A],
  ['bark_lost', 'Excuse me, do you know the way downtown?', VOICE_A],
  ['bark_backoff', 'Back off, I\'m warning you!', VOICE_B],
  // cop
  ['cop_freeze', 'Freeze! Hands where I can see them!', VOICE_B],
  ['cop_stop', 'Stop right there! You\'re under arrest!', VOICE_B],
  ['cop_suspect', 'Suspect on foot, all units respond.', VOICE_B],
  // shopkeeper
  ['shop_welcome', 'Welcome in, take a look around.', VOICE_A],
  ['shop_rob', 'Okay, okay, take the money, just don\'t hurt me!', VOICE_A],
  // scanner
  ['scanner1', 'Dispatch, we have a ten thirty one in progress downtown.', VOICE_B],
  ['scanner2', 'All units, suspect is armed and dangerous, use caution.', VOICE_A],
  // second takes so the same reaction doesn't always sound identical
  // (audio.playVar rotates name / name_2 / name_3 automatically)
  ['bark_hey_2', 'Watch it, pal!', VOICE_A],
  ['bark_help_2', 'Call nine one one! Hurry!', VOICE_B],
  ['bark_run_2', 'Gun! GUN! Get down!', VOICE_B],
  ['bark_crazy_2', 'What is wrong with you?!', VOICE_A],
  ['bark_mycar_2', 'Hey! Somebody stop him!', VOICE_A],
  ['bark_photo_2', 'This is going online, buddy!', VOICE_B],
  ['bark_moveit_2', 'Any day now, come on!', VOICE_A],
  ['bark_nice_day_2', 'Some weather today, huh?', VOICE_B],
  ['bark_lost_2', 'Is the marina this way? I always get turned around.', VOICE_B],
  ['bark_backoff_2', 'I mean it, stay back!', VOICE_A],
  ['cop_freeze_2', 'Police! Don\'t move!', VOICE_B],
  ['shop_welcome_2', 'Looking for anything special today?', VOICE_A],
  // new situations
  ['bark_fight', 'You want to go? Let\'s go!', VOICE_B],
  ['bark_fight_2', 'Get him!', VOICE_A],
  ['bark_cops_coming', 'Cops! The cops are coming!', VOICE_A],
  ['cop_backup', 'Shots fired, requesting backup now!', VOICE_B],
  ['scream_f', 'Aaaah! No no no!', VOICE_A],
  ['scream_m', 'Hey— aagh! Look out!', VOICE_B],
];

// ------------------------------------------------------------------ Marco
// One take per subtitle line, named marco_<trigger>, marco_<trigger>_2, …
// (index-aligned with LINES so the audio says what the subtitle shows).
async function genMarco() {
  const { LINES } = await import('../src/core/voice.js');
  console.log('\n[MARCO]');
  for (const [trigger, lines] of Object.entries(LINES)) {
    for (let i = 0; i < lines.length; i++) {
      const name = i === 0 ? `marco_${trigger}` : `marco_${trigger}_${i + 1}`;
      // strip typographic quotes/dashes the TTS reads awkwardly
      const text = lines[i].replace(/…/g, '...').replace(/[’‘]/g, "'").replace(/—/g, ', ');
      await genVoice(name, text, VOICE_M);
    }
  }
}

// ------------------------------------------------------------------ music
const MUSIC = [
  ['radio_neon', 'upbeat retro synthwave instrumental, driving arpeggios, 80s, no vocals', 30000],
  ['radio_costa', 'sunny latin pop instrumental, congas and guitar, upbeat, no vocals', 30000],
  ['radio_slow', 'chill lofi hip hop instrumental, mellow keys and vinyl, no vocals', 30000],
  ['radio_trap', 'hard trap instrumental, booming 808 bass, fast rolling hi-hats, half-time claps, dark rnb minor keys, no vocals, no profanity', 30000],
  ['menu_theme', 'moody cinematic crime drama theme, tense strings and bass, no vocals', 20000],
];

// ------------------------------------------------------------------ run
async function run() {
  // sanity check the configured Marco voice without spending any quota
  if (args.includes('--marco-check')) {
    for (const id of [VOICE_M, VOICE_M.replace(/^ID/, '')]) {
      const r = await get(`/v1/voices/${id}`);
      let name = '';
      try { name = JSON.parse(r.body).name ?? ''; } catch {}
      console.log(`voice ${id}: HTTP ${r.status}${name ? ` (${name})` : ''}${r.status !== 200 ? ' ' + r.body.slice(0, 160) : ''}`);
    }
    const sub = await get('/v1/user/subscription');
    try {
      const s = JSON.parse(sub.body);
      console.log(`quota: ${s.character_count}/${s.character_limit} chars used (${s.tier})`);
    } catch { console.log('subscription check:', sub.status); }
    return;
  }
  if (args.includes('--marco-only')) { await genMarco(); return finishManifest(); }
  if (want('--sfx')) { console.log('\n[SFX]'); for (const [n, t, d, o] of SFX) await genSound(n, t, d, o || {}); }
  if (want('--voice')) {
    console.log('\n[VOICE]');
    for (const [n, t, v] of BARKS) await genVoice(n, t, v);
    await genMarco();
  }
  if (want('--music')) { console.log('\n[MUSIC]'); for (const [n, p, l] of MUSIC) await genMusic(n, p, l); }
  finishManifest();
}

function finishManifest() {
  // merge into existing manifest if present
  const mfPath = path.join(OUT, 'manifest.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(mfPath, 'utf8')); } catch {}
  const merged = {
    sfx: { ...existing.sfx, ...manifest.sfx },
    voice: { ...existing.voice, ...manifest.voice },
    music: { ...existing.music, ...manifest.music },
  };
  fs.writeFileSync(mfPath, JSON.stringify(merged, null, 2));
  console.log(`\nDone. TTS chars spent this run: ${spentChars}`);
  console.log(`sfx:${Object.keys(merged.sfx).length} voice:${Object.keys(merged.voice).length} music:${Object.keys(merged.music).length}`);
}
run();
