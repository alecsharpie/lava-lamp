"""Random search + local refinement over the physics parameters, scored by search.py.

usage: python3 tools/ref/explore.py <out_dir> [rounds=4] [per_round=16] [--seed-from results.json]
Round 1 samples the whole RANGES box; later rounds perturb the best few so far.
Writes <out_dir>/best.json (best overrides) and per-round results.
"""
import json, os, random, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEF = json.loads(subprocess.run(['node', '-e', "import('./src/sim.js').then(m=>console.log(JSON.stringify(m.DEFAULTS)))"], cwd=os.path.join(HERE, '..', '..'), capture_output=True, text=True).stdout)
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))

RANGES = {
    'h': (0.0108, 0.0135), 'liqBottom': (0.41, 0.47), 'liqTop': (0.28, 0.38),
    'kLiq': (0.05, 0.16), 'insul': (0.03, 0.1), 'cohesion': (2.5, 6.0),
    'visHot': (0.004, 0.03), 'heater': (1.5, 3.5), 'heaterLambda': (0.22, 0.45), 'buoy': (20, 40),
    'dragSurf': (1.0, 3.0), 'kCond': (0.006, 0.025), 'floorWet': (0.0, 0.6),
    'heaterSpot': (0.3, 0.6), 'buoySmooth': (0.5, 1.0),
}


def sample(rng):
    return {k: round(rng.uniform(a, b), 4) for k, (a, b) in RANGES.items()}


def perturb(p, rng, s):
    q = dict(p)
    for k, (a, b) in RANGES.items():
        if rng.random() < 0.5:
            q[k] = round(min(b, max(a, q[k] + rng.gauss(0, s * (b - a)))), 4)
    return q


if __name__ == '__main__':
    out = sys.argv[1]; rounds = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    per = int(sys.argv[3]) if len(sys.argv) > 3 else 16
    os.makedirs(out, exist_ok=True)
    rng = random.Random(1)
    pool = []  # (score, params)
    if '--seed-from' in sys.argv:
        for r in json.load(open(sys.argv[sys.argv.index('--seed-from') + 1])):
            pool.append((r['score'], {k: r['params'].get(k, DEF.get(k)) for k in RANGES}))
    for rd in range(rounds):
        V = {}
        if not pool:
            for i in range(per): V[f'r{rd}_{i}'] = sample(rng)
        else:
            pool.sort(key=lambda t: t[0])
            elite = pool[:4]
            for i in range(per):
                base = elite[i % len(elite)][1]
                base = {**{k: DEF.get(k, (a + b) / 2) for k, (a, b) in RANGES.items()}, **base}
                V[f'r{rd}_{i}'] = perturb(base, rng, 0.18 / (1 + rd * 0.5)) if i >= 2 else (sample(rng) if i == 0 else perturb(base, rng, 0.05))
        vf = os.path.join(out, f'round{rd}.json'); json.dump(V, open(vf, 'w'), indent=1)
        rd_out = os.path.join(out, f'round{rd}')
        subprocess.run([sys.executable, os.path.join(HERE, 'search.py'), vf, '--out', rd_out, '--secs', '300', '--warm', '150'], check=True,
                       stdout=subprocess.DEVNULL)
        for r in json.load(open(os.path.join(rd_out, 'results.json'))):
            pool.append((r['score'], {k: r['params'].get(k, DEF.get(k)) for k in RANGES}))
        pool.sort(key=lambda t: t[0])
        print(f'round {rd}: best {pool[0][0]:.2f}  {json.dumps(pool[0][1])}', flush=True)
        json.dump({'score': pool[0][0], 'params': pool[0][1], 'top': pool[:6]}, open(os.path.join(out, 'best.json'), 'w'), indent=1)
