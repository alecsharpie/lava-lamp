// Converts simulation particles into a 3D RGBA8 volume for the raymarcher:
//   R = wax density (metaball field, scaled)
//   G = transmittance of bulb light arriving from below (wax casts light shadows upward)
//   B = wax temperature
//   A = blurred density (soft glow / ambient occlusion)
import { LAMP } from './sim.js';

export class FieldBuilder {
  constructor({ nx = 48, kernelH = 0.9, scale = 0.25, absorb = 28 } = {}) {
    const half = LAMP.Rb + 0.002;
    this.min = [-half, -0.002, -half];
    this.nx = nx; this.nz = nx;
    this.voxel = (2 * half) / nx;
    this.ny = Math.ceil((LAMP.top + 0.008 - this.min[1]) / this.voxel);
    this.size = [this.nx * this.voxel, this.ny * this.voxel, this.nz * this.voxel];
    this.kernelH = kernelH; this.scale = scale; this.absorb = absorb; // kernelH: splat radius in units of the sim h
    const n = this.nx * this.ny * this.nz;
    this.dens = new Float32Array(n);
    this.temp = new Float32Array(n);
    this.od = new Float32Array(this.nx * this.nz);
    this.lightTop = 1;
    // lookup table for exp(-depth/2) * 255 (byte-encoded square root of the transmittance)
    this.lutScale = 128; this.lut = new Uint8Array(16 * 128 + 1);
    for (let i = 0; i < this.lut.length; i++) this.lut[i] = (Math.exp(-i / this.lutScale / 2) * 255 + 0.5) | 0;
  }

  // positions in metres (globe-local) via sim units * h
  build(sim, out) {
    const { nx, ny, nz, voxel, dens, temp } = this;
    dens.fill(0); temp.fill(0);
    const h = sim.p.h, R = this.kernelH * h, R2 = R * R, invR2 = 1 / R2;
    const rv = Math.ceil(R / voxel);
    const mx = this.min[0], my = this.min[1], mz = this.min[2];
    const sx = nx, sxy = nx * ny;
    for (let i = 0; i < sim.N; i++) {
      const px = sim.x[i] * h, py = sim.y[i] * h, pz = sim.z[i] * h, T = sim.T[i];
      const fx = (px - mx) / voxel - 0.5, fy = (py - my) / voxel - 0.5, fz = (pz - mz) / voxel - 0.5;
      const cx = Math.round(fx), cy = Math.round(fy), cz = Math.round(fz);
      const z0 = Math.max(0, cz - rv), z1 = Math.min(nz - 1, cz + rv);
      const y0 = Math.max(0, cy - rv), y1 = Math.min(ny - 1, cy + rv);
      const x0 = Math.max(0, cx - rv), x1 = Math.min(nx - 1, cx + rv);
      for (let z = z0; z <= z1; z++) {
        const dz = (z - fz) * voxel, dz2 = dz * dz; if (dz2 >= R2) continue;
        for (let y = y0; y <= y1; y++) {
          const dy = (y - fy) * voxel, dyz = dz2 + dy * dy; if (dyz >= R2) continue;
          let o = z * sxy + y * sx + x0;
          for (let x = x0; x <= x1; x++, o++) {
            const dx = (x - fx) * voxel, d2 = dyz + dx * dx; if (d2 >= R2) continue;
            const q = 1 - d2 * invR2, w = q * q * q;
            dens[o] += w; temp[o] += w * T;
          }
        }
      }
    }

    // bulb light: sweep upward through each column accumulating wax optical depth, packing each
    // voxel as we go (one pass; 4 bytes written as one 32-bit word)
    const od = this.od, sc = this.scale, iso = 0.25 / sc;
    const kAbs = this.absorb * voxel;
    const lut = this.lut, lutScale = this.lutScale, lutMax = lut.length - 1;
    const out32 = new Uint32Array(out.buffer, out.byteOffset, out.length >> 2);
    od.fill(0);
    let lt = 0, ln = 0;
    for (let y = 0; y < ny; y++) {
      const probeRow = y === ny - 4;
      for (let z = 0; z < nz; z++) {
        let o = z * sxy + y * sx, c = z * nx;
        for (let x = 0; x < nx; x++, o++, c++) {
          const d = dens[o];
          const occ = d <= iso * 0.5 ? 0 : d >= iso * 1.6 ? 1 : (d - iso * 0.5) / (iso * 1.1);
          const depth = od[c] += occ * kAbs;
          // G = sqrt(exp(-depth)) = exp(-depth/2): more precision in the shadows
          const li = depth * lutScale, g = li >= lutMax ? 0 : lut[li | 0];
          const r = d * sc >= 1 ? 255 : (d * sc * 255) | 0;
          const t = d > 1e-4 ? Math.min(255, (temp[o] / d) * 255) | 0 : 0;
          out32[o] = r | (g << 8) | (t << 16) | 0xff000000;
          if (probeRow) { lt += Math.exp(-depth); ln++; }
        }
      }
      // light leaks sideways a little (the bulb is a broad source): blur this slice's depth
      if ((y & 1) === 0) this.blurSlice(od);
    }
    this.lightTop = lt / ln;
    return out;
  }

  blurSlice(od) {
    const nx = this.nx, nz = this.nz, t = this._row || (this._row = new Float32Array(nx * nz));
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const c = z * nx + x;
      const l = od[x > 0 ? c - 1 : c], r = od[x < nx - 1 ? c + 1 : c];
      t[c] = 0.25 * l + 0.5 * od[c] + 0.25 * r;
    }
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const c = z * nx + x;
      const u = t[z > 0 ? c - nx : c], d = t[z < nz - 1 ? c + nx : c];
      od[c] = 0.25 * u + 0.5 * t[c] + 0.25 * d;
    }
  }
}
