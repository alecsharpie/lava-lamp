"""Parameter search for the lava physics, scored against the reference-video metrics.

usage: python3 tools/ref/search.py <variants.json> [--secs 400] [--warm 200] [--jobs 8] [--out runs/x]
variants.json: {"name": {sim overrides...}, ...}   (a "_base" entry is merged into every variant)

Each variant runs tools/simclip.mjs from a molten (warm) start, discards the warm-up, records
front-view silhouettes, computes the same metrics as the reference clips, and gets a score
(sum of squared z-scores vs the reference targets; lower is better).
"""
import json, os, subprocess, sys, argparse
from concurrent.futures import ThreadPoolExecutor
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)
import metrics as M  # noqa: E402

REF = json.load(open(os.path.join(HERE, 'reference_metrics.json')))


def targets():
    def agg(k):
        v = [m[k] for m in REF.values() if k in m]
        return float(np.mean(v)) if v else None
    full = [m for m in REF.values() if 'profile' in m]
    return {
        # metric: (target, tolerance, weight)
        'blob_d_med': (agg('blob_d_med'), 0.10, 1.5),
        'blob_d_p90': (agg('blob_d_p90'), 0.10, 1.0),
        'area': (agg('area'), 0.08, 0.7),
        'col_frac': (agg('col_frac'), 0.15, 1.0),
        'blobs_per_frame': (agg('blobs_per_frame'), 0.5, 0.5),
        'speed_med': (agg('speed_med'), 0.05, 1.0),
        'speed_p90': (agg('speed_p90'), 0.08, 0.7),
        'top_reach': (float(np.mean([m['top_reach'] for m in full])), 0.25, 1.5),
        'prof0': (float(np.mean([m['profile'][0] for m in full])), 0.12, 1.5),  # pool sits on the glass
        'prof_mid': (float(np.mean([np.mean(m['profile'][3:7]) for m in full])), 0.08, 0.7),
    }


TARGETS = targets()


def score(m):
    m = dict(m)
    m['prof0'] = m['profile'][0]
    m['prof_mid'] = float(np.mean(m['profile'][3:7]))
    terms = {}
    for k, (t, tol, w) in TARGETS.items():
        v = m.get(k)
        terms[k] = 25.0 if v is None else w * ((v - t) / tol) ** 2
    return sum(terms.values()), terms


def run(name, ov, a):
    b = os.path.join(a.out, name + '.bin')
    subprocess.run(['node', os.path.join(ROOT, 'tools', 'simclip.mjs'), b, str(a.secs), json.dumps(ov), a.start, str(a.warm)],
                   check=True, capture_output=True)
    wax, globe, dt, _ = M.load_sim(b)
    m = M.metrics(wax, globe, dt, full=True, realtime=True)
    M.save_overlay(os.path.join(a.out, name + '.png'), wax, globe, n=14)
    s, terms = score(m)
    return name, s, terms, m


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('variants'); ap.add_argument('--secs', type=int, default=400)
    ap.add_argument('--warm', type=int, default=200); ap.add_argument('--jobs', type=int, default=8)
    ap.add_argument('--start', default='warm'); ap.add_argument('--out', default=os.path.join(ROOT, 'runs', 'search'))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    V = json.load(open(a.variants))
    base = V.pop('_base', {})
    jobs = {k: {**base, **v} for k, v in V.items()}
    print('targets:', {k: round(v[0], 3) for k, v in TARGETS.items()})
    res = []
    with ThreadPoolExecutor(a.jobs) as ex:
        for r in ex.map(lambda kv: run(kv[0], kv[1], a), jobs.items()):
            res.append(r)
            name, s, terms, m = r
            print(f'{name:>14} score {s:7.2f} | ' + ' '.join(f'{k}={m.get(k, m["profile"][0] if k == "prof0" else 0):.2f}' for k in ['blob_d_med', 'blob_d_p90', 'area', 'col_frac', 'speed_med', 'top_reach', 'prof0']), flush=True)
    res.sort(key=lambda r: r[1])
    print('\nranking:')
    for name, s, terms, m in res:
        worst = sorted(terms.items(), key=lambda kv: -kv[1])[:3]
        print(f'{name:>14} {s:7.2f}  worst: ' + ', '.join(f'{k} {v:.1f}' for k, v in worst) + f'  profile={m["profile"]}')
    json.dump([{'name': n, 'score': s, 'terms': t, 'metrics': m, 'params': jobs[n]} for n, s, t, m in res],
              open(os.path.join(a.out, 'results.json'), 'w'), indent=1)
