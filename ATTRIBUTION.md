# Asset Attribution

Bayvale's code, city, story, characters and design are original work created
for this project. **Every visible 3D model in the game is generated at
runtime by the project's own code** — people, vehicles, buildings, street
furniture, vegetation, sky, sun and moon included. The remaining third-party
inputs are listed below.

## Animation source

- **three.js example `Soldier.glb`** — MIT license, © three.js authors.
  https://github.com/mrdoob/three.js — used **solely as the animation and
  skeleton source** (Idle/Walk/Run clips + Mixamo-style bone hierarchy) for
  Bayvale's own generated character bodies. The GLB's mesh is stripped at
  load and never rendered. Stored at `assets/anim/soldier-rig.glb`.

## Surface textures

- **ambientCG** (asphalt, sidewalk, brick, concrete, plaster, grass, sand,
  metal PBR sets) — CC0 1.0. https://ambientcg.com

## Audio

- All sound effects, character voice lines and radio music were **generated**
  for this project with the ElevenLabs API (`tools/gen-audio.mjs`) and are
  original to Bayvale. No third-party audio files are used.

## Libraries

- **three.js** (r0.185) — MIT license, © three.js authors. Vendored in
  `vendor/`.

CC0 assets require no attribution; they are credited here as a courtesy.
