// Marco's running monologue: short reactions to what's happening RIGHT NOW,
// with per-trigger cooldowns, a global gap, and no-repeat-last selection so
// nothing feels canned. Lines show as subtitles; if generated voice takes
// (marco_<trigger>, marco_<trigger>_2, …) exist in the audio manifest they
// play too. All lines are profanity-free.

// exported so tools/gen-audio.mjs generates one voice take per line —
// the spoken audio always matches the subtitle
export const LINES = {
  cops: [
    'Great. Company.',
    'Here they come…',
    'Not today, officers.',
    'I really don’t have time for this.',
  ],
  evaded: [
    'Lost ’em.',
    'And… breathe.',
    'They’ll need better maps than that.',
    'Gone like smoke.',
  ],
  crash: [
    'That’s coming out of somebody’s paycheck.',
    'Whoa — okay. Okay.',
    'Smooth, Marco. Real smooth.',
    'The car had it coming.',
  ],
  carjack: [
    'Borrowing it. Mostly.',
    'New ride. Don’t wait up.',
    'Insurance will cover it. Probably.',
  ],
  breakin: [
    'Sorry about the window.',
    'Locks only slow down honest people.',
  ],
  robbery: [
    'Register’s lighter. Time to not be here.',
    'Easy money. Loud money.',
    'Rosa never has to know about this.',
  ],
  hurt: [
    'That’s… a lot of blood.',
    'Need a minute. Or a medic.',
    'Still standing. Barely.',
  ],
  kill: [
    'Didn’t want that.',
    'No going back now.',
    'This city does it to everyone.',
  ],
  rain: [
    'And now it rains. Perfect.',
    'The city needed a shower anyway.',
    'Great night for a walk. Not.',
  ],
  incognito: [
    'New car, new me.',
    'Let ’em chase the old one.',
  ],
  idle: [
    'Six years away and it still smells like trouble.',
    'Rosa was right about this town.',
    'Corvo’s out there somewhere. Getting comfortable.',
    'Focus, Marco.',
    'One more job. Then we’ll see.',
  ],
};

const COOLDOWNS = { idle: 60, cops: 18, crash: 14, hurt: 25, kill: 30, rain: 90 };

export class Voice {
  constructor(game) {
    this.game = game;
    this.cool = {};
    this.lastIdx = {};
    this.globalUntil = 0;
    this._idleT = 45;
    this._lastHealth = 100;
  }

  say(trigger, chance = 1) {
    const g = this.game;
    const lines = LINES[trigger];
    if (!lines?.length || g.player?.dead) return;
    if (Math.random() > chance) return;
    const t = g.time;
    if (t < this.globalUntil || t < (this.cool[trigger] ?? 0)) return;
    this.globalUntil = t + 11;
    this.cool[trigger] = t + (COOLDOWNS[trigger] ?? 20);
    let i = Math.floor(Math.random() * lines.length);
    if (i === this.lastIdx[trigger] && lines.length > 1) i = (i + 1) % lines.length;
    this.lastIdx[trigger] = i;
    g.hud?.say('Marco', lines[i], 3.4);
    // takes are named per line (marco_x, marco_x_2, …) so the audio says
    // exactly what the subtitle shows
    const take = i === 0 ? `marco_${trigger}` : `marco_${trigger}_${i + 1}`;
    g.audio?.playVar?.(take, { gain: 0.9 });
  }

  update(dt) {
    const g = this.game;
    if (g.state.mode !== 'play' || g.player.dead) return;
    // idle mutterings when the city is quiet
    this._idleT -= dt;
    if (this._idleT <= 0) {
      this._idleT = 70 + Math.random() * 80;
      if ((g.state.wanted?.stars ?? 0) === 0) this.say('idle', 0.8);
    }
    // pain reaction when health crosses the red line
    const hp = g.player.health;
    if (hp < 30 && this._lastHealth >= 30) this.say('hurt', 0.85);
    this._lastHealth = hp;
  }
}
