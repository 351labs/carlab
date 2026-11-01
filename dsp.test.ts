import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineDSP, type EngineConfig, type PhysicalAudioState } from './dsp.ts';
import { defaultConfig, normalizeConfig, presets } from './presets.ts';

const SAMPLE_RATE = 24000;

function render(dsp: EngineDSP, seconds: number, block = 128): [Float32Array, Float32Array] {
	const frames = Math.round(seconds * dsp.sampleRate);
	const left = new Float32Array(frames);
	const right = new Float32Array(frames);
	for (let start = 0; start < frames; start += block) {
		const end = Math.min(frames, start + block);
		dsp.process(left.subarray(start, end), right.subarray(start, end));
	}
	return [left, right];
}

function rms(signal: Float32Array): number {
	let sum = 0;
	for (const value of signal) sum += value * value;
	return Math.sqrt(sum / Math.max(1, signal.length));
}

function difference(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += (a[i]! - b[i]!) ** 2;
	return Math.sqrt(sum / a.length);
}

test('all eleven instruments have valid four-stroke event schedules and independent configuration arrays', () => {
	assert.equal(presets.length, 11);
	assert.equal(new Set(presets.map((preset) => preset.id)).size, 11);
	assert.deepEqual(presets.slice(9).map((preset) => preset.id), ['v12-classic', 'i4-compact-1-2']);
	for (const { config } of presets) {
		assert.equal(config.firingAngles.length, config.cylinders);
		assert.equal(config.firingOrder.length, config.cylinders);
		assert.equal(new Set(config.firingOrder).size, config.cylinders);
		assert.ok(config.firingAngles.every((angle, index, all) => angle >= 0 && angle < 720 && (!index || angle > all[index - 1]!)));
		const copy = normalizeConfig(config);
		copy.firingAngles[0] = 12;
		assert.equal(config.firingAngles[0], 0);
	}
});

test('crossplane banks have unequal gaps while flatplane banks have even gaps', () => {
	function bankGaps(config: EngineConfig): number[] {
		const events = config.firingAngles.filter((_, index) => config.cylinderBanks[config.firingOrder[index]! - 1] === 0);
		return events.map((angle, index) => ((events[(index + 1) % events.length]! - angle) + 720) % 720);
	}
	const cross = presets.find((preset) => preset.id === 'v8-crossplane')!.config;
	const flat = presets.find((preset) => preset.id === 'v8-flatplane')!.config;
	assert.deepEqual([...new Set(bankGaps(cross))].sort((a, b) => a - b), [90, 180, 270]);
	assert.deepEqual([...new Set(bankGaps(flat))], [180]);
	const twin = presets.find((preset) => preset.id === 'v-twin-1-2')!.config;
	assert.deepEqual(twin.firingAngles, [0, 315]);
});

test('normalization repairs malformed imports, sorts paired events and does not mutate callers', () => {
	const malformed = normalizeConfig({ cylinders: 9.8, displacement: NaN, exhaustLength: Infinity, redline: -30,
		pipeDiameter: 1, cylinderBanks: [8], firingAngles: [NaN] });
	assert.equal(malformed.cylinders, 10);
	assert.equal(malformed.displacement, defaultConfig.displacement);
	assert.equal(malformed.pipeDiameter, 20);
	assert.ok(malformed.redline > malformed.idleRpm);
	assert.equal(malformed.firingAngles.length, 10);
	const input = { ...defaultConfig, firingAngles: [360, 0, 540, 180], firingOrder: [4, 1, 2, 3] };
	const sorted = normalizeConfig(input);
	assert.deepEqual(sorted.firingAngles, [0, 180, 360, 540]);
	assert.deepEqual(sorted.firingOrder, [1, 3, 4, 2]);
	assert.deepEqual(input.firingAngles, [360, 0, 540, 180]);
	assert.equal(normalizeConfig({ combustionDetail: 4 }).combustionDetail, 1);
	assert.equal(normalizeConfig({ combustionDetail: 0 }).combustionDetail, 0);
	assert.equal(normalizeConfig({ perspective: 'invalid' as EngineConfig['perspective'] }).perspective, 'exhaust');
});

test('four-stroke cadence is one event per cylinder per two revolutions', () => {
	const config = normalizeConfig({ ...defaultConfig, idleRpm: 1200, irregularity: 0,
		roughness: 0, timingJitter: 0, lowBody: 0, wear: 0 });
	const dsp = new EngineDSP(SAMPLE_RATE, config);
	dsp.setState({ rpm: 1200, load: 0.6, throttle: 0.6 });
	render(dsp, 1);
	const telemetry = dsp.getTelemetry();
	assert.ok(Math.abs(telemetry.firingEvents - 40) <= 1, `expected 40 events, saw ${telemetry.firingEvents}`);
	assert.equal(telemetry.firingHz, 40);
	assert.ok(Math.abs(telemetry.cycle - 10) < 1e-8);
});

test('character, timing and noise remain deterministic regardless of host block size', () => {
	const config: EngineConfig = { ...presets.find((preset) => preset.id === 'v12-classic')!.config,
		wear: 0.8, combustionDetail: 1, perspective: 'cabin' };
	const a = new EngineDSP(SAMPLE_RATE, config);
	const b = new EngineDSP(SAMPLE_RATE, config);
	a.setState({ rpm: config.idleRpm, load: 0.12, throttle: 0.08 });
	b.setState({ rpm: config.idleRpm, load: 0.12, throttle: 0.08 });
	const [leftA, rightA] = render(a, 0.7, 128);
	const [leftB, rightB] = render(b, 0.7, 317);
	assert.deepEqual(leftA, leftB);
	assert.deepEqual(rightA, rightB);
	assert.ok(rms(leftA) > 0.005);
});

test('bounded cycle timing has variance without changing the mean phase or losing events', () => {
	const config = { ...defaultConfig, idleRpm: 1200, roughness: 0, lowBody: 0, wear: 0, timingJitter: 1 };
	const jittered = new EngineDSP(SAMPLE_RATE, config);
	const healthy = new EngineDSP(SAMPLE_RATE, { ...config, timingJitter: 0 });
	for (const dsp of [jittered, healthy]) dsp.setState({ rpm: 1200, load: 0.5, throttle: 0.5 });
	let variation = 0;
	for (let cycle = 0; cycle < 20; cycle++) {
		render(jittered, 0.1);
		const character = jittered.getCharacterTelemetry();
		assert.ok(Math.abs(character.timingMeanDeg) < 1e-12, 'each cycle must have zero mean timing offset');
		assert.ok(character.timingMaxDeg <= 7.2 + 1e-10);
		variation += character.timingRmsDeg;
	}
	render(healthy, 2);
	assert.ok(variation / 20 > 1, 'jitter must produce actual arrival variance');
	assert.equal(healthy.getCharacterTelemetry().timingRmsDeg, 0);
	assert.equal(jittered.getTelemetry().cycle, healthy.getTelemetry().cycle);
	assert.ok(Math.abs(jittered.getTelemetry().firingEvents - healthy.getTelemetry().firingEvents) <= 1);
	assert.equal(jittered.getTelemetry().firingEvents, jittered.getTelemetry().combustionEvents);
});

function bassFraction(signal: Float32Array): number {
	const upper = 1 - Math.exp(-2 * Math.PI * 220 / SAMPLE_RATE);
	const lower = 1 - Math.exp(-2 * Math.PI * 35 / SAMPLE_RATE);
	let low = 0, high = 0, bass = 0, total = 0;
	for (const value of signal) {
		low += (value - low) * upper; high += (value - high) * lower;
		bass += (low - high) ** 2; total += value * value;
	}
	return bass / Math.max(total, 1e-12);
}

test('V10/V12 body resonance adds35–220Hz energy while preserving ignition cadence', (context) => {
	for (const id of ['v10-5', 'v12-highrev']) {
		const config = { ...presets.find((preset) => preset.id === id)!.config, roughness: 0, timingJitter: 0, wear: 0, combustionDetail: 0 };
		const bare = new EngineDSP(SAMPLE_RATE, { ...config, lowBody: 0 });
		const body = new EngineDSP(SAMPLE_RATE, { ...config, lowBody: 1 });
		for (const dsp of [bare, body]) {
			dsp.setState({ rpm: 3000, load: 0.7, throttle: 0.7 });
			render(dsp, 0.8);
		}
		const [plain] = render(bare, 0.8);
		const [full] = render(body, 0.8);
		const before = bassFraction(plain), after = bassFraction(full);
		context.diagnostic(`${id}: bass fraction ${before.toFixed(4)} -> ${after.toFixed(4)}`);
		assert.ok(after > before * 1.15, `${id}: low-body control must increase the bass share`);
		assert.ok(difference(plain, full) > 0.005);
		assert.equal(bare.getTelemetry().firingEvents, body.getTelemetry().firingEvents);
		assert.equal(bare.getTelemetry().cycle, body.getTelemetry().cycle);
	}
});

test('wear weakens some idle burns without creating silence or high-load dropouts', () => {
	const config = { ...presets.find((preset) => preset.id === 'v12-classic')!.config,
		roughness: 0, timingJitter: 0, wear: 1, seed: 81271 };
	const idle = new EngineDSP(SAMPLE_RATE, config);
	idle.setState({ rpm: config.idleRpm, load: 0.05, throttle: 0.05 });
	render(idle, 3);
	const count = idle.getCharacterTelemetry().weakCombustions;
	assert.ok(count > 0 && count < idle.getTelemetry().combustionEvents * 0.15);
	assert.equal(idle.getTelemetry().firingEvents, idle.getTelemetry().combustionEvents);
	const loaded = new EngineDSP(SAMPLE_RATE, config);
	loaded.setState({ rpm: 3500, load: 1, throttle: 1 });
	render(loaded, 0.8);
	const initial = loaded.getCharacterTelemetry().weakCombustions;
	render(loaded, 1);
	assert.equal(loaded.getCharacterTelemetry().weakCombustions, initial);
});

test('rough idle hunts slowly but roughness does not wobble a high-RPM target', () => {
	const config = { ...defaultConfig, roughness: 1, timingJitter: 0, wear: 0 };
	const dsp = new EngineDSP(SAMPLE_RATE, config);
	dsp.setState({ rpm: config.idleRpm, load: 0.1, throttle: 0.1 });
	let minimum = Infinity, maximum = -Infinity;
	for (let i = 0; i < 30; i++) {
		render(dsp, 0.1);
		minimum = Math.min(minimum, dsp.getTelemetry().rpm);
		maximum = Math.max(maximum, dsp.getTelemetry().rpm);
	}
	assert.ok(maximum - minimum > 15 && maximum - minimum < 150);
	dsp.setState({ rpm: 5000, load: 0.7, throttle: 0.7 });
	render(dsp, 2);
	assert.equal(dsp.getCharacterTelemetry().idleHuntRpm, 0);
	assert.ok(Math.abs(dsp.getTelemetry().rpm - 5000) < 0.01);
});

test('each preset remains finite, DC-controlled and bounded through an RPM/load sweep', () => {
	for (const preset of presets) {
		const dsp = new EngineDSP(SAMPLE_RATE, preset.config);
		dsp.setState({ rpm: preset.config.redline * 0.84, load: 0.9, throttle: 0.95 });
		const [left, right] = render(dsp, 0.5);
		let sum = 0;
		for (let i = 0; i < left.length; i++) {
			assert.ok(Number.isFinite(left[i]) && Number.isFinite(right[i]), preset.id);
			assert.ok(Math.abs(left[i]!) < 1 && Math.abs(right[i]!) < 1, preset.id);
			sum += left[i]!;
		}
		assert.ok(Math.abs(sum / left.length) < 0.03, `${preset.id} DC mean`);
		assert.ok(rms(left) > 0.003, `${preset.id} must sound`);
	}
});

test('pipe geometry and bank firing pattern affect sound without changing cadence', () => {
	const cross = presets.find((preset) => preset.id === 'v8-crossplane')!.config;
	const flat = presets.find((preset) => preset.id === 'v8-flatplane')!.config;
	const a = new EngineDSP(SAMPLE_RATE, cross);
	const b = new EngineDSP(SAMPLE_RATE, { ...cross, firingOrder: flat.firingOrder });
	const c = new EngineDSP(SAMPLE_RATE, { ...cross, exhaustLength: 0.35, headerLength: 0.15 });
	for (const dsp of [a, b, c]) dsp.setState({ rpm: 3500, load: 0.7, throttle: 0.7 });
	const [soundA] = render(a, 0.6);
	const [soundB] = render(b, 0.6);
	const [soundC] = render(c, 0.6);
	assert.ok(difference(soundA, soundB) > 0.008, 'bank cadence must be audible');
	assert.ok(difference(soundA, soundC) > 0.008, 'pipe geometry must be audible');
	assert.equal(a.getTelemetry().firingEvents, b.getTelemetry().firingEvents);
	assert.equal(a.getTelemetry().firingEvents, c.getTelemetry().firingEvents);
});

test('turbo spools over time, retains inertia and vents on a throttle lift', () => {
	const dsp = new EngineDSP(SAMPLE_RATE, presets[0]!.config);
	dsp.setState({ rpm: 5500, load: 1, throttle: 1 });
	render(dsp, 0.15);
	const early = dsp.getTelemetry().boost;
	render(dsp, 2.2);
	const charged = dsp.getTelemetry();
	assert.ok(charged.boost > early + 0.2);
	assert.ok(charged.turboRpm > 100000);
	dsp.setState({ load: 0, throttle: 0 });
	render(dsp, 0.07);
	const lift = dsp.getTelemetry();
	assert.ok(lift.bov > 0.15, `BOV envelope ${lift.bov}`);
	assert.ok(lift.boost > 0.05, 'spool state must not vanish at throttle lift');
	render(dsp, 2);
	assert.ok(dsp.getTelemetry().boost < lift.boost * 0.05);
});

test('limiter cuts combustion without changing the four-stroke event clock', () => {
	const config = normalizeConfig({ ...defaultConfig, idleRpm: 1200, redline: 3000 });
	const dsp = new EngineDSP(SAMPLE_RATE, config);
	dsp.setState({ rpm: 3400, load: 1, throttle: 1 });
	render(dsp, 0.8);
	const before = dsp.getTelemetry();
	render(dsp, 0.6);
	const after = dsp.getTelemetry();
	assert.ok(after.limiter);
	const scheduled = after.firingEvents - before.firingEvents;
	const combustions = after.combustionEvents - before.combustionEvents;
	assert.ok(scheduled > 50);
	assert.ok(combustions < scheduled * 0.45 && combustions > scheduled * 0.2);
});

test('configuration changes and explicit transients remain bounded; stop becomes silent', () => {
	const dsp = new EngineDSP(SAMPLE_RATE, defaultConfig);
	dsp.setState({ rpm: 4000, load: 0.8, throttle: 0.9 });
	render(dsp, 0.1);
	dsp.setConfig(presets[8]!.config);
	dsp.trigger('shift');
	dsp.trigger('blip');
	const [changing] = render(dsp, 0.2);
	assert.ok(changing.every((value) => Number.isFinite(value) && Math.abs(value) < 1));
	dsp.setState({ rpm: NaN, load: Infinity, throttle: -Infinity });
	assert.ok(Number.isFinite(dsp.getTelemetry().rpm));
	dsp.trigger('stop');
	render(dsp, 2.5);
	const [stopped] = render(dsp, 0.2);
	assert.ok(rms(stopped) < 1e-6, `stopped RMS ${rms(stopped)}`);
	dsp.trigger('start');
	const [restarted] = render(dsp, 0.5);
	assert.ok(rms(restarted) > 0.005);
});

test('muted layers settle to silence and mismatched host channel lengths are cleared', () => {
	const config = { ...defaultConfig, exhaustGain: 0, intakeGain: 0, mechanicalGain: 0, turboGain: 0 };
	for (const perspective of ['exhaust', 'engine', 'cabin', 'roadside'] as const) {
		const dsp = new EngineDSP(SAMPLE_RATE, { ...config, perspective });
		const left = new Float32Array(256).fill(0.8);
		const right = new Float32Array(128).fill(0.8);
		dsp.process(left, right);
		assert.ok(left.every((value) => value === 0), perspective);
		assert.ok(right.every((value) => value === 0), perspective);
	}
	assert.throws(() => new EngineDSP(NaN, config), RangeError);
});

test('detailed valve pulses change with RPM/load without changing ignition timing', () => {
	const config = { ...defaultConfig, roughness: 0, timingJitter: 0, wear: 0, combustionDetail: 1 };
	function settled(rpm: number, load: number): EngineDSP {
		const dsp = new EngineDSP(SAMPLE_RATE, config);
		dsp.setState({ rpm, load, throttle: load });
		render(dsp, 1);
		return dsp;
	}
	const slow = settled(1200, 0.2).getPulseTelemetry();
	const fast = settled(6000, 0.2).getPulseTelemetry();
	assert.ok(slow.blowdownMs > fast.blowdownMs * 2);
	assert.ok(slow.intakeMs > fast.intakeMs * 2);
	assert.ok(slow.flowMs > slow.blowdownMs && fast.flowMs > fast.blowdownMs);
	const light = settled(3000, 0.15).getPulseTelemetry();
	const loaded = settled(3000, 0.95);
	assert.ok(loaded.getPulseTelemetry().blowdownMs < light.blowdownMs * 0.85);
	const legacy = new EngineDSP(SAMPLE_RATE, { ...config, combustionDetail: 0 });
	legacy.setState({ rpm: 3000, load: 0.95, throttle: 0.95 });
	render(legacy, 1);
	const [before] = render(legacy, 0.5), [after] = render(loaded, 0.5);
	assert.ok(difference(before, after) > 0.005, 'pulse shape must change audibly rather than just metadata');
	assert.equal(legacy.getTelemetry().firingEvents, loaded.getTelemetry().firingEvents);
	assert.equal(legacy.getTelemetry().cycle, loaded.getTelemetry().cycle);
});

function edgeRatio(signal: Float32Array): number {
	let edge = 0, energy = 0;
	for (let i = 1; i < signal.length; i++) { edge += (signal[i]! - signal[i - 1]!) ** 2; energy += signal[i]! ** 2; }
	return edge / Math.max(energy, 1e-12);
}

test('listening perspectives colour identical sources and retain the same crank/event clock', (context) => {
	const signals = new Map<EngineConfig['perspective'], Float32Array>();
	let cycle = -1, events = -1;
	for (const perspective of ['exhaust', 'engine', 'cabin', 'roadside'] as const) {
		const dsp = new EngineDSP(SAMPLE_RATE, { ...defaultConfig, perspective });
		dsp.setState({ rpm: 4200, load: 0.8, throttle: 0.8 });
		render(dsp, 0.8);
		const [signal] = render(dsp, 0.6);
		signals.set(perspective, signal);
		assert.ok(signal.every((value) => Number.isFinite(value) && Math.abs(value) < 1));
		assert.ok(rms(signal) > 0.002);
		const telemetry = dsp.getTelemetry();
		if (cycle < 0) { cycle = telemetry.cycle; events = telemetry.firingEvents; }
		assert.equal(telemetry.cycle, cycle); assert.equal(telemetry.firingEvents, events);
	}
	const exhaust = signals.get('exhaust')!, cabin = signals.get('cabin')!, road = signals.get('roadside')!;
	context.diagnostic(`edge ratios exhaust=${edgeRatio(exhaust).toFixed(4)} cabin=${edgeRatio(cabin).toFixed(4)}`);
	assert.ok(edgeRatio(cabin) < edgeRatio(exhaust) * 0.75, 'cabin transfer must reduce sharp high-frequency detail');
	assert.ok(rms(road) < rms(exhaust) * 0.75, 'static roadside transfer must attenuate close sources');
	assert.ok(difference(exhaust, signals.get('engine')!) > 0.003);
});

test('perspective changes crossfade without an immediate routing discontinuity', () => {
	const base = new EngineDSP(SAMPLE_RATE, defaultConfig), changed = new EngineDSP(SAMPLE_RATE, defaultConfig);
	for (const dsp of [base, changed]) { dsp.setState({ rpm: 3500, load: 0.7, throttle: 0.7 }); render(dsp, 0.7); }
	changed.setConfig({ ...defaultConfig, perspective: 'cabin' });
	const [a] = render(base, 0.05), [b] = render(changed, 0.05);
	assert.ok(Math.abs(a[0]! - b[0]!) < 0.005);
	assert.ok(difference(a, b) > 0.002, 'new perspective must fade in over subsequent samples');
});

test('actual physical RPM tracks a trajectory without the artistic inertia lag', () => {
	const config = { ...defaultConfig, inertia: 1, roughness: 0, timingJitter: 0, wear: 0 };
	const actual = new EngineDSP(SAMPLE_RATE, config), target = new EngineDSP(SAMPLE_RATE, config);
	const left = new Float32Array(128), right = new Float32Array(128);
	let expected = config.idleRpm;
	for (let block = 0; block < 110; block++) {
		expected = config.idleRpm + (block + 1) * 128 / SAMPLE_RATE * 2500;
		actual.setState({ rpm: expected, load: 0.8, throttle: 0.8 }, true);
		target.setState({ rpm: expected, load: 0.8, throttle: 0.8 });
		actual.process(left, right);
		assert.ok(left.every((value) => Number.isFinite(value) && Math.abs(value) < 1));
		target.process(left, right);
	}
	assert.ok(Math.abs(actual.getTelemetry().rpm - expected) < 20);
	assert.ok(expected - target.getTelemetry().rpm > 400);
	actual.setState({ rpm: 5000 }, true); render(actual, 0.05);
	assert.ok(Math.abs(actual.getTelemetry().rpm - 5000) < 1);
	// Each call explicitly selects tracking; a default partial update returns to
	// the existing artistic-target mode, as the public API contract specifies.
	actual.setState({ rpm: 6500 }); render(actual, 0.05);
	assert.ok(6500 - actual.getTelemetry().rpm > 1000);
});

test('actual-state mode preserves steady cadence and avoids synthetic RPM offsets', () => {
	const config = { ...defaultConfig, idleRpm: 1200, roughness: 0, timingJitter: 0, wear: 0 };
	const actual = new EngineDSP(SAMPLE_RATE, config), target = new EngineDSP(SAMPLE_RATE, config);
	actual.setState({ rpm: 1200, load: 0.6, throttle: 0.6 }, true);
	target.setState({ rpm: 1200, load: 0.6, throttle: 0.6 });
	const [a] = render(actual, 1), [b] = render(target, 1);
	assert.deepEqual(a, b);
	assert.equal(actual.getTelemetry().firingEvents, target.getTelemetry().firingEvents);
	assert.equal(actual.getTelemetry().cycle, target.getTelemetry().cycle);
	actual.setConfig({ ...config, roughness: 1 });
	actual.setState({ load: 0.1, throttle: 0.1 }, true);
	actual.trigger('shift'); actual.trigger('blip'); render(actual, 0.3);
	assert.equal(actual.getTelemetry().rpm, 1200);
	assert.equal(actual.getCharacterTelemetry().idleHuntRpm, 0);
});

const physicalAudio = (patch: Partial<PhysicalAudioState> = {}): PhysicalAudioState => ({
	boostBar: 0, fuelCut: false, intakePressureBar: 0.85, exhaustPressureBar: 1.08,
	exhaustMassFlowKgs: 0.12, exhaustTemperatureK: 760, cycleEnergyScale: 1,
	burnDurationScale: 1, combustionPhaseDeg: 0, residualFraction: 0.05, cycleIndex: 0, ...patch,
});

test('manual state retains the v3 path even if unrelated physical metadata is present', () => {
	const a = new EngineDSP(SAMPLE_RATE, defaultConfig), b = new EngineDSP(SAMPLE_RATE, defaultConfig);
	a.setState({ rpm: 3200, load: 0.7, throttle: 0.8 });
	b.setState({ rpm: 3200, load: 0.7, throttle: 0.8, physical: physicalAudio({ fuelCut: true, boostBar: 4 }) });
	assert.deepEqual(render(a, 0.5), render(b, 0.5));
	assert.equal(b.getPhysicalAudioTelemetry(), null);
});

test('shared boost is authoritative, including zero and a configured NA voice', () => {
	const solo = { ...defaultConfig, exhaustGain: 0, intakeGain: 0, mechanicalGain: 0, turboGain: 1 };
	const zero = new EngineDSP(SAMPLE_RATE, { ...solo, boostBar: 2.5 });
	zero.setState({ rpm: 4000, load: 0.8, throttle: 0.9, physical: physicalAudio({ boostBar: 0 }) }, true);
	const [silent] = render(zero, 0.5);
	assert.equal(zero.getTelemetry().boost, 0);
	assert.equal(rms(silent), 0);
	const charged = new EngineDSP(SAMPLE_RATE, { ...solo, boostBar: 0 });
	charged.setState({ rpm: 4000, load: 0.8, throttle: 0.9, physical: physicalAudio({ boostBar: 0.8 }) }, true);
	const [audible] = render(charged, 0.5);
	assert.equal(charged.getTelemetry().boost, 0.8);
	assert.ok(rms(audible) > 0.002);
});

test('physical DFCO stops combustion while positive airflow remains audible', () => {
	const config = { ...defaultConfig, lowBody: 0, intakeGain: 0, mechanicalGain: 0, turboGain: 0,
		roughness: 1, timingJitter: 1, wear: 1, irregularity: 1, overrun: 1 };
	const flow = new EngineDSP(SAMPLE_RATE, config), still = new EngineDSP(SAMPLE_RATE, config);
	flow.setState({ rpm: 3000, load: 0, throttle: 0, physical: physicalAudio({ fuelCut: true }) }, true);
	still.setState({ rpm: 3000, load: 0, throttle: 0, physical: physicalAudio({ fuelCut: true, exhaustMassFlowKgs: 0 }) }, true);
	const [flowing] = render(flow, 0.8), [quiet] = render(still, 0.8);
	assert.ok(flow.getTelemetry().firingEvents > 30);
	assert.equal(flow.getTelemetry().combustionEvents, 0);
	assert.equal(flow.getCharacterTelemetry().weakCombustions, 0);
	assert.equal(flow.getCharacterTelemetry().timingRmsDeg, 0);
	assert.ok(rms(flowing) > 0.0001);
	assert.equal(rms(quiet), 0);
	const fueled = new EngineDSP(SAMPLE_RATE, config);
	fueled.setState({ rpm: 3000, load: 0.7, throttle: 0.7, physical: physicalAudio() }, true);
	const [burning] = render(fueled, 0.8);
	assert.ok(fueled.getTelemetry().combustionEvents > 30);
	assert.ok(difference(flowing, burning) > 0.005);
});

test('shared cycle factors replace artistic variation and stay deterministic across blocks', () => {
	const config = { ...defaultConfig, idleRpm: 1200, roughness: 1, timingJitter: 1, wear: 1, irregularity: 1 };
	const a = new EngineDSP(SAMPLE_RATE, config);
	const b = new EngineDSP(SAMPLE_RATE, { ...config, roughness: 0, timingJitter: 0, wear: 0, irregularity: 0 });
	for (let cycle = 0; cycle < 6; cycle++) {
		const physical = physicalAudio({ cycleIndex: cycle + 7, cycleEnergyScale: 0.8 + (cycle % 3) * 0.1,
			burnDurationScale: 0.8 + cycle * 0.1, combustionPhaseDeg: cycle % 2 ? -2.5 : 2.5 });
		for (const dsp of [a, b]) dsp.setState({ rpm: 1200, load: 0.6, throttle: 0.6, physical }, true);
		assert.deepEqual(render(a, 0.1, 128), render(b, 0.1, 317));
		const applied = a.getPhysicalAudioTelemetry()!;
		assert.equal(applied.cycleIndex, physical.cycleIndex);
		assert.equal(applied.cycleEnergyScale, physical.cycleEnergyScale);
		assert.equal(applied.burnDurationScale, physical.burnDurationScale);
		assert.ok(Math.abs(applied.combustionPhaseDeg - physical.combustionPhaseDeg) < 1e-12);
	}
	assert.ok(Math.abs(a.getTelemetry().firingEvents - 24) <= 1);
	assert.equal(a.getTelemetry().firingEvents, a.getTelemetry().combustionEvents);
	assert.equal(a.getCharacterTelemetry().weakCombustions, 0);
});

test('physical temperature/flow transfer adapts geometric resonators and remains finite', () => {
	const cold = new EngineDSP(SAMPLE_RATE, defaultConfig), hot = new EngineDSP(SAMPLE_RATE, defaultConfig);
	for (const [dsp, temperature] of [[cold, 280], [hot, 1300]] as const) {
		dsp.setState({ rpm: 3000, load: 0.7, throttle: 0.7, physical: physicalAudio({ exhaustTemperatureK: temperature }) }, true);
		render(dsp, 0.7);
	}
	const [cool] = render(cold, 0.4), [warm] = render(hot, 0.4);
	assert.ok(difference(cool, warm) > 0.003);
	assert.equal(cold.getTelemetry().cycle, hot.getTelemetry().cycle);
	for (const sampleRate of [8000, 96000]) {
		const dsp = new EngineDSP(sampleRate, { ...defaultConfig, pipeDiameter: 20, exhaustLength: 4, headerLength: 2 });
		dsp.setState({ rpm: 16000, load: 1, throttle: 1, physical: physicalAudio({ boostBar: 6,
			exhaustTemperatureK: 1800, exhaustPressureBar: 0.1, exhaustMassFlowKgs: 10,
			cycleEnergyScale: 3, burnDurationScale: 2.5, combustionPhaseDeg: 12 }) }, true);
		const [signal] = render(dsp, 0.12);
		assert.ok(signal.every((value) => Number.isFinite(value) && Math.abs(value) < 1));
	}
});

test('all muted sources stay silent under shared physical flow in every perspective', () => {
	for (const perspective of ['exhaust', 'engine', 'cabin', 'roadside'] as const) {
		const dsp = new EngineDSP(SAMPLE_RATE, { ...defaultConfig, perspective,
			exhaustGain: 0, intakeGain: 0, mechanicalGain: 0, turboGain: 0 });
		dsp.setState({ rpm: 3500, load: 0.8, throttle: 0.9, physical: physicalAudio({ boostBar: 1 }) }, true);
		const [left, right] = render(dsp, 0.25);
		assert.equal(rms(left), 0); assert.equal(rms(right), 0);
	}
});
