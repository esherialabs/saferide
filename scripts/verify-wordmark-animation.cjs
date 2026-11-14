// Synthetic browser proof of the production component through ui-reskin-preview.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const base = process.argv[2] || 'http://127.0.0.1:8127';
const output = process.argv[3];
if (!output) throw Error('Provide a task-owned output directory as the second argument.');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
  const results = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const open = async (screen, theme, width) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${base}/?screen=${screen}&theme=${theme}&chrome=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const logo = page.getByRole('img', { name: 'SafeRide logo', exact: true }).first();
      await logo.waitFor({ timeout: 60000 });
      await page.waitForFunction(() => {
        const root = document.querySelector('[role="img"][aria-label="SafeRide logo"]');
        return root && [...root.querySelectorAll('img')].every(im => im.complete && im.naturalWidth > 0);
      });
      const measured = await logo.evaluate(el => {
        const artwork = el.querySelector('img[src*="-letters.png"]')?.parentElement ?? el.querySelector('img[src*="/logo"]')?.parentElement ?? el;
        const box = artwork.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && Math.abs(box.width / box.height - 1200 / 263) < .02;
      });
      assert(measured, `Wordmark bounds/proportions: ${screen}/${theme}/${width}`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow');
      return logo;
    };
    const sample = logo => logo.evaluate(el => [...el.querySelectorAll('img[src*="highlight-"]')].map(im => Number(getComputedStyle(im.parentElement).opacity)));
    const allFull = async logo => (await sample(logo)).every(value => value === 1);

    for (const theme of ['light', 'dark', 'highContrast']) {
      for (const width of [320, 390, 430]) {
        const logo = await open('landing', theme, width);
        assert.equal((await sample(logo)).length, 8);
        await page.screenshot({ path: path.join(output, `landing-${theme}-${width}.png`) });
        results.push({ screen: 'landing', theme, width, bounds: 'passed', assets: 'passed' });
      }
    }
    for (const screen of ['home', 'settings', 'splash', 'sign-in', 'onboarding']) {
      const logo = await open(screen, 'light', 320);
      if (screen === 'sign-in' || screen === 'onboarding') {
        assert.equal((await sample(logo)).length, 0, 'Existing animated=false opt-out must remain static');
      }
      results.push({ screen, theme: 'light', width: 320, bounds: 'passed', assets: 'passed' });
    }

    const logo = await open('landing', 'light', 390);
    const sequence = [];
    const geometry = await logo.boundingBox();
    for (let elapsed = 0; elapsed < 14200; elapsed += 200) {
      const values = await sample(logo);
      assert(values.every(value => value >= .379 && value <= 1), 'Every original colour stays visible');
      assert(values.filter(value => value < .999).length <= 2, 'Only adjacent highlights fade');
      const lowest = values.indexOf(Math.min(...values));
      if (Math.min(...values) < .9 && sequence.at(-1) !== lowest) sequence.push(lowest);
      const box = await logo.boundingBox();
      assert.deepEqual(box, geometry, 'Lettering/layout must remain fixed');
      await page.waitForTimeout(200);
    }
    assert(sequence.length >= 8, 'At least one complete sequence observed');
    for (let i = 1; i < sequence.length; i++) assert.equal(sequence[i], (sequence[i - 1] + 1) % 8, 'Left-to-right following order');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    assert(await allFull(logo), 'Live reduced-motion change restores all colours');
    await page.waitForTimeout(500);
    assert(await allFull(logo), 'Reduced-motion logo stays static');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(500);
    assert(!(await allFull(logo)), 'Animation restarts after reduced motion is disabled');

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(200);
    assert(await allFull(logo), 'Background restores full static colours');
    await page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);
    assert(!(await allFull(logo)), 'Foreground restarts the sequence');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(output, 'landing-static-reduced-motion.png') });
    // Record the preview's generic NetworkError separately; do not claim a clean
    // browser console from synthetic layout proof or infer its source here.
    const unexpected = errors.filter(error => error !== 'A network error occurred.');
    assert.deepEqual(unexpected, [], 'Unexpected runtime errors');
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({
      layouts: results, sequence, motion: 'passed', reducedMotion: 'passed', background: 'passed', fixedGeometry: 'passed',
      genericPreviewNetworkErrors: errors.length - unexpected.length,
      scope: 'React Native Web synthetic preview; native device/TalkBack acceptance pending',
    }, null, 2) + '\n');
    console.log(`Passed ${results.length} layouts, asset loading, ordered motion, static opt-outs, reduced motion and background cleanup.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
