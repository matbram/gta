// In-car radio: three generative music stations, composed procedurally at
// runtime from synth voices — kick/hat/snare, bass, pads and a random-walk
// lead. No samples, no fixed melodies; every listen is a little different.

const STATIONS = [
  {
    id: 'neon', name: 'NEON DRIVE 88.3', bpm: 112, swing: 0,
    // chord loops are plain triads; the lead improvises over a minor pentatonic
    chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]],
    scale: [0, 3, 5, 7, 10],
    root: 45,
    style: 'synthwave',
  },
  {
    id: 'costa', name: 'COSTA CALOR', bpm: 128, swing: 0.12,
    chords: [[50, 53, 57], [55, 59, 62], [48, 52, 55], [45, 49, 52]],
    scale: [0, 2, 3, 5, 7, 8, 10],
    root: 50,
    style: 'latin',
  },
  {
    id: 'slow', name: 'THE SLOW LANE', bpm: 76, swing: 0.28,
    chords: [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]],
    scale: [0, 2, 4, 7, 9],
    root: 41,
    style: 'lofi',
  },
];

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class Radio {
  constructor(audio) {
    this.audio = audio;          // AudioEngine
    this.station = -1;           // -1 = off
    this.nextStep = 0;
    this.stepTime = 0;
    this.playing = false;
    this.bus = null;
  }

  ensureBus() {
    const ctx = this.audio.ctx;
    if (!ctx || this.bus) return;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    // gentle radio EQ so music sits under SFX
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6500;
    this.bus.connect(lp);
    lp.connect(this.audio.master);
  }

  cycle() {
    if (!this.audio.ctx) this.audio.init();
    if (!this.audio.ctx) return null;
    this.ensureBus();
    this.station = this.station >= STATIONS.length - 1 ? -1 : this.station + 1;
    if (this.station === -1) {
      this.stop();
      return 'RADIO OFF';
    }
    this.start();
    return STATIONS[this.station].name;
  }

  start() {
    this.playing = true;
    this.nextStep = 0;
    this.stepTime = this.audio.ctx.currentTime + 0.1;
    this.bus.gain.cancelScheduledValues(this.audio.ctx.currentTime);
    this.bus.gain.setTargetAtTime(0.24, this.audio.ctx.currentTime, 0.4);
  }

  stop() {
    this.playing = false;
    if (this.bus && this.audio.ctx) {
      this.bus.gain.setTargetAtTime(0, this.audio.ctx.currentTime, 0.15);
    }
  }

  setDucked(mult) {
    if (this.bus && this.audio.ctx && this.playing)
      this.bus.gain.setTargetAtTime(0.24 * mult, this.audio.ctx.currentTime, 0.3);
  }

  // ---------------- voices ----------------
  osc(type, freq, when, dur, gain, opts = {}) {
    const ctx = this.audio.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, when);
    if (opts.slideTo) o.frequency.exponentialRampToValueAtTime(opts.slideTo, when + dur);
    const g = ctx.createGain();
    const a = opts.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + a);
    g.gain.setTargetAtTime(0.0001, when + dur * (opts.sustain ?? 0.55), dur * 0.2);
    let out = g;
    if (opts.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.lp;
      o.connect(f); f.connect(g);
    } else o.connect(g);
    out.connect(this.bus);
    o.start(when);
    o.stop(when + dur + 0.3);
  }

  noise(when, dur, gain, filterType, freq, q = 1) {
    const ctx = this.audio.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.audio.noiseBuffer(1);
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    src.connect(f); f.connect(g); g.connect(this.bus);
    src.start(when);
    src.stop(when + dur + 0.05);
  }

  kick(when) {
    this.osc('sine', 120, when, 0.16, 0.6, { slideTo: 42, sustain: 0.9 });
  }
  hat(when, open = false) {
    this.noise(when, open ? 0.16 : 0.045, 0.12, 'highpass', 7200);
  }
  snare(when) {
    this.noise(when, 0.14, 0.2, 'bandpass', 1900, 0.8);
    this.osc('triangle', 190, when, 0.09, 0.14);
  }
  shaker(when) {
    this.noise(when, 0.05, 0.07, 'highpass', 9000);
  }

  // ---------------- sequencing ----------------
  update() {
    if (!this.playing || !this.audio.ctx) return;
    const ctx = this.audio.ctx;
    const st = STATIONS[this.station];
    const stepDur = 60 / st.bpm / 4;      // 16th note

    // resync after pause / throttled tab so we never burst-play missed notes
    if (ctx.currentTime - this.stepTime > 0.5) {
      this.stepTime = ctx.currentTime + 0.05;
    }

    while (this.stepTime < ctx.currentTime + 0.25) {
      const s = this.nextStep;
      const bar = Math.floor(s / 16) % st.chords.length;
      const step16 = s % 16;
      const chord = st.chords[bar];
      const swing = step16 % 2 === 1 ? st.swing * stepDur : 0;
      const t = this.stepTime + swing;

      if (st.style === 'synthwave') {
        if (step16 % 4 === 0) this.kick(t);
        if (step16 % 4 === 2) this.hat(t);
        if (step16 % 8 === 4) this.snare(t);
        // driving 8th bass on the root
        if (step16 % 2 === 0) {
          const oct = step16 % 8 === 0 ? 0 : 12;
          this.osc('sawtooth', midiHz(chord[0] - 24 + (step16 % 4 === 2 ? 12 : 0)), t, stepDur * 1.8, 0.22, { lp: 500 });
        }
        // pad at bar start
        if (step16 === 0) {
          for (const n of chord) this.osc('triangle', midiHz(n), t, stepDur * 16, 0.055, { attack: 0.4, sustain: 0.85, lp: 2400 });
        }
        // sparkle lead every other bar
        if (Math.random() < 0.16 && step16 % 2 === 0) {
          const deg = st.scale[Math.floor(Math.random() * st.scale.length)];
          this.osc('square', midiHz(st.root + 24 + deg), t, stepDur * 2, 0.05, { lp: 3200 });
        }
      } else if (st.style === 'latin') {
        if (step16 % 8 === 0 || step16 % 8 === 3) this.kick(t);
        if (step16 % 2 === 0) this.shaker(t);
        if (step16 % 8 === 4) this.snare(t);
        // tumbao-ish syncopated bass
        if ([0, 3, 6, 10, 12].includes(step16)) {
          const note = chord[step16 % 3 === 0 ? 0 : (step16 % 3)];
          this.osc('sawtooth', midiHz(note - 24), t, stepDur * 1.6, 0.2, { lp: 620 });
        }
        // offbeat chord stabs
        if (step16 % 4 === 2) {
          for (const n of chord) this.osc('sawtooth', midiHz(n), t, stepDur * 0.9, 0.045, { lp: 1900 });
        }
        // bright lead runs
        if (Math.random() < 0.22 && step16 % 2 === 1) {
          const deg = st.scale[Math.floor(Math.random() * st.scale.length)];
          this.osc('triangle', midiHz(st.root + 12 + deg), t, stepDur * 1.5, 0.07);
        }
      } else {
        // lofi
        if (step16 === 0 || step16 === 10) this.kick(t);
        if (step16 === 4 || step16 === 12) this.snare(t);
        if (step16 % 2 === 0) this.hat(t);
        if (step16 === 0) {
          for (const n of chord) this.osc('triangle', midiHz(n), t, stepDur * 16, 0.06, { attack: 0.25, sustain: 0.9, lp: 1500 });
          this.osc('sine', midiHz(chord[0] - 24), t, stepDur * 14, 0.22, { attack: 0.05, sustain: 0.9 });
        }
        // sleepy melody
        if (Math.random() < 0.12 && step16 % 4 === 0) {
          const deg = st.scale[Math.floor(Math.random() * st.scale.length)];
          this.osc('sine', midiHz(st.root + 24 + deg), t, stepDur * 5, 0.09, { attack: 0.03 });
        }
        // vinyl crackle
        if (Math.random() < 0.3) this.noise(t, 0.02, 0.012, 'highpass', 4000);
      }

      this.nextStep++;
      this.stepTime += stepDur;
    }
  }
}
