// Rotating circular minimap rendered to a 2D canvas from the pre-painted map image.

import { makeMapCanvas } from '../world/textures.js';

const VIEW_M = 260;          // metres of world shown across the minimap

export class Minimap {
  constructor(city) {
    this.city = city;
    this.mapCanvas = makeMapCanvas(city, 1024);
    this.canvas = document.getElementById('minimap');
    this.ctx = this.canvas.getContext('2d');
    this.pxPerM = 1024 / city.SPAN;
  }

  // blips: [{x, z, color, shape:'dot'|'square'|'triangle', label, above, below}]
  draw(px, pz, headingRad, blips = [], waypoint = null, route = null) {
    const ctx = this.ctx;
    const S = this.canvas.width;          // 448
    const R = S / 2;
    ctx.clearRect(0, 0, S, S);

    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 4, 0, Math.PI * 2);
    ctx.clip();

    // draw the rotated map: world → minimap scale
    const scale = S / VIEW_M;                       // px per metre on screen
    const mapScale = scale / this.pxPerM;           // scale applied to map image
    ctx.translate(R, R);
    ctx.rotate(headingRad);                          // rotate map opposite to heading
    ctx.scale(mapScale, mapScale);
    const mx = (px + this.city.HALF) * this.pxPerM;
    const mz = (pz + this.city.HALF) * this.pxPerM;
    ctx.translate(-mx, -mz);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.mapCanvas, 0, 0);
    ctx.restore();

    // blips (rotate positions around centre)
    const rot = (wx, wz) => {
      const dx = (wx - px) * scale, dz = (wz - pz) * scale;
      const c = Math.cos(headingRad), s = Math.sin(headingRad);
      return [R + dx * c - dz * s, R + dx * s + dz * c];
    };

    // waypoint route drawn over the map
    if (route && route.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(R, R, R - 6, 0, Math.PI * 2);
      ctx.clip();
      ctx.strokeStyle = 'rgba(150,80,150,0.9)';
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < route.length; i++) {
        const [x, y] = rot(route[i].x, route[i].z);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    const drawBlip = (b) => {
      let [x, y] = rot(b.x, b.z);
      const d = Math.hypot(x - R, y - R);
      const maxD = R - 14;
      let clamped = false;
      if (d > maxD) { x = R + ((x - R) / d) * maxD; y = R + ((y - R) / d) * maxD; clamped = true; }
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 3;
      ctx.fillStyle = b.color;
      if (b.shape === 'square' || clamped) {
        ctx.fillRect(x - 5, y - 5, 10, 10);
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeRect(x - 5, y - 5, 10, 10);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.stroke();
      }
      if (b.letter) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 9px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.letter, x, y + 0.5);
      }
      ctx.restore();
    };

    for (const b of blips) drawBlip(b);
    if (waypoint) drawBlip({ ...waypoint, color: '#8a4a8a', shape: 'square' });

    // player arrow (always centred, pointing up = facing direction)
    ctx.save();
    ctx.translate(R, R);
    ctx.fillStyle = '#f5f1e6';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6.5, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-6.5, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // north indicator
    ctx.save();
    const nx = R + Math.sin(-headingRad) * (R - 16) * -1;
    const ny = R + Math.cos(-headingRad) * (R - 16) * -1;
    ctx.fillStyle = '#e8dcc8';
    ctx.font = 'bold 15px Georgia';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 4;
    ctx.fillText('N', nx, ny);
    ctx.restore();
  }
}
