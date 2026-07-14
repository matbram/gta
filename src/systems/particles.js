// Pooled particle system: two THREE.Points clouds (soft smoke + additive glow),
// each a single draw call. CPU-simulated, GPU-rendered.

import * as THREE from 'three';

const MAX = 900;

const VERT = `
  attribute float size;
  attribute float alpha;
  attribute vec3 pcolor;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = alpha;
    vColor = pcolor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (240.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const FRAG = `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float soft = smoothstep(0.5, 0.05, d);
    gl_FragColor = vec4(vColor, vAlpha * soft);
  }
`;

class Cloud {
  constructor(scene, blending) {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 3);
    this.size = new Float32Array(MAX);
    this.alpha = new Float32Array(MAX);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // particle state
    this.p = [];
    for (let i = 0; i < MAX; i++) {
      this.p.push({ live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, s0: 1, s1: 1, a0: 1, r: 0, g: 0, b: 0, grav: 0, drag: 1 });
      this.alpha[i] = 0;
      this.pos[i * 3 + 1] = -1000;
    }
    this.cursor = 0;
  }

  emit(opts) {
    const P = this.p[this.cursor];
    this.cursor = (this.cursor + 1) % MAX;
    Object.assign(P, {
      live: true, life: 0,
      x: opts.x, y: opts.y, z: opts.z,
      vx: opts.vx || 0, vy: opts.vy || 0, vz: opts.vz || 0,
      maxLife: opts.life || 1,
      s0: opts.s0 ?? 1, s1: opts.s1 ?? 2,
      a0: opts.a ?? 0.8,
      r: opts.r, g: opts.g, b: opts.b,
      grav: opts.grav ?? 0, drag: opts.drag ?? 1,
    });
  }

  update(dt) {
    for (let i = 0; i < MAX; i++) {
      const P = this.p[i];
      if (!P.live) continue;
      P.life += dt;
      if (P.life >= P.maxLife) {
        P.live = false;
        this.alpha[i] = 0;
        this.pos[i * 3 + 1] = -1000;
        continue;
      }
      const t = P.life / P.maxLife;
      P.vy += P.grav * dt;
      const drag = Math.pow(P.drag, dt * 60);
      P.vx *= drag; P.vy *= drag; P.vz *= drag;
      P.x += P.vx * dt; P.y += P.vy * dt; P.z += P.vz * dt;
      this.pos[i * 3] = P.x; this.pos[i * 3 + 1] = P.y; this.pos[i * 3 + 2] = P.z;
      this.col[i * 3] = P.r; this.col[i * 3 + 1] = P.g; this.col[i * 3 + 2] = P.b;
      this.size[i] = P.s0 + (P.s1 - P.s0) * t;
      this.alpha[i] = P.a0 * (1 - t);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.pcolor.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }
}

export class ParticleSystem {
  constructor(game) {
    this.game = game;
    this.smoke = new Cloud(game.scene, THREE.NormalBlending);
    this.glow = new Cloud(game.scene, THREE.AdditiveBlending);
  }

  update(dt) {
    this.smoke.update(dt);
    this.glow.update(dt);

    // muzzle light decay
    if (this._mLight && this._mLightT > 0) {
      this._mLightT -= dt;
      this._mLight.intensity = this._mLightT > 0 ? this._mLight.intensity * 0.7 : 0;
      if (this._mLightT <= 0) this._mLight.intensity = 0;
    }

    // tracers fade fast then return to the pool
    if (this._tracers) {
      for (const tr of this._tracers) {
        tr.t += dt;
        tr.line.material.opacity = Math.max(0, 0.85 - tr.t * 12);
        if (tr.t > 0.07) { tr.line.visible = false; this._tracerPool.push(tr.line); tr._done = true; }
      }
      if (this._tracers.some((t) => t._done)) this._tracers = this._tracers.filter((t) => !t._done);
    }

    // shell physics
    if (this._shells) {
      const d = this._shellDummy;
      let any = false;
      for (let i = 0; i < this._shells.length; i++) {
        const s = this._shells[i];
        if (!s.live) { d.position.set(0, -100, 0); d.updateMatrix(); this._shellMesh.setMatrixAt(i, d.matrix); continue; }
        any = true;
        s.t += dt;
        s.vy -= 16 * dt;
        s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
        const gy = this.game.city.groundHeight(s.x, s.z) + 0.02;
        if (s.y <= gy) { s.y = gy; s.vy *= -0.3; s.vx *= 0.5; s.vz *= 0.5; if (s.t > 4) s.live = false; }
        s.rot += dt * 8;
        d.position.set(s.x, s.y, s.z);
        d.rotation.set(s.rot, s.rot * 0.7, 1.2);
        d.scale.setScalar(1);
        d.updateMatrix();
        this._shellMesh.setMatrixAt(i, d.matrix);
      }
      if (any) this._shellMesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------- effect recipes ----------
  puffSmoke(x, y, z, dark = 0.35, n = 1) {
    for (let i = 0; i < n; i++) {
      this.smoke.emit({
        x: x + (Math.random() - 0.5) * 0.5, y, z: z + (Math.random() - 0.5) * 0.5,
        vx: (Math.random() - 0.5) * 0.6, vy: 1 + Math.random() * 1.2, vz: (Math.random() - 0.5) * 0.6,
        life: 1.4 + Math.random(), s0: 0.9, s1: 3.2, a: 0.42,
        r: dark, g: dark, b: dark, drag: 0.985,
      });
    }
  }

  dust(x, y, z, n = 3) {
    for (let i = 0; i < n; i++) {
      this.smoke.emit({
        x, y: y + 0.1, z,
        vx: (Math.random() - 0.5) * 2.4, vy: 0.5 + Math.random(), vz: (Math.random() - 0.5) * 2.4,
        life: 0.5 + Math.random() * 0.4, s0: 0.5, s1: 1.8, a: 0.3,
        r: 0.62, g: 0.58, b: 0.5, drag: 0.94,
      });
    }
  }

  sparks(x, y, z, n = 8) {
    for (let i = 0; i < n; i++) {
      this.glow.emit({
        x, y, z,
        vx: (Math.random() - 0.5) * 7, vy: Math.random() * 5, vz: (Math.random() - 0.5) * 7,
        life: 0.3 + Math.random() * 0.3, s0: 0.35, s1: 0.1, a: 1,
        r: 1, g: 0.8, b: 0.35, grav: -14, drag: 0.98,
      });
    }
  }

  blood(x, y, z, n = 7) {
    for (let i = 0; i < n; i++) {
      this.smoke.emit({
        x, y, z,
        vx: (Math.random() - 0.5) * 3.2, vy: Math.random() * 2.6, vz: (Math.random() - 0.5) * 3.2,
        life: 0.45 + Math.random() * 0.3, s0: 0.28, s1: 0.7, a: 0.85,
        r: 0.5, g: 0.05, b: 0.04, grav: -9, drag: 0.97,
      });
    }
  }

  muzzleFlash(x, y, z, dirX, dirZ) {
    this.glow.emit({
      x: x + dirX * 0.4, y, z: z + dirZ * 0.4,
      vx: dirX * 2, vy: 0, vz: dirZ * 2,
      life: 0.08, s0: 1.1, s1: 0.3, a: 1,
      r: 1, g: 0.85, b: 0.4,
    });
  }

  // brief point-light flash at the muzzle (pooled, one shared light)
  muzzleLight(x, y, z) {
    if (!this._mLight) {
      this._mLight = new THREE.PointLight(0xffddaa, 0, 22, 2);
      this.game.scene.add(this._mLight);
      this._mLightT = 0;
    }
    this._mLight.position.set(x, y, z);
    this._mLight.intensity = 6;
    this._mLightT = 0.06;
  }

  // glowing tracer line from muzzle to impact
  tracer(x0, y0, z0, x1, y1, z1) {
    if (!this._tracers) {
      this._tracerPool = [];
      this._tracers = [];
      const mat = new THREE.LineBasicMaterial({ color: 0xffe6a0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
      for (let i = 0; i < 24; i++) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const line = new THREE.Line(geo, mat.clone());
        line.frustumCulled = false;
        line.visible = false;
        this.game.scene.add(line);
        this._tracerPool.push(line);
      }
    }
    const line = this._tracerPool.pop();
    if (!line) return;
    const pos = line.geometry.attributes.position.array;
    pos[0] = x0; pos[1] = y0; pos[2] = z0;
    pos[3] = x1; pos[4] = y1; pos[5] = z1;
    line.geometry.attributes.position.needsUpdate = true;
    line.material.opacity = 0.85;
    line.visible = true;
    this._tracers.push({ line, t: 0 });
  }

  // ejected brass shell (pooled instanced)
  shell(x, y, z, heading) {
    if (!this._shells) {
      const geo = new THREE.CylinderGeometry(0.02, 0.02, 0.07, 5);
      const mat = new THREE.MeshStandardMaterial({ color: 0xc8a848, metalness: 0.8, roughness: 0.4 });
      this._shellMesh = new THREE.InstancedMesh(geo, mat, 30);
      this._shellMesh.frustumCulled = false;
      this.game.scene.add(this._shellMesh);
      this._shells = [];
      this._shellCursor = 0;
      for (let i = 0; i < 30; i++) this._shells.push({ x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0, rot: 0, live: false });
      this._shellDummy = new THREE.Object3D();
    }
    const s = this._shells[this._shellCursor];
    this._shellCursor = (this._shellCursor + 1) % 30;
    const rx = Math.cos(heading), rz = -Math.sin(heading);   // eject to the right
    s.x = x; s.y = y; s.z = z;
    s.vx = rx * 2 + (Math.random() - 0.5); s.vy = 1.5 + Math.random(); s.vz = rz * 2 + (Math.random() - 0.5);
    s.rot = Math.random() * 6; s.live = true; s.t = 0;
  }

  fire(x, y, z, n = 2) {
    for (let i = 0; i < n; i++) {
      this.glow.emit({
        x: x + (Math.random() - 0.5) * 0.9, y, z: z + (Math.random() - 0.5) * 0.9,
        vx: (Math.random() - 0.5) * 0.5, vy: 2 + Math.random() * 2, vz: (Math.random() - 0.5) * 0.5,
        life: 0.5 + Math.random() * 0.4, s0: 1.4, s1: 0.4, a: 0.9,
        r: 1, g: 0.45 + Math.random() * 0.3, b: 0.1, drag: 0.97,
      });
    }
  }

  explosion(x, y, z) {
    for (let i = 0; i < 26; i++) {
      this.glow.emit({
        x, y: y + 0.5, z,
        vx: (Math.random() - 0.5) * 16, vy: Math.random() * 11, vz: (Math.random() - 0.5) * 16,
        life: 0.5 + Math.random() * 0.5, s0: 2.2, s1: 0.4, a: 1,
        r: 1, g: 0.5 + Math.random() * 0.4, b: 0.15, grav: -6, drag: 0.96,
      });
    }
    for (let i = 0; i < 18; i++) {
      this.smoke.emit({
        x, y: y + 1, z,
        vx: (Math.random() - 0.5) * 6, vy: 2 + Math.random() * 5, vz: (Math.random() - 0.5) * 6,
        life: 1.8 + Math.random() * 1.4, s0: 2.2, s1: 7, a: 0.55,
        r: 0.16, g: 0.15, b: 0.14, drag: 0.985,
      });
    }
    this.sparks(x, y + 0.5, z, 16);
  }

  // firefighter hose arc
  waterJet(x, y, z, dirX, dirZ) {
    for (let i = 0; i < 3; i++) {
      this.smoke.emit({
        x, y, z,
        vx: dirX * (7 + Math.random() * 3) + (Math.random() - 0.5) * 1.2,
        vy: 2.2 + Math.random() * 1.2,
        vz: dirZ * (7 + Math.random() * 3) + (Math.random() - 0.5) * 1.2,
        life: 0.7 + Math.random() * 0.3, s0: 0.3, s1: 1.1, a: 0.7,
        r: 0.68, g: 0.82, b: 0.95, grav: -13, drag: 0.99,
      });
    }
  }

  waterSplash(x, y, z) {
    for (let i = 0; i < 12; i++) {
      this.smoke.emit({
        x, y, z,
        vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 3, vz: (Math.random() - 0.5) * 4,
        life: 0.6 + Math.random() * 0.4, s0: 0.5, s1: 1.6, a: 0.7,
        r: 0.75, g: 0.85, b: 0.92, grav: -10, drag: 0.97,
      });
    }
  }

  // shattered glass on a hard crash: glittering shards
  glassBurst(x, y, z) {
    for (let i = 0; i < 14; i++) {
      this.glow.emit({
        x, y, z,
        vx: (Math.random() - 0.5) * 6, vy: 1.5 + Math.random() * 4, vz: (Math.random() - 0.5) * 6,
        life: 0.4 + Math.random() * 0.35, s0: 0.16, s1: 0.05, a: 0.9,
        r: 0.8, g: 0.9, b: 1.0, grav: -16, drag: 0.98,
      });
    }
  }

  // rubber skid marks: ring-buffer of dark ground quads
  skid(x, z, heading) {
    if (!this._skidPool) {
      const geo = new THREE.PlaneGeometry(0.24, 1.0);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x0c0c0e, transparent: true, opacity: 0.4, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2,
      });
      this._skidPool = new THREE.InstancedMesh(geo, mat, 220);
      this._skidPool.frustumCulled = false;
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < 220; i++) this._skidPool.setMatrixAt(i, zero);
      this._skidIdx = 0;
      this._skidDummy = new THREE.Object3D();
      this.game.scene.add(this._skidPool);
    }
    if (this.game.time - (this._skidT ?? -1) < 0.045) return;
    this._skidT = this.game.time;
    const g = this.game.city.groundHeight(x, z);
    // two stripes, one per rear tyre
    const rx = Math.cos(heading) * 0.72, rz = -Math.sin(heading) * 0.72;
    for (const s of [-1, 1]) {
      this._skidDummy.position.set(x + rx * s, g + 0.025, z + rz * s);
      this._skidDummy.rotation.set(0, heading, 0);
      this._skidDummy.scale.set(1, 1, 1);
      this._skidDummy.updateMatrix();
      this._skidPool.setMatrixAt(this._skidIdx % 220, this._skidDummy.matrix);
      this._skidIdx++;
    }
    this._skidPool.instanceMatrix.needsUpdate = true;
  }

  // broken-hydrant water column — call every frame while the geyser is live
  geyser(x, y, z, strength = 1) {
    for (let i = 0; i < 4; i++) {
      this.smoke.emit({
        x: x + (Math.random() - 0.5) * 0.25, y, z: z + (Math.random() - 0.5) * 0.25,
        vx: (Math.random() - 0.5) * 1.8,
        vy: (8 + Math.random() * 4.5) * strength,
        vz: (Math.random() - 0.5) * 1.8,
        life: 0.9 + Math.random() * 0.4, s0: 0.3, s1: 1.3, a: 0.75,
        r: 0.68, g: 0.82, b: 0.95, grav: -15, drag: 0.995,
      });
    }
  }
}
