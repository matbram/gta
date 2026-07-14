# BAYVALE

An original open-world action game for the browser, built from scratch with
Three.js — a living city with a real sun and moon, weather, true collision
physics, walk-in interiors with no loading screens, original generated
characters and vehicles, a six-star wanted system, intelligent role-based
NPCs, first-person and third-person combat with ragdolls, a 12-mission
story, and a full generated soundtrack.

The city, story, characters and design are **100% original** — and so are
the models: **every visible 3D asset (people, cars, buildings, street
furniture, palms, sky) is generated at runtime by the game's own code.**
The only third-party inputs are CC0 surface textures, an MIT animation-clip
source that is never rendered (see `ATTRIBUTION.md`), and audio that was
**generated** with the ElevenLabs API.

![Bayvale](screenshots/g1-vehicles.png)

## Run it

```bash
npm start          # zero-dependency Node server, respects $PORT (default 8080)
# open http://localhost:8080
```

No build step and no runtime dependencies — `server.js` uses only Node
built-ins, so it also works as-is on container platforms that run `npm start`.
Any other static server works too (e.g. `npx http-server -p 8080`).
Chrome/Edge/Firefox, desktop recommended (keyboard + mouse).

## The game

You are **Marco Reyes**, back in your home town of Bayvale after six years
away, working your way up from taxi errands for your cousin **Rosa** to
dismantling **Ray Corvo**'s grip on the city, one mission at a time.

- **Open world** — a 1.8 km × 1.8 km island city with nine palm-lined
  districts, murals, utility poles with sagging wires, parked cars on every
  block, working traffic lights, and rooftop clutter over the bay.
- **A real sky** — visible sun disc with flare, a cratered moon with live
  phases, stars, drifting clouds, and a procedural sky dome that re-bakes
  the scene's environment lighting every half game-hour. Weather rolls
  between clear, overcast and rain — rain slicks the streets glossy, closes
  the fog in, and flashes lightning at night.
- **Real collision** — cars are true oriented boxes that can't pass through
  each other, trees, or poles. Lamp posts and traffic lights snap and topple
  on hard hits, hydrants burst into 20-second water geysers, trash cans
  tumble, crashes shatter glass and leave skid marks.
- **Walk-in interiors** — no loading screens, no teleports: buildings hollow
  out as you approach and you walk through a swinging glass door into
  stores, diners, laundromats, the gun shop, the burger joint, a nightclub
  with dancers, and your safehouse. Hold a gun on a clerk to rob the
  register — the heat lands when you step back onto the street, and ducking
  indoors breaks police line of sight.
- **Original people** — every pedestrian is a generated human: men and
  women of all ages and builds, with faces, hairstyles, beards, gray hair
  and wrinkles for the elderly, hoodies and floral shirts and uniforms —
  cops with caps and badges, firefighters in turnout gear and helmets,
  medics with the cross, keepers in aprons — all driven by real animation
  clips and six personality-driven roles that decide how they react: flee,
  cower, film you on their phone, fight back, or call the police.
- **People who actually perceive** — everyone has a field of view and
  hearing: gunfire behind their back makes them turn and look before they
  react, brandished weapons only worry people who can see them, corpses
  get discovered, gang corners warn you off before they jump you, and the
  cast changes with the clock — joggers at dawn, rush-hour crowds, thin
  dangerous streets at 3 a.m.
- **Original vehicles** — ten types, each a profile-extruded body with real
  wheel arches, windshields, clearcoat paint, license plates, mirrors, and
  working lightbars/sirens/liveries for the services. They drive like
  vehicles: torque curves with audible gear shifts, brake and reverse
  lights, a km/h speedometer, per-type seating (you straddle the bike, sit
  the driver's side in cars), locked cars with alarms, and sirens that
  part traffic — including the one you stole.
- **Combat 2.0** — first-person and third-person, six weapons with recoil,
  tracers, ejected shells and muzzle flashes; melee combos with lunges,
  hit-stop and knockdowns; hard lock-on (Tab), dodge rolls, a weapon wheel;
  ragdoll physics and blood pools on every takedown.
- **Wanted system** — six stars: foot patrols → cruisers (with PIT maneuvers
  and rubber-banding) → roadblocks → tactical units → a searchlight
  helicopter. The police work with information, not telepathy: quiet
  crimes need witnesses, unseen cops converge on your last known position
  and search it, switching cars unseen breaks their description of you,
  and a stolen cruiser makes you one of them until you blow your cover.
- **Missions** — 12 story missions across three contacts (drive, chase, tail,
  escort, defend, assault), plus taxi fares and 30 hidden lucky coins.
- **Audio** — generated weapon/vehicle/world SFX with distance + stereo pan
  and per-take pitch variation, role-based voice barks, police-scanner
  chatter, Marco's running self-talk, surface-aware footsteps that splash
  in the rain, a rain bed, seagulls over the bay, interiors that muffle
  the street, and three radio stations of real music.
- **Progression** — money, weapons, armor, safehouse saving (localStorage),
  quality presets (Low/Med/High) with auto-degrade.

## Controls

| Key | Action |
| --- | --- |
| W A S D | move / drive |
| Mouse | camera (click canvas to lock) |
| Shift | sprint |
| Space | jump / handbrake · dodge roll (locked on) |
| LMB | attack / fire |
| RMB | hold to aim |
| Tab / MMB | lock on to target |
| Scroll | switch weapon |
| Hold Q | weapon wheel (slow-mo) |
| F / Enter | enter or exit vehicle |
| R | reload · radio (in a vehicle) |
| H | horn |
| T | taxi fares (while driving a taxi) |
| M | map — click to set a waypoint (A* route on the minimap) |
| V | camera: near / mid / far / first-person |
| Esc / P | pause (quality settings here) |

Glowing yellow markers on the sidewalk are enterable doors — just walk in.

## Regenerating assets

Textures, the animation source and all audio are committed, so the game runs
as-is. To re-fetch or regenerate them:

```bash
node tools/fetch-assets.mjs                 # CC0 textures + MIT animation source
ELEVENLABS_API_KEY=sk_... node tools/gen-audio.mjs --all   # SFX, voice, music
```

The audio generator reads the key **only** from the environment — it is never
committed. If you were handed a key in chat, rotate it after use.

## Testing

Headless verification (Playwright + the game's `window.__game` debug API):

```bash
npm start &                   # server on :8080
npm test                      # all 14 suites
```

Suites: boot, drive, **collision** (OBB cars, knockables, geysers),
**people** (character variety, uniforms, clip binding), **sky** (sun/moon,
env re-bake, rain), combat, missions, deep (6-star, respray, soak), npc
(archetypes, witnesses, dispatch), **interiors** (continuous-position
walk-in, robbery, bed, counters), g6 (first-person, ragdolls, lock-on,
streetscape), audio, chase (PIT, helicopter), and a full continuous
playthrough. Tests fast-forward the simulation deterministically
(`__game.tick`), so they pass even on slow software renderers.

## Architecture

```
index.html            HUD DOM + import map (three.js vendored, no bundler)
src/main.js           boot, game loop, mode state machine, debug API
src/core/             input, camera, graphics, animator, audio, radio, save
src/world/            seeded city generator (road graph → districts → lots),
                      canvas textures, chunk meshes, terrain, sky, day/night,
                      props + vegetation libraries (all generated geometry)
src/entities/         character factory (mesh+atlas), player, peds, cops,
                      goons, vehicle factory + physics
src/systems/          traffic, pedestrians, combat, wanted, missions, gore,
                      knockables, weather, dispatch, walk-in interiors,
                      world-life, particles
src/ui/               HUD, rotating minimap
```

Everything in Bayvale — names, story, map, art, music — is original work
created for this project.
