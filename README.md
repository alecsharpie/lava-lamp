# Lava Lamps

Physically simulated, raymarched lava lamps in the browser (Three.js, no build step).

**Live:** https://alecsharpie.github.io/lava-lamp/

```bash
cd lava-lamp
python3 -m http.server 8766
# open http://localhost:8766
```

**Controls:**
- Drag to orbit, scroll to zoom, right-drag to pan.
- Click a lamp to select it; double-click a lamp to nudge it.

The **Scene** panel sets:
- number of lamps (1–5) and time speed;
- room light (dark to evenly lit), exposure, glow and vignette;
- thermal camera view and slow orbit;
- quality (`Auto` scales resolution to hold the display's frame rate).

The **Selected lamp** panel sets:
- colours, liquid tint and base finish;
- power and bulb wattage;
- nudge and cold start.

URL parameters: `?lamps=1&room=0.6&speed=4&thermal=1&hideui=1&cam=close|wide`

## How it works

**Physics (`src/sim.js`, one Web Worker per lamp).** About 640 wax particles form a viscoelastic
fluid: double-density relaxation (Clavet et al. 2005), with surface-only cohesion standing in for
surface tension. Each particle carries a temperature:

- **Heating.** The bulb heats a thin layer above the bottom glass, focused toward the centre.
- **Wetting.** The bottom glass acts like wax for the density solver, so the pool rests on it
  instead of beading up into a floating drop.
- **Heat exchange.** Wax swaps heat with a liquid that is warmer at the bottom than at the top.
  Exchange happens mostly through a blob's surface, so big blobs keep their heat long enough to
  reach the cap, and thin necks cool and pinch off.
- **Buoyancy.** It follows each blob's neighbour-averaged temperature, so blobs and columns rise
  and sink as bodies rather than tearing apart particle by particle.
- **Stiffening and freezing.** Wax below the softening point turns stiff, and below the freezing
  point it is solid (lamp off, cold start).

**Volume (`src/field.js`).** Every simulation step, the particles are splatted into a 48×107×48
RGBA8 3D texture holding:

- metaball density;
- the bulb's light transmittance (an upward sweep, so blobs shadow everything above them);
- wax temperature.

**Rendering (`src/shaders.js`).** Each globe's fragment shader:

1. refracts into the glass and marches through the 3.5 mm wall;
2. raymarches the liquid with bulb in-scattering and coloured absorption;
3. finds the wax surface and shades it with translucency, rim light and the bulb's highlight;
4. exits through the far wall, by refraction or total internal reflection, into a screen-space
   copy of the room.

The metal uses small reflection probes, refreshed round-robin, that see a glowing stand-in for
the globe. Studio softboxes appear only in reflections. Post-processing does bloom, then ACES,
vignette, slight chromatic aberration and grain in one pass.

**Performance:**
- Physics and volume building run in workers: under 1 ms per step plus about 5 ms per volume, per
  lamp.
- The 3D texture is uploaded only when the simulation has actually stepped.
- No shadow maps.
- In `Auto` quality the resolution drops when frames run long and climbs back when there's
  headroom.

## Realism harness (`tools/`)

The physics parameters are fitted to real footage instead of tuned by eye.

1. **Reference footage.** `reference/SOURCES.md` lists the photos and clips. They belong to their
   authors and aren't in the repo; `tools/ref/fetch.sh` downloads the clips the metrics use. `tools/ref/refs.json` says which clips are measured and how wax differs from liquid in
   each (paler, brighter or more saturated).
2. **Measuring.** `python3 tools/ref/metrics.py refs` segments each clip into wax/globe masks,
   writes overlays to `tools/ref/masks/` for checking, and writes
   `tools/ref/reference_metrics.json`. The metrics are:
   - wax area;
   - detached blob size relative to the globe width;
   - blobs per frame;
   - how often one body spans 60% of the globe (columns);
   - blob rise speed;
   - the height profile of the wax;
   - how often wax reaches the top.
3. **Simulated footage.** `node tools/simclip.mjs out.bin 600 '{"h":0.011}' warm 150` runs the
   physics headlessly. It renders front-view silhouettes as a camera would see them through the
   water-filled globe, refraction included. `python3 tools/ref/metrics.py sim out.bin strip.png`
   measures them the same way.
4. **Search.**
   - `python3 tools/ref/search.py variants.json` runs parameter variants in parallel and scores
     each against the reference metrics (sum of squared z-scores).
   - `python3 tools/ref/explore.py runs/ex 6 16` does random search with local refinement.
5. **Baking.** `node tools/makestates.mjs` bakes `src/states.json`, the pre-warmed snapshots the
   page opens on.

The current defaults score about 18 against the references (lower is better). The original
physics scored about 197: its pool hovered above the glass, blobs were small, and wax rarely
reached the cap. `tools/variants.mjs` takes batches of headless browser screenshots.
