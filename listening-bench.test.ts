import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeClip, auditionDecodedBank, cropSegment, createBlindTrial, lockRenderOptions, matchLevels, measureLoudness,
	renderLockedPair, revealBlindTrial, type StereoClip } from './listening-bench.ts';
import { defaultConfig, normalizeConfig } from './presets.ts';

function tone(frequency = 997, amplitude = 0.1, duration = 3, sampleRate = 48000, right: 'same' | 'silent' | 'opposite' = 'same'): StereoClip {
	const left = Float32Array.from({ length: Math.round(duration * sampleRate) }, (_, frame) => amplitude * Math.sin(2 * Math.PI * frequency * frame / sampleRate));
	return { left, right: right === 'silent' ? new Float32Array(left.length) : Float32Array.from(left, (value) => right === 'opposite' ? -value : value), sampleRate };
}

test('crop copies exact selected frames, clamps file boundaries and rejects invalid media', () => {
	const clip = tone(100, 0.2, 1, 12000);
	const selected = cropSegment(clip, 0.25, 0.75);
	assert.equal(selected.left.length, 6000); assert.equal(selected.left[1], clip.left[3001]);
	selected.left[1] = 99; assert.notEqual(clip.left[3001], 99);
	assert.equal(cropSegment(clip, -1, 2).left.length, clip.left.length);
	assert.throws(() => cropSegment(clip, 1, 0)); assert.throws(() => cropSegment(clip, NaN, 1));
	assert.throws(() => analyzeClip({ ...clip, right: new Float32Array(2) }));
	const invalid = tone(); invalid.left[0] = NaN; assert.throws(() => analyzeClip(invalid));
});

test('spectral bands measure known tones and retain opposite-phase stereo energy', () => {
	const bass = analyzeClip(tone(40, 0.3, 1));
	const body = analyzeClip(tone(100, 0.3, 1));
	const opposite = analyzeClip(tone(100, 0.3, 1, 48000, 'opposite'));
	assert.ok(bass.bands[0].fraction > 0.999); assert.ok(body.bands[1].fraction > 0.999);
	assert.ok(Math.abs(body.bands[1].power - opposite.bands[1].power) < 1e-12);
	assert.ok(Math.abs(body.rmsDbfs - 20 * Math.log10(0.3 / Math.sqrt(2))) < 0.001);
	assert.equal(opposite.truePeakDbtp, null); assert.ok(opposite.waveform.min.some((value) => value < 0));
	assert.ok(opposite.waveform.max.some((value) => value > 0));
	assert.ok(body.envelope.relativeRms < 1e-5);
});

test('BS1770 calibration: full-scale997Hz on one front channel reads−3.01LUFS; stereo adds3.01LU', () => {
	const mono = measureLoudness(tone(997, 1, 4, 48000, 'silent'));
	const stereo = measureLoudness(tone(997, 1, 4));
	assert.ok(Math.abs(mono.integratedLufs! + 3.01) < 0.03, String(mono.integratedLufs));
	assert.ok(Math.abs(stereo.integratedLufs! - mono.integratedLufs! - 10 * Math.log10(2)) < 0.0001);
	assert.equal(mono.totalBlocks, 37); assert.equal(mono.gatedBlocks, 37);
});

test('K-weighting adapts sample rate and preserves amplitude level differences', () => {
	const reference = measureLoudness(tone(997, 0.1, 4, 48000)).integratedLufs!;
	for (const sampleRate of [44100, 96000]) {
		const measured = measureLoudness(tone(997, 0.1, 4, sampleRate)).integratedLufs!;
		assert.ok(Math.abs(measured - reference) < 0.03, `${sampleRate}: ${measured} vs ${reference}`);
	}
	const quieter = measureLoudness(tone(997, 0.025, 4)).integratedLufs!;
	assert.ok(Math.abs(reference - quieter - 20 * Math.log10(4)) < 0.0001);
});

test('loudness gates silence/quiet blocks and declines insufficient400ms excerpts', () => {
	const active = tone(997, 0.1, 6), silenceTail = new Float32Array(active.left.length * 2);
	silenceTail.set(active.left);
	const gated = measureLoudness({ left: silenceTail, right: silenceTail.slice(), sampleRate: 48000 });
	const base = measureLoudness(active);
	assert.ok(Math.abs(gated.integratedLufs! - base.integratedLufs!) < 0.15);
	assert.ok(gated.gatedBlocks < gated.totalBlocks);
	assert.equal(measureLoudness(tone(997, 0.000001, 2)).integratedLufs, null);
	const short = measureLoudness(tone(997, 0.1, 0.3));
	assert.equal(short.integratedLufs, null); assert.ok(short.warnings.length > 0);
});

test('matching uses one metric for all, equalizes level and leaves source arrays untouched', () => {
	const a = tone(997, 0.1), b = tone(997, 0.4), original = a.left.slice();
	const matched = matchLevels([a, b], { mode: 'lufs', targetDb: -23 });
	const levels = matched.clips.map((clip) => measureLoudness(clip).integratedLufs!);
	assert.equal(matched.mode, 'lufs'); assert.ok(Math.abs(levels[0] - levels[1]) < 0.001);
	assert.ok(Math.abs(levels[0] - matched.actualTargetDb) < 0.001);
	assert.deepEqual(a.left, original);
	const fallback = matchLevels([tone(100, 0.1, 0.1), tone(100, 0.4, 0.1)], { mode: 'lufs' });
	assert.equal(fallback.mode, 'rms'); assert.ok(fallback.warnings.length);
});

test('sample-peak ceiling reduces all gains together without clipping or changing match ratios', () => {
	const impulse = tone(100, 0.0001); impulse.left[10000] = 0.99; impulse.right[10000] = 0.99;
	const continuous = tone(100, 0.3);
	const result = matchLevels([impulse, continuous], { mode: 'rms', targetDb: -6, peakCeilingDbfs: -1 });
	assert.ok(result.commonReductionDb < 0); assert.ok(result.actualTargetDb < result.requestedTargetDb);
	for (const clip of result.clips) assert.ok(analyzeClip(clip).samplePeak <= 10 ** (-1 / 20) + 1e-7);
	const levels = result.clips.map((clip) => analyzeClip(clip).rmsDbfs);
	assert.ok(Math.abs(levels[0] - levels[1]) < 0.001);
	assert.equal(matchLevels([{ left: new Float32Array(1000), right: new Float32Array(1000), sampleRate: 48000 }]).clips[0].left[0], 0);
});

test('locked comparison shares absolute controls, sample clock and deterministic rendering', () => {
	const b = normalizeConfig({ ...defaultConfig, idleRpm: 1200, redline: 6000 });
	const locked = lockRenderOptions([defaultConfig, b], { scenario: 'steady', rpm: 9000, load: 0.8, throttle: 0.2, duration: 0.1, sampleRate: 12000 });
	assert.equal(locked.controlIdleRpm, 1200); assert.equal(locked.controlRedlineRpm, 6000);
	assert.equal(locked.rpm, 5820); assert.equal(locked.load, 0.8); assert.equal(locked.throttle, 0.2);
	const pair = renderLockedPair(defaultConfig, defaultConfig, { scenario: 'drive', duration: 0.1, sampleRate: 12000 });
	assert.equal(pair.clips[0].left.length, 1200); assert.deepEqual(pair.clips[0].left, pair.clips[1].left);
	assert.deepEqual(pair.clips[0].right, pair.clips[1].right);
	assert.ok(pair.clips[0].left.some((sample) => sample !== 0));
});

test('locked dynamic comparison does not add different artificial RPM inertia per candidate',()=>{
	const light=normalizeConfig({...defaultConfig,inertia:.05}),heavy=normalizeConfig({...defaultConfig,inertia:.95});
	const pair=renderLockedPair(light,heavy,{scenario:'drive',duration:.3,sampleRate:12000});
	assert.deepEqual(pair.clips[0].left,pair.clips[1].left);
	assert.deepEqual(pair.clips[0].right,pair.clips[1].right);
});

test('blind label mapping is deterministic per seed, randomized between seeds and reveals valid ratings', () => {
	const ids = ['Referência', 'Atual', 'Snapshot'];
	const trial = createBlindTrial(ids, 12345);
	assert.deepEqual(trial, createBlindTrial(ids, 12345));
	assert.deepEqual(new Set(Object.values(trial.assignments)), new Set(ids));
	const mappings = new Set(Array.from({ length: 12 }, (_, seed) => JSON.stringify(createBlindTrial(ids, seed * 100003 + 1).assignments)));
	assert.ok(mappings.size > 1);
	const ratings = revealBlindTrial(trial, [{ label: 'A', score: 7.5, note: 'mais corpo' }]);
	assert.equal(ratings[0].id, trial.assignments.A); assert.equal(ratings[0].score, 7.5);
	assert.throws(() => revealBlindTrial(trial, [{ label: 'Z', score: 7 }]));
	assert.throws(() => revealBlindTrial(trial, [{ label: 'A', score: 11 }]));
	assert.throws(() => createBlindTrial(['same', 'same'], 1));
});

test('decoded-bank audition bilinearly blends actual anchor samples with bounded deterministic weights', () => {
	const constant = (value: number): StereoClip => ({ left: new Float32Array(100).fill(value), right: new Float32Array(100).fill(-value), sampleRate: 8000 });
	const points = [{ rpm: 1000, load: 0, clip: constant(0.1) }, { rpm: 2000, load: 0, clip: constant(0.3) },
		{ rpm: 1000, load: 1, clip: constant(0.5) }, { rpm: 2000, load: 1, clip: constant(0.7) }];
	const midpoint = auditionDecodedBank(points, { duration: 0.2, sampleRate: 8000, startRpm: 1500, endRpm: 1500, startLoad: 0.5, endLoad: 0.5 });
	assert.ok(Math.abs(midpoint.clip.left[500] - 0.4) < 1e-6);
	assert.ok(Math.abs(midpoint.clip.right[500] + 0.4) < 1e-6);
	const options = { duration: 0.2, sampleRate: 8000, startRpm: 1000, endRpm: 2000, startLoad: 0, endLoad: 1 };
	const a = auditionDecodedBank(points, options), b = auditionDecodedBank(points, options);
	assert.deepEqual(a.clip.left, b.clip.left);
	assert.ok(a.clip.left.every((sample) => sample >= 0 && sample <= 0.700001));
	for (const item of a.trace) {
		assert.ok(Math.abs(item.weights.reduce((sum, anchor) => sum + anchor.weight, 0) - 1) < 1e-12);
		assert.ok(item.weights.every((anchor) => anchor.weight >= 0 && anchor.weight <= 1));
	}
	assert.throws(() => auditionDecodedBank(points.slice(1), options));
});
