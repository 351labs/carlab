import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const load = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
test('EPA fixtures retain source citation, full worksheet scope and its 12-row subset', async () => {
 const [subset, all] = await Promise.all([load('./mazda-measured.json'), load('./mazda-measured-all.json')]);
 const citation = '2014 Mazda 2.0L SKYACTIV-G Engine Tier 2 Fuel – Test Data Package. Version 2018-02. Ann Arbor, MI: US EPA, National Vehicle and Fuel Emissions Laboratory, National Center for Advanced Technology, 2018.';
 assert.equal(all.source.suggestedCitation, citation);
 assert.equal(subset.source.suggestedCitation, `SUGGESTED CITATION: ${citation}`);
 assert.equal(all.source.archiveSha256, subset.source.archiveSha256);
 assert.equal(all.source.workbookMemberSha256, subset.source.workbookMemberSha256);
 assert.equal(all.points.length, 137); assert.equal(all.columns.length, 26);
 assert.equal(subset.points.length, 12);
 assert.ok(subset.points.every(point => all.points.some(row => row.excelRow === point.excelRow)));
 assert.match(subset.reuse.scope, /137 rows/);
 assert.match(all.reuseBasis, /below 50 Nm/);
 const text = await readFile(new URL('../credits.md', import.meta.url), 'utf8');
 assert.ok(text.includes(citation));
 assert.ok(text.includes('the engine operation and fuel consumption data produced in this testing are robust and can be used for any purpose.'));
 assert.match(text, /uncertainty increases at very low load/);
 for (const file of ['./extract-mazda-steady.py', './summarize-mazda.mjs']) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /MAZDA-INPUTS\.md|ASSESSMENT\.md/);
 }
});
