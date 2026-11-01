// Adversarial headless browser probe. Run from the CarLab repo root after `npm run build`,
// via `lm-remote --host local --gpu`. Functional checks only, not a benchmark.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preview } from 'vite';
import puppeteer from 'puppeteer-core';

const PAYLOAD = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
const results = {}, errors = [], dialogs = [];
const temp = await mkdtemp(join(tmpdir(), 'carlab-adv-'));
const server = await preview({ configFile: 'preview.config.ts', build: { outDir: 'dist/client' }, preview: { host: '127.0.0.1', port: 0, strictPort: false } });
const executablePath = process.env.CHROME_PATH ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'].find(existsSync);
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
const step = async (name, fn) => { try { results[name] = await fn(); } catch (error) { results[name] = { failed: String(error?.message ?? error).slice(0, 300) }; } };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
  page.on('pageerror', e => errors.push(String(e?.stack ?? e).slice(0, 400)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });
  page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
  await page.evaluateOnNewDocument(() => { window.__xss = 0; });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await page.goto(`${origin}?mode=scholar&lang=pt`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__engineLab?.getBackend?.() === 'rust-wasm-v3', { timeout: 30000 });
  const setValue = (sel, value) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, value);
  const click = sel => page.$eval(sel, el => el.click());
  const upload = async (sel, name, text) => { const p = join(temp, name); await writeFile(p, text); await (await page.$(sel)).uploadFile(p); await new Promise(r => setTimeout(r, 600)); };

  await step('library save + hostile import', async () => {
    await setValue('#library-name', PAYLOAD); await setValue('#library-notes', PAYLOAD); await click('#library-save');
    await setValue('#library-exhaust-name', PAYLOAD); await click('#library-exhaust-save');
    const lib = await page.evaluate(() => JSON.parse(localStorage.getItem('carlab-engine-lab-library-v1')));
    lib.projects[0].name = PAYLOAD + '2'; lib.projects[0].revisions[0].notes = PAYLOAD;
    await upload('#library-panel input[type=file]', 'lib.json', JSON.stringify(lib));
    return { projects: await page.evaluate(() => JSON.parse(localStorage.getItem('carlab-engine-lab-library-v1')).projects.length), status: await page.$eval('#library-status', e => e.textContent.slice(0, 160)) };
  });
  await step('VE map hostile provenance', async () => {
    const map = JSON.parse(await page.$eval('#physical-ve-map-json', e => e.value));
    map.provenance = { ...map.provenance, label: PAYLOAD, notes: PAYLOAD, version: PAYLOAD.slice(0, 50) };
    await setValue('#physical-ve-map-json', JSON.stringify(map)); await click('#physical-ve-map-apply');
    return (await page.$eval('#physical-ve-map-status', e => e.textContent)).slice(0, 200);
  });
  await step('material card hostile name', async () => {
    const card = { schema: 1, name: PAYLOAD, provenance: { kind: 'assumed', source: PAYLOAD, conditions: PAYLOAD }, allowableStressMPa: [{ temperatureK: 300, stressMPa: 200 }, { temperatureK: 500, stressMPa: 150 }] };
    await setValue('#material-json', JSON.stringify(card)); await click('#material-apply');
    return (await page.$eval('#material-card-status', e => e.textContent)).slice(0, 200);
  });
  await step('ECU CSV hostile id', async () => {
    await upload('#ecu-observation-file', 'ecu.csv', `id,rpm,map_bar_abs,observed_lambda,split\n"${PAYLOAD}",2500,0.7,1.05,train\n=HYPERLINK("http://example.invalid"),3000,0.8,1.0,train\n`);
    return (await page.$eval('#ecu-observation-status', e => e.textContent)).slice(0, 200);
  });
  await step('config import hostile enums', async () => {
    await upload('#config-file', 'cfg.json', JSON.stringify({ config: { cylinders: 4, layout: PAYLOAD, perspective: PAYLOAD, firingAngles: [PAYLOAD], displacement: 1e308 }, physical: { veMap: { provenance: { label: PAYLOAD } } } }));
    return await page.evaluate(() => { const c = window.__engineLab.getConfig(); return { layout: c.layout, perspective: c.perspective, displacement: c.displacement }; });
  });
  await step('pressure source text', async () => { await setValue('#pressure-source', PAYLOAD); return true; });
  await step('xss outcome', async () => page.evaluate(() => ({ xssCounter: window.__xss, injectedImgX: document.querySelectorAll('img[src="x"]').length, literalPayloadShownAsText: document.body.innerText.includes('<img src=x') })));

  await step('audio rapid toggles', async () => {
    for (let i = 0; i < 12; i++) { await click('#power'); await new Promise(r => setTimeout(r, 40 + (i % 3) * 30)); }
    await new Promise(r => setTimeout(r, 1500));
    return await page.evaluate(() => ({ running: window.__engineLab.isRunning(), audio: window.__engineLab.audioState(), status: document.getElementById('status').textContent }));
  });
  await step('audio churn while running', async () => {
    if (!(await page.evaluate(() => window.__engineLab.isRunning()))) await click('#power');
    await page.waitForFunction(() => window.__engineLab.isRunning(), { timeout: 10000 });
    for (let i = 0; i < 9; i++) { await page.evaluate(i => window.__engineLab.selectPreset(i), i); await new Promise(r => setTimeout(r, 120)); }
    await page.evaluate(() => window.__engineLab.setConfig({ cylinders: 12, redline: 18000, idleRpm: 2400, displacement: 12, boostBar: 2.5 }));
    await new Promise(r => setTimeout(r, 2000));
    return await page.evaluate(() => { const t = window.__engineLab.getTelemetry(); return { running: window.__engineLab.isRunning(), audio: window.__engineLab.audioState(), finite: Object.values(t).filter(v => typeof v === 'number').every(Number.isFinite), rpm: t.rpm }; });
  });
  await step('navigate away and back', async () => {
    await page.goto('about:blank'); await page.goBack({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__engineLab?.getBackend?.() === 'rust-wasm-v3', { timeout: 30000 });
    await new Promise(r => setTimeout(r, 1000));
    return await page.evaluate(() => ({ running: window.__engineLab.isRunning(), cfg: window.__engineLab.getConfig().cylinders }));
  });
  await step('beforeunload alone keeps model usable', async () => { await page.evaluate(() => window.dispatchEvent(new Event('beforeunload'))); await new Promise(r => setTimeout(r, 500)); return await page.evaluate(() => window.__engineLab.getPowertrainState().rpm > 0); });
} finally {
  await browser.close(); await server.httpServer.close(); await rm(temp, { recursive: true, force: true });
}
console.log(JSON.stringify({ results, errors: errors.slice(0, 20), errorCount: errors.length, dialogs }, null, 1));
