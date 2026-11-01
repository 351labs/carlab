import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sourceRevision } from './source-revision.mjs';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const identity = sourceRevision({ root, requireExplicit: true });
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
assert.equal(build.sourceCommit, identity.sourceCommit);
assert.equal(build.sourceIdentity, 'explicit-verified');
for (const file of manifest.files) {
  assert.ok(!file.path.split('/').some(part => ['.env', '.git', 'node_modules', 'src'].includes(part)));
  assert.ok(!/\.(?:map|key|pem|p12|pfx)$/.test(file.path));
  const bytes = await readFile(resolve(output, 'assets', file.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
}
const assets = await readdir(resolve(output, 'assets/assets'));
assert.equal(assets.filter(name => /^index-.*\.js$/.test(name)).length, 1, 'Exactly one current application entry is published.');
assert.equal(assets.filter(name => name.endsWith('.wasm')).length, 1);
const wasmPath = resolve(output, 'assets/assets', assets.find(name => name.endsWith('.wasm')));
assert.equal(createHash('sha256').update(await readFile(wasmPath)).digest('hex'), build.wasmSha256);
execFileSync(process.execPath, [resolve(root, 'scripts/check-binary-paths.mjs'), wasmPath], { cwd: root, stdio: 'inherit' });
for (const file of ['LICENSE', 'NOTICE', 'credits.md', 'THIRD_PARTY_NOTICES.md', 'licenses/three-MIT.txt', 'licenses/vite-MIT.md', 'licenses/cantera-BSD-3-Clause.txt', 'licenses/rust-and-dependencies.md', 'references/ATTRIBUTION.md']) {
  assert.ok((await readFile(resolve(output, 'assets', file))).length > 100, file);
}
for (const file of ['LICENSE', 'NOTICE', 'credits.md', 'licenses/cantera-BSD-3-Clause.txt']) {
  assert.deepEqual(await readFile(resolve(output, 'assets', file)), await readFile(resolve(root, file)), `Published ${file} matches its source.`);
}
assert.ok((await readdir(resolve(output, 'assets/licenses/rust-stdlib'))).length > 0);
const audioRoot = resolve(output, 'assets/audio');
const audioProvenance = JSON.parse(await readFile(resolve(audioRoot, 'PROVENANCE.json'), 'utf8'));
assert.equal(audioProvenance.schema, 'carlab-historical-audio-provenance-1');
assert.equal(audioProvenance.status, 'historical-captures-not-current-model-reproducibility');
assert.deepEqual(audioProvenance.files.map(file => file.file).sort(), (await readdir(audioRoot)).filter(file => file.endsWith('.wav')).sort());
for (const clip of audioProvenance.files) {
  assert.match(clip.file, /^[\w-]+\.wav$/);
  assert.equal(createHash('sha256').update(await readFile(resolve(audioRoot, clip.file))).digest('hex'), clip.sha256, `Historical audio provenance: ${clip.file}`);
}
console.log(JSON.stringify({ worker: worker.name, domain: worker.domains[0], files: manifest.files.length, sourceCommit: build.sourceCommit, wasmSha256: build.wasmSha256, status: 'passed' }));
