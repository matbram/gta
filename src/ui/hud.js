// DOM HUD: clock, money, health/armor, wanted stars, weapon, zone popups,
// centre messages (WASTED/BUSTED/MISSION PASSED), objective + subtitle lines.

import { formatMoney, formatClock, formatTimer, clamp } from '../core/mathutil.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), clock: $('hud-clock'), money: $('hud-money'), stars: $('hud-stars'),
      health: $('hud-health').firstElementChild,
      armor: $('hud-armor').firstElementChild,
      armorBar: $('hud-armor'),
      breath: $('hud-breath'), breathFill: $('hud-breath').firstElementChild,
      weaponIcon: document.querySelector('#hud-weapon .wicon'),
      weaponName: document.querySelector('#hud-weapon .wname'),
      weaponAmmo: document.querySelector('#hud-weapon .wammo'),
      zone: $('zonename'), veh: $('vehname'),
      center: $('centermsg'), centerSub: $('centersub'),
      objective: document.querySelector('#objective span'),
      subtitle: document.querySelector('#subtitle span'),
      toast: document.querySelector('#toast span'),
      radioToast: document.querySelector('#radiotoast span'),
      timerBox: $('timerbox'), timerText: document.querySelector('#timerbox span'),
      crosshair: $('crosshair'), vignette: $('vignette'), fader: $('fader'),
      boomflash: $('boomflash'),
      dmgdir: $('dmgdir'),
      speedo: $('speedo'),
      speedoKmh: document.querySelector('#speedo .kmh'),
      speedoBar: document.querySelector('#speedo .sbar i'),
      ticks: $('moneyticks'),
    };
    this.shownMoney = 0;
    this.damageFlashT = 0;
    this.boomFlashV = 0;
    this.zoneTimer = 0;
    this.vehTimer = 0;
    this.toastTimer = 0;
    this.radioTimer = 0;
    this.subtitleTimer = 0;
    this.centerTimer = 0;
    this.lastStars = -1;
  }

  show() { this.el.hud.classList.remove('hidden'); this._tickBase = null; }
  hide() { this.el.hud.classList.add('hidden'); }

  boomFlash(strength) {
    this.boomFlashV = Math.max(this.boomFlashV, strength);
  }

  update(dt, game) {
    const p = game.player;
    // money counts toward the real value
    const target = game.state.money;
    // floating +$/-$ ticks on every change (baseline set on first frame)
    if (this._tickBase == null) this._tickBase = target;
    else if (target !== this._tickBase) {
      this.moneyTick(target - this._tickBase);
      this._tickBase = target;
    }
    if (this.shownMoney !== target) {
      const diff = target - this.shownMoney;
      const step = Math.max(1, Math.abs(diff) * dt * 6);
      this.shownMoney += clamp(diff, -step, step);
      if (Math.abs(target - this.shownMoney) < 1) this.shownMoney = target;
      this.el.money.textContent = formatMoney(this.shownMoney);
      this.el.money.classList.toggle('flash', diff > 0);
    } else {
      this.el.money.classList.remove('flash');
    }

    this.el.clock.textContent = formatClock(game.dayNight.minutes);
    this.el.health.style.width = `${clamp((p.health / p.maxHealth) * 100, 0, 100)}%`;
    this.el.armor.style.width = `${clamp(p.armor, 0, 100)}%`;
    this.el.armorBar.style.display = p.armor > 0 ? '' : 'none';

    // wanted stars
    const stars = game.state.wanted?.stars ?? 0;
    if (stars !== this.lastStars) {
      this.lastStars = stars;
      let html = '';
      for (let i = 0; i < 6; i++) html += `<span class="${i < stars ? 'on' : 'off'}">★</span>`;
      this.el.stars.innerHTML = html;
    }

    // directional damage arc: rotates to face where the hit came from
    if (this._dmgT > 0) {
      this._dmgT -= dt;
      const yaw = game.cameraRig?.yaw ?? 0;
      // screen-up is the camera's forward (yaw + π in world terms)
      const rel = (this._dmgAngle ?? 0) - (yaw + Math.PI);
      this.el.dmgdir.style.transform = `rotate(${-rel}rad)`;
      this.el.dmgdir.style.opacity = Math.min(1, this._dmgT * 2.2);
    } else if (this.el.dmgdir.style.opacity !== '0') {
      this.el.dmgdir.style.opacity = 0;
    }

    // vignette when hurt + brief flash on damage
    const hurt = 1 - p.health / p.maxHealth;
    let vig = hurt > 0.55 ? (hurt - 0.55) * 1.8 : 0;
    if (this.damageFlashT > 0) {
      this.damageFlashT -= dt;
      vig = Math.max(vig, this.damageFlashT * 2.2);
    }
    this.el.vignette.style.opacity = vig;

    // explosion screen flash: instant on, fast decay
    if (this.boomFlashV > 0.005) {
      this.boomFlashV = Math.max(0, this.boomFlashV - dt * 4);
      this.el.boomflash.style.opacity = this.boomFlashV;
    } else if (this.el.boomflash.style.opacity !== '0') {
      this.el.boomflash.style.opacity = 0;
    }

    // speedometer while driving
    const veh = p.vehicle;
    if (veh) {
      this.el.speedo.classList.remove('hidden');
      const mph = Math.round(Math.abs(veh.speed) * 2.237);   // m/s → mph
      if (mph !== this._kmh) {
        this._kmh = mph;
        this.el.speedoKmh.textContent = mph;
        this.el.speedoBar.style.width =
          `${clamp(Math.abs(veh.speed) / veh.spec.maxSpeed, 0, 1) * 100}%`;
      }
    } else if (this._kmh != null) {
      this._kmh = null;
      this.el.speedo.classList.add('hidden');
    }

    // stamina shown as the blue bar while it's not full
    if (p.stamina < 0.98 && !p.vehicle) {
      this.el.breath.classList.remove('hidden');
      this.el.breathFill.style.width = `${p.stamina * 100}%`;
    } else this.el.breath.classList.add('hidden');

    // timers for transient labels
    if (this.zoneTimer > 0) { this.zoneTimer -= dt; if (this.zoneTimer <= 0) this.el.zone.style.opacity = 0; }
    if (this.vehTimer > 0) { this.vehTimer -= dt; if (this.vehTimer <= 0) this.el.veh.style.opacity = 0; }
    if (this.toastTimer > 0) { this.toastTimer -= dt; if (this.toastTimer <= 0) this.el.toast.style.opacity = 0; }
    if (this.radioTimer > 0) { this.radioTimer -= dt; if (this.radioTimer <= 0) this.el.radioToast.style.opacity = 0; }
    if (this.subtitleTimer > 0) {
      this.subtitleTimer -= dt;
      if (this.subtitleTimer <= 0) this.el.subtitle.classList.add('hidden');
    }
    if (this.centerTimer > 0) {
      this.centerTimer -= dt;
      if (this.centerTimer <= 0) { this.el.center.style.opacity = 0; this.el.centerSub.style.opacity = 0; }
    }
  }

  moneyTick(diff) {
    const box = this.el.ticks;
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'mtick ' + (diff > 0 ? 'gain' : 'loss');
    d.textContent = (diff > 0 ? '+' : '−') + formatMoney(Math.abs(diff));
    box.appendChild(d);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => d.remove(), 1700);
  }

  setWeapon(icon, name, ammoText) {
    this.el.weaponIcon.textContent = icon;
    this.el.weaponName.textContent = name;
    this.el.weaponAmmo.textContent = ammoText || '';
  }

  showZone(name) {
    this.el.zone.textContent = name;
    this.el.zone.style.opacity = 1;
    this.zoneTimer = 3.5;
  }

  showVehicleName(name) {
    this.el.veh.textContent = name;
    this.el.veh.style.opacity = 1;
    this.vehTimer = 3;
  }

  showCenter(text, cls, sub = '', seconds = 4) {
    this.el.center.textContent = text;
    this.el.center.className = cls;
    this.el.center.style.opacity = 1;
    this.el.centerSub.textContent = sub;
    this.el.centerSub.style.opacity = sub ? 1 : 0;
    this.centerTimer = seconds;
  }

  showToast(text, seconds = 3.5) {
    this.el.toast.textContent = text;
    this.el.toast.style.opacity = 1;
    this.toastTimer = seconds;
  }

  showRadio(text, seconds = 3) {
    this.el.radioToast.textContent = text;
    this.el.radioToast.style.opacity = 1;
    this.radioTimer = seconds;
  }

  setObjective(html) {
    if (!html) { this.el.objective.classList.add('hidden'); return; }
    this.el.objective.innerHTML = html;
    this.el.objective.classList.remove('hidden');
  }

  clearSubtitle() {
    this.subtitleTimer = 0;
    this.el.subtitle.classList.add('hidden');
  }

  say(speaker, line, seconds = 4.5) {
    this.el.subtitle.innerHTML = speaker ? `<span class="speaker">${speaker}:</span> ${line}` : line;
    this.el.subtitle.classList.remove('hidden');
    this.subtitleTimer = seconds;
  }

  setTimer(seconds, urgent) {
    if (seconds == null) { this.el.timerBox.style.display = 'none'; return; }
    this.el.timerBox.style.display = 'block';
    this.el.timerBox.classList.toggle('urgent', !!urgent);
    this.el.timerText.textContent = formatTimer(seconds);
  }

  // worldAngle: direction the hit came FROM (atan2 toward the attacker);
  // shown as a red arc on that side of the screen
  damageFlash(worldAngle = null) {
    this.damageFlashT = 0.28;
    this._dmgAngle = worldAngle;
    this._dmgT = worldAngle != null ? 0.75 : 0;
  }

  setCrosshair(visible, hit = false, bloom = 0, { kill = false, ads = 0 } = {}) {
    if (kill && !this._killCss) {
      this._killCss = true;
      const st = document.createElement('style');
      st.textContent = '#crosshair.killmark span,#crosshair.killmark::before,#crosshair.killmark::after{background:#e33 !important;}' +
        '#crosshair.killmark{filter:drop-shadow(0 0 3px rgba(230,40,40,.8));}';
      document.head.appendChild(st);
    }
    this.el.crosshair.style.display = visible ? 'block' : 'none';
    this.el.crosshair.classList.toggle('hitmark', hit && !kill);
    this.el.crosshair.classList.toggle('killmark', kill);
    // bloom spreads the arms outward; aiming down sights tightens them
    if (visible) {
      const s = (1 + bloom * 0.9) * (1 - 0.45 * (ads || 0));
      this.el.crosshair.style.transform = `translate(-50%,-50%) scale(${s})`;
    }
  }

  // sniper-style scope vignette while a scoped weapon is fully aimed
  setScope(on) {
    if (!this._scope) {
      if (!on) return;
      const d = document.createElement('div');
      d.id = 'scope';
      d.style.cssText = 'position:fixed;inset:0;pointer-events:none;display:none;z-index:40;' +
        'background:radial-gradient(circle at 50% 50%, transparent 26%, rgba(0,0,0,.97) 34%);';
      const line = document.createElement('div');
      line.style.cssText = 'position:absolute;left:50%;top:50%;width:56vmin;height:1px;' +
        'background:rgba(0,0,0,.75);transform:translate(-50%,-50%);';
      const lineV = document.createElement('div');
      lineV.style.cssText = 'position:absolute;left:50%;top:50%;width:1px;height:56vmin;' +
        'background:rgba(0,0,0,.75);transform:translate(-50%,-50%);';
      d.append(line, lineV);
      document.body.appendChild(d);
      this._scope = d;
    }
    this._scope.style.display = on ? 'block' : 'none';
  }

  fade(toBlack, instant = false) {
    if (instant) this.el.fader.style.transition = 'none';
    else this.el.fader.style.transition = 'opacity .7s';
    this.el.fader.style.opacity = toBlack ? 1 : 0;
    if (instant) requestAnimationFrame(() => { this.el.fader.style.transition = 'opacity .7s'; });
  }
}
