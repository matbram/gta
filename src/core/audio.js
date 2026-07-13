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
      this.onReady?.();
    } catch { this.enabled = false; }
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

  punch() {
    if (!this.ctx) return;
    this.burst({ dur: 0.08, gain: 0.5, filterFrom: 700, filterTo: 150 });
    this.tone({ freq: 120, freqTo: 60, dur: 0.08, gain: 0.35, type: 'sine' });
  }

  explosion(x, z) {
    if (!this.ctx) return;
    const g = x !== undefined ? this.spatialGain(x, z, 1, 300) : 1;
    this.burst({ dur: 1.1, gain: 0.95 * g, filterFrom: 900, filterTo: 60 });
    this.tone({ freq: 70, freqTo: 28, dur: 0.9, gain: 0.7 * g, type: 'sine' });
  }

  carDoor() { if (this.ctx) { this.tone({ freq: 220, freqTo: 120, dur: 0.07, gain: 0.3, type: 'square' }); this.burst({ dur: 0.05, gain: 0.2, filterFrom: 1200, filterTo: 300 }); } }
  pickup() { if (this.ctx) { this.tone({ freq: 780, dur: 0.09, gain: 0.25, type: 'triangle' }); this.tone({ freq: 1170, dur: 0.12, gain: 0.25, type: 'triangle', delay: 0.08 }); } }
  cash() { if (this.ctx) { this.tone({ freq: 1050, dur: 0.06, gain: 0.22, type: 'square' }); this.tone({ freq: 1560, dur: 0.09, gain: 0.2, type: 'square', delay: 0.06 }); } }
  wantedUp() { if (this.ctx) { this.tone({ freq: 320, freqTo: 620, dur: 0.22, gain: 0.3, type: 'sawtooth' }); } }
  missionPassed() {
    if (!this.ctx) return;
    const notes = [523, 659, 784, 1046];
    notes.forEach((f, i) => this.tone({ freq: f, dur: 0.34, gain: 0.22, type: 'triangle', delay: i * 0.13 }));
  }
  missionFailed() {
    if (!this.ctx) return;
    [392, 330, 262].forEach((f, i) => this.tone({ freq: f, dur: 0.4, gain: 0.22, type: 'triangle', delay: i * 0.16 }));
  }
  splash(x, z) { if (this.ctx) this.burst({ dur: 0.45, gain: 0.5 * this.spatialGain(x, z, 1, 80), filterFrom: 1500, filterTo: 200 }); }
  horn(x, z) {
    if (!this.ctx) return;
    const g = this.spatialGain(x, z, 0.6, 110);
    this.tone({ freq: 392, dur: 0.34, gain: 0.3 * g, type: 'sawtooth' });
    this.tone({ freq: 494, dur: 0.34, gain: 0.25 * g, type: 'sawtooth' });
  }
  screech(x, z, strength = 1) {
    if (!this.ctx) return;
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

  // ---------------- engine loop (player vehicle) ----------------
  startEngine() {
    if (!this.ctx || this.engineNodes) return;
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
    if (!this.engineNodes) return;
    const { osc, osc2, g } = this.engineNodes;
    g.gain.linearRampToValueAtTime(0, this.now() + 0.15);
    setTimeout(() => { try { osc.stop(); osc2.stop(); } catch {} }, 250);
    this.engineNodes = null;
  }

  setEngine(speedNorm, throttle) {
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
    try { s.osc.stop(); s.lfo.stop(); } catch {}
    this.sirens.delete(key);
  }

  update(dt) {
    if (!this.ctx) return;
    for (const [, s] of this.sirens) {
      const p = s.getPos();
      s.g.gain.value = this.spatialGain(p.x, p.z, 0.14, 260);
    }
    this.radio?.update?.(dt);
  }
}
