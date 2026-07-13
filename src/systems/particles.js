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
}
