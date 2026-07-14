// Real sky: gradient dome shader, a visible sun disc with glow + streak
// flare, a cratered moon with live phases, and a tiny offscreen dome scene
// that PMREM-bakes the procedural sky into scene.environment (replacing the
// static HDRIs). Colours are driven per-frame by the day/night cycle.

import * as THREE from 'three';
import { clamp, lerp } from '../core/mathutil.js';

const DOME_R = 2750;

function makeGlowSprite(size, inner, mid) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(size / 2, size / 2, size * 0.02, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, mid);
  g.addColorStop(1, 'rgba(255,200,120,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  return new THREE.SpriteMaterial({
    map: tex, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, depthTest: false,
  });
}

function paintMoon(canvas, phase) {
  // phase 0..1: 0 new, 0.5 full
  const S = canvas.width;
  const x = canvas.getContext('2d');
  x.clearRect(0, 0, S, S);
  x.fillStyle = '#d9dce2';
  x.beginPath(); x.arc(S / 2, S / 2, S * 0.46, 0, 7); x.fill();
  // craters
  x.fillStyle = 'rgba(148,153,164,0.8)';
  const craters = [[0.36, 0.4, 0.09], [0.62, 0.3, 0.06], [0.55, 0.62, 0.11], [0.3, 0.66, 0.05], [0.68, 0.52, 0.045], [0.45, 0.24, 0.05]];
  for (const [cx, cy, r] of craters) {
    x.beginPath(); x.arc(cx * S, cy * S, r * S, 0, 7); x.fill();
  }
  x.fillStyle = 'rgba(120,126,138,0.5)';
  x.beginPath(); x.arc(S * 0.5, S * 0.55, S * 0.16, 0, 7); x.fill();
  // phase shadow: offset dark disc
  const lit = Math.sin(phase * Math.PI);         // 0 new → 1 full → 0 new
  if (lit < 0.98) {
    const off = (1 - lit) * S * 0.7 * (phase < 0.5 ? 1 : -1);
    x.globalCompositeOperation = 'destination-out';
    x.beginPath(); x.arc(S / 2 + off, S / 2, S * 0.46, 0, 7); x.fill();
    x.globalCompositeOperation = 'source-over';
  }
}

function domeMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uSunDir;
      uniform float uWarm;        // sunrise/sunset amount 0..1
      uniform float uNight;       // 0 day → 1 night
      uniform float uCloud;       // overcast amount 0..1
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float up = max(d.y, 0.0);
        vec3 col = mix(uHorizon, uZenith, pow(up, 0.48));
        // warm band hugging the horizon on the sun's side
        float sunSide = max(dot(normalize(d.xz), normalize(uSunDir.xz + vec2(1e-4))), 0.0);
        float band = exp(-abs(d.y) * 5.5) * (0.35 + 0.65 * sunSide * sunSide);
        col = mix(col, vec3(1.0, 0.52, 0.26), band * uWarm * 0.8);
        // sun halo (disc mesh sits on top; this is atmosphere glow)
        float cosSun = max(dot(d, uSunDir), 0.0);
        float halo = pow(cosSun, 24.0) * 0.35 + pow(cosSun, 260.0) * 0.9;
        col += vec3(1.0, 0.86, 0.62) * halo * (1.0 - uNight) * (1.0 - uCloud * 0.75);
        // overcast flattens everything toward grey
        vec3 grey = mix(vec3(0.52, 0.55, 0.59), vec3(0.06, 0.065, 0.08), uNight);
        col = mix(col, grey * (0.75 + 0.25 * up), uCloud * 0.85);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export class SkyDome {
  constructor(scene) {
    this.scene = scene;
    this.uniforms = {
      uZenith: { value: new THREE.Color(0x8ec2e8) },
      uHorizon: { value: new THREE.Color(0xbcd4e4) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uWarm: { value: 0 },
      uNight: { value: 0 },
      uCloud: { value: 0 },
    };
    const mat = domeMaterial(this.uniforms);
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_R, 28, 14), mat);
    this.dome.name = 'skydome';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -100;
    scene.add(this.dome);

    // --- sun disc + flare sprites ---
    this.sunDisc = new THREE.Mesh(
      new THREE.CircleGeometry(52, 24),
      new THREE.MeshBasicMaterial({ color: 0xfff6d8, fog: false, transparent: true, opacity: 1 }),
    );
    this.sunDisc.name = 'sundisc';
    scene.add(this.sunDisc);
    this.sunGlow = new THREE.Sprite(makeGlowSprite(256, 'rgba(255,244,214,0.9)', 'rgba(255,196,110,0.32)'));
    this.sunGlow.scale.set(520, 520, 1);
    scene.add(this.sunGlow);
    this.sunStreak = new THREE.Sprite(makeGlowSprite(256, 'rgba(255,240,210,0.55)', 'rgba(255,200,130,0.15)'));
    this.sunStreak.scale.set(1500, 60, 1);
    scene.add(this.sunStreak);

    // --- moon with painted phases ---
    this.moonCanvas = document.createElement('canvas');
    this.moonCanvas.width = this.moonCanvas.height = 128;
    this.moonPhase = -1;
    this.moonTex = new THREE.CanvasTexture(this.moonCanvas);
    this.moonDisc = new THREE.Mesh(
      new THREE.CircleGeometry(40, 24),
      new THREE.MeshBasicMaterial({ map: this.moonTex, fog: false, transparent: true, opacity: 0.95 }),
    );
    this.moonDisc.name = 'moondisc';
    scene.add(this.moonDisc);

    // --- offscreen env scene: dome + dark ground bowl, PMREM-baked ---
    this.envScene = new THREE.Scene();
    this.envDome = new THREE.Mesh(this.dome.geometry, mat);
    this.envScene.add(this.envDome);
    const bowl = new THREE.Mesh(
      new THREE.CircleGeometry(DOME_R * 0.98, 20),
      new THREE.MeshBasicMaterial({ color: 0x2a2c2e, side: THREE.DoubleSide }),
    );
    bowl.rotation.x = -Math.PI / 2;
    bowl.position.y = -12;
    this.envScene.add(bowl);
    this._envRT = null;
    this._envKey = null;
  }

  // sunDir: normalized direction TOWARD the sun; day: game day index for moon phase
  update(focus, sunDir, { warm = 0, night = 0, cloud = 0, day = 0 } = {}) {
    const U = this.uniforms;
    U.uSunDir.value.copy(sunDir);
    U.uWarm.value = warm;
    U.uNight.value = night;
    U.uCloud.value = cloud;

    this.dome.position.set(focus.x, 0, focus.z);

    // sun disc + flare
    const sunUp = sunDir.y > -0.03;
    const sp = this.sunDisc.position;
    sp.set(focus.x + sunDir.x * (DOME_R - 220), sunDir.y * (DOME_R - 220), focus.z + sunDir.z * (DOME_R - 220));
    this.sunDisc.visible = sunUp;
    this.sunDisc.lookAt(focus.x, 0, focus.z);
    const flareA = clamp(sunDir.y * 4, 0, 1) * (1 - night) * (1 - cloud * 0.9);
    this.sunGlow.visible = this.sunStreak.visible = sunUp && flareA > 0.02;
    this.sunGlow.position.copy(sp);
    this.sunStreak.position.copy(sp);
    this.sunGlow.material.opacity = flareA;
    this.sunStreak.material.opacity = flareA * 0.5;
    // the disc itself dims out as dusk deepens (flare fades separately)
    this.sunDisc.material.opacity =
      (1 - cloud * 0.85) * clamp(1 - (night - 0.18) * 3.2, 0, 1);

    // moon opposite the sun, phase advances daily
    const md = this.moonDisc.position;
    md.set(focus.x - sunDir.x * (DOME_R - 260), -sunDir.y * (DOME_R - 260), focus.z - sunDir.z * (DOME_R - 260));
    this.moonDisc.visible = -sunDir.y > -0.02;
    this.moonDisc.lookAt(focus.x, 0, focus.z);
    this.moonDisc.material.opacity = clamp(0.35 + night * 0.65, 0, 1) * (1 - cloud * 0.8);
    const phase = ((day % 8) / 8 + 0.5) % 1;     // 8-day lunar cycle, starts full-ish
    const bucket = Math.round(phase * 16) / 16;
    if (bucket !== this.moonPhase) {
      this.moonPhase = bucket;
      paintMoon(this.moonCanvas, bucket);
      this.moonTex.needsUpdate = true;
    }
  }

  setSkyColors(zenith, horizon) {
    this.uniforms.uZenith.value.copy(zenith);
    this.uniforms.uHorizon.value.copy(horizon);
  }

  // bake the dome into scene.environment when the look changes enough
  refreshEnv(gfx, key) {
    if (key === this._envKey) return false;
    this._envKey = key;
    const old = this._envRT;
    // sigma 0: the dome is already a smooth gradient, and any blur sigma
    // runs a huge convolution that stalls the frame (the periodic hitch)
    this._envRT = gfx.pmrem.fromScene(this.envScene, 0, 1, DOME_R * 2);
    this.scene.environment = this._envRT.texture;
    old?.dispose();
    return true;
  }
}
