// Back/forward-cache lifecycle probe: run audio, navigate away, come back, use the page again.
import { existsSync } from 'node:fs';
import { preview } from 'vite';
import puppeteer from 'puppeteer-core';
const out = {}, errors = [];
const server = await preview({ configFile: 'preview.config.ts', build: { outDir: 'dist/client' }, preview: { host: '127.0.0.1', port: 0, strictPort: false } });
const executablePath = process.env.CHROME_PATH ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'].find(existsSync);
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
const pause = ms => new Promise(r => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e?.stack ?? e).slice(0, 400)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await page.goto(`${origin}?mode=enthusiast`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__engineLab?.getBackend?.() === 'rust-wasm-v3', { timeout: 30000 });
  await page.evaluate(() => { window.__marker = 'original-document'; window.__pageshows = []; addEventListener('pageshow', e => window.__pageshows.push(e.persisted)); });
  await page.click('#power'); await page.waitForFunction(() => window.__engineLab.isRunning(), { timeout: 10000 });
  out.beforeLeave = await page.evaluate(() => ({ running: window.__engineLab.isRunning(), audio: window.__engineLab.audioState() }));
  await page.goto('about:blank', { waitUntil: 'load' });
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(e => { out.goBackError = String(e.message).slice(0, 120); });
  await page.waitForFunction(() => !!window.__engineLab, { timeout: 20000 });
  await pause(1500);
  out.afterReturn = await page.evaluate(() => ({ sameDocument: window.__marker === 'original-document', pageshowPersisted: window.__pageshows ?? null, navType: performance.getEntriesByType('navigation')[0]?.type, running: window.__engineLab.isRunning(), audio: window.__engineLab.audioState(), status: document.getElementById('status')?.textContent }));
  out.powertrainUsable = await page.evaluate(() => { try { return window.__engineLab.getPowertrainState().rpm > 0; } catch (e) { return String(e.message); } });
  await page.click('#power'); await pause(1500);
  out.restart = await page.evaluate(() => ({ running: window.__engineLab.isRunning(), audio: window.__engineLab.audioState(), rpm: window.__engineLab.getTelemetry().rpm }));
  await page.evaluate(() => window.__engineLab.selectPreset(3)); await pause(800);
  out.presetAfterRestore = await page.evaluate(() => window.__engineLab.getConfig().cylinders);
} catch (e) { out.failure = String(e?.message ?? e).slice(0, 300); } finally { await browser.close(); await server.httpServer.close(); }
console.log(JSON.stringify({ out, errors, errorCount: errors.length }, null, 1));
