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
  // ---- context lines (round 4) ----
  killstreak: [
    'Okay, that’s enough bodies for one afternoon.',
    'They’re gonna need more chalk.',
    'I’m not proud of this. Mostly.',
    'Somebody stop me. Preferably not them.',
  ],
  copkill: [
    'That’s a cop. That is a very dead cop.',
    'No coming back from that one.',
    'They are going to want words. And bullets.',
  ],
  lowhealth: [
    'I’m running on fumes here.',
    'One more hit and it’s lights out.',
    'Need a hospital. Or a miracle.',
  ],
  hardland: [
    'Ooh — felt that in my knees.',
    'Stuck the landing. Barely.',
    'Note to self: elevators exist.',
  ],
  district: [
    'New neighborhood. New ways to get in trouble.',
    'Haven’t been down here in years.',
    'This part of town never changes.',
  ],
  purchase: [
    'Money well spent. Probably.',
    'Retail therapy, Bayvale style.',
    'Put it on my tab.',
  ],
  star3: [
    'Okay, now they’re taking this personally.',
    'Half the force is out here for me.',
    'This just got a lot more complicated.',
  ],
  boom: [
    'Whoa! Okay, too much.',
    'That’ll wake the neighbors.',
    'Beautiful. Terrible. Beautiful.',
  ],
  flip: [
    'That’s coming out of the deposit.',
    'Still alive. The car? Not so much.',
    'Okay, who put that there?',
  ],
};

const COOLDOWNS = {
  idle: 60, cops: 18, crash: 14, hurt: 25, kill: 30, rain: 90,
  killstreak: 40, copkill: 20, lowhealth: 30, hardland: 12, district: 45,
  purchase: 15, star3: 60, boom: 18, flip: 20,
};

export class Voice {
  constructor(game) {
    this.game = game;
    this.cool = {};
    this.lastIdx = {};
    this.globalUntil = 0;
    this._idleT = 45;
    this._lastHealth = 100;
    this._killTimes = [];
  }

  // player kills feed a rolling window; 3+ inside 15s earns a streak line
  notifyKill() {
    const t = this.game.time;
    this._killTimes = this._killTimes.filter((k) => t - k < 15);
    this._killTimes.push(t);
    if (this._killTimes.length >= 3) { this.say('killstreak', 0.7); this._killTimes = []; }
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
    // pain reaction when health crosses the red line, panic when critical
    const hp = g.player.health;
    if (hp < 10 && this._lastHealth >= 10) this.say('lowhealth', 0.9);
    else if (hp < 30 && this._lastHealth >= 30) this.say('hurt', 0.85);
    this._lastHealth = hp;
  }
}
