import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, '.cloudflare/output/v0/workers/default');
const worker = JSON.parse(await readFile(resolve(output, 'worker.config.json'), 'utf8'));
assert.equal(worker.name, 'carlab');
assert.deepEqual(worker.domains, ['carlab.351labs.xyz']);
assert.equal(worker.workersDev, false);
assert.equal(worker.previewUrls, false);
assert.equal(worker.entrypoint, undefined);
assert.equal(worker.env, undefined);
const manifest = JSON.parse(await readFile(resolve(root, 'dist/release.json'), 'utf8'));
const build = JSON.parse(await readFile(resolve(output, 'assets/build.json'), 'utf8'));
assert.equal(build.application, 'CarLab');
assert.match(build.sourceCommit, /^[a-f0-9]{40}$/);
if (process.env.CARLAB_SOURCE_COMMIT) assert.equal(build.sourceCommit, process.env.CARLAB_SOURCE_COMMIT);
for (const file of manifest.files) {
  assert.ok(!file.path.split('/').some(part => ['.env', '.git', 'node_modules', 'src'].includes(part)));
  assert.ok(!/\.(?:map|key|pem|p12|pfx)$/.test(file.path));
  const bytes = await readFile(resolve(output, 'assets', file.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
}
const assets = await readdir(resolve(output, 'assets/assets'));
assert.equal(assets.filter(name => /^index-.*\.js$/.test(name)).length, 1, 'Exactly one current application entry is published.');
assert.equal(assets.filter(name => name.endsWith('.wasm')).length, 1);
for (const file of ['THIRD_PARTY_NOTICES.md', 'licenses/three-MIT.txt', 'licenses/rust-and-dependencies.md', 'references/ATTRIBUTION.md']) {
  assert.ok((await readFile(resolve(output, 'assets', file))).length > 100, file);
}
assert.ok((await readdir(resolve(output, 'assets/licenses/rust-stdlib'))).length > 0);
console.log(JSON.stringify({ worker: worker.name, domain: worker.domains[0], files: manifest.files.length, sourceCommit: build.sourceCommit, wasmSha256: build.wasmSha256, status: 'passed' }));
