import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, zipFiles, crc32 } from './export.ts';
import { contentKeySource, renderBank, renderClip, renderStemSet, scenarioState } from './offline.ts';
import { defaultConfig } from './presets.ts';

test('WAV encodes a valid interleaved stereo PCM16 header and bounded samples', () => {
	const data = encodeWav(new Float32Array([-2, -0.5, 0, 1, NaN]), new Float32Array([2, 0.5, 0, -1, Infinity]), 48000);
	const view = new DataView(data.buffer);
	assert.equal(new TextDecoder().decode(data.subarray(0, 4)), 'RIFF');
	assert.equal(new TextDecoder().decode(data.subarray(8, 12)), 'WAVE');
	assert.equal(view.getUint32(4, true), data.length - 8);
	assert.equal(view.getUint16(22, true), 2); assert.equal(view.getUint32(24, true), 48000);
	assert.equal(view.getUint16(34, true), 16); assert.equal(view.getUint32(40, true), 20);
	assert.equal(view.getInt16(44, true), -32768); assert.equal(view.getInt16(46, true), 32767);
	assert.equal(view.getInt16(60, true), 0); assert.equal(view.getInt16(62, true), 0);
	assert.throws(() => encodeWav(new Float32Array(2), new Float32Array(1), 48000));
	assert.throws(() => encodeWav(new Float32Array(1), new Float32Array(1), NaN));
});

test('ZIP has correct CRC, entry directory offsets and deterministic bytes', () => {
	const data = new TextEncoder().encode('123456789');
	assert.equal(crc32(data), 0xcbf43926);
	const files = [{ name: 'manifest.json', data }, { name: 'loops/test.wav', data: new Uint8Array([0, 128, 255]) }];
	const zip = zipFiles(files), view = new DataView(zip.buffer);
	assert.deepEqual(zip, zipFiles(files));
	assert.equal(view.getUint32(0, true), 0x04034b50);
	assert.equal(view.getUint32(14, true), 0xcbf43926);
	const end = zip.length - 22, directory = view.getUint32(end + 16, true);
	assert.equal(view.getUint32(end, true), 0x06054b50); assert.equal(view.getUint16(end + 10, true), 2);
	assert.equal(view.getUint32(directory, true), 0x02014b50); assert.equal(view.getUint32(directory + 42, true), 0);
	assert.throws(() => zipFiles([{ name: '../bad', data }]));
	assert.throws(() => zipFiles([{ name: 'same', data }, { name: 'same', data }]));
});

test('offline export is deterministic, finite, stereo, non-silent and includes edge fades', () => {
	const options = { scenario: 'steady' as const, sampleRate: 12000, duration: 0.12, rpm: 3500, load: 0.8 };
	const a = renderClip(defaultConfig, options), b = renderClip(defaultConfig, options);
	assert.equal(a.left.length, 1440); assert.equal(a.right.length, 1440);
	assert.deepEqual(a.left, b.left); assert.deepEqual(a.right, b.right);
	assert.ok(a.rms > 0.0001); assert.ok(Number.isFinite(a.peak) && a.peak <= 1);
	assert.equal(a.left[0], 0); assert.equal(a.left.at(-1), 0);
});

test('trajectories keep RPM, load and throttle separate and release load during overrun', () => {
	const loaded = scenarioState(defaultConfig, 'overrun', 1, 10);
	const lifted = scenarioState(defaultConfig, 'overrun', 4, 10);
	assert.equal(loaded.throttle, 1); assert.equal(lifted.throttle, 0);
	assert.ok(lifted.rpm > defaultConfig.idleRpm); assert.ok(lifted.load < 0.1);
	const steady = scenarioState(defaultConfig, 'steady', 0, 10, 4000, 0.2);
	assert.equal(steady.rpm, 4000); assert.equal(steady.load, 0.2);
});

test('bank exports all 48 unique RPM/load anchors with valid loop bounds and finite levels', () => {
	const progress: number[] = [];
	const bank = renderBank(defaultConfig, (value) => progress.push(value));
	assert.equal(bank.files.length, 49); assert.equal(bank.stats.points, 48);
	assert.equal(progress[0], 0); assert.equal(progress.at(-1), 1);
	assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]!));
	const manifest = JSON.parse(new TextDecoder().decode(bank.files[0]!.data));
	assert.equal(manifest.rpmAnchors.length, 12); assert.equal(manifest.loadAnchors.length, 4);
	assert.equal(manifest.throttlePolicy, 'equals load at each anchor');
	assert.equal(new Set(bank.files.map((file) => file.name)).size, 49);
	for (const point of manifest.points) {
		const file = bank.files.find((entry) => entry.name === point.file)!;
		const view = new DataView(file.data.buffer);
		assert.equal(view.getUint32(40, true), point.frames * 4);
		assert.equal(point.loopStart, 0); assert.equal(point.loopEnd, point.frames);
		assert.ok(Number.isFinite(point.peak) && point.peak <= 1 && point.rms > 0);
		assert.ok(point.duration > 0.85 && point.duration < 1.15);
		// The splice ends on the sample immediately before the capture head.
		const seamLeft = Math.abs(view.getInt16(44, true) - view.getInt16(file.data.length - 4, true)) / 32768;
		assert.ok(seamLeft < 0.3, `${point.file} seam step ${seamLeft}`);
	}
});

test('stem set preserves full mix, exports four finite layers and keeps disabled layers silent', () => {
	const config = { ...defaultConfig, mechanicalGain: 0, boostBar: 0 };
	const options = { scenario: 'steady' as const, sampleRate: 12000, duration: 0.08, rpm: 3200, load: 0.8 };
	const progress: number[] = [];
	const stems = renderStemSet(config, options, (value) => progress.push(value));
	const again = renderStemSet(config, options);
	assert.equal(stems.files.filter((file) => file.name.endsWith('.wav')).length, 5);
	assert.equal(stems.files.length, 7); assert.equal(stems.stats.stems, 4);
	assert.equal(progress[0], 0); assert.equal(progress.at(-1), 1);
	assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]!));
	assert.deepEqual(stems.files, again.files);
	const full = renderClip(config, options);
	assert.deepEqual(stems.files.find((file) => file.name === 'fullmix.wav')!.data, encodeWav(full.left, full.right, full.sampleRate));
	for (const name of ['stems/mechanical.wav', 'stems/turbo.wav']) {
		assert.ok(stems.files.find((file) => file.name === name)!.data.subarray(44).every((byte) => byte === 0), `${name} should be silent`);
	}
	const manifest = JSON.parse(new TextDecoder().decode(stems.files[0]!.data));
	assert.equal(manifest.files.length, 5); assert.equal(manifest.seed, config.seed);
	assert.ok(manifest.note.includes('nonlinear')); assert.ok(manifest.note.includes('does not necessarily'));
	assert.ok(manifest.files.every((file: { peak: number; rms: number }) => Number.isFinite(file.peak) && file.peak <= 1 && Number.isFinite(file.rms)));
	assert.ok(stems.files.some((file) => file.name === 'config.json'));
});

test('content identity is insertion-order independent, normalizes defaults and includes model/config/render kind', () => {
	const a = contentKeySource(defaultConfig, { scenario: 'rev' });
	const reversed = Object.fromEntries(Object.entries(defaultConfig).reverse());
	assert.equal(a, contentKeySource(reversed, { duration: 12, scenario: 'rev', sampleRate: 48000 }));
	assert.notEqual(a, contentKeySource({ ...defaultConfig, exhaustLength: 2.5 }, { scenario: 'rev' }));
	assert.notEqual(a, contentKeySource(defaultConfig, { scenario: 'rev' }, 'stems'));
	assert.notEqual(a, contentKeySource(defaultConfig, undefined, 'bank'));
	assert.ok(JSON.parse(a).model.startsWith('carlab-engine-lab-'));
});

test('steady rendering controls throttle independently of fixed RPM and load and includes it in cache identity', () => {
	const open = scenarioState(defaultConfig, 'steady', 1, 4, 3600, 0.7, 1);
	const closed = scenarioState(defaultConfig, 'steady', 1, 4, 3600, 0.7, 0);
	assert.equal(open.rpm, closed.rpm); assert.equal(open.load, closed.load);
	assert.equal(open.throttle, 1); assert.equal(closed.throttle, 0);
	assert.equal(scenarioState(defaultConfig, 'steady', 1, 4, 3600, 0.7).throttle, 0.7);
	const options = { scenario: 'steady' as const, sampleRate: 12000, duration: 0.08, rpm: 3600, load: 0.7 };
	assert.equal(contentKeySource(defaultConfig, options), contentKeySource(defaultConfig, { ...options, throttle: 0.7 }));
	assert.notEqual(contentKeySource(defaultConfig, { ...options, throttle: 0 }), contentKeySource(defaultConfig, { ...options, throttle: 1 }));
	const a = renderClip(defaultConfig, { ...options, throttle: 0 });
	const b = renderClip(defaultConfig, { ...options, throttle: 1 });
	assert.notDeepEqual(a.left, b.left);
	assert.ok(Number.isFinite(a.rms) && Number.isFinite(b.rms));
});
