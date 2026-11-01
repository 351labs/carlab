#!/usr/bin/env node
// Inspect raw artifacts without printing the paths or bytes being searched.
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/check-binary-paths.mjs <artifact> [...artifacts]');
  process.exit(2);
}
const home = process.env.HOME;
const privatePaths = [process.cwd(), home, process.env.CARGO_HOME || (home && `${home}/.cargo`),
  process.env.RUSTUP_HOME || (home && `${home}/.rustup`), process.env.TMPDIR || '/tmp']
  .filter(Boolean).map(p => resolve(p)).filter(p => p !== sep && p.length > 3);
for (const p of [...privatePaths]) {
  try { const physical = realpathSync(p); if (physical !== sep) privatePaths.push(physical); } catch { /* optional directory */ }
}
let failed = false;
for (const file of files) {
  try {
    const data = await readFile(file);
    const bytes = data.toString('latin1');
    const exact = privatePaths.some(p => data.includes(Buffer.from(p === '/tmp' || p === '/private/tmp' ? `${p}/` : p)));
    // Covers build environments other than this process, without echoing paths.
    const generic = /(?:\/Users\/|\/home\/|\/private\/var\/folders\/|\/var\/folders\/)[^\x00-\x20\x7f]{2,}/.test(bytes);
    if (exact || generic) {
      console.error('FAIL: artifact contains a private build path.');
      failed = true;
    } else console.log('PASS: artifact contains no detected private build path.');
  } catch {
    console.error('FAIL: artifact could not be read.');
    failed = true;
  }
}
if (failed) process.exitCode = 1;
