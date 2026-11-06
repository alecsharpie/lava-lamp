// Loads the page once, then applies JS snippets and screenshots each variant.
// usage: node tools/variants.mjs <outdir> <variants.json> [w h] [query]
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
const require = createRequire(homedir() + '/.claude/skills/screenshot-verify/package.json');
const { chromium } = require('playwright');

const [out, vfile, w = '1000', h = '760', query = 'hideui=1'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const variants = JSON.parse(readFileSync(vfile, 'utf8'));
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto(`http://localhost:${process.env.PORT || 8766}/?${query}`);
await page.waitForFunction(() => window.LL && window.LL.stats, null, { timeout: 60000 });
await page.waitForTimeout(2500);
for (const v of variants) {
  if (v.js) await page.evaluate(v.js);
  await page.waitForTimeout(v.wait ?? 1800);
  await page.screenshot({ path: `${out}/${v.name}.png` });
  console.log('shot', v.name);
}
await browser.close();
