// Thrown ballistics: grenades arc, bounce and detonate; molotovs shatter
// on the first hard contact and leave a burning patch. A fixed pool of 4
// live projectiles (meshes built once); throwing past the cap detonates
// the oldest instead of dropping input.

import * as THREE from 'three';
import { clamp, dist2d } from '../core/mathutil.js';

const POOL = 4;

export class ProjectileSystem {
  constructor(game) {
    this.game = game;
    this.pool = [];
    const dark = new THREE.MeshLambertMaterial({ color: 0x27301f });
    const glass = new THREE.MeshLambertMaterial({ color: 0x3a5a2a, emissive: 0xd86a1a, emissiveIntensity: 0.6 });
    for (let i = 0; i < POOL; i++) {
      const grenade = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), dark);
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.26, 7), glass);
      grenade.visible = bottle.visible = false;
      game.scene.add(grenade, bottle);
      this.pool.push({
        live: false, kind: 'grenade', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        fuse: 0, bounces: 0, culprit: 'player', spin: 0, age: 0,
        meshes: { grenade, bottle },
      });
    }
  }

  throwProjectile(kind, x, y, z, vx, vy, vz, culprit = 'player') {
    // free slot, else steal the oldest (detonate it early)
    let p = this.pool.find((s) => !s.live);
    if (!p) {
      p = this.pool.reduce((a, b) => (a.age > b.age ? a : b));
      this.detonate(p);
    }
    Object.assign(p, {
      live: true, kind, x, y, z, vx, vy, vz, culprit,
      fuse: kind === 'grenade' ? 2.5 : 6, bounces: 0, spin: Math.random() * 6, age: 0,
    });
    p.meshes.grenade.visible = kind === 'grenade';
    p.meshes.bottle.visible = kind === 'molotov';
    return p;
  }

  detonate(p) {
    if (!p.live) return;
    p.live = false;
    p.meshes.grenade.visible = p.meshes.bottle.visible = false;
    const game = this.game;
    const water = game.city.groundHeight(p.x, p.z) < (game.city.WATER_Y ?? -0.4) + 0.05;
    if (p.kind === 'grenade') {
      // underwater booms are muffled but still boom
      game.vehicles?.explodeAt(p.x, p.y, p.z, water ? 4 : 7, p.culprit);
      if (water) game.particles?.waterSplash(p.x, p.y + 0.4, p.z);
    } else {
      // molotov: glass + fire patch (arson, not an explosion — heat comes
      // from what the fire does, via the normal witness/kill pipelines)
      game.particles?.glassBurst(p.x, p.y + 0.2, p.z);
      game.audio?.ricochet?.(p.x, p.z);
      if (water) { game.particles?.waterSplash(p.x, p.y + 0.2, p.z); return; }   // fizzles
      game.particles?.fire(p.x, p.y + 0.3, p.z, 6);
      game.dispatch?.reportFire(p.x, p.z, null,
        { radius: 2.2, dur: 8, dmgPeds: true, culprit: p.culprit, strength: 1.6 });
      game.peds?.senseEvent?.(p.x, p.z, 'crash', p.culprit);
    }
  }

  update(dt) {
    const game = this.game;
    const city = game.city;
    for (const p of this.pool) {
      if (!p.live) continue;
      p.age += dt;
      p.fuse -= dt;
      if (p.fuse <= 0) { this.detonate(p); continue; }
      p.vy -= 18 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      // ground contact
      const gy = city.groundHeight(p.x, p.z) + 0.06;
      if (p.y <= gy) {
        if (p.kind === 'molotov') { p.y = gy; this.detonate(p); continue; }
        p.y = gy;
        p.vy = -p.vy * 0.45;
        p.vx *= 0.6; p.vz *= 0.6;
        p.bounces++;
        if (Math.abs(p.vy) > 1.2) game.audio?.ricochet?.(p.x, p.z);
        if (p.bounces > 6) { p.vy = 0; p.vx *= 0.8; p.vz *= 0.8; }
      }

      // static colliders: reflect the penetrated axis (grenade) or shatter
      for (const b of city.queryColliders(p.x, p.z, 0.35)) {
        if (b.gone) continue;
        if (p.x <= b.minX || p.x >= b.maxX || p.z <= b.minZ || p.z >= b.maxZ) continue;
        const top = b.baseY != null ? b.baseY + b.h : city.groundHeight(p.x, p.z) + b.h;
        const bottom = b.baseY ?? -Infinity;
        if (p.y > top || p.y < bottom) continue;
        if (p.kind === 'molotov') { this.detonate(p); break; }
        // push out along the shallower axis and reflect that velocity
        const px = Math.min(p.x - b.minX, b.maxX - p.x);
        const pz = Math.min(p.z - b.minZ, b.maxZ - p.z);
        if (px < pz) {
          p.x = p.x - b.minX < b.maxX - p.x ? b.minX - 0.01 : b.maxX + 0.01;
          p.vx = -p.vx * 0.4;
        } else {
          p.z = p.z - b.minZ < b.maxZ - p.z ? b.minZ - 0.01 : b.maxZ + 0.01;
          p.vz = -p.vz * 0.4;
        }
        break;
      }
      if (!p.live) continue;

      // vehicles: ricochet off (or shatter on) roofs and panels
      const vehicles = game.vehicles?.vehicles;
      if (vehicles) {
        for (const v of vehicles) {
          if (v.dead) continue;
          const d = dist2d(p.x, p.z, v.pos.x, v.pos.z);
          if (d > v.boundR + 0.2 || p.y > v.pos.y + v.spec.h + 0.2) continue;
          const sH = Math.sin(v.heading), cH = Math.cos(v.heading);
          const dx = p.x - v.pos.x, dz = p.z - v.pos.z;
          if (Math.abs(dx * sH + dz * cH) > v.hl || Math.abs(dx * cH - dz * sH) > v.hw) continue;
          if (p.kind === 'molotov') { this.detonate(p); break; }
          const nd = d || 1;
          p.vx = (dx / nd) * Math.abs(p.vx) * 0.5 + v.vel.x * 0.3;
          p.vz = (dz / nd) * Math.abs(p.vz) * 0.5 + v.vel.y * 0.3;
          p.vy = Math.max(p.vy, 2);
          break;
        }
      }
      if (!p.live) continue;

      const mesh = p.kind === 'grenade' ? p.meshes.grenade : p.meshes.bottle;
      mesh.position.set(p.x, p.y, p.z);
      mesh.rotation.x += p.spin * dt;
      mesh.rotation.z += p.spin * 0.7 * dt;
    }
  }
}
