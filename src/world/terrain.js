// Terrain mesh (displaced plane textured by the painted ground canvas),
// water planes and the night-sky star field.

import * as THREE from 'three';
import { makeGroundCanvas } from './textures.js';

export function buildTerrain(city, scene) {
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
  const mat = new THREE.MeshLambertMaterial({ map: groundTex });
  const ground = new THREE.Mesh(geo, mat);
  ground.receiveShadow = true;
  ground.name = 'terrain';
  scene.add(ground);

  // ---- water ----
  const waterMat = new THREE.MeshLambertMaterial({
    color: 0x2e6485, transparent: true, opacity: 0.86,
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
      // gentle water shimmer
      waterMat.opacity = 0.84 + Math.sin(t * 0.8) * 0.03;
    },
    setStarAlpha(a) { starMat.opacity = a; },
  };
}
