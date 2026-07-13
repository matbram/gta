// WebAudio engine — every sound is synthesized live, no audio files.
// Distance attenuation is applied per one-shot from the listener (player) position.

import { clamp, lerp } from './mathutil.js';

export class AudioEngine {
  constructor(game) {
    this.game = game;
    this.ctx = null;
    this.master = null;
    this.engineNodes = null;
    this.sirens = new Map();      // vehicle → siren nodes
    this.enabled = true;
    this.radio = null;            // set by phase E radio module

    // resume audio on first user gesture
    const unlock = () => {
      this.init();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  init() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.buffers = new Map();
      this.loadManifest();
      this.onReady?.();
    } catch { this.enabled = false; }
  }

  // load the generated ElevenLabs clips (decoded once, played from buffers)
  async loadManifest() {
    try {
      const res = await fetch('./assets/audio/manifest.json');
      if (!res.ok) return;
      const man = await res.json();
      this.manifest = man;
      const all = { ...man.sfx, ...man.voice, ...man.music };
      for (const [name, url] of Object.entries(all)) {
        fetch('./' + url).then((r) => r.arrayBuffer())
          .then((ab) => this.ctx.decodeAudioData(ab))
          .then((buf) => this.buffers.set(name, buf))
          .catch(() => {});
      }
      this.hasFiles = true;
    } catch {}
  }

  // play a decoded buffer with spatial gain + stereo pan from world position
  playBuffer(name, { x, z, gain = 1, range = 90, rate = 1, loop = false } = {}) {
    if (!this.ctx) return null;
    const buf = this.buffers?.get(name);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.loop = loop;
    const g = this.ctx.createGain();
    let node = g;
    let spatial = gain;
    if (x !== undefined) {
      spatial = this.spatialGain(x, z, gain, range);
      if (spatial <= 0.005 && !loop) return null;
      const pan = this.ctx.createStereoPanner?.();
      if (pan) {
        const p = this.game.player.pos;
        const rel = Math.atan2(x - p.x, z - p.z) - (this.game.cameraRig?.yaw ?? 0);
        pan.pan.value = clamp(Math.sin(rel), -0.9, 0.9);
        g.connect(pan); pan.connect(this.master);
      } else { g.connect(this.master); }
    } else { g.connect(this.master); }
    g.gain.value = spatial;
    src.connect(g);
    src.start();
    return { src, gain: g };
  }

  // pause/resume everything (menus, map, shop) — suspends the whole context
  setActive(active) {
    if (!this.ctx || this._active === active) return;
    this._active = active;
    try {
      if (active) this.ctx.resume();
      else this.ctx.suspend();
    } catch {}
  }

  // gain scaled by distance from player
  spatialGain(x, z, base = 1, range = 90) {
    const p = this.game.player.pos;
    const d = Math.hypot(x - p.x, z - p.z);
    return base * clamp(1 - d / range, 0, 1) ** 1.6;
  }

  now() { return this.ctx ? this.ctx.currentTime : 0; }

  // ---------------- one-shot builders ----------------
  noiseBuffer(seconds = 0.5) {
    if (this._noise && this._noiseLen === seconds) return this._noise;
    const rate = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, rate * seconds, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this._noise = buf; this._noiseLen = seconds;
    return buf;
  }

  burst({ dur = 0.2, gain = 0.6, filterFrom = 3000, filterTo = 400, type = 'lowpass', q = 1 }) {
    if (!(gain > 0.001)) return;          // inaudible / zero gain would throw on ramps
    const t = this.now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(1);
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(filterFrom, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, filterTo), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.05);
  }

  tone({ freq = 440, freqTo = null, dur = 0.2, gain = 0.3, type = 'sine', delay = 0 }) {
    if (!(gain > 0.001)) return;          // exponential ramps reject zero targets
    const t = this.now() + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, freqTo), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // ---------------- named SFX ----------------
  gunshot(kind = 'pistol', x, z) {
    if (!this.ctx) return;
    // prefer the generated clip
    if (this.buffers?.has('gun_' + kind)) {
      this.playBuffer('gun_' + kind, x !== undefined ? { x, z, gain: 0.9, range: 170 } : { gain: 0.9 });
      return;
    }
    const g = x !== undefined ? this.spatialGain(x, z, 1, 160) : 1;
    if (g <= 0.01) return;
    switch (kind) {
      case 'pistol':
        this.burst({ dur: 0.14, gain: 0.55 * g, filterFrom: 2600, filterTo: 300 });
        this.tone({ freq: 160, freqTo: 60, dur: 0.1, gain: 0.3 * g, type: 'square' });
        break;
      case 'smg':
        this.burst({ dur: 0.09, gain: 0.4 * g, filterFrom: 3400, filterTo: 500 });
        this.tone({ freq: 200, freqTo: 90, dur: 0.06, gain: 0.22 * g, type: 'square' });
        break;
      case 'shotgun':
        this.burst({ dur: 0.32, gain: 0.75 * g, filterFrom: 1800, filterTo: 120 });
        this.tone({ freq: 90, freqTo: 40, dur: 0.25, gain: 0.4 * g, type: 'sawtooth' });
        break;
      case 'rifle':
        this.burst({ dur: 0.18, gain: 0.6 * g, filterFrom: 3800, filterTo: 400 });
        this.tone({ freq: 140, freqTo: 55, dur: 0.14, gain: 0.32 * g, type: 'square' });
        break;
    }
  }

  ricochet(x, z) {
    if (!this.ctx) return;
    const g = this.spatialGain(x, z, 0.5, 60);
    if (g < 0.02) return;
    this.tone({ freq: 2400 + Math.random() * 1400, freqTo: 500, dur: 0.09, gain: 0.12 * g, type: 'triangle' });
  }

  footstep(run = false) {
    if (!this.ctx) return;
    this.burst({ dur: run ? 0.08 : 0.06, gain: run ? 0.09 : 0.05, filterFrom: 900, filterTo: 200, q: 1.5 });
  }

  whoosh() {
    if (!this.ctx) return;
    if (this.buffers?.has('whoosh')) return void this.playBuffer('whoosh', { gain: 0.5 });
    this.burst({ dur: 0.25, gain: 0.25, filterFrom: 1800, filterTo: 400, type: 'bandpass', q: 2 });
  }

  punch() {
    if (!this.ctx) return;
    if (this.buffers?.has('punch')) return void this.playBuffer('punch', { gain: 0.7 });
    this.burst({ dur: 0.08, gain: 0.5, filterFrom: 700, filterTo: 150 });
    this.tone({ freq: 120, freqTo: 60, dur: 0.08, gain: 0.35, type: 'sine' });
  }

  explosion(x, z) {
    if (!this.ctx) return;
    if (this.buffers?.has('explosion')) return void this.playBuffer('explosion', x !== undefined ? { x, z, gain: 1, range: 300 } : { gain: 1 });
    const g = x !== undefined ? this.spatialGain(x, z, 1, 300) : 1;
    this.burst({ dur: 1.1, gain: 0.95 * g, filterFrom: 900, filterTo: 60 });
    this.tone({ freq: 70, freqTo: 28, dur: 0.9, gain: 0.7 * g, type: 'sine' });
  }

  carDoor() { if (this.buffers?.has('car_door')) return void this.playBuffer('car_door', { gain: 0.6 }); if (this.ctx) { this.tone({ freq: 220, freqTo: 120, dur: 0.07, gain: 0.3, type: 'square' }); this.burst({ dur: 0.05, gain: 0.2, filterFrom: 1200, filterTo: 300 }); } }
  pickup() { if (this.buffers?.has('pickup')) return void this.playBuffer('pickup', { gain: 0.5 }); if (this.ctx) { this.tone({ freq: 780, dur: 0.09, gain: 0.25, type: 'triangle' }); this.tone({ freq: 1170, dur: 0.12, gain: 0.25, type: 'triangle', delay: 0.08 }); } }
  cash() { if (this.buffers?.has('cash')) return void this.playBuffer('cash', { gain: 0.5 }); if (this.ctx) { this.tone({ freq: 1050, dur: 0.06, gain: 0.22, type: 'square' }); this.tone({ freq: 1560, dur: 0.09, gain: 0.2, type: 'square', delay: 0.06 }); } }
  wantedUp() { if (this.buffers?.has('wanted_up')) return void this.playBuffer('wanted_up', { gain: 0.6 }); if (this.ctx) { this.tone({ freq: 320, freqTo: 620, dur: 0.22, gain: 0.3, type: 'sawtooth' }); } }
  missionPassed() {
    if (!this.ctx) return;
    if (this.buffers?.has('mission_pass')) return void this.playBuffer('mission_pass', { gain: 0.7 });
    const notes = [523, 659, 784, 1046];
    notes.forEach((f, i) => this.tone({ freq: f, dur: 0.34, gain: 0.22, type: 'triangle', delay: i * 0.13 }));
  }
  missionFailed() {
    if (!this.ctx) return;
    if (this.buffers?.has('mission_fail')) return void this.playBuffer('mission_fail', { gain: 0.7 });
    [392, 330, 262].forEach((f, i) => this.tone({ freq: f, dur: 0.4, gain: 0.22, type: 'triangle', delay: i * 0.16 }));
  }
  splash(x, z) { if (this.buffers?.has('splash')) return void this.playBuffer('splash', { x, z, gain: 0.7, range: 90 }); if (this.ctx) this.burst({ dur: 0.45, gain: 0.5 * this.spatialGain(x, z, 1, 80), filterFrom: 1500, filterTo: 200 }); }
  thunder() {
    if (!this.ctx) return;
    this.burst({ dur: 1.7, gain: 0.5, filterFrom: 420, filterTo: 40 });
    this.tone({ freq: 55, freqTo: 28, dur: 1.3, gain: 0.3, type: 'sine', delay: 0.08 });
  }

  // vehicle impact — intensity is closing speed (m/s), scales volume + pitch
  crash(intensity, x, z) {
    this.crashCount = (this.crashCount || 0) + 1;   // test hook
    if (!this.ctx) return;
    const v = clamp(intensity / 14, 0.25, 1);
    if (this.buffers?.has('car_crash')) {
      return void this.playBuffer('car_crash', {
        x, z, gain: 0.85 * v, range: 140, rate: 0.9 + Math.random() * 0.25 + (1 - v) * 0.2,
      });
    }
    const g = (x !== undefined ? this.spatialGain(x, z, 1, 140) : 1) * v;
    if (g < 0.03) return;
    this.burst({ dur: 0.28, gain: 0.7 * g, filterFrom: 2400, filterTo: 200 });
    this.tone({ freq: 90, freqTo: 45, dur: 0.22, gain: 0.4 * g, type: 'sine' });
  }
  horn(x, z) {
    if (!this.ctx) return;
    if (this.buffers?.has('car_horn')) return void this.playBuffer('car_horn', { x, z, gain: 0.6, range: 120 });
    const g = this.spatialGain(x, z, 0.6, 110);
    this.tone({ freq: 392, dur: 0.34, gain: 0.3 * g, type: 'sawtooth' });
    this.tone({ freq: 494, dur: 0.34, gain: 0.25 * g, type: 'sawtooth' });
  }
  screech(x, z, strength = 1) {
    if (!this.ctx) return;
    if (this.buffers?.has('skid')) { if (this._lastScreech && this.now() - this._lastScreech < 0.3) return; this._lastScreech = this.now(); return void this.playBuffer('skid', { x, z, gain: 0.4 * strength, range: 90 }); }
    if (this._lastScreech && this.now() - this._lastScreech < 0.24) return;
    this._lastScreech = this.now();
    const g = this.spatialGain(x, z, 0.6, 80) * strength;
    if (g < 0.03) return;
    this.tone({ freq: 900 + Math.random() * 300, freqTo: 700, dur: 0.3, gain: 0.12 * g, type: 'sawtooth' });
  }
  scream(x, z) {
    if (!this.ctx) return;
    const g = this.spatialGain(x, z, 0.7, 70);
    if (g < 0.05) return;
    const f = 600 + Math.random() * 300;
    this.tone({ freq: f, freqTo: f * 1.6, dur: 0.28, gain: 0.14 * g, type: 'sawtooth' });
  }

  // ---------------- ped voice barks + ambient ----------------
  bark(name, x, z) {
    if (!this.ctx || !this.buffers?.has(name)) return;
    if (this._lastBark && this.now() - this._lastBark < 0.6) return;   // don't overlap chatter
    const g = this.spatialGain(x, z, 0.9, 55);
    if (g < 0.08) return;
    this._lastBark = this.now();
    this.playBuffer(name, { x, z, gain: 0.9, range: 55 });
  }

  // looped ambient bed, crossfaded by district/time (one active at a time)
  setAmbient(name) {
    if (!this.ctx) return;
    // don't commit the name until the buffer exists (they decode async, so an
    // early call would otherwise latch the name and stay silent all session)
    if (name && !this.buffers?.has(name)) { this._ambientName = null; return; }
    if (this._ambientName === name) return;
    this._ambientName = name;
    // fade out old
    if (this._ambient) {
      const old = this._ambient;
      old.gain.gain.setTargetAtTime(0, this.now(), 0.6);
      setTimeout(() => { try { old.src.stop(); } catch {} }, 1500);
      this._ambient = null;
    }
    if (name) {
      const node = this.playBuffer(name, { gain: 0.0001, loop: true });
      if (node) { node.gain.gain.setTargetAtTime(0.28, this.now(), 0.8); this._ambient = node; }
    }
  }

  // ---------------- engine loop (player vehicle) ----------------
  startEngine() {
    if (!this.ctx) return;
    // sample-based engine: loop the idle clip and pitch-bend it by RPM
    if (this.buffers?.has('engine_idle') && !this.engineSample) {
      const node = this.playBuffer('engine_idle', { gain: 0.0001, loop: true });
      if (node) { node.gain.gain.value = 0.12; this.engineSample = node; return; }
    }
    if (this.engineNodes) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 55;
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 28;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 320; f.Q.value = 2;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    osc.connect(f); osc2.connect(f); f.connect(g); g.connect(this.master);
    osc.start(); osc2.start();
    this.engineNodes = { osc, osc2, f, g };
  }

  stopEngine() {
    if (this.engineSample) {
      const s = this.engineSample;
      s.gain.gain.setTargetAtTime(0, this.now(), 0.1);
      setTimeout(() => { try { s.src.stop(); } catch {} }, 300);
      this.engineSample = null;
    }
    if (!this.engineNodes) return;
    const { osc, osc2, g } = this.engineNodes;
    g.gain.linearRampToValueAtTime(0, this.now() + 0.15);
    setTimeout(() => { try { osc.stop(); osc2.stop(); } catch {} }, 250);
    this.engineNodes = null;
  }

  setEngine(speedNorm, throttle) {
    if (this.engineSample) {
      // pitch + volume track rpm
      this.engineSample.src.playbackRate.value = 0.7 + speedNorm * 1.8 + (throttle ? 0.15 : 0);
      this.engineSample.gain.gain.value = 0.1 + speedNorm * 0.1 + (throttle ? 0.04 : 0);
      return;
    }
    if (!this.engineNodes) return;
    const { osc, osc2, f, g } = this.engineNodes;
    const rpm = 0.18 + speedNorm * 0.82;
    osc.frequency.value = 50 + rpm * 165 + (throttle ? 14 : 0);
    osc2.frequency.value = 25 + rpm * 80;
    f.frequency.value = 260 + rpm * 900;
    g.gain.value = 0.075 + rpm * 0.075 + (throttle ? 0.03 : 0);
  }

  // ---------------- police siren loops ----------------
  startSiren(key, getPos) {
    if (!this.ctx || this.sirens.has(key) || this.sirens.size >= 2) return;
    // sample-based siren loop
    if (this.buffers?.has('siren')) {
      const p = getPos();
      const node = this.playBuffer('siren', { gain: 0.0001, loop: true });
      if (node) {
        node.gain.gain.value = this.spatialGain(p.x, p.z, 0.2, 260);
        this.sirens.set(key, { sample: node, getPos });
        return;
      }
    }
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.55;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
    osc.frequency.value = 750;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    osc.connect(g); g.connect(this.master);
    osc.start(); lfo.start();
    this.sirens.set(key, { osc, lfo, g, getPos });
  }

  stopSiren(key) {
    const s = this.sirens.get(key);
    if (!s) return;
    try { if (s.sample) s.sample.src.stop(); else { s.osc.stop(); s.lfo.stop(); } } catch {}
    this.sirens.delete(key);
  }

  update(dt) {
    if (!this.ctx) return;
    for (const [, s] of this.sirens) {
      const p = s.getPos();
      const g = this.spatialGain(p.x, p.z, s.sample ? 0.22 : 0.14, 260);
      if (s.sample) s.sample.gain.gain.value = g;
      else s.g.gain.value = g;
    }
    // ambient bed follows district / time / interior
    this.updateAmbient();
    this.radio?.update?.(dt);
  }

  updateAmbient() {
    const game = this.game;
    if (!game.player || game.state.mode !== 'play') return;
    let want = null;
    if (game.interiors?.current === 'club') want = 'amb_club';
    else if (game.player.vehicle) want = null;      // engine covers it
    else {
      const d = game.city.districtAt(game.player.pos.x, game.player.pos.z);
      const night = game.dayNight?.nightIntensity > 0.5;
      if (d === 'beach') want = 'amb_beach';
      else if (d === 'park') want = 'amb_park';
      else want = night ? 'amb_city_night' : 'amb_city_day';
    }
    this.setAmbient(want);
  }
}
