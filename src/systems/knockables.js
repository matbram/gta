// Knockable street props. A hard enough vehicle hit breaks a lamp post,
// hydrant, bench or trash can loose: the instanced copy is hidden, its
// collider retired, and a physical debris stand-in falls/tumbles, settles,
// then sinks away. Broken hydrants leave a water geyser behind.

import * as THREE from 'three';
import { clamp } from '../core/mathutil.js';

const MAX_DEBRIS = 24;
const GEYSER_TIME = 22;

export class Knockables {
  constructor(game) {
    this.game = game;
    this.debris = [];
    this.geysers = [];
    this.knockedCount = 0;   // test hook
  }

  // Returns true when the prop actually broke loose (caller lets the car roll on).
  knock(p, veh) {
    if (!p || p.knocked || !p._slots?.length) return false;
    const city = this.game.city;
    p.knocked = true;
    if (p.box) { p.box.gone = true; city.removeBox(p.box); p.box = null; }
    this.knockedCount++;

    // hide every instanced copy of this prop
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const s of p._slots) {
      s.mesh.setMatrixAt(s.idx, zero);
      s.mesh.instanceMatrix.needsUpdate = true;
    }

    const kn = city.propPhys?.[p.kind]?.knock || {};
    const groundY = city.groundHeight(p.x, p.z);
    const vx = veh ? veh.vel.x : 0, vz = veh ? veh.vel.y : 0;
    const sp = Math.hypot(vx, vz) || 1;

    if (kn.geyser) {
      this.geysers.push({ x: p.x, y: groundY + 0.15, z: p.z, t: GEYSER_TIME });
      this.game.particles?.waterSplash(p.x, groundY + 0.5, p.z);
    }
    if (kn.sparks) this.game.particles?.sparks(p.x, groundY + 3.5, p.z, 12);
    this.game.audio?.crash?.(clamp(sp, 4, 12), p.x, p.z);

    // debris body reusing the instanced geometry/materials
    const g = new THREE.Group();
    for (const s of p._slots) {
      if (s.noDebris) continue;
      const m = new THREE.Mesh(s.mesh.geometry, s.mesh.material);
      m.castShadow = true;
      g.add(m);
    }
    if (!g.children.length) return true;   // nothing visual (geyser-only stump etc.)
    const sc = p.s || 1;
    g.position.set(p.x, groundY, p.z);
    g.rotation.y = p.rot || 0;
    g.scale.setScalar(sc);
    this.game.scene.add(g);

    const d = {
      group: g, kind: p.kind, groundY,
      mode: kn.fall ? 'fall' : 'tumble',
      yawQ: g.quaternion.clone(),   // preserve the prop's standing yaw
      // fall: hinge at the base, tipping in the direction of travel
      axis: new THREE.Vector3(vz / sp, 0, -vx / sp),
      angle: 0, angVel: 0.4 + sp * 0.06,
      // tumble: fly with the car's momentum
      vel: new THREE.Vector3(vx * 0.55, 2.2 + sp * 0.12, vz * 0.55),
      spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize().multiplyScalar(2 + sp * 0.25),
      y: groundY, settle: 0, sink: 0, t: 0,
    };
    if (d.mode === 'fall') d.vel.set(0, 0, 0);
    this.debris.push(d);
    if (this.debris.length > MAX_DEBRIS) this.disposeDebris(this.debris.shift());
    return true;
  }

  disposeDebris(d) {
    // geometry + materials are shared with the InstancedMeshes — do not dispose
    this.game.scene.remove(d.group);
  }

  update(dt) {
    const parts = this.game.particles;

    for (const gz of this.geysers) {
      gz.t -= dt;
      if (parts && gz.t > 0) parts.geyser(gz.x, gz.y, gz.z, clamp(gz.t / GEYSER_TIME, 0.25, 1));
    }
    this.geysers = this.geysers.filter((gz) => gz.t > 0);

    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.t += dt;

      if (d.sink > 0) {
        d.sink += dt;
        d.group.position.y -= dt * 0.7;
        if (d.sink > 2.2) { this.disposeDebris(d); this.debris.splice(i, 1); }
        continue;
      }

      if (d.mode === 'fall') {
        // hinge-fall about the base until the pole lies flat
        if (d.angle < Math.PI / 2 - 0.03) {
          d.angVel += dt * 3.2;
          d.angle = Math.min(Math.PI / 2 - 0.02, d.angle + d.angVel * dt);
          d.group.quaternion.setFromAxisAngle(d.axis, d.angle).multiply(d.yawQ);
          if (d.angle >= Math.PI / 2 - 0.03) {
            // the pole tip lands at base + 5*(-axis.z, axis.x)
            parts?.sparks(d.group.position.x - d.axis.z * 5, d.groundY + 0.3, d.group.position.z + d.axis.x * 5, 8);
            this.game.cameraRig?.addShake(0.15);
          }
        } else if (d.t > 6) d.sink = 0.001;
      } else {
        // free tumble with one ground bounce
        d.vel.y -= 18 * dt;
        d.group.position.addScaledVector(d.vel, dt);
        const q = new THREE.Quaternion().setFromAxisAngle(d.spin.clone().normalize(), d.spin.length() * dt);
        d.group.quaternion.premultiply(q);
        if (d.group.position.y < d.groundY) {
          d.group.position.y = d.groundY;
          if (Math.abs(d.vel.y) > 1.5) {
            d.vel.y *= -0.3;
            d.vel.x *= 0.55; d.vel.z *= 0.55;
            d.spin.multiplyScalar(0.5);
          } else {
            d.vel.set(0, 0, 0);
            d.spin.set(0, 0, 0);
            d.settle += dt;
            if (d.settle > 5) d.sink = 0.001;
          }
        }
      }
    }
  }
}
