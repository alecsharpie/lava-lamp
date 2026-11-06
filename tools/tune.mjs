// Headless physics tuning: runs the sim and writes side-view snapshots.
// usage: node tools/tune.mjs <outdir> <seconds> <snapEvery> [jsonOverrides] [cold|warm]
import { LavaSim, LAMP } from '../src/sim.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const [out = 'out', secs = '60', every = '5', ov = '{}', mode = 'cold'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const sim = new LavaSim(JSON.parse(ov));
if (mode === 'warm') sim.warmStart();
if (mode === 'state') { const st = JSON.parse((await import('node:fs')).readFileSync(new URL('../src/state.json', import.meta.url))); console.log('loaded', sim.load(st)); }
const W = 120, H = Math.round(W * LAMP.H / (2 * LAMP.Rb * 1.05));
const scale = W / (2 * LAMP.Rb * 1.05);
const h = sim.p.h;

function snap(name) {
  const img = new Uint8Array(W * H * 3).fill(20);
  // glass outline
  for (let py = 0; py < H; py++) {
    const y = (H - 1 - py) / scale; const R = (Math.min(LAMP.H, y) <= LAMP.H) ? 0 : 0;
  }
  const rad = 0.42 * h * scale;
  const order = Array.from({ length: sim.N }, (_, i) => i).sort((a, b) => sim.z[a] - sim.z[b]);
  for (const i of order) {
    const cx = W / 2 + sim.x[i] * h * scale, cy = H - 1 - sim.y[i] * h * scale;
    const t = sim.T[i];
    const shade = 0.55 + 0.45 * (sim.z[i] * h / LAMP.Rb + 1) / 2;
    const r = Math.min(255, 255 * Math.min(1, t * 1.8)) * shade, g = 255 * Math.max(0, t - 0.5) * 1.6 * shade, b = 255 * Math.max(0, 0.5 - t) * 2 * shade;
    for (let yy = Math.floor(cy - rad); yy <= cy + rad; yy++) for (let xx = Math.floor(cx - rad); xx <= cx + rad; xx++) {
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if ((xx - cx) ** 2 + (yy - cy) ** 2 > rad * rad) continue;
      const o = (yy * W + xx) * 3; img[o] = r; img[o + 1] = g; img[o + 2] = b;
    }
  }
  const hdr = `P6 ${W} ${H} 255\n`;
  writeFileSync(`${out}/${name}.ppm`, Buffer.concat([Buffer.from(hdr), Buffer.from(img)]));
}

const steps = Math.round(+secs / sim.p.dt), snapSteps = Math.round(+every / sim.p.dt);
const t0 = performance.now();
let f = 0;
for (let s = 0; s <= steps; s++) {
  if (s % snapSteps === 0) {
    snap(String(f++).padStart(3, '0'));
    const st = sim.stats();
    console.log(`t=${sim.time.toFixed(0)}s W=${st.W.toFixed(2)} ymean=${(st.ymean * h * 100).toFixed(1)}cm ymax=${(st.ymax * h * 100).toFixed(1)}cm Tmean=${st.Tmean.toFixed(2)} molten=${st.molten.toFixed(2)} pairs=${st.pairs}`);
  }
  sim.step();
}
const ms = (performance.now() - t0) / steps;
console.log(`N=${sim.N} ${ms.toFixed(2)} ms/step`);
execSync(`magick montage ${out}/*.ppm -geometry +2+2 -tile ${Math.min(f, 16)}x -background '#444' ${out}/strip.png && rm ${out}/*.ppm`);
writeFileSync(`${out}/state.json`, JSON.stringify(sim.serialize()));
