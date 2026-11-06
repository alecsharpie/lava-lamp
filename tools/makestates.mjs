// Bakes src/states.json: several snapshots of a running lamp (one per lamp in the lineup), so the
// page opens on lamps that are already flowing and out of step with each other.
// usage: node tools/makestates.mjs [count=5] [warmup=420] [gap=47]
import { LavaSim } from '../src/sim.js';
import { writeFileSync } from 'node:fs';

const [count = '5', warmup = '420', gap = '47'] = process.argv.slice(2);
const sim = new LavaSim();
sim.warmStart();
const steps = (s) => { for (let i = 0, n = Math.round(s / sim.p.dt); i < n; i++) sim.step(); };
steps(+warmup);
const out = [];
for (let k = 0; k < +count; k++) {
  steps(+gap);
  const st = sim.stats();
  out.push(sim.serialize());
  console.log(`snapshot ${k}: t=${sim.time.toFixed(0)}s ymean=${(st.ymean * sim.p.h * 100).toFixed(1)}cm ymax=${(st.ymax * sim.p.h * 100).toFixed(1)}cm`);
}
writeFileSync(new URL('../src/states.json', import.meta.url), JSON.stringify(out));
