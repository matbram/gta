// World interaction layer: POI markers (safehouse save, gun shop, respray,
// food), cash drops, 30 hidden lucky coins, the taxi side-gig, the big map
// with click-to-waypoint and A* route drawing on the minimap.

import * as THREE from 'three';
import { WEAPONS } from './combat.js';
import { dist2d, clamp, formatMoney } from '../core/mathutil.js';
import { RNG } from '../core/rng.js';

const $ = (id) => document.getElementById(id);

// shared map icon set, keyed by city.pois key — one source of truth for
// both the big map markers and its legend so "where can I do things" reads
// at a glance
const POI_ICONS = {
  safehouse:     { glyph: '🏠', color: '#5fae52', label: 'Safehouse (save)' },
  gunShop:       { glyph: '🔫', color: '#b03a2e', label: 'Gun shop' },
  respray:       { glyph: '🎨', color: '#4a7fb5', label: 'Respray' },
  foodShop:      { glyph: '🍔', color: '#d87a3a', label: 'Food (heal)' },
  hospital:      { glyph: '➕', color: '#e05a5a', label: 'Hospital' },
  taxiDepot:     { glyph: '🚕', color: '#e8c84a', label: 'Taxi depot' },
  policeHQ:      { glyph: '🛡️', color: '#3a6a9a', label: 'Police HQ' },
  nightclub:     { glyph: '🎵', color: '#a05ac0', label: 'Nightclub' },
  docksWarehouse:{ glyph: '📦', color: '#8a7a5a', label: 'Warehouse' },
  mansion:       { glyph: '🏛️', color: '#c8b070', label: 'Mansion' },
};

export class WorldLife {
  constructor(game) {
    this.game = game;
    this.pickups = [];        // { mesh, kind, amount, x, z, id? }
    this.coinsTaken = new Set();
    this.shopOpen = null;
    this.taxiGig = null;
    this.route = null;        // array of {x,z} nodes for waypoint routing
    this.markers = [];

    this.buildPoiMarkers();
    this.spawnCoins();
    game.blipProviders.push((blips) => this.provideBlips(blips));
    this.bigmapCanvas = $('bigmap-canvas');
    this.bindBigMap();
  }

  // ---------------- POI markers ----------------
  buildPoiMarkers() {
    const game = this.game;
    const defs = [
      { poi: 'safehouse', color: 0x5fae52, kind: 'safehouse', label: 'Safehouse — save game' },
      { poi: 'gunShop', color: 0xb03a2e, kind: 'gunshop', label: 'Bullseye Rounds' },
      { poi: 'respray', color: 0x4a7fb5, kind: 'respray', label: 'Kandy Kustoms' },
      { poi: 'foodShop', color: 0xd87a3a, kind: 'food', label: 'Pronto Burger' },
    ];
    for (const d of defs) {
      const poi = game.city.pois[d.poi];
      if (!poi) continue;
      const geo = new THREE.CylinderGeometry(1.4, 1.4, 2.2, 18, 1, true);
      const mat = new THREE.MeshBasicMaterial({
        color: d.color, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(poi.x, game.city.groundHeight(poi.x, poi.z) + 1.1, poi.z);
      game.scene.add(mesh);
      this.markers.push({ ...d, x: poi.x, z: poi.z, mesh, cooldown: 0 });
    }
  }

  // civic dressing: cruisers parked outside BPD HQ, an ambulance at
  // St. Aurora — the institutions look inhabited
  dressInstitutions() {
    const game = this.game;
    const put = (poi, type, n) => {
      if (!poi) return;
      for (let k = 0; k < n; k++) {
        const v = game.vehicles?.spawnOnRoadNear(poi.x + k * 7 - 4, poi.z + 6, type);
        if (v) { v.parked = true; v.sirenOn = false; }
      }
    };
    put(game.city.pois.policeHQ, 'police', 2);
    put(game.city.pois.hospital, 'ambulance', 1);
  }

  // Interiors claims doors after construction and moves some POIs onto
  // them — re-sync the frozen marker copies so blips match the real doors
  refreshPoiMarkers() {
    for (const m of this.markers) {
      const poi = this.game.city.pois[m.poi];
      if (!poi) continue;
      m.x = poi.x;
      m.z = poi.z;
      m.mesh.position.set(poi.x, this.game.city.groundHeight(poi.x, poi.z) + 1.1, poi.z);
    }
  }

  provideBlips(blips) {
    // service markers: distinct colour + icon glyph so each is legible
    const meta = {
      safehouse: { color: '#5fae52', glyph: '🏠' }, gunshop: { color: '#b03a2e', glyph: '🔫' },
      respray: { color: '#4a7fb5', glyph: '🎨' }, food: { color: '#d87a3a', glyph: '🍔' },
    };
    for (const m of this.markers) {
      const mi = meta[m.kind] || { color: '#ccc' };
      blips.push({ x: m.x, z: m.z, color: mi.color, shape: 'square', letter: mi.glyph });
    }
    // taxi gig target
    if (this.taxiGig) blips.push({ x: this.taxiGig.x, z: this.taxiGig.z, color: '#e8c84a' });
    // police blips while wanted
    for (const c of this.game.wanted?.footCops || []) {
      if (!c.dead) blips.push({ x: c.pos.x, z: c.pos.z, color: '#4a7fb5' });
    }
    for (const cr of this.game.wanted?.cruisers || []) {
      if (!cr.vehicle.dead) blips.push({ x: cr.vehicle.pos.x, z: cr.vehicle.pos.z, color: '#4a7fb5' });
    }
  }

  // ---------------- pickups ----------------
  dropCash(x, z, amount) {
    const game = this.game;
    // shared geometry/material for every cash drop (they come and go constantly)
    if (!this._cashGeo) {
      this._cashGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.08, 10);
      this._cashMat = new THREE.MeshLambertMaterial({ color: 0x5fae52, emissive: 0x2a5e28, emissiveIntensity: 0.5 });
    }
    const mesh = new THREE.Mesh(this._cashGeo, this._cashMat);
    const y = game.city.groundHeight(x, z);
    mesh.position.set(x, y + 0.25, z);
    game.scene.add(mesh);
    this.pickups.push({ mesh, kind: 'cash', amount, x, z, t: 0, ttl: 30 });
  }

  // a dropped firearm (dead cops leave their sidearm behind)
  dropWeapon(x, z, weaponId, ammo) {
    const game = this.game;
    if (!this._gunGeoA) {
      this._gunGeoA = new THREE.BoxGeometry(0.09, 0.09, 0.42);   // slide/barrel
      this._gunGeoB = new THREE.BoxGeometry(0.09, 0.2, 0.11);    // grip
      this._gunMat = new THREE.MeshLambertMaterial({ color: 0x2a2c30, emissive: 0x8899aa, emissiveIntensity: 0.18 });
    }
    const mesh = new THREE.Group();
    const a = new THREE.Mesh(this._gunGeoA, this._gunMat);
    const b = new THREE.Mesh(this._gunGeoB, this._gunMat);
    b.position.set(0, -0.12, -0.13);
    mesh.add(a, b);
    const y = game.city.groundHeight(x, z);
    mesh.position.set(x, y + 0.16, z);
    mesh.rotation.z = 0.3;
    game.scene.add(mesh);
    this.pickups.push({ mesh, kind: 'weapon', weapon: weaponId, amount: ammo, x, z, t: 0, ttl: 45 });
  }

  spawnCoins() {
    // 30 lucky coins hidden across the map, deterministic locations
    const game = this.game;
    const rng = new RNG(game.city.seed + 999);
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 0.1, 14);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({ color: 0xe8c84a, emissive: 0xa8842a, emissiveIntensity: 0.6 });
    let placed = 0, tries = 0;
    while (placed < 30 && tries < 500) {
      tries++;
      const x = rng.float(-game.city.HALF + 80, game.city.HALF - 80);
      const z = rng.float(-game.city.HALF + 80, game.city.HALF - 80);
      if (!game.city.landAt(x, z)) continue;
      // keep off buildings
      const blocked = game.city.queryColliders(x, z, 1).some((b) =>
        x > b.minX - 1 && x < b.maxX + 1 && z > b.minZ - 1 && z < b.maxZ + 1);
      if (blocked) continue;
      const id = 'coin' + placed;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, game.city.groundHeight(x, z) + 0.8, z);
      this.game.scene.add(mesh);
      this.pickups.push({ mesh, kind: 'coin', amount: 100, x, z, id, t: 0, ttl: Infinity });
      placed++;
    }
  }

  restoreCoins(takenIds) {
    this.coinsTaken = new Set(takenIds);
    for (const p of [...this.pickups]) {
      if (p.kind === 'coin' && this.coinsTaken.has(p.id)) {
        p.mesh.removeFromParent();
        this.pickups.splice(this.pickups.indexOf(p), 1);
      }
    }
    this.game.state.stats.coins = this.coinsTaken.size;
  }

  // ---------------- shops ----------------
  openShop(kind) {
    const game = this.game;
    game.setMode('shop');
    this.shopOpen = kind;
    const panel = $('shop-items');
    panel.innerHTML = '';
    $('shop').classList.remove('hidden');

    const addItem = (icon, label, price, cb, sub = '') => {
      const div = document.createElement('div');
      div.className = 'shop-item' + (game.state.money < price ? ' cant' : '');
      div.innerHTML = `<span><span class="icon">${icon}</span>${label}${sub ? ` <small style="color:#8a7a68">${sub}</small>` : ''}</span><span class="price">$${price}</span>`;
      div.onclick = () => {
        if (!game.spendMoney(price)) { game.hud.showToast('Not enough cash.', 2); return; }
        cb();
        game.audio?.cash();
        game.voice?.say?.('purchase', 0.4);
        this.closeShop();
      };
      panel.appendChild(div);
    };

    if (kind === 'gunshop') {
      $('shop-title').textContent = 'BULLSEYE ROUNDS';
      for (const id of ['bat', 'pistol', 'revolver', 'smg', 'shotgun', 'rifle', 'grenade', 'molotov']) {
        const w = WEAPONS[id];
        const owned = game.combat.inventory[id];
        const packSize = w.thrown ? 5 : (w.mag ?? 0) * 2;
        if (owned && !w.melee) {
          addItem(w.icon, `${w.name} ${w.thrown ? '×5' : 'ammo'}`, Math.round(w.price * 0.25),
            () => game.combat.give(id, packSize), w.thrown ? '+5' : `+${packSize} rounds`);
        } else if (!owned) {
          addItem(w.icon, w.name, w.price, () => game.combat.give(id, w.melee ? 0 : packSize));
        }
      }
      addItem('🦺', 'BODY ARMOR', 350, () => { game.player.armor = 100; });
    } else if (kind === 'food') {
      $('shop-title').textContent = 'PRONTO BURGER';
      addItem('🍔', 'EL GRANDE BURGER', 15, () => game.player.heal(40), '+40 health');
      addItem('🌮', 'DOCKSIDE TACOS', 8, () => game.player.heal(20), '+20 health');
      addItem('☕', 'CORONET COFFEE', 4, () => { game.player.stamina = 1; game.player.heal(5); }, 'stamina refill');
    }
  }

  closeShop() {
    $('shop').classList.add('hidden');
    if (this.game.state.mode === 'shop') this.game.setMode('play');
    this.shopOpen = null;
    // small cooldown so the marker doesn't instantly reopen
    for (const m of this.markers) m.cooldown = 2.5;
  }

  // ---------------- taxi gig ----------------
  startTaxiGig() {
    const game = this.game;
    const v = game.player.vehicle;
    if (!v || v.type !== 'taxi') return;
    const poi = this.randomPoi();
    this.taxiGig = { phase: 'pickup', x: poi.x, z: poi.z, t: 90, fares: 0 };
    game.hud.showToast('Fare accepted — pick up the passenger at the marker.', 4);
  }

  randomPoi() {
    const keys = Object.keys(this.game.city.pois);
    const k = keys[Math.floor(Math.random() * keys.length)];
    return this.game.city.pois[k];
  }

  updateTaxiGig(dt) {
    const game = this.game;
    const gig = this.taxiGig;
    if (!gig) return;
    const v = game.player.vehicle;
    if (!v || v.type !== 'taxi' || v.dead) {
      game.hud.showToast('Fare cancelled.', 3);
      game.hud.setTimer(null);
      this.taxiGig = null;
      return;
    }
    gig.t -= dt;
    if (!game.missions?.active) game.hud.setTimer(gig.t, gig.t < 12);
    if (gig.t <= 0) {
      game.hud.showToast('Too slow — the fare walked.', 3);
      game.hud.setTimer(null);
      this.taxiGig = null;
      return;
    }
    if (dist2d(game.player.pos.x, game.player.pos.z, gig.x, gig.z) < 7 && Math.abs(v.speed) < 2) {
      if (gig.phase === 'pickup') {
        const dest = this.randomPoi();
        gig.phase = 'dropoff';
        gig.x = dest.x; gig.z = dest.z;
        gig.t = 75;
        game.hud.showToast('Passenger aboard — go to the destination!', 3);
        game.audio?.carDoor();
      } else {
        gig.fares++;
        const pay = 50 + Math.floor(Math.random() * 40) + gig.fares * 10;
        game.addMoney(pay);
        game.audio?.cash();
        game.hud.showToast(`Fare paid ${formatMoney(pay)} — next pickup?`, 3);
        const poi = this.randomPoi();
        gig.phase = 'pickup';
        gig.x = poi.x; gig.z = poi.z;
        gig.t = 90;
      }
    }
  }

  // ---------------- big map ----------------
  bindBigMap() {
    const canvas = this.bigmapCanvas;
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const u = (e.clientX - rect.left) / rect.width;
      const v = (e.clientY - rect.top) / rect.height;
      const x = u * this.game.city.SPAN - this.game.city.HALF;
      const z = v * this.game.city.SPAN - this.game.city.HALF;
      this.game.state.waypoint = { x, z };
      this.computeRoute(x, z);
      this.game.hud.showToast('Waypoint set.', 2);
      this.drawBigMap();
    });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.game.state.waypoint = null;
      this.route = null;
      this.drawBigMap();
    });
  }

  openBigMap() { this.drawBigMap(); }
  updateBigMap() { /* redrawn on interaction; static otherwise */ }

  districtLabels() {
    if (this._labels) return this._labels;
    // average the cell centres per district for label placement
    const sums = {};
    for (const c of this.game.city.cells) {
      if (!sums[c.district]) sums[c.district] = { x: 0, z: 0, n: 0 };
      sums[c.district].x += c.cx; sums[c.district].z += c.cz; sums[c.district].n++;
    }
    const names = {
      crown: 'Crown Center', oldtown: 'Old Coronet', midtown: 'Midtown',
      suburbs: 'Sunset Flats', docks: 'Ironhook Docks', beach: 'Verdemar Beach',
      park: 'Palmera Park', heights: 'Bayvale Heights', farm: 'Northfields',
    };
    this._labels = Object.entries(sums)
      .filter(([k, v]) => names[k] && v.n > 3)
      .map(([k, v]) => ({ name: names[k], x: v.x / v.n, z: v.z / v.n }));
    return this._labels;
  }

  drawBigMap() {
    const game = this.game;
    const ctx = this.bigmapCanvas.getContext('2d');
    const S = this.bigmapCanvas.width;
    const px = (x) => ((x + game.city.HALF) / game.city.SPAN) * S;
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(game.minimap.mapCanvas, 0, 0, S, S);

    // district names
    ctx.save();
    ctx.font = 'italic bold 13px Georgia';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(60,50,40,0.85)';
    ctx.shadowColor = 'rgba(255,250,235,0.7)';
    ctx.shadowBlur = 3;
    for (const l of this.districtLabels()) ctx.fillText(l.name.toUpperCase(), px(l.x), px(l.z));
    ctx.restore();

    // route
    if (this.route) {
      ctx.strokeStyle = 'rgba(138,74,138,0.9)';
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < this.route.length; i++) {
        const p = this.route[i];
        if (i === 0) ctx.moveTo(px(p.x), px(p.z));
        else ctx.lineTo(px(p.x), px(p.z));
      }
      ctx.stroke();
    }

    const drawIcon = (x, z, color, glyph, r = 9) => {
      ctx.fillStyle = color;
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px(x), px(z), r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      if (glyph) {
        ctx.font = `${r + 2}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(glyph, px(x), px(z) + 0.5);
      }
    };

    // shared POI icon set — every place you can DO something, always shown
    const p = game.city.pois;
    for (const [key, meta] of Object.entries(POI_ICONS)) {
      if (p[key]) drawIcon(p[key].x, p[key].z, meta.color, meta.glyph);
    }
    // mission contacts (kept as their lettered blips)
    const blips = [];
    game.missions?.provideBlips?.(blips);
    for (const b of blips) if (b.letter) drawIcon(b.x, b.z, b.color, b.letter);

    // waypoint
    if (game.state.waypoint) drawIcon(game.state.waypoint.x, game.state.waypoint.z, '#8a4a8a', '📍');

    // legend panel
    this.drawMapLegend(ctx, S);

    // player
    const pp = game.player.pos;
    ctx.save();
    ctx.translate(px(pp.x), px(pp.z));
    ctx.rotate(Math.PI - game.player.heading);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#111';
    ctx.beginPath();
    ctx.moveTo(0, -10); ctx.lineTo(6, 8); ctx.lineTo(0, 4); ctx.lineTo(-6, 8);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  drawMapLegend(ctx, S) {
    const p = this.game.city.pois;
    const rows = Object.entries(POI_ICONS).filter(([k]) => p[k]);
    const pad = 10, lh = 20, boxW = 168, boxH = pad * 2 + rows.length * lh + 20;
    const x0 = 12, y0 = S - boxH - 12;
    ctx.save();
    ctx.fillStyle = 'rgba(10,12,14,0.82)';
    ctx.strokeStyle = 'rgba(120,110,90,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(x0, y0, boxW, boxH);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#d8ccb8';
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('MAP KEY', x0 + pad, y0 + pad + 6);
    let yy = y0 + pad + 24;
    for (const [, meta] of rows) {
      ctx.font = '15px Arial';
      ctx.textAlign = 'center';
      ctx.fillStyle = meta.color;
      ctx.beginPath();
      ctx.arc(x0 + pad + 7, yy, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.fillText(meta.glyph, x0 + pad + 7, yy + 0.5);
      ctx.font = '12px Arial';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#cbbfa8';
      ctx.fillText(meta.label, x0 + pad + 22, yy + 0.5);
      yy += lh;
    }
    ctx.restore();
  }

  // A* over the road graph from player to waypoint
  computeRoute(tx, tz) {
    const city = this.game.city;
    const start = city.nearestNode(this.game.player.pos.x, this.game.player.pos.z);
    const goal = city.nearestNode(tx, tz);
    if (!start || !goal) { this.route = null; return; }
    const open = new Map();
    const gScore = new Map();
    const came = new Map();
    const key = (n) => n.i + ',' + n.j;
    const h = (n) => Math.abs(n.x - goal.x) + Math.abs(n.z - goal.z);
    open.set(key(start), start);
    gScore.set(key(start), 0);
    const fScore = new Map([[key(start), h(start)]]);
    let found = null;
    let guard = 0;
    while (open.size && guard++ < 4000) {
      // lowest f
      let cur = null, cf = Infinity;
      for (const [k, n] of open) {
        const f = fScore.get(k) ?? Infinity;
        if (f < cf) { cf = f; cur = n; }
      }
      if (cur === goal) { found = cur; break; }
      open.delete(key(cur));
      for (const e of cur.edges) {
        const nb = e.a === cur ? e.b : e.a;
        const tentative = (gScore.get(key(cur)) ?? Infinity) + e.len;
        if (tentative < (gScore.get(key(nb)) ?? Infinity)) {
          came.set(key(nb), cur);
          gScore.set(key(nb), tentative);
          fScore.set(key(nb), tentative + h(nb));
          open.set(key(nb), nb);
        }
      }
    }
    if (!found) { this.route = null; return; }
    const path = [{ x: tx, z: tz }];
    let cur = found;
    while (cur) {
      path.push({ x: cur.x, z: cur.z });
      cur = came.get(key(cur));
    }
    path.push({ x: this.game.player.pos.x, z: this.game.player.pos.z });
    path.reverse();
    this.route = path;
  }

  // ---------------- per-frame ----------------
  update(dt) {
    const game = this.game;
    const p = game.player.pos;
    const t = game.time;

    // one-time civic dressing once vehicles exist
    if (!this._dressed && game.vehicles) {
      this._dressed = true;
      this.dressInstitutions();
    }

    // seagulls over the waterfront
    this._gullT = (this._gullT ?? 8) - dt;
    if (this._gullT <= 0) {
      this._gullT = 10 + Math.random() * 16;
      const d = game.city.districtAt(p.x, p.z);
      if (d === 'beach' || d === 'docks') {
        const a = Math.random() * Math.PI * 2;
        game.audio?.seagull?.(p.x + Math.cos(a) * 30, p.z + Math.sin(a) * 30);
      }
    }

    // ambient theater: every so often a siren wails past on a call of its
    // own — the city has emergencies that aren't about you
    this._passByT = (this._passByT ?? 40) - dt;
    if (this._passByT <= 0) {
      this._passByT = 75 + Math.random() * 70;
      if ((game.state.wanted?.stars ?? 0) === 0) {
        game.traffic?.trySpawn(p, Math.random() < 0.65 ? 'police' : 'ambulance');
      }
    }

    // markers: pulse + trigger
    for (const m of this.markers) {
      m.cooldown -= dt;
      m.mesh.material.opacity = 0.28 + Math.sin(t * 2.5) * 0.1;
      m.mesh.rotation.y = t * 0.7;
      if (m.cooldown > 0 || game.player.vehicle || game.player.dead || game.state.mode !== 'play') continue;
      if (dist2d(p.x, p.z, m.x, m.z) < 1.7) {
        m.cooldown = 3;
        // gun shop / food / safehouse entrances are handled by the interiors
        // system now — these markers remain as map blips only
      }
    }

    // respray: drive in with a car
    const resprayM = this.markers.find((m) => m.kind === 'respray');
    if (resprayM && game.player.vehicle && !game.player.vehicle.dead &&
        dist2d(p.x, p.z, resprayM.x, resprayM.z) < 7 && resprayM.cooldown <= 0) {
      resprayM.cooldown = 6;
      const cost = 100;
      if (game.state.wanted.stars > 0 && game.spendMoney(cost)) {
        game.wanted.clear();
        game.player.vehicle.health = Math.max(game.player.vehicle.health, 80);
        game.hud.showToast(`Fresh paint, clean plates. -$${cost}`, 4);
        game.audio?.cash();
      } else if (game.state.wanted.stars === 0 && game.player.vehicle.health < 95 && game.spendMoney(cost)) {
        game.player.vehicle.health = 100;
        game.hud.showToast(`Repaired and resprayed. -$${cost}`, 3);
        game.audio?.cash();
      }
    }

    // pickups
    for (const pk of [...this.pickups]) {
      pk.t += dt;
      pk.mesh.rotation.y = t * 2.2;
      if (pk.kind === 'coin') pk.mesh.rotation.z = t * 1.1;
      if (pk.ttl !== Infinity && pk.t > pk.ttl) {
        pk.mesh.removeFromParent();
        this.pickups.splice(this.pickups.indexOf(pk), 1);
        continue;
      }
      if (dist2d(p.x, p.z, pk.x, pk.z) < 1.4) {
        if (pk.kind === 'cash') {
          game.addMoney(pk.amount);
          game.audio?.cash();
        } else if (pk.kind === 'weapon') {
          game.combat?.give(pk.weapon, pk.amount);
          game.audio?.pickup?.();
        } else if (pk.kind === 'coin') {
          this.coinsTaken.add(pk.id);
          game.state.stats.coins = this.coinsTaken.size;
          game.addMoney(pk.amount);
          game.audio?.pickup();
          game.hud.showToast(`Lucky coin ${this.coinsTaken.size}/30  (+$${pk.amount})`, 3);
          if (this.coinsTaken.size === 30) {
            game.addMoney(5000);
            game.player.maxHealth = 125;
            game.hud.showToast('All 30 coins! +$5,000 and +25 max health.', 6);
          }
        }
        pk.mesh.removeFromParent();
        this.pickups.splice(this.pickups.indexOf(pk), 1);
      }
    }

    // taxi gig hotkey
    if (game.input.wasPressed('KeyT') && game.player.vehicle?.type === 'taxi' && !this.taxiGig) {
      this.startTaxiGig();
    }
    this.updateTaxiGig(dt);

    // waypoint reached?
    if (game.state.waypoint && dist2d(p.x, p.z, game.state.waypoint.x, game.state.waypoint.z) < 12) {
      game.state.waypoint = null;
      this.route = null;
    }
  }
}
