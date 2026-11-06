// Runs one lamp's lava physics + volume build off the main thread.
import { LavaSim } from './sim.js';
import { FieldBuilder } from './field.js';

let sim = null, fb = null;
let speed = 1, last = 0, acc = 0, simMs = 0;
let ext = null; // {ax, az, until}

function makeSim(params, state, preroll) {
  sim = new LavaSim(params);
  if (!(state && sim.load(state))) {
    sim.warmStart();
    preroll = Math.max(preroll || 0, 150);
  }
  // fast-forward (also used to de-synchronise several lamps started from one snapshot)
  const total = Math.round((preroll || 0) / sim.p.dt);
  for (let s = 0; s < total; s++) {
    sim.step();
    if (s % 300 === 0) postMessage({ type: 'progress', value: s / total });
  }
}

onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      fb = new FieldBuilder(m.field);
      makeSim(m.params, m.state, m.preroll);
      if (m.mirror) for (let i = 0; i < sim.N; i++) { sim.x[i] = -sim.x[i]; }
      if (m.rotate) {
        const c = Math.cos(m.rotate), s = Math.sin(m.rotate);
        for (let i = 0; i < sim.N; i++) { const x = sim.x[i], z = sim.z[i]; sim.x[i] = c * x - s * z; sim.z[i] = s * x + c * z; }
      }
      last = performance.now();
      postMessage({ type: 'ready', dims: [fb.nx, fb.ny, fb.nz], min: fb.min, size: fb.size, voxel: fb.voxel, N: sim.N });
      break;
    }
    case 'set': sim.p[m.key] = m.value; break;
    case 'speed': speed = m.value; break;
    case 'cold': sim.coldStart(); break;
    case 'nudge': ext = { ax: m.ax, az: m.az, until: sim.time + m.dur }; break;
    case 'frame': {
      const now = performance.now();
      const dtReal = Math.min(0.1, (now - last) / 1000); last = now;
      acc += dtReal * speed;
      const dt = sim.p.dt;
      let steps = Math.floor(acc / dt);
      const maxSteps = 8;
      if (steps > maxSteps) { steps = maxSteps; acc = 0; } else acc -= steps * dt;
      const n = fb.nx * fb.ny * fb.nz * 4;
      const buf = m.buffer && m.buffer.byteLength === n ? new Uint8Array(m.buffer) : new Uint8Array(n);
      if (steps === 0 && !m.force) { // nothing changed: hand the buffer straight back
        postMessage({ type: 'field', buffer: buf.buffer, fresh: false }, [buf.buffer]);
        break;
      }
      const t0 = performance.now();
      for (let s = 0; s < steps; s++) {
        if (ext && sim.time < ext.until) { sim.ext.ax = ext.ax; sim.ext.az = ext.az; }
        else { sim.ext.ax = 0; sim.ext.az = 0; ext = null; }
        sim.step();
      }
      fb.build(sim, buf);
      simMs = simMs * 0.9 + (performance.now() - t0) * 0.1;
      let Tm = 0; for (let i = 0; i < sim.N; i++) Tm += sim.T[i]; Tm /= sim.N;
      postMessage({
        type: 'field', buffer: buf.buffer, fresh: true,
        stats: { W: sim.W, liqBottom: sim.liquidT(0), waxT: Tm, lightTop: fb.lightTop, simMs, steps, time: sim.time }
      }, [buf.buffer]);
      break;
    }
    case 'dump': postMessage({ type: 'dump', state: sim.serialize() }); break;
  }
};
