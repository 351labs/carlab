import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { preview } from 'vite';
import puppeteer from 'puppeteer-core';

// Functional checks only. Run via lm-remote --host local --gpu; not a benchmark.
const proof = process.env.ENGINE_LAB_PROOF ?? 'output/review-fixes/workshop';
await mkdir(proof, { recursive: true });
const checks = [], errors = [], uploads = [], platformRequests = [], models = {}, translations = {};
let server, browser, failure;
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
try {
  // Vite preview does not process Cloudflare's _headers; apply the exact global
  // headers from that file so local browser checks exercise the deployed policy.
  const headerLines = (await readFile('public/_headers', 'utf8')).split('\n');
  const globalHeaders = {};
  for (const line of headerLines.slice(1)) {
    if (!/^\s/.test(line)) break;
    const match = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (match) globalHeaders[match[1]] = match[2];
  }
  if (!process.env.CARLAB_TEST_URL) server = await preview({ configFile: 'preview.config.ts', plugins: [{ name: 'test-cloudflare-global-headers', configurePreviewServer(vite) { vite.middlewares.use((_req, res, next) => { for (const [name, value] of Object.entries(globalHeaders)) res.setHeader(name, value); next(); }); } }], build: { outDir: process.env.ENGINE_LAB_DIST ?? 'dist/client' }, preview: { host: '127.0.0.1', port: 0, strictPort: false } });

  const executablePath = process.env.CHROME_PATH ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'].find(existsSync);
  const args = ['--mute-audio', '--autoplay-policy=user-gesture-required'];
  if (process.env.CARLAB_TEST_DNS_ADDRESS) {
    assert.equal(isIP(process.env.CARLAB_TEST_DNS_ADDRESS), 4);
    assert.ok(process.env.CARLAB_TEST_URL);
    args.push(`--host-resolver-rules=MAP ${new URL(process.env.CARLAB_TEST_URL).hostname} ${process.env.CARLAB_TEST_DNS_ADDRESS}`);
  }
  browser = await puppeteer.launch({ executablePath, headless: true, args });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.stack ?? String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => {
    if (['GET', 'HEAD'].includes(request.method())) return;
    const url = new URL(request.url());
    if (process.env.CARLAB_TEST_URL && url.origin === new URL(process.env.CARLAB_TEST_URL).origin && url.pathname.startsWith('/cdn-cgi/challenge-platform/')) platformRequests.push({ method: request.method(), platform: 'Cloudflare security check' });
    else uploads.push(request.url());
  });
  const origin = process.env.CARLAB_TEST_URL ?? `http://127.0.0.1:${server.httpServer.address().port}/`;
  const noDebug = await browser.newPage();
  const plain = new URL(origin); plain.searchParams.delete('debug');
  const plainResponse = await noDebug.goto(plain.href, { waitUntil: 'networkidle0' });
  const csp = plainResponse.headers()['content-security-policy'] ?? '';
  check('production page sends the configured CSP and denies framing', csp === globalHeaders['Content-Security-Policy'] && plainResponse.headers()['x-frame-options'] === 'DENY');
  check('production diagnostics are absent without an explicit debug flag', await noDebug.evaluate(() => !('__engineLab' in window) && !!document.querySelector('#power')));
  check('CSP blocks inline script and cross-origin requests', await noDebug.evaluate(async () => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective));
    const script = document.createElement('script'); script.textContent = 'window.__cspInlineRan = true'; document.head.append(script);
    let fetchBlocked = false;
    try { await fetch('https://example.invalid/carlab-csp-check'); } catch { fetchBlocked = true; }
    await new Promise(resolve => setTimeout(resolve, 100));
    return !window.__cspInlineRan && fetchBlocked && violations.includes('script-src-elem') && violations.includes('connect-src');
  }));
  await noDebug.close();
  const target = new URL(origin); target.searchParams.set('mode', 'normal'); target.searchParams.set('lang', 'pt'); target.searchParams.set('debug', '1');
  const url = target.href;
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__engineLab?.workshop().meshes > 0 && window.__engineLab.workshop().triangles > 0, { timeout: 30000 });
  check('Rust backend and real WebGL geometry initialize without starting audio', await page.evaluate(() => window.__engineLab.getBackend() === 'rust-wasm-v3' && !window.__engineLab.isRunning() && window.__engineLab.workshop().available));
  check('Normal hides research and calibration controls', await page.evaluate(() => ['parameters-panel', 'physics-panel', 'ecu-panel', 'cycle-panel', 'thermal-panel', 'library-panel'].every(id => getComputedStyle(document.getElementById(id)).display === 'none')));
  check('Normal retains listening, pedal, RPM and WAV controls', await page.evaluate(() => ['power', 'rpm', 'throttle-input', 'export-wav'].every(id => document.getElementById(id).getBoundingClientRect().height > 0)));
  const select = async (selector, value) => { await page.select(selector, value); };
  const input = async (selector, value) => { await page.$eval(selector, (element, v) => { element.value = String(v); element.dispatchEvent(new Event('input', { bubbles: true })); }, value); };
  const part = async id => {
    await page.click(`[data-part="${id}"]`);
    await page.waitForFunction(id => { const d = window.__engineLab.workshop(); return d.part === id && !d.loading && d.meshes > 0 && d.triangles > 0; }, {}, id);
  };
  for (const id of ['engine', 'turbo', 'exhaust', 'injection', 'instruments']) {
    await part(id);
    models[id] = await page.evaluate(() => window.__engineLab.workshop());
    check(`${id} loads a distinct inspectable 3D assembly`, models[id].meshes > 10 && !models[id].error);
    await page.click('[data-view="cutaway"]');
    await page.click('[data-view="exploded"]');
    check(`${id} accepts cutaway and exploded views`, await page.evaluate(() => { const d = window.__engineLab.workshop(); return d.cutaway && d.exploded === 1; }));
    await page.$eval('#workshop-panel', element => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `${proof}/${id}-cutaway.png` });
    await page.click('[data-view="reset"]');
  }
  await part('engine');
  await select('[data-preset-select]', '8');
  await page.waitForFunction(() => window.__engineLab.getConfig().cylinders === 12);
  check('the visible engine selector updates the actual engine topology', await page.evaluate(() => window.__engineLab.getConfig().layout === 'v'));
  await input('[data-config="displacement"]', 5.5);
  check('the workshop displacement control updates the simulation', await page.evaluate(() => window.__engineLab.getConfig().displacement === 5.5));
  await part('turbo'); await page.click('[data-turbo="compact"]');
  check('the compact turbo recipe reaches the actual configuration', await page.evaluate(() => { const c = window.__engineLab.getConfig(); return c.boostBar === .8 && c.turboSize === .25; }));
  await part('exhaust'); await page.click('[data-exhaust-recipe="open"]');
  check('exhaust recipe updates acoustic and explicitly assumed physical controls', await page.evaluate(() => window.__engineLab.getConfig().muffler === .05 && window.__engineLab.getPhysical().exhaustRestrictionK === 2));
  const configBeforeModes = await page.evaluate(() => JSON.stringify(window.__engineLab.getConfig()));
  await select('[data-workshop-mode]', 'enthusiast');
  check('Enthusiast reveals tuning, comparisons and EFI', await page.evaluate(() => ['parameters-panel', 'bench-panel', 'physics-panel', 'ecu-panel'].every(id => getComputedStyle(document.getElementById(id)).display !== 'none') && getComputedStyle(document.getElementById('cycle-panel')).display === 'none'));
  await select('[data-workshop-mode]', 'scholar');
  check('Scholar reveals cycle, thermal and provenance workflows', await page.evaluate(() => ['cycle-panel', 'thermal-panel', 'library-panel'].every(id => getComputedStyle(document.getElementById(id)).display !== 'none')));
  check('changing experience modes preserves the engine', await page.evaluate(expected => JSON.stringify(window.__engineLab.getConfig()) === expected, configBeforeModes));
  await select('[data-workshop-mode]', 'normal');
  await part('injection'); await select('[data-fuel]', 'diesel');
  await page.waitForFunction(() => window.__engineLab.getPhysical().ecu?.combustionMode === 'directInjectionDiesel' && window.__engineLab.workshop().metadata?.enabled);
  check('diesel selection enables the Rust DI controller', await page.evaluate(() => window.__engineLab.getPhysical().ecu.enabled));
  await select('[data-fuel]', 'e85');
  await page.waitForFunction(() => window.__engineLab.getPhysical().ecu?.fuel.ethanolVolumeFraction === .85);
  check('E85 selection restores spark injection and the requested blend', await page.evaluate(() => window.__engineLab.getPhysical().ecu.combustionMode === 'portInjectionSpark'));
  await select('[data-workshop-mode]', 'enthusiast');
  await input('#physical-brake', 73); await select('#physical-gear', '2');
  await select('[data-workshop-mode]', 'normal');
  await page.waitForFunction(() => document.querySelector('#normal-drive-brake').value === '73');
  check('Normal exposes retained physical brake and gear instead of hiding them', await page.evaluate(() => !document.querySelector('#normal-physical-controls').hidden && document.querySelector('#normal-drive-gear').value === '2'));
  await input('#normal-drive-brake', 0); await select('#normal-drive-gear', '1');
  check('Normal physical controls write through to the shared driver', await page.evaluate(() => document.querySelector('#physical-brake').value === '0' && document.querySelector('#physical-gear').value === '1'));
  await page.click('#power');
  await page.waitForFunction(() => window.__engineLab.isRunning() && window.__engineLab.getTelemetry().combustionEvents > 0 && window.__engineLab.audioState() === 'running', { timeout: 15000 });
  check('the redesigned controls start real Rust AudioWorklet combustion', true);
  await input('#throttle-input', 62);
  check('Normal pedal controls the physical driver after selecting fuel', await page.$eval('#physical-throttle', element => Number(element.value) === 62));
  await page.click('#power'); await page.waitForFunction(() => !window.__engineLab.isRunning());
  check('the redesigned power control stops playback', true);
  await page.$eval('#v12-steady-before', audio => audio.play());
  await page.waitForFunction(() => document.querySelector('#v12-steady-before').currentTime > .1, { timeout: 10000 });
  check('same-origin reference media plays under the policy', await page.$eval('#v12-steady-before', audio => audio.error === null && audio.duration > 0));
  await page.$eval('#v12-steady-before', audio => audio.pause());
  await page.click('#export-wav');
  await page.waitForFunction(() => window.__engineLab.getLastDownload()?.name === 'engine-physical.wav', { timeout: 60000 });
  check('Normal WAV export follows physical EFI driving rather than a hidden acoustic scenario', await page.evaluate(() => window.__engineLab.getLastDownload().bytes === 12 * 48000 * 4 + 44));
  await part('engine');
  const beforeLanguages = await page.evaluate(() => JSON.stringify(window.__engineLab.getConfig()));
  const rawNotes = '{"source":"Português / 日本語 user input"}';
  await page.$eval('#physical-ve-map-json', (element, value) => { element.value = value; }, rawNotes);
  for (const lang of ['pt', 'en', 'zh', 'ja', 'es', 'ko', 'fr']) {
    await select('[data-workshop-language]', lang);
    await page.waitForFunction(lang => document.documentElement.lang === (lang === 'zh' ? 'zh-Hans' : lang), {}, lang);
    translations[lang] = await page.evaluate(() => ({ title: document.querySelector('.workshop-title h2').textContent, engine: document.querySelector('[data-part="engine"]').textContent, power: document.querySelector('#power').textContent, mode: document.querySelector('[data-workshop-mode] option:checked').textContent }));
    check(`${lang} switches the visible workshop language`, translations[lang].title.length > 0 && (lang === 'en' || translations[lang].title !== translations.en?.title));
  }
  check('all seven locales have distinct workshop titles', new Set(Object.values(translations).map(value => value.title)).size === 7);
  check('language changes preserve the simulation configuration', await page.evaluate(expected => JSON.stringify(window.__engineLab.getConfig()) === expected, beforeLanguages));
  check('language changes preserve user-entered JSON exactly', await page.$eval('#physical-ve-map-json', (element, expected) => element.value === expected, rawNotes));
  await select('[data-workshop-language]', 'ja');
  check('Japanese also translates the edited-engine heading and voice tags', await page.evaluate(() => !document.querySelector('#engine-name').textContent.includes('Sua configuração') && !document.querySelector('#voice-tags').textContent.includes('cilindrada')));
  await page.screenshot({ path: `${proof}/desktop-ja.png` });
  check('beforeunload alone preserves the native model until navigation commits', await page.evaluate(() => { window.dispatchEvent(new Event('beforeunload')); return Number.isFinite(window.__engineLab.getPowertrainState().rpm); }));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__engineLab?.workshop().meshes > 0);
  check('language and mode survive reload through the shareable URL', await page.evaluate(() => window.__engineLab.getLocale() === 'ja' && window.__engineLab.getMode() === 'normal'));
  await select('[data-workshop-language]', 'pt');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.$eval('#workshop-panel', element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${proof}/mobile-pt.png`, fullPage: true });
  check('mobile layout has no horizontal document overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  check('camera buttons provide keyboard-focusable alternatives to dragging', await page.$$eval('[data-camera-action]', elements => elements.length === 4 && elements.every(element => element.getAttribute('aria-label') && !element.disabled)));
  for (const lang of ['en', 'zh', 'ja', 'es', 'ko', 'fr']) {
    await select('[data-workshop-language]', lang);
    const layout = await page.evaluate(() => ({ fits: document.documentElement.scrollWidth <= innerWidth + 1, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('body *')].filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1) && getComputedStyle(element).position !== 'fixed'; }).map(element => ({ tag: element.tagName, id: element.id, class: element.className, right: element.getBoundingClientRect().right, text: element.textContent.slice(0, 120) })).slice(0, 25) }));
    if (!layout.fits) { await writeFile(`${proof}/overflow-${lang}.json`, JSON.stringify(layout, null, 2) + '\n'); await page.screenshot({ path: `${proof}/overflow-${lang}.png`, fullPage: true }); }
    check(`${lang} mobile layout fits the viewport`, layout.fits);
  }
  await select('[data-workshop-language]', 'pt');
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
  await page.$eval('#workshop-panel', element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${proof}/desktop-pt.png` });
  const i18n = await page.evaluate(() => window.__engineLab.getI18nDiagnostics());
  await writeFile(`${proof}/translation-coverage.json`, JSON.stringify(i18n, null, 2) + '\n');
  // Exercise an actual BFCache restoration, preserving the original document.
  await page.evaluate(() => { window.__bfcacheMarker = 'original'; window.__bfcacheShows = []; addEventListener('pageshow', event => window.__bfcacheShows.push(event.persisted)); });
  await page.click('#power'); await page.waitForFunction(() => window.__engineLab.isRunning() && window.__engineLab.audioState() === 'running');
  await page.goto('about:blank', { waitUntil: 'load' });
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForFunction(() => window.__engineLab && window.__bfcacheShows?.includes(true), { timeout: 20000 });
  check('BFCache restores the original document with audio stopped and powertrain intact', await page.evaluate(() => window.__bfcacheMarker === 'original' && window.__bfcacheShows.includes(true) && !window.__engineLab.isRunning() && Number.isFinite(window.__engineLab.getPowertrainState().rpm)));
  await page.click('#power');
  await page.waitForFunction(() => window.__engineLab.isRunning() && window.__engineLab.audioState() === 'running', { timeout: 15000 });
  await page.evaluate(() => window.__engineLab.selectPreset(3));
  check('audio and preset selection work after BFCache restoration', await page.evaluate(() => window.__engineLab.getConfig().cylinders === 4 && window.__engineLab.isRunning()));
  await page.click('#power'); await page.waitForFunction(() => !window.__engineLab.isRunning());
  const fallback = await browser.newPage();
  await fallback.evaluateOnNewDocument(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, ...args) { return String(kind).startsWith('webgl') ? null : original.call(this, kind, ...args); };
  });
  await fallback.goto(url.replace('lang=pt', 'lang=en'), { waitUntil: 'networkidle0' });
  await fallback.waitForFunction(() => window.__engineLab && !window.__engineLab.workshop().available);
  check('WebGL-unavailable fallback leaves audio and mathematical controls usable', await fallback.evaluate(() => document.querySelector('.workshop-render-status').textContent.includes('unavailable') && !document.querySelector('#power').disabled && window.__engineLab.getConfig().cylinders > 0));
  await fallback.close();
  check('no script or console errors occurred', errors.length === 0);
  check('application performs no uploads outside Cloudflare-managed security checks', uploads.length === 0);
} catch (error) { failure = error; }
finally {
  await browser?.close(); await server?.httpServer.close();
  await writeFile(`${proof}/browser-check.json`, JSON.stringify({ host: 'lm-remote runner (hostname omitted)', target: process.env.CARLAB_TEST_URL ?? 'local preview', dnsAddressOverride: process.env.CARLAB_TEST_DNS_ADDRESS ?? null, checks, models, translations, errors, uploads, platformRequests, failure: failure ? String(failure) : null, scope: 'Functional headless Chrome checks; no performance benchmark or real-engine fidelity claim. Cloudflare-managed security POSTs are recorded separately from application uploads.' }, null, 2) + '\n');
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: checks.length, errors: errors.length, uploads: uploads.length }));
