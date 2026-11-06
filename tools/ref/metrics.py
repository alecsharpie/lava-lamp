"""Lava-lamp motion metrics, computed identically for reference videos and simulation runs.

Both sources are reduced to a sequence of binary "wax silhouette" masks inside a "globe" mask
(front view). Metrics are normalised by globe width / height so different lamps compare.

usage:
  python3 tools/ref/metrics.py video <config-name>      # one reference clip (see refs.json)
  python3 tools/ref/metrics.py refs                     # all clips -> tools/ref/reference_metrics.json
  python3 tools/ref/metrics.py sim <masks.bin>          # masks written by tools/simclip.mjs
"""
import json, subprocess, sys, os
import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
VID = os.path.join(ROOT, 'reference', 'video')
NB = 10  # height bins


def probe(path):
    o = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                        'stream=width,height', '-of', 'csv=p=0', path], capture_output=True, text=True).stdout
    w, h = o.strip().split(',')[:2]
    return int(w), int(h)


def read_frames(path, fps, w, start=0, dur=None):
    W, H = probe(path)
    h = int(round(H * w / W / 2)) * 2
    cmd = ['ffmpeg', '-v', 'error', '-ss', str(start)] + (['-t', str(dur)] if dur else []) + \
          ['-i', path, '-vf', f'fps={fps},scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    raw = subprocess.run(cmd, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3).astype(np.float32)


def otsu(v):
    hist, edges = np.histogram(v, 256)
    p = hist / hist.sum(); c = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(p); m = np.cumsum(p * c); mt = m[-1]
    s = (mt * w0 - m) ** 2 / (w0 * (1 - w0) + 1e-12)
    return c[np.argmax(s)]


def video_masks(cfg):
    path = os.path.join(VID, cfg['file'])
    F = read_frames(path, cfg.get('fps', 4), cfg.get('w', 240), cfg.get('start', 0), cfg.get('dur'))
    lum = F.mean(-1)
    globe = ndimage.binary_opening(lum.max(0) > cfg.get('globeThresh', 40), iterations=2)
    globe = ndimage.binary_fill_holes(globe)
    lab, n = ndimage.label(globe)
    globe = lab == (np.argmax(ndimage.sum(globe, lab, range(1, n + 1))) + 1)
    globe = ndimage.binary_erosion(globe, iterations=2)  # stay off the glass edge
    if cfg.get('crop'):  # [top, bottom] fractions of frame rows to ignore (overlays, base)
        t, b = cfg['crop']; hh = globe.shape[0]
        globe[:int(t * hh)] = False; globe[hh - int(b * hh):] = False
    feat = cfg.get('feature', 'gr')
    if feat == 'gr':   # wax paler than a saturated liquid
        v = F[..., 1] / (F[..., 0] + 8)
    elif feat == 'lum':  # wax brighter than a dark liquid
        v = lum
    elif feat == 'sat':  # wax more saturated than a pale liquid
        mx, mn = F.max(-1), F.min(-1); v = (mx - mn) / (mx + 8)
    vals = v[:, globe]
    thr = cfg.get('thresh') or otsu(vals[:, ::3].ravel())
    wax = (v > thr) if not cfg.get('invert') else (v < thr)
    wax &= globe[None]
    wax = np.stack([ndimage.binary_opening(m, iterations=1) for m in wax])
    return wax, globe, cfg.get('speed', 1.0) / cfg.get('fps', 4), F


def metrics(wax, globe, dt, full=True, realtime=True):
    """wax: [T,H,W] bool, globe: [H,W] bool, dt: seconds of lamp time between frames."""
    rows = np.where(globe.any(1))[0]
    y0, y1 = rows.min(), rows.max() + 1   # top, bottom (image rows: top=0)
    Hg = y1 - y0
    widths = globe.sum(1).astype(float)
    Wg = np.median(widths[y0:y1])
    # --- area and vertical profile (fraction of each height bin covered; bin 0 = bottom)
    prof = np.zeros(NB)
    for b in range(NB):
        r1 = y1 - int(b * Hg / NB); r0 = y1 - int((b + 1) * Hg / NB)
        g = globe[r0:r1].sum()
        prof[b] = wax[:, r0:r1].sum() / (g * len(wax) + 1e-9)
    area = wax.sum() / (globe.sum() * len(wax))
    # --- components per frame
    blobs, ncomp, colspan, topreach, topocc = [], [], [], [], []
    tracks = []
    top_rows = slice(y0, y0 + max(1, int(0.15 * Hg)))
    for t, m in enumerate(wax):
        lab, n = ndimage.label(m)
        topreach.append(bool(m[top_rows].any()))
        topocc.append(m[top_rows].sum() / max(1, globe[top_rows].sum()))
        cur = []
        maxspan = 0
        if n:
            objs = ndimage.find_objects(lab)
            sizes = ndimage.sum(m, lab, range(1, n + 1))
            for i, sl in enumerate(objs):
                a = sizes[i]
                if a < 0.0015 * Wg * Wg: continue  # specks
                ys, xs = sl
                span = (ys.stop - ys.start) / Hg
                maxspan = max(maxspan, span)
                touches_bottom = ys.stop >= y1 - 0.06 * Hg
                touches_top = ys.start <= y0 + 0.04 * Hg
                cy, cx = ndimage.center_of_mass(lab[sl] == i + 1)
                cy += ys.start
                if not touches_bottom and not touches_top:
                    blobs.append(2 * np.sqrt(a / np.pi) / Wg)
                    cur.append((cy, cx + xs.start, a))
        ncomp.append(len(cur))
        colspan.append(maxspan)
        tracks.append(cur)
    # --- blob vertical speeds (match each blob to the nearest similar blob next frame)
    speeds = []
    if realtime:
        for a, b in zip(tracks[:-1], tracks[1:]):
            for (y, x, ar) in a:
                best, bd = None, 1e9
                for (y2, x2, ar2) in b:
                    if not (0.6 < ar2 / ar < 1.6): continue
                    d = np.hypot(y2 - y, x2 - x)
                    if d < bd: bd, best = d, (y2, x2)
                if best is not None and bd < 0.25 * Wg:
                    speeds.append(abs(best[0] - y) / Wg / dt)
    blobs = np.array(blobs) if blobs else np.zeros(1)
    out = {
        'frames': len(wax), 'seconds': len(wax) * dt,
        'area': float(area),
        'blob_d_med': float(np.median(blobs)), 'blob_d_p90': float(np.percentile(blobs, 90)),
        'blobs_per_frame': float(np.mean(ncomp)),
        'col_span_med': float(np.median(colspan)), 'col_frac': float(np.mean(np.array(colspan) > 0.6)),
    }
    if full:
        out.update({'profile': [round(float(v), 4) for v in prof],
                    'top_reach': float(np.mean(topreach)), 'top_occ': float(np.mean(topocc))})
    if realtime and speeds:
        s = np.array(speeds)
        out.update({'speed_med': float(np.median(s)), 'speed_p90': float(np.percentile(s, 90))})
    return out


def load_sim(path):
    with open(path, 'rb') as f:
        hdr = json.loads(f.readline())
        T, H, W = hdr['frames'], hdr['h'], hdr['w']
        data = np.frombuffer(f.read(), np.uint8)
    globe = data[:H * W].reshape(H, W) > 0
    wax = data[H * W:H * W * (T + 1)].reshape(T, H, W) > 0
    return wax, globe, hdr['dt'], hdr


def save_overlay(path, wax, globe, frames=None, n=8):
    from PIL import Image
    idx = np.linspace(0, len(wax) - 1, n).astype(int)
    tiles = []
    for i in idx:
        img = np.zeros(globe.shape + (3,), np.uint8)
        img[globe] = (60, 30, 90); img[wax[i]] = (255, 140, 40)
        if frames is not None:
            img = np.concatenate([frames[i].astype(np.uint8), img], 0)
        tiles.append(img)
    Image.fromarray(np.concatenate(tiles, 1)).save(path)


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode in ('video', 'refs'):
        refs = json.load(open(os.path.join(HERE, 'refs.json')))
        names = [sys.argv[2]] if mode == 'video' else [k for k in refs if not k.startswith('_')]
        allm = {}
        for k in names:
            c = refs[k]
            wax, globe, dt, F = video_masks(c)
            m = metrics(wax, globe, dt, full=c.get('full', False), realtime=c.get('speed', 1) == 1)
            m['note'] = c.get('note', '')
            allm[k] = m
            os.makedirs(os.path.join(HERE, 'masks'), exist_ok=True)
            save_overlay(os.path.join(HERE, 'masks', k + '.png'), wax, globe, F)
            print(k, json.dumps(m))
        if mode == 'refs':
            json.dump(allm, open(os.path.join(HERE, 'reference_metrics.json'), 'w'), indent=1)
    elif mode == 'sim':
        wax, globe, dt, hdr = load_sim(sys.argv[2])
        m = metrics(wax, globe, dt, full=True, realtime=True)
        if len(sys.argv) > 3: save_overlay(sys.argv[3], wax, globe, n=12)
        print(json.dumps(m))
