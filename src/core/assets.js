// Asset registry: loads the fetched GLB/GLTF models, PBR textures and HDRIs
// listed in assets/manifest.json. Every accessor degrades gracefully — if a
// file is missing the game falls back to its procedural equivalent.

import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from '../../vendor/jsm/loaders/DRACOLoader.js';
import { RGBELoader } from '../../vendor/jsm/loaders/RGBELoader.js';
import { clone as skeletonClone } from '../../vendor/jsm/utils/SkeletonUtils.js';

export class Assets {
  constructor() {
    this.models = new Map();      // key → { scene, animations }
    this.textureSets = new Map(); // key → { map, normalMap, roughnessMap }
    this.hdris = new Map();       // key → DataTexture (equirect)
    this.manifest = null;

    this.gltfLoader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('./vendor/draco/');
    this.gltfLoader.setDRACOLoader(draco);
    this.rgbeLoader = new RGBELoader();
    this.texLoader = new THREE.TextureLoader();
  }

  async load(onProgress = () => {}) {
    try {
      const res = await fetch('./assets/manifest.json');
      if (!res.ok) throw new Error('no manifest');
      this.manifest = await res.json();
    } catch {
      console.warn('[assets] no manifest — running fully procedural');
      return this;
    }

    const jobs = [];
    const modelKeys = Object.keys(this.manifest.models || {});
    let done = 0;
    const total = modelKeys.length + (this.manifest.textures?.length || 0) + (this.manifest.hdri?.length || 0);
    const tick = () => onProgress(++done / Math.max(total, 1));

    for (const key of modelKeys) {
      jobs.push(this.gltfLoader.loadAsync('./' + this.manifest.models[key])
        .then((g) => { this.models.set(key, { scene: g.scene, animations: g.animations }); })
        .catch((e) => console.warn('[assets] model failed:', key, e.message))
        .finally(tick));
    }
    for (const name of this.manifest.textures || []) {
      jobs.push(this.loadTextureSet(name).finally(tick));
    }
    for (const name of this.manifest.hdri || []) {
      jobs.push(this.rgbeLoader.loadAsync(`./assets/hdri/${name}.hdr`)
        .then((t) => { t.mapping = THREE.EquirectangularReflectionMapping; this.hdris.set(name, t); })
        .catch((e) => console.warn('[assets] hdri failed:', name, e.message))
        .finally(tick));
    }
    await Promise.all(jobs);
    console.log(`[assets] loaded ${this.models.size} models, ${this.textureSets.size} texture sets, ${this.hdris.size} hdris`);
    return this;
  }

  async loadTextureSet(name) {
    const base = `./assets/textures/${name}/`;
    const set = {};
    const tryTex = async (file, key, srgb) => {
      try {
        const t = await this.texLoader.loadAsync(base + file);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        set[key] = t;
      } catch {}
    };
    await Promise.all([
      tryTex('color.jpg', 'map', true),
      tryTex('normal.jpg', 'normalMap', false),
      tryTex('rough.jpg', 'roughnessMap', false),
    ]);
    if (set.map) this.textureSets.set(name, set);
  }

  has(key) { return this.models.has(key); }

  // fresh clone of a static model (shared materials by default)
  model(key, { recolorables = null } = {}) {
    const entry = this.models.get(key);
    if (!entry) return null;
    const c = entry.scene.clone(true);
    return c;
  }

  // clone preserving skinned meshes + bones; returns { scene, animations }
  skinned(key) {
    const entry = this.models.get(key);
    if (!entry) return null;
    return { scene: skeletonClone(entry.scene), animations: entry.animations };
  }

  animations(key) { return this.models.get(key)?.animations ?? []; }

  // build a MeshStandardMaterial from a fetched PBR set
  pbrMaterial(name, { repeat = 1, color = 0xffffff, roughness = 1, metalness = 0 } = {}) {
    const set = this.textureSets.get(name);
    if (!set) return null;
    const mat = new THREE.MeshStandardMaterial({
      color, roughness, metalness,
      map: set.map.clone(),
      normalMap: set.normalMap ? set.normalMap.clone() : null,
      roughnessMap: set.roughnessMap ? set.roughnessMap.clone() : null,
    });
    for (const t of [mat.map, mat.normalMap, mat.roughnessMap]) {
      if (t) { t.repeat.set(repeat, repeat); t.needsUpdate = true; }
    }
    return mat;
  }

  textureSet(name) { return this.textureSets.get(name) ?? null; }
  hdri(name) { return this.hdris.get(name) ?? null; }
}
