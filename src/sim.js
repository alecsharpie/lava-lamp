// Lava lamp physics: a viscoelastic particle fluid (double-density relaxation,
// after Clavet et al. 2005) carrying temperature. Wax melts, expands when hot,
// rises, cools near the top and sinks. Pure JS so it runs in a worker or Node.

// ---- Lamp geometry (metres, globe-local: origin at the inner bottom centre) ----
export const LAMP = {
  H: 0.245,     // inner height of the glass globe
  top: 0.207,   // wax ceiling (just under the cap edge)
  Rb: 0.047,    // widest inner radius
  Rt: 0.024,    // inner radius at the top
  r0: 0.039,    // inner radius at the very bottom
  yb: 0.032,    // height of the widest point
  glass: 0.0035 // wall thickness
};

export function rIn(y) {
  const { H, Rb, Rt, r0, yb } = LAMP;
  if (y <= yb) { const s = 1 - Math.max(y, 0) / yb; return Rb - (Rb - r0) * s * s; }
  const t = Math.min(1, (y - yb) / (H - yb));
  const e = 0.12;
  const s = (Math.sqrt(t * t + e * e) - e) / (Math.sqrt(1 + e * e) - e);
  return Rb + (Rt - Rb) * s;
}

// Small deterministic PRNG so runs are reproducible.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export const DEFAULTS = {
  h: 0.0108,          // interaction radius (m)
  waxVolume: 1.0e-4,  // m^3 of wax
  spacing: 0.5,       // initial packing (h units)
  k: 0.010, kNear: 0.030, rho0: 1.6, // double-density relaxation
  cohesion: 2.5,      // scales the attractive (negative) pressure = surface tension
  rhoFull: 2.0,       // fallback interior density
  visHot: 0.011, visCold: 0.25, visQuad: 0.02, // per-step viscosity fractions
  buoy: 33,           // buoyancy gain (h/s^2 per unit temperature)
  Tn: 0.50,           // neutral-buoyancy temperature
  Tm: 0.42,           // softening point: cooler wax is stiff and viscous
  Tfreeze: 0.25,      // below this the wax is a rigid solid (lamp off)
  drag0: 0.3, dragSurf: 1.94, // drag from the surrounding liquid (surface-weighted -> big blobs move faster)
  heat: 1.0,          // bulb power (0 = off)
  heater: 2.51, heaterLambda: 0.274, // heat input near the bottom
  heaterSpot: 0.343, heaterEdge: 0.15, // radial focus of the bulb's hot spot
  kLiq: 0.102, kCond: 0.0108,
  insul: 0.077,      // heat exchange of fully interior wax, relative to surface wax
  buoySmooth: 1.0, buoySmoothIter: 2, // buoyancy from neighbour-averaged temperature: blobs respond to
                      // heat as whole bodies instead of tearing apart particle by particle
  floorWet: 0.26,     // the bottom glass/coil acts like wax for the density solver: the pool wets it
                      // and rests on it instead of beading up into a floating drop
  liqBottom: 0.426, liqTop: 0.34, room: 0.04,
  warmTau: 80,        // seconds (sim) for the liquid to warm up
  dt: 1 / 30,
  seed: 7,
};

export class LavaSim {
  constructor(opts = {}) {
    this.p = Object.assign({}, DEFAULTS, opts);
    this.rand = mulberry32(this.p.seed);
    const h = this.p.h;
    this.N = Math.round(this.p.waxVolume / Math.pow(this.p.spacing * h, 3));
    const N = this.N;
    this.x = new Float32Array(N); this.y = new Float32Array(N); this.z = new Float32Array(N);
    this.px = new Float32Array(N); this.py = new Float32Array(N); this.pz = new Float32Array(N);
    this.vx = new Float32Array(N); this.vy = new Float32Array(N); this.vz = new Float32Array(N);
    this.dx = new Float32Array(N); this.dy = new Float32Array(N); this.dz = new Float32Array(N);
    this.T = new Float32Array(N); this.dT = new Float32Array(N);
    this.rho = new Float32Array(N); this.rhoN = new Float32Array(N);
    this.mob = new Float32Array(N); this.expo = new Float32Array(N);
    this.Ts = new Float32Array(N); this.Tw = new Float32Array(N);
    this.time = 0; this.W = 1;
    this.ext = { ax: 0, ay: 0, az: 0 }; // external (shake) acceleration, h/s^2

    // geometry in sim units
    this.top = LAMP.top / h;
    this.Rmax = LAMP.Rb / h;
    this.profN = 512;
    this.prof = new Float32Array(this.profN + 1);
    for (let i = 0; i <= this.profN; i++) this.prof[i] = rIn((i / this.profN) * LAMP.H) / h;
    this.Hs = LAMP.H / h;

    // neighbour grid (cell = 1 h)
    this.gx = Math.ceil(2 * this.Rmax) + 2; this.gz = this.gx;
    this.gy = Math.ceil(this.top) + 2;
    this.cellCount = new Int32Array(this.gx * this.gy * this.gz);
    this.cellStart = new Int32Array(this.gx * this.gy * this.gz + 1);
    this.sorted = new Int32Array(N);
    this.cellOf = new Int32Array(N);
    this.maxPairs = N * 48;
    this.pi = new Int32Array(this.maxPairs); this.pj = new Int32Array(this.maxPairs);
    this.nPairs = 0;

    this.coldStart();
  }

  R(y) { // inner radius at sim-unit height y
    let f = (y / this.Hs) * this.profN; if (f < 0) f = 0; if (f > this.profN) f = this.profN;
    const i = Math.floor(f), t = f - i;
    return this.prof[i] * (1 - t) + this.prof[Math.min(i + 1, this.profN)] * t;
  }

  // Solid wax packed into the bottom of the globe.
  coldStart(T0 = this.p.room) {
    const s = this.p.spacing, N = this.N, r = this.rand;
    let n = 0, layer = 0;
    while (n < N) {
      const yy = 0.25 + layer * s * 0.85;
      const R = this.R(yy) - 0.3;
      const off = (layer % 2) * s * 0.5;
      for (let ix = -Math.ceil(R / s); ix <= Math.ceil(R / s) && n < N; ix++)
        for (let iz = -Math.ceil(R / s); iz <= Math.ceil(R / s) && n < N; iz++) {
          const xx = ix * s + off + (r() - 0.5) * 0.05, zz = iz * s + off + (r() - 0.5) * 0.05;
          if (xx * xx + zz * zz > R * R) continue;
          this.x[n] = xx; this.y[n] = yy + (r() - 0.5) * 0.05; this.z[n] = zz;
          this.vx[n] = this.vy[n] = this.vz[n] = 0;
          this.T[n] = T0; n++;
        }
      layer++;
    }
    this.W = 0; this.time = 0;
  }

  // Already-molten start (used to bootstrap a running lamp).
  warmStart() {
    this.coldStart(this.p.Tm + 0.12);
    this.W = 1;
  }

  liquidT(y) {
    const p = this.p, t = Math.min(1, Math.max(0, y / this.top));
    const hot = p.liqBottom + (p.liqTop - p.liqBottom) * t;
    return p.room + (hot - p.room) * this.W;
  }

  buildPairs() {
    const N = this.N, gx = this.gx, gy = this.gy, gz = this.gz, ox = this.Rmax + 1;
    const cc = this.cellCount, cs = this.cellStart, srt = this.sorted, cof = this.cellOf;
    cc.fill(0);
    for (let i = 0; i < N; i++) {
      let cx = Math.floor(this.x[i] + ox), cy = Math.floor(this.y[i]), cz = Math.floor(this.z[i] + ox);
      cx = cx < 0 ? 0 : cx >= gx ? gx - 1 : cx; cy = cy < 0 ? 0 : cy >= gy ? gy - 1 : cy; cz = cz < 0 ? 0 : cz >= gz ? gz - 1 : cz;
      const c = (cy * gz + cz) * gx + cx; cof[i] = c; cc[c]++;
    }
    let acc = 0;
    for (let c = 0; c < cc.length; c++) { cs[c] = acc; acc += cc[c]; }
    cs[cc.length] = acc;
    const fill = cc; // reuse as cursor
    for (let c = 0; c < cc.length; c++) fill[c] = cs[c];
    for (let i = 0; i < N; i++) srt[fill[cof[i]]++] = i;

    let np = 0; const pi = this.pi, pj = this.pj, X = this.x, Y = this.y, Z = this.z;
    for (let i = 0; i < N; i++) {
      const c = cof[i];
      const cx = c % gx, cz = Math.floor(c / gx) % gz, cy = Math.floor(c / (gx * gz));
      const xi = X[i], yi = Y[i], zi = Z[i];
      for (let dy = -1; dy <= 1; dy++) {
        const yy = cy + dy; if (yy < 0 || yy >= gy) continue;
        for (let dz = -1; dz <= 1; dz++) {
          const zz = cz + dz; if (zz < 0 || zz >= gz) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = cx + dx; if (xx < 0 || xx >= gx) continue;
            const cell = (yy * gz + zz) * gx + xx;
            for (let k = cs[cell], e = cs[cell + 1]; k < e; k++) {
              const j = srt[k]; if (j <= i) continue;
              const ex = X[j] - xi, ey = Y[j] - yi, ez = Z[j] - zi;
              if (ex * ex + ey * ey + ez * ez < 1 && np < this.maxPairs) { pi[np] = i; pj[np] = j; np++; }
            }
          }
        }
      }
    }
    this.nPairs = np;
  }

  step() {
    const p = this.p, N = this.N, dt = p.dt;
    const X = this.x, Y = this.y, Z = this.z, VX = this.vx, VY = this.vy, VZ = this.vz;
    const T = this.T, mob = this.mob, expo = this.expo;
    this.time += dt;
    this.W += dt * (Math.min(1, p.heat) - this.W) / p.warmTau;
    if (this.W < 0) this.W = 0;

    // --- body forces, drag, mobility
    const ext = this.ext;
    // neighbour-averaged temperature for buoyancy (uses last step's neighbour pairs)
    const Ts = this.Ts; Ts.set(T);
    if (p.buoySmooth > 0 && this.nPairs) {
      const Tw = this.Tw, pi = this.pi, pj = this.pj, np = this.nPairs;
      for (let it = 0; it < p.buoySmoothIter; it++) {
        const acc = this.dT; acc.set(Ts); Tw.fill(1);
        for (let k = 0; k < np; k++) {
          const i = pi[k], j = pj[k];
          const ex = X[j] - X[i], ey = Y[j] - Y[i], ez = Z[j] - Z[i];
          const r2 = ex * ex + ey * ey + ez * ez; if (r2 >= 1) continue;
          const w = 1 - r2;
          acc[i] += w * Ts[j]; acc[j] += w * Ts[i]; Tw[i] += w; Tw[j] += w;
        }
        for (let i = 0; i < N; i++) Ts[i] = acc[i] / Tw[i];
      }
      const a = p.buoySmooth;
      for (let i = 0; i < N; i++) Ts[i] = T[i] + a * (Ts[i] - T[i]);
    }
    for (let i = 0; i < N; i++) {
      const m = smooth(p.Tfreeze - 0.03, p.Tfreeze + 0.05, T[i]); // frozen solid only when truly cold
      mob[i] = m;
      let b = Ts[i] - p.Tn; b = b < -0.3 ? -0.3 : b > 0.3 ? 0.3 : b;
      VY[i] += (p.buoy * b + ext.ay) * dt;
      VX[i] += ext.ax * dt; VZ[i] += ext.az * dt;
      const d = Math.exp(-dt * (p.drag0 + p.dragSurf * expo[i]));
      const f = d * m;
      VX[i] *= f; VY[i] *= f; VZ[i] *= f;
    }

    this.buildPairs();
    const pi = this.pi, pj = this.pj, np = this.nPairs;

    // --- viscosity impulses (stronger in cooler, stiffer wax)
    for (let k = 0; k < np; k++) {
      const i = pi[k], j = pj[k];
      let ex = X[j] - X[i], ey = Y[j] - Y[i], ez = Z[j] - Z[i];
      const r = Math.sqrt(ex * ex + ey * ey + ez * ez); if (r < 1e-6) continue;
      ex /= r; ey /= r; ez /= r;
      const q = 1 - r;
      const u = (VX[i] - VX[j]) * ex + (VY[i] - VY[j]) * ey + (VZ[i] - VZ[j]) * ez;
      const Tij = 0.5 * (T[i] + T[j]);
      let sig = p.visCold + (p.visHot - p.visCold) * smooth(p.Tm - 0.03, p.Tm + 0.05, Tij); // stiff below the softening point
      if (mob[i] < 0.5 || mob[j] < 0.5) sig = 0.9; // molten wax can't flow through a solid block
      // full tangential + normal damping (gives honey-like coherence)
      const rvx = VX[i] - VX[j], rvy = VY[i] - VY[j], rvz = VZ[i] - VZ[j];
      const a = q * sig * 0.5, bq = q * p.visQuad * Math.abs(u) * 0.5;
      const mi = mob[i], mj = mob[j], ms = mi + mj + 1e-6;
      const wi = mi / ms * 2, wj = mj / ms * 2;
      const ix = a * rvx + bq * u * ex, iy = a * rvy + bq * u * ey, iz = a * rvz + bq * u * ez;
      VX[i] -= ix * wi * 0.5; VY[i] -= iy * wi * 0.5; VZ[i] -= iz * wi * 0.5;
      VX[j] += ix * wj * 0.5; VY[j] += iy * wj * 0.5; VZ[j] += iz * wj * 0.5;
    }

    // --- advance
    const PX = this.px, PY = this.py, PZ = this.pz;
    for (let i = 0; i < N; i++) {
      PX[i] = X[i]; PY[i] = Y[i]; PZ[i] = Z[i];
      X[i] += VX[i] * dt; Y[i] += VY[i] * dt; Z[i] += VZ[i] * dt;
    }

    // --- double density relaxation (Jacobi style)
    const rho = this.rho, rhoN = this.rhoN, DX = this.dx, DY = this.dy, DZ = this.dz;
    rho.fill(0); rhoN.fill(0);
    for (let k = 0; k < np; k++) {
      const i = pi[k], j = pj[k];
      const ex = X[j] - X[i], ey = Y[j] - Y[i], ez = Z[j] - Z[i];
      const r2 = ex * ex + ey * ey + ez * ez; if (r2 >= 1) continue;
      const q = 1 - Math.sqrt(r2), q2 = q * q, q3 = q2 * q;
      rho[i] += q2; rho[j] += q2; rhoN[i] += q3; rhoN[j] += q3;
    }
    // ghost wax below the floor (wetting): only the bottom glass, the side walls stay non-wetting
    const fw = p.floorWet;
    if (fw > 0) for (let i = 0; i < N; i++) {
      const d = Y[i]; if (d >= 1) continue;
      const q = 1 - d; rho[i] += fw * 3 * q * q; rhoN[i] += fw * 3 * q * q * q;
    }
    DX.fill(0); DY.fill(0); DZ.fill(0);
    if (fw > 0) for (let i = 0; i < N; i++) {
      const d = Y[i]; if (d >= 1) continue;
      const q = 1 - d;
      let P = p.k * (rho[i] - p.rho0); if (P < 0) P *= p.cohesion;
      const Pn = p.kNear * rhoN[i];
      DY[i] += fw * 3 * (P * q + Pn * q * q) * (mob[i] + 0.02);
    }
    for (let k = 0; k < np; k++) {
      const i = pi[k], j = pj[k];
      let ex = X[j] - X[i], ey = Y[j] - Y[i], ez = Z[j] - Z[i];
      const r2 = ex * ex + ey * ey + ez * ez; if (r2 >= 1 || r2 < 1e-12) continue;
      const r = Math.sqrt(r2); ex /= r; ey /= r; ez /= r;
      const q = 1 - r;
      let P = p.k * (rho[i] + rho[j] - 2 * p.rho0) * 0.5;
      if (P < 0) P *= p.cohesion;
      const Pn = p.kNear * (rhoN[i] + rhoN[j]) * 0.5;
      const D = (P * q + Pn * q * q);
      const mi = mob[i] + 0.02, mj = mob[j] + 0.02, ms = mi + mj;
      const wi = mi / ms, wj = mj / ms;
      DX[i] -= D * ex * wi; DY[i] -= D * ey * wi; DZ[i] -= D * ez * wi;
      DX[j] += D * ex * wj; DY[j] += D * ey * wj; DZ[j] += D * ez * wj;
    }

    // --- apply, collide with the glass, recover velocity
    const pad = 0.18, top = this.top - pad;
    for (let i = 0; i < N; i++) {
      let x = X[i] + DX[i], y = Y[i] + DY[i], z = Z[i] + DZ[i];
      if (y < pad) y = pad; else if (y > top) y = top;
      const R = this.R(y) - pad, r2 = x * x + z * z;
      if (r2 > R * R) { const s = R / Math.sqrt(r2); x *= s; z *= s; }
      X[i] = x; Y[i] = y; Z[i] = z;
      VX[i] = (x - PX[i]) / dt; VY[i] = (y - PY[i]) / dt; VZ[i] = (z - PZ[i]) / dt;
      // speed limit for robustness
      const v2 = VX[i] * VX[i] + VY[i] * VY[i] + VZ[i] * VZ[i];
      if (v2 > 64) { const s = 8 / Math.sqrt(v2); VX[i] *= s; VY[i] *= s; VZ[i] *= s; }
    }

    // --- heat: heater at the bottom, exchange with the liquid, conduction
    const dT = this.dT; dT.fill(0);
    for (let k = 0; k < np; k++) {
      const i = pi[k], j = pj[k];
      const ex = X[j] - X[i], ey = Y[j] - Y[i], ez = Z[j] - Z[i];
      const r2 = ex * ex + ey * ey + ez * ez; if (r2 >= 1) continue;
      // solid wax conducts heat far better than molten wax (no convection to help it)
      const w = (1 - Math.sqrt(r2)) * (1 + 14 * (2 - mob[i] - mob[j]));
      const f = w * (T[j] - T[i]);
      dT[i] += f; dT[j] -= f;
    }
    // adaptive estimate of interior density: mean over the denser half
    let rs = 0; for (let i = 0; i < N; i++) rs += rho[i]; rs /= N;
    let ra = 0, rn = 0; for (let i = 0; i < N; i++) if (rho[i] > rs) { ra += rho[i]; rn++; }
    const rhoFull = rn ? ra / rn : p.rhoFull; this.rhoFull = rhoFull;
    const heatIn = p.heat * p.heater * (0.12 + 0.88 * this.W), invL = 1 / p.heaterLambda, rho0 = p.rho0;
    const hs = p.heaterSpot * this.R(0), invHot2 = 1 / (hs * hs);
    for (let i = 0; i < N; i++) {
      const e = Math.min(1, Math.max(0, 1.1 - rho[i] / rhoFull));
      expo[i] = e;
      const y = Y[i];
      const r2 = (X[i] * X[i] + Z[i] * Z[i]) * invHot2;
      const q = heatIn * Math.exp(-y * invL) * (p.heaterEdge + (1 - p.heaterEdge) * 2.2 * Math.exp(-r2));
      const tl = this.liquidT(y);
      let t = T[i] + dt * (q + p.kLiq * (p.insul + e) * (tl - T[i]) + p.kCond * dT[i]);
      T[i] = t < 0 ? 0 : t > 1 ? 1 : t;
    }
  }

  stats() {
    let ymax = 0, ysum = 0, Tsum = 0, molten = 0;
    for (let i = 0; i < this.N; i++) {
      ysum += this.y[i]; Tsum += this.T[i]; if (this.y[i] > ymax) ymax = this.y[i];
      if (this.T[i] > this.p.Tfreeze) molten++;
    }
    return { N: this.N, pairs: this.nPairs, ymean: ysum / this.N, ymax, Tmean: Tsum / this.N, molten: molten / this.N, W: this.W };
  }

  serialize() {
    return { N: this.N, W: this.W, x: Array.from(this.x, v => +v.toFixed(3)), y: Array.from(this.y, v => +v.toFixed(3)), z: Array.from(this.z, v => +v.toFixed(3)), T: Array.from(this.T, v => +v.toFixed(3)) };
  }
  load(s) {
    if (s.N !== this.N) return false;
    this.x.set(s.x); this.y.set(s.y); this.z.set(s.z); this.T.set(s.T); this.W = s.W;
    this.vx.fill(0); this.vy.fill(0); this.vz.fill(0);
    return true;
  }
}
