import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = name => readFile(new URL(name, import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
const canonical = x => Array.isArray(x) ? '[' + x.map(canonical).join(',') + ']'
 : x !== null && typeof x === 'object' ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}' : JSON.stringify(x);

test('imported data and split remain frozen after metadata migration', async () => {
 const metadata = JSON.parse(await read('./import-provenance.json'));
 for (const [name, entry] of Object.entries(metadata.files)) {
  const bytes = await read('./' + name);
  assert.equal(hash(bytes), entry.derivedSha256, `${name} file bytes`);
  assert.match(entry.originalSha256, /^[a-f0-9]{64}$/);
  if (!entry.canonicalDataSha256) continue;
  const value = JSON.parse(bytes);
  const data = name.startsWith('mazda-measured') ? value.points
   : name === 'legacy-model2-reference.json' ? value.cases
   : { rows: value.rows, trainingRows: value.trainingRows, holdoutRows: value.holdoutRows };
  assert.equal(hash(canonical(data)), entry.canonicalDataSha256, `${name} numerical data`);
 }
 const split = JSON.parse(await read('./mazda-split-model3.json'));
 assert.equal(split.fixtureSha256, hash(await read('./mazda-measured-all.json')));
});
