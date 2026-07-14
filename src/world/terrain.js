// Terrain mesh (displaced plane textured by the painted ground canvas),
// water planes and the night-sky star field.

import * as THREE from 'three';
import { makeGroundCanvas } from './textures.js';
import { lerp } from '../core/mathutil.js';

export function buildTerrain(city, scene, assets = null) {
  const { SPAN, HALF, WATER_Y } = city;

  // ---- ground ----
  const segs = 200;
  const geo = new THREE.PlaneGeometry(SPAN, SPAN, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, city.groundHeight(x, z));
  }
  geo.computeVertexNormals();

  const groundCanvas = makeGroundCanvas(city, 4096);
  const groundTex = new THREE.CanvasTexture(groundCanvas);
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = 8;
  // painted canvas stays the colour layer; a tiled asphalt normal map adds
  // fine surface response to sun/headlights when assets are present
  let mat;
  const asphalt = assets?.textureSet('asphalt');
  if (asphalt?.normalMap) {
    const nrm = asphalt.normalMap.clone();
    nrm.wrapS = nrm.wrapT = THREE.RepeatWrapping;
    nrm.repeat.set(SPAN / 6, SPAN / 6);
    nrm.needsUpdate = true;
    mat = new THREE.MeshStandardMaterial({
      map: groundTex, normalMap: nrm,
      normalScale: new THREE.Vector2(0.12, 0.12),   // fine grain, not boulders
      roughness: 0.94, metalness: 0,
    });
  } else {
    mat = new THREE.MeshLambertMaterial({ map: groundTex });
  }
  const ground = new THREE.Mesh(geo, mat);
  ground.receiveShadow = true;
  ground.name = 'terrain';
  scene.add(ground);

  // ---- water: normal-mapped, scrolling, with specular sun glint ----
  const waterNormal = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    // encode gentle wave normals: mostly +z (128,128,255) with soft ripples
    const img = ctx.createImageData(256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        const nx = Math.sin(x * 0.18 + y * 0.07) * 22 + Math.sin(x * 0.045 - y * 0.11) * 14;
        const ny = Math.cos(x * 0.09 - y * 0.16) * 22 + Math.sin(y * 0.05 + x * 0.12) * 14;
        img.data[i] = 128 + nx;
        img.data[i + 1] = 128 + ny;
        img.data[i + 2] = 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(140, 140);
    return t;
  })();
  const waterMat = new THREE.MeshPhongMaterial({
    color: 0x2e6485, transparent: true, opacity: 0.88,
    shininess: 220, specular: 0x88aabb,
    normalMap: waterNormal, normalScale: new THREE.Vector2(0.55, 0.55),
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(SPAN * 3, SPAN * 3), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_Y;
  water.name = 'water';
  scene.add(water);

  // deep ocean colour under the shallow plane so the horizon reads dark
  const deep = new THREE.Mesh(
    new THREE.PlaneGeometry(SPAN * 3, SPAN * 3),
    new THREE.MeshBasicMaterial({ color: 0x16374e })
  );
  deep.rotation.x = -Math.PI / 2;
  deep.position.y = WATER_Y - 1.5;
  scene.add(deep);

  // ---- drifting billboard clouds ----
  const cloudGroup = new THREE.Group();
  {
    const cc = document.createElement('canvas');
    cc.width = cc.height = 128;
    const cctx = cc.getContext('2d');
    const grad = cctx.createRadialGradient(64, 64, 8, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.4)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    cctx.fillStyle = grad;
    cctx.fillRect(0, 0, 128, 128);
    const cloudTex = new THREE.CanvasTexture(cc);
    for (let i = 0; i < 18; i++) {
      const mat = new THREE.SpriteMaterial({
        map: cloudTex, transparent: true, opacity: 0.35 + Math.random() * 0.3, depthWrite: false,
      });
      mat.userData.baseOpacity = mat.opacity;
      const spr = new THREE.Sprite(mat);
      const sc = 180 + Math.random() * 260;
      spr.scale.set(sc, sc * 0.38, 1);
      spr.position.set((Math.random() - 0.5) * SPAN * 2, 250 + Math.random() * 130, (Math.random() - 0.5) * SPAN * 2);
      cloudGroup.add(spr);
    }
    scene.add(cloudGroup);
  }

  // ---- stars (visible at night) ----
  const starGeo = new THREE.BufferGeometry();
  const starCount = 700;
  const positions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI * 0.48;
    const r = 2600;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi) + 80;
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xdde6ff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.name = 'stars';
  scene.add(stars);

  return {
    ground, water, stars,
    update(dt, t) {
      // gentle shimmer + two-direction normal scroll
      waterMat.opacity = 0.85 + Math.sin(t * 0.8) * 0.03;
      waterNormal.offset.set(t * 0.008, t * 0.0045);
      // clouds drift east, wrapping around the island
      for (const c of cloudGroup.children) {
        c.position.x += dt * 3.5;
        if (c.position.x > SPAN * 1.4) c.position.x = -SPAN * 1.4;
      }
    },
    setStarAlpha(a) { starMat.opacity = a; },
    // weather hooks
    setCloudCover(cover, rain = 0) {
      const tint = 1 - rain * 0.55;
      for (const c of cloudGroup.children) {
        c.material.opacity = c.material.userData.baseOpacity * (0.5 + cover * 1.7);
        c.material.color.setScalar(tint);
      }
    },
    setWet(t) {
      // rain glosses the streets: tighter reflections + stronger env pickup
      if (mat.roughness !== undefined) {
        mat.roughness = lerp(0.94, 0.42, t);
        mat.envMapIntensity = lerp(1, 2.1, t);
      }
    },
  };
}
