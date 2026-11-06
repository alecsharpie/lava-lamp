// Frame-cost benchmark: headless Chrome on the real GPU. The page's ?prof=1 profiler waits for each
// frame's GPU work, so costs show even while the frame rate is locked at 60. Compare scenarios that
// switch features off to see what each one costs.
// usage: node tools/bench.mjs [scenarios.json] [w=1440 h=900 dpr=2]
//   scenarios: [{ "name", "query"?, "js"? }]  (js runs after load; quality is pinned so it can't adapt)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const require = createRequire(homedir() + '/.claude/skills/screenshot-verify/package.json');
const { chromium } = require('playwright');

const [file, w = '1440', h = '900', dpr = '2'] = process.argv.slice(2);
const port = process.env.PORT || 8766;
const scenarios = file ? JSON.parse(readFileSync(file, 'utf8')) : [{ name: 'default' }];
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

console.log(`viewport ${w}x${h} @${dpr}x  (per-frame CPU+GPU time with a GPU sync; p25 is the least-disturbed estimate)`);
const rounds = +(process.env.ROUNDS || 2);
const res = {};
for (let round = 0; round < rounds; round++) for (const s of scenarios) {
  const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: +dpr });
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.goto(`http://localhost:${port}/?hideui=1&prof=1&${s.query || ''}`);
  await page.waitForFunction(() => window.LL && window.LL.stats, null, { timeout: 60000 });
  await page.evaluate(`LL.view.quality = '${s.quality || 'Auto'}'; LL.resize();`);
  if (s.js) await page.evaluate(s.js);
  await page.waitForTimeout(3000);
  await page.evaluate(() => { window.LL.prof.samples.length = 0; window.__f0 = window.LL.rendered; });
  await page.waitForTimeout(5000);
  const r = await page.evaluate(() => ({ s: [...window.LL.prof.samples].sort((a, b) => a - b), f: window.LL.rendered - window.__f0, pr: window.LL.pr }));
  const q = (p) => r.s[Math.floor(r.s.length * p)] || 0;
  (res[s.name] ||= []).push({ p25: q(0.25), med: q(0.5), fps: r.f / 5, pr: r.pr });
  await page.close();
}
for (const s of scenarios) {
  const v = res[s.name], p25 = Math.min(...v.map(x => x.p25)), med = Math.min(...v.map(x => x.med)), fps = v[0].fps;
  console.log(`${s.name.padEnd(26)} p25 ${p25.toFixed(2).padStart(6)} ms  median ${med.toFixed(2).padStart(6)} ms  x ${fps.toFixed(0).padStart(3)} frames/s  = ${(p25 * fps / 10).toFixed(0).padStart(3)}% of a second  pr ${v[0].pr}`);
}
await browser.close();
