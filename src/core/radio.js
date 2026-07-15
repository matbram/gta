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
  {
    // hard trap / R&B: booming 808s, half-time claps, rolling hats, dark keys.
    // 140 bpm read as half-time. Instrumental, so it stays profanity-free.
    id: 'trap', name: 'BLOCK HEAT 101.1', bpm: 140, swing: 0,
    // dark minor 7th voicings for the R&B lushness: i - VI - VII - i
    chords: [[57, 60, 64, 67], [53, 56, 60, 63], [55, 58, 62, 65], [57, 60, 64, 67]],
    scale: [0, 3, 5, 6, 7, 10],   // minor pentatonic + the b5 "blue" note
    root: 33,                     // low A for the sub-bass 808
    style: 'trap',
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

  // named track per station when generated music is available
  trackFor(i) {
    return ['radio_neon', 'radio_costa', 'radio_slow', 'radio_trap'][i];
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
    // prefer the generated track for this station
    const track = this.trackFor(this.station);
    if (this.audio.buffers?.has(track)) {
      this.playing = true;
      this.stopSynth();
      this.startTrack(track);
      return STATIONS[this.station].name;
    }
    this.start();
    return STATIONS[this.station].name;
  }

  startTrack(track) {
    if (this._trackNode) { try { this._trackNode.src.stop(); } catch {} this._trackNode = null; }
    const node = this.audio.playBuffer(track, { gain: 0.0001, loop: true });
    if (node) { node.gain.gain.setTargetAtTime(0.3, this.audio.now(), 0.4); this._trackNode = node; this.usingTrack = true; }
  }

  stopSynth() {
    if (this.bus) this.bus.gain.setTargetAtTime(0, this.audio.now(), 0.1);
  }

  // resume the current station after re-entering a vehicle — prefers the
  // generated track, else the synth sequencer
  resume() {
    if (this.station < 0) return;
    const track = this.trackFor(this.station);
    if (this.audio.buffers?.has(track)) {
      this.playing = true;
      this.stopSynth();
      this.startTrack(track);
    } else this.start();
  }

  start() {
    this.playing = true;
    this.usingTrack = false;
    // starting the synth sequencer means any generated track must stop first
    if (this._trackNode) { const n = this._trackNode; try { n.src.stop(); } catch {} this._trackNode = null; }
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
    if (this._trackNode) { const n = this._trackNode; n.gain.gain.setTargetAtTime(0, this.audio.now(), 0.15); setTimeout(() => { try { n.src.stop(); } catch {} }, 400); this._trackNode = null; }
    this.usingTrack = false;
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
  // trap 808: a sub-bass sine with a fast pitch drop on the attack (the
  // signature 808 "pluck") and a long booming decay — doubles as kick + bass
  sub808(when, freq, dur) {
    const ctx = this.audio.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 1.8, when);
    o.frequency.exponentialRampToValueAtTime(freq, when + 0.035);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.72, when + 0.008);
    g.gain.setTargetAtTime(0.0001, when + dur * 0.45, dur * 0.3);
    o.connect(g); g.connect(this.bus);
    o.start(when); o.stop(when + dur + 0.3);
  }
  // layered hand-clap: a few tight noise bursts stacked, then a short room tail
  clap(when) {
    const offs = [0, 0.011, 0.023];
    for (const o of offs) this.noise(when + o, 0.028, 0.14, 'bandpass', 1700, 0.7);
    this.noise(when + 0.03, 0.16, 0.12, 'bandpass', 1500, 0.5);
  }

  // ---------------- sequencing ----------------
  update() {
    if (!this.playing || !this.audio.ctx) return;
    if (this.usingTrack) return;       // sample track needs no sequencing
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
      } else if (st.style === 'trap') {
        const stepDur2 = 60 / st.bpm / 4;
        // 808 sub-bass on a syncopated half-time pattern, gliding to the root
        if ([0, 3, 6, 8, 11, 14].includes(step16)) {
          let n = chord[0] - 24;                 // two octaves down = sub
          if (step16 === 6) n += 7;              // slide to the 5th
          else if (step16 === 11) n += 3;        // minor 3rd
          this.sub808(t, midiHz(n), stepDur2 * (step16 === 8 ? 3.4 : 2.6));
        }
        // punchy kick reinforcing the 808 downbeats
        if (step16 % 8 === 0) this.kick(t);
        // half-time clap on beat 3
        if (step16 === 8) this.clap(t);
        // rolling hats: steady 16ths, open on the & of 2, plus 1/32 + triplet rolls
        this.hat(t, step16 === 6);
        if (step16 % 4 === 2 && Math.random() < 0.55) {
          this.hat(t + stepDur2 / 2, false);
        }
        if ((step16 === 7 || step16 === 15) && Math.random() < 0.5) {
          const n = 3 + ((Math.random() * 3) | 0);   // 3–5 hat roll
          for (let k = 1; k < n; k++) this.hat(t + (stepDur2 * k) / n, false);
        }
        // lush R&B pad holds the chord across the bar
        if (step16 === 0) {
          for (const nn of chord) this.osc('triangle', midiHz(nn), t, stepDur2 * 16, 0.04, { attack: 0.5, sustain: 0.9, lp: 2000 });
        }
        // dark bell/pluck lead picks minor-pentatonic notes, sparse
        if (step16 % 2 === 0 && Math.random() < 0.28) {
          const deg = st.scale[Math.floor(Math.random() * st.scale.length)];
          this.osc('square', midiHz(st.root + 24 + deg), t, stepDur2 * 3, 0.05, { lp: 2600 });
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
