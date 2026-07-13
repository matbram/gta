// Graphics manager: tone mapping, post-processing chain (bloom + FXAA),
// quality presets with automatic degradation, environment map plumbing.

import * as THREE from 'three';
import { EffectComposer } from '../../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../../vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/jsm/postprocessing/OutputPass.js';
import { FXAAPass } from '../../vendor/jsm/postprocessing/FXAAPass.js';

export const QUALITY = {
  low: { post: false, shadow: 1024, pixelRatio: 1, bloom: 0 },
  medium: { post: true, shadow: 2048, pixelRatio: 1.5, bloom: 0.35 },
  high: { post: true, shadow: 4096, pixelRatio: 2, bloom: 0.5 },
};

export class Graphics {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.composer = null;
    this.quality = null;
    this.sunLight = null;          // set by daynight for shadow-res control
    this.pmrem = new THREE.PMREMGenerator(renderer);

    // fps tracking for auto-degrade
    this.fpsAccum = 0;
    this.fpsFrames = 0;
    this.fpsAvg = 60;
    this.lastDropT = 0;
    this.autoDrop = true;

    let saved = null;
    try { saved = localStorage.getItem('bayvale-quality'); } catch {}
    this.setQuality(saved && QUALITY[saved] ? saved : 'high');
  }

  buildComposer() {
    const q = QUALITY[this.quality];
    this.disposeComposer();
    if (!q.post) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloomPass = new UnrealBloomPass(size, q.bloom, 0.5, 0.82);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.fxaaPass = new FXAAPass();
    this.composer.addPass(this.fxaaPass);
  }

  disposeComposer() {
    if (this.composer) {
      // EffectComposer.dispose() only frees its render targets, not the passes;
      // dispose each pass's own GPU resources (bloom render targets, FXAA
      // fsquad material, etc.) so quality changes don't leak.
      for (const pass of this.composer.passes || []) pass.dispose?.();
      this.composer.dispose?.();
      this.composer = null;
    }
  }

  setQuality(name) {
    if (!QUALITY[name] || this.quality === name) return;
    this.quality = name;
    const q = QUALITY[name];
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, q.pixelRatio));
    if (this.sunLight) {
      this.sunLight.shadow.mapSize.set(q.shadow, q.shadow);
      this.sunLight.shadow.map?.dispose();
      this.sunLight.shadow.map = null;
    }
    this.buildComposer();
    try { localStorage.setItem('bayvale-quality', name); } catch {}
  }

  // night boost: emissives glow more after dark
  setBloomStrength(mult) {
    const q = QUALITY[this.quality];
    if (this.bloomPass) this.bloomPass.strength = q.bloom * mult;
  }

  setExposure(v) { this.renderer.toneMappingExposure = v; }

  registerSun(light) {
    this.sunLight = light;
    const q = QUALITY[this.quality];
    light.shadow.mapSize.set(q.shadow, q.shadow);
  }

  // HDRI/env plumbing (textures arrive in the asset phase)
  setEnvironmentFromEquirect(texture, intensity = 1) {
    const env = this.pmrem.fromEquirectangular(texture);
    texture.dispose();
    this.scene.environment = env.texture;
    this.scene.environmentIntensity = intensity;
    return env.texture;
  }

  setEnvironmentIntensity(v) {
    this.scene.environmentIntensity = v;
  }

  resize(w, h) {
    this.composer?.setSize(w, h);
  }

  render(dt) {
    // fps averaging → auto quality drop
    if (this.autoDrop && dt > 0) {
      this.fpsAccum += dt;
      this.fpsFrames++;
      if (this.fpsAccum >= 3) {
        this.fpsAvg = this.fpsFrames / this.fpsAccum;
        this.fpsAccum = 0;
        this.fpsFrames = 0;
        const now = performance.now() / 1000;
        if (this.fpsAvg < 28 && now - this.lastDropT > 10) {
          this.lastDropT = now;
          if (this.quality === 'high') this.setQuality('medium');
          else if (this.quality === 'medium') this.setQuality('low');
        }
      }
    }

    if (this.composer) {
      this.renderPass.camera = this.camera;
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}
