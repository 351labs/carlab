import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConfig, normalizeConfig, presets } from './presets.ts';
import {
	MAX_PROJECTS, MAX_REVISIONS, EXHAUST_FIELDS, emptyLibrary, saveProject, saveExhaust,
	serializeLibrary, parseLibrary, copyProject, mergeLibraries, applyExhaust,
	applyPhysicalExhaust, capturePhysicalExhaust, physicalProvenanceSummary,
} from './projects.ts';

const now = '2026-10-31T10:00:00.000Z';

test('named engine/physics projects round-trip, clone nested inputs, and preserve literal names', () => {
	const engine = normalizeConfig(presets[2].config);
	const physical = { massKg: 1400, gearRatios: [3.4, 2.1], assumptions: { calibrated: false } };
	const name = '<img src=x onerror=alert(1)> V2';
	const saved = saveProject(emptyLibrary(), { name, notes: ' Lenta irregular, sem exagero. ', project: { engine, physical } }, now);
	engine.firingAngles[1] = 999;
	physical.gearRatios[0] = 99;
	const restored = parseLibrary(serializeLibrary(saved.library));
	assert.equal(restored.projects[0].name, name);
	const revision = restored.projects[0].revisions[0];
	assert.equal(revision.notes, 'Lenta irregular, sem exagero.');
	assert.deepEqual(revision.engine.firingAngles, [0, 315]);
	assert.deepEqual(revision.physical?.gearRatios, [3.4, 2.1]);
	assert.equal(revision.createdAt, now);
	const recalled = copyProject(revision);
	(recalled.physical!.gearRatios as number[])[0] = 77;
	assert.deepEqual(revision.physical?.gearRatios, [3.4, 2.1]);
});

test('invalid storage and non-JSON physical inputs are rejected without replacing the original library', () => {
	assert.deepEqual(parseLibrary(null), emptyLibrary());
	assert.throws(() => parseLibrary('{broken'), /JSON inválida/);
	assert.throws(() => parseLibrary(JSON.stringify({ ...emptyLibrary(), schema: 2 })), /versão/);
	assert.throws(() => copyProject({ engine: defaultConfig, physical: { torque: NaN } }), /JSON finitos/);
	assert.throws(() => copyProject({ engine: defaultConfig, physical: { method: () => 42 } }), /JSON finitos/);
	assert.throws(() => copyProject({ engine: defaultConfig, physical: { values: new Array(2) } }), /JSON finitos/);
	assert.throws(() => copyProject({ engine: defaultConfig, physical: JSON.parse('{"__proto__":{"admin":true}}') }), /reservado/);
	const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
	assert.throws(() => copyProject({ engine: defaultConfig, physical: cyclic }), /níveis demais/);
	const library = emptyLibrary();
	assert.throws(() => saveProject(library, { name: ' ', notes: '', project: { engine: defaultConfig } }, now), /Nome/);
	assert.deepEqual(library, emptyLibrary());
});

test('saving a voice caps revision history while preserving newest settings and the prior library', () => {
	let result = saveProject(emptyLibrary(), { name: 'I4', notes: '0', project: { engine: defaultConfig } }, now);
	const initial = result.library;
	for (let index = 1; index < MAX_REVISIONS + 4; index++) {
		result = saveProject(result.library, { id: result.projectId, name: 'I4 refinado', notes: String(index), project: { engine: normalizeConfig({ ...defaultConfig, pipeDiameter: 40 + index }) } }, now);
	}
	const project = result.library.projects[0];
	assert.equal(project.id, result.projectId);
	assert.equal(project.revisions.length, MAX_REVISIONS);
	assert.equal(project.revisions[0].notes, String(MAX_REVISIONS + 3));
	assert.equal(project.revisions[MAX_REVISIONS - 1].notes, '4');
	assert.equal(new Set(project.revisions.map(revision => revision.id)).size, MAX_REVISIONS);
	assert.equal(initial.projects[0].revisions.length, 1);
	assert.equal(initial.projects[0].name, 'I4');
});

test('an exhaust recipe changes only exhaust geometry/loss fields, never the donor engine or character', () => {
	const donor = normalizeConfig({ ...presets[9].config, exhaustLength: 3.1, pipeDiameter: 81, muffler: 0.7 });
	const target = normalizeConfig(presets[2].config);
	const saved = saveExhaust(emptyLibrary(), 'Coletor longo', donor, now);
	const recipe = parseLibrary(serializeLibrary(saved.library)).exhausts[0];
	const applied = applyExhaust(target, recipe.config);
	for (const key of EXHAUST_FIELDS) assert.equal(applied[key], donor[key]);
	const withoutExhaust = (config: typeof defaultConfig) => Object.fromEntries(Object.entries(config).filter(([key]) => !(EXHAUST_FIELDS as readonly string[]).includes(key)));
	assert.deepEqual(withoutExhaust(applied), withoutExhaust(target));
	assert.equal(target.exhaustLength, presets[2].config.exhaustLength);
});

test('imports append independent IDs and refuse duplicate IDs or capacity overflow', () => {
	const source = saveProject(emptyLibrary(), { name: 'Original', notes: '', project: { engine: defaultConfig } }, now).library;
	const merged = mergeLibraries(source, source);
	assert.equal(merged.projects.length, 2);
	assert.notEqual(merged.projects[0].id, merged.projects[1].id);
	assert.notEqual(merged.projects[0].revisions[0].id, merged.projects[1].revisions[0].id);
	const duplicate = { ...source, projects: [source.projects[0], source.projects[0]] };
	assert.throws(() => parseLibrary(JSON.stringify(duplicate)), /duplicados/);
	let full = emptyLibrary();
	for (let index = 0; index < MAX_PROJECTS; index++) full = saveProject(full, { name: `Voz ${index}`, notes: '', project: { engine: defaultConfig } }, now).library;
	assert.throws(() => mergeLibraries(full, source), /limite/);
	assert.throws(() => saveProject(full, { name: 'Outro', notes: '', project: { engine: defaultConfig } }, now), /Limite/);
});

test('project backups retain map, thermal and material provenance as independent JSON snapshots', () => {
	const physical = {
		provenance: { source: 'assumed', label: 'Original design inputs', version: 'physical-2' },
		veMap: { kind: 'volumetric-efficiency', axisUnits: { rpm: 'rpm', pressure: 'bar-absolute' }, rpm: [900, 3000, 6500], pressureBar: [0.3, 1], values: [[0.6, 0.8], [0.7, 0.95], [0.65, 0.85]], provenance: { source: 'fitted', label: 'Owner bench run', version: 'fit-3', validation: { label: 'held-out loads', independent: true } } },
		thermal: { wallHeatCapacityJPerK: 19000, initialWallK: 360 },
		materialScreen: { card: { name: 'Owner material card', provenance: { source: 'measured', label: 'Coupon series', version: '2' }, allowableStress: [{ temperatureK: 300, stressMPa: 180 }, { temperatureK: 450, stressMPa: 120 }] } },
	};
	const saved = saveProject(emptyLibrary(), { name: 'Physical I4', notes: 'Map domain and material evidence recorded.', project: { engine: defaultConfig, physical } }, now);
	physical.veMap.values[0][0] = 99; physical.materialScreen.card.allowableStress[0].stressMPa = 999;
	const revision = parseLibrary(serializeLibrary(saved.library)).projects[0].revisions[0];
	const original = revision.physical as typeof physical;
	assert.equal(original.veMap.values[0][0], 0.6);
	assert.equal(original.veMap.provenance.validation.independent, true);
	assert.equal(original.materialScreen.card.allowableStress[0].stressMPa, 180);
	const recalled = copyProject(revision).physical as typeof physical;
	recalled.veMap.provenance.label = 'Changed locally';
	assert.equal(original.veMap.provenance.label, 'Owner bench run');
	assert.ok(physicalProvenanceSummary(original).some(line => line.includes('Mapa de enchimento: ajustado') && line.includes('fit-3')));
	const grid = Array.from({ length: 32 }, (_, row) => Array.from({ length: 32 }, (_, column) => 0.65 + row * 0.00123456789 + column * 0.000987654321));
	const largeMaps = { ...physical, veMap: { ...physical.veMap, values: grid }, indicatedEfficiencyMap: { values: grid }, fmepMap: { values: grid } };
	assert.ok(JSON.stringify(largeMaps).length > 32_000);
	assert.deepEqual(copyProject({ engine: defaultConfig, physical: largeMaps }).physical, largeMaps);
});

test('saved physical exhaust recipes merge only explicit flow boundaries and preserve old schema-1 recipes', () => {
	const donor = { exhaustVolumeL: 7.5, exhaustRestrictionK: 12, exhaustFrictionFactor: 0.04, vehicleMassKg: 2400, veMap: { provenance: { source: 'measured' }, values: [[1]] }, thermal: { initialWallK: 600 } };
	const target = { exhaustVolumeL: 2, exhaustRestrictionK: 3, exhaustFrictionFactor: 0.02, vehicleMassKg: 950, veMap: { provenance: { source: 'assumed' }, values: [[0.8]] }, thermal: { initialWallK: 350 } };
	const result = saveExhaust(emptyLibrary(), 'Long physical exhaust', presets[9].config, now, donor);
	const recipe = parseLibrary(serializeLibrary(result.library)).exhausts[0];
	assert.deepEqual(recipe.physical, { exhaustVolumeL: 7.5, exhaustRestrictionK: 12, exhaustFrictionFactor: 0.04 });
	donor.exhaustRestrictionK = 99;
	const applied = applyPhysicalExhaust(target, recipe.physical);
	assert.equal(applied.exhaustRestrictionK, 12);
	assert.equal(applied.vehicleMassKg, 950);
	assert.deepEqual(applied.veMap, target.veMap); assert.notEqual(applied.veMap, target.veMap);
	assert.deepEqual(applied.thermal, target.thermal);
	assert.equal(target.exhaustRestrictionK, 3);
	const acousticOnly = saveExhaust(emptyLibrary(), 'Legacy exhaust', defaultConfig, now).library;
	assert.equal(parseLibrary(serializeLibrary(acousticOnly)).exhausts[0].physical, undefined);
	assert.deepEqual(applyPhysicalExhaust(target), target);
	assert.equal(capturePhysicalExhaust({ vehicleMassKg: 2000 }), undefined);
});

test('physical exhaust imports reject non-finite, out-of-domain and unrelated donor parameters', () => {
	assert.throws(() => capturePhysicalExhaust({ exhaustRestrictionK: NaN }), /inválido/);
	assert.throws(() => capturePhysicalExhaust({ exhaustFrictionFactor: 0 }), /inválido/);
	assert.throws(() => capturePhysicalExhaust({ exhaustVolumeL: 31 }), /inválido/);
	const source = saveExhaust(emptyLibrary(), 'Exhaust', defaultConfig, now).library;
	const unrelated = { ...source, exhausts: source.exhausts.map(exhaust => ({ ...exhaust, physical: { exhaustRestrictionK: 2, vehicleMassKg: 900 } })) };
	assert.throws(() => parseLibrary(JSON.stringify(unrelated)), /não permitidos/);
	assert.throws(() => applyPhysicalExhaust({}, { vehicleMassKg: 900 } as never), /não permitidos/);
	assert.throws(() => copyProject({ engine: defaultConfig, physical: { trace: new Array(361).fill(1) } }), /Lista física grande/);
	assert.throws(() => copyProject({ engine: defaultConfig, physical: { notes: 'x'.repeat(256_001) } }), /Configuração física grande/);
	const summary = physicalProvenanceSummary({ provenance: { source: 'toString', label: '<script>literal</script>', version: '1' } });
	assert.ok(summary[0].includes('origem não informada'));
	assert.ok(summary[0].includes('<script>literal</script>'));
});
