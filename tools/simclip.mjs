// Runs the simulation headlessly and writes front-view wax silhouettes, as a camera would see
// them through the water-filled globe (refraction included), for tools/ref/metrics.py.
// usage: node tools/simclip.mjs <out.bin> [seconds=600] [overridesJSON={}] [start=state|warm|cold] [warmup=0]
//   also writes <out>.state.json (final state) so a good run can become src/state.json
import { LavaSim, LAMP, rIn } from '../src/sim.js';
import { FieldBuilder } from '../src/field.js';
import { writeFileSync, readFileSync, openSync, writeSync, closeSync } from 'node:fs';

const [out, secs = '600', ov = '{}', start = 'state', warm = '0'] = process.argv.slice(2);
const params = JSON.parse(ov);
const sim = new LavaSim(params);
if (start === 'warm') sim.warmStart();
else if (start === 'state') {
  const st = JSON.parse(readFileSync(new URL('../src/state.json', import.meta.url)));
  if (!sim.load(st)) sim.warmStart();
}
const fb = new FieldBuilder({ nx: 40, kernelH: +(process.env.KERNEL_H || 0.9) });
const tmp = new Uint8Array(fb.nx * fb.ny * fb.nz * 4);

const VIS_TOP = 0.203;              // the cap hides the glass above this
const W = 48, H = Math.round(W * VIS_TOP / (2 * LAMP.Rb));
const frameDt = 0.25;               // seconds of lamp time between frames
const n = 1.333;

// silhouette of the globe
const globe = new Uint8Array(W * H);
for (let r = 0; r < H; r++) {
  const y = (H - 1 - r + 0.5) / H * VIS_TOP, R = rIn(y);
  for (let c = 0; c < W; c++) { const x = ((c + 0.5) / W * 2 - 1) * LAMP.Rb; if (Math.abs(x) < R * 0.97) globe[r * W + c] = 1; }
}

function densAt(x, y, z) {
  const fx = Math.floor((x - fb.min[0]) / fb.voxel), fy = Math.floor((y - fb.min[1]) / fb.voxel), fz = Math.floor((z - fb.min[2]) / fb.voxel);
  if (fx < 0 || fy < 0 || fz < 0 || fx >= fb.nx || fy >= fb.ny || fz >= fb.nz) return 0;
  return fb.dens[fz * fb.nx * fb.ny + fy * fb.nx + fx];
}
const iso = 0.25 / fb.scale;
function silhouette(mask) {
  for (let r = 0; r < H; r++) {
    const y = (H - 1 - r + 0.5) / H * VIS_TOP, R = rIn(y);
    for (let c = 0; c < W; c++) {
      const o = r * W + c; mask[o] = 0;
      if (!globe[o]) continue;
      const xs = ((c + 0.5) / W * 2 - 1) * LAMP.Rb;
      // orthographic ray along -z enters the circle at (xs, zs), refracts into the water
      const zs = Math.sqrt(R * R - xs * xs), nx = xs / R, nz = zs / R;
      const cosi = nz, eta = 1 / n, k = 1 - eta * eta * (1 - cosi * cosi);
      const tx = -eta * 0 + (eta * cosi - Math.sqrt(k)) * nx, tz = -eta + (eta * cosi - Math.sqrt(k)) * nz;
      const len = 2 * R, st = fb.voxel * 0.5;
      for (let t = st; t < len; t += st) {
        const x = xs + tx * t, z = zs + tz * t;
        if (x * x + z * z > R * R) break;
        if (densAt(x, y, z) > iso) { mask[o] = 1; break; }
      }
    }
  }
}

for (let s = 0; s < Math.round(+warm / sim.p.dt); s++) sim.step();
const frames = Math.round(+secs / frameDt), per = Math.round(frameDt / sim.p.dt);
const fd = openSync(out, 'w');
writeSync(fd, JSON.stringify({ frames, w: W, h: H, dt: frameDt, params }) + '\n');
writeSync(fd, globe);
const mask = new Uint8Array(W * H);
const t0 = performance.now();
for (let f = 0; f < frames; f++) {
  for (let s = 0; s < per; s++) sim.step();
  fb.build(sim, tmp);
  silhouette(mask);
  writeSync(fd, mask);
}
closeSync(fd);
writeFileSync(out + '.state.json', JSON.stringify(sim.serialize()));
console.error(`${out}: ${frames} frames, ${((performance.now() - t0) / 1000).toFixed(1)}s wall`);
