import type { EngineConfig,EngineState } from './dsp.ts';
import { EngineDSP,normalizeConfig,getBackendIdentity } from './backend.ts';
import { encodeWav, type ExportFile } from './export.ts';

export const MODEL_VERSION = 'carlab-engine-lab-5';
export type Scenario = 'idle' | 'rev' | 'drive' | 'steady' | 'overrun';
export interface RenderOptions {
	sampleRate?: number;
	duration?: number;
	scenario: Scenario;
	rpm?: number;
	load?: number;
	throttle?: number;
}
export interface RenderedClip {
	left: Float32Array;
	right: Float32Array;
	sampleRate: number;
	peak: number;
	rms: number;
}

export type RenderKind = 'clip' | 'bank' | 'stems';

const bounded = (value: number | undefined, fallback: number, min: number, max: number): number =>
	typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/** Canonical render identity. Hash its UTF-8 bytes with SHA-256 at the cache/CLI
 * boundary. No dates or object insertion order affect the source; the complete
 * normalized configuration and model version participate in the identity.
 */
export function contentKeySource(input: Partial<EngineConfig>, options?: RenderOptions, kind: RenderKind = 'clip'): string {
	const config = normalizeConfig(input);
	if (kind === 'bank') return canonicalJson({ model: MODEL_VERSION, backend:getBackendIdentity(), kind, config, render: { sampleRate: 48000, rpmAnchors: 12, loadAnchors: [0.15, 0.4, 0.7, 1] } });
	const scenario = options?.scenario ?? 'rev';
	const render: Record<string, unknown> = {
		scenario,
		sampleRate: Math.round(bounded(options?.sampleRate, 48000, 8000, 96000)),
		duration: bounded(options?.duration, 12, 0.05, 30),
	};
	if (scenario === 'steady') {
		render.rpm = bounded(options?.rpm, config.idleRpm + (config.redline * 0.97 - config.idleRpm) * 0.4, config.idleRpm, config.redline * 1.04);
		render.load = bounded(options?.load, 0.65, 0, 1);
		render.throttle = bounded(options?.throttle, render.load as number, 0, 1);
	}
	return canonicalJson({ model: MODEL_VERSION, backend:getBackendIdentity(), kind, config, render });
}

/** Sample-clock trajectories are shared by offline rendering and the live lab. */
export function scenarioState(config: EngineConfig, scenario: Scenario, seconds: number, duration: number,
	rpm?: number, load?: number, throttle?: number): EngineState {
	const idle = config.idleRpm;
	const top = config.redline * 0.97;
	const travel = top - idle;
	const unit = Math.max(0, Math.min(1, seconds / Math.max(0.1, duration)));
	if (scenario === 'steady') {
		const steadyLoad = bounded(load, 0.65, 0, 1);
		return { rpm: bounded(rpm, idle + travel * 0.4, idle, config.redline * 1.04), load: steadyLoad,
			throttle: bounded(throttle, steadyLoad, 0, 1) };
	}
	if (scenario === 'idle') return { rpm: idle, load: 0.14, throttle: 0.06 };
	if (scenario === 'overrun') {
		const lifting = unit > 0.22;
		return { rpm: lifting ? top - travel * Math.min(1, (unit - 0.22) / 0.78) : idle + travel * Math.min(1, unit / 0.18), load: lifting ? 0.025 : 0.95, throttle: lifting ? 0 : 1 };
	}
	if (scenario === 'drive') {
		const stages = 4;
		const progress = Math.min(stages - 0.0001, unit * stages);
		const gear = Math.floor(progress);
		const phase = progress - gear;
		const from = gear === 0 ? 0 : 0.37;
		const shift = phase > 0.92;
		return { rpm: idle + travel * (from + (0.98 - from) * Math.min(1, phase / 0.92)), load: shift ? 0.06 : 0.92, throttle: shift ? 0 : 1 };
	}
	// Two smooth throttle blips, including a quiet tail that exposes the exhaust decay.
	const local = (unit * 2) % 1;
	const rise = Math.min(1, local / 0.36);
	const falling = Math.max(0, 1 - (local - 0.42) / 0.54);
	const amount = Math.min(rise, falling);
	return { rpm: idle + travel * amount, load: local < 0.42 ? 0.85 : 0.045, throttle: local < 0.42 ? amount : 0 };
}

function stats(left: Float32Array, right: Float32Array): { peak: number; rms: number } {
	let peak = 0, square = 0;
	for (let index = 0; index < left.length; index++) {
		const l = left[index]!, r = right[index]!;
		if (!Number.isFinite(l) || !Number.isFinite(r)) throw new Error('Synthesis produced non-finite audio.');
		peak = Math.max(peak, Math.abs(l), Math.abs(r)); square += l * l + r * r;
	}
	return { peak, rms: Math.sqrt(square / Math.max(1, left.length * 2)) };
}

/** Bounded-memory offline render using exactly the same DSP as AudioWorklet. */
export function renderClip(input: EngineConfig, options: RenderOptions,
	onProgress?: (fraction: number) => void): RenderedClip {
	const config = normalizeConfig(input);
	const sampleRate = Math.round(bounded(options.sampleRate, 48000, 8000, 96000));
	const duration = bounded(options.duration, 12, 0.05, 30);
	const frames = Math.round(duration * sampleRate);
	const left = new Float32Array(frames), right = new Float32Array(frames);
	const dsp = new EngineDSP(sampleRate, config);
	try {
	const a = new Float32Array(256), b = new Float32Array(256);
	const initial = scenarioState(config, options.scenario, 0, duration, options.rpm, options.load, options.throttle);
	dsp.setState(initial);
	// Settle waveguides and RPM before the first recorded sample.
	const warmup = options.scenario === 'steady' && config.boostBar > 0
		? Math.max(1.5, 6 * (0.22 + config.turboSize * 1.65)) : 1.5;
	for (let warm = 0; warm < sampleRate * warmup; warm += a.length) dsp.process(a, b);
	let previousGear = 0;
	onProgress?.(0);
	for (let frame = 0; frame < frames; frame += a.length) {
		const seconds = frame / sampleRate;
		dsp.setState(scenarioState(config, options.scenario, seconds, duration, options.rpm, options.load, options.throttle));
		const gear = Math.floor(seconds / duration * 4);
		if (options.scenario === 'drive' && gear !== previousGear) dsp.trigger('shift');
		previousGear = gear;
		dsp.process(a, b);
		const count = Math.min(a.length, frames - frame);
		left.set(a.subarray(0, count), frame); right.set(b.subarray(0, count), frame);
		if ((frame / a.length) % 64 === 0) onProgress?.(frame / frames);
	}
	// Clip exports are audition files: short edge fades prevent player start/stop clicks.
	const edge = Math.min(Math.floor(sampleRate * 0.008), Math.floor(frames / 2));
	for (let index = 0; index < edge; index++) {
		const gain = 0.5 - 0.5 * Math.cos(Math.PI * index / Math.max(1, edge - 1));
		left[index] = left[index]! * gain; right[index] = right[index]! * gain;
		left[frames - 1 - index] = left[frames - 1 - index]! * gain;
		right[frames - 1 - index] = right[frames - 1 - index]! * gain;
	}
	if (frames > 0) { left[0] = 0; right[0] = 0; left[frames - 1] = 0; right[frames - 1] = 0; }
	onProgress?.(1);
	return { left, right, sampleRate, ...stats(left, right) };
	} finally { dsp.dispose(); }
}

export interface StemSetResult {
	files: ExportFile[];
	stats: { stems: number; sampleRate: number; frames: number; duration: number; peak: number; rms: number; bytes: number };
}

/** Audition/mixing stems from identical seeds and trajectories. Each isolation
 * retains the configured gain of that layer and mutes the other three layers.
 * The DSP's DC removal and nonlinear safety output run independently, so adding
 * these finished stems does not necessarily reproduce the finished full mix.
 */
export function renderStemSet(input: EngineConfig, options: RenderOptions,
	onProgress?: (fraction: number) => void): StemSetResult {
	const config = normalizeConfig(input);
	const layers = [
		{ id: 'exhaust', gain: 'exhaustGain' }, { id: 'intake', gain: 'intakeGain' },
		{ id: 'mechanical', gain: 'mechanicalGain' }, { id: 'turbo', gain: 'turboGain' },
	] as const;
	const files: ExportFile[] = [];
	const entries: Record<string, unknown>[] = [];
	const note = 'Each layer is rendered through an independent nonlinear safety output. Summing the finished isolated layers does not necessarily reproduce the finished full mix.';
	const full = renderClip(config, options, (value) => onProgress?.(value / 5));
	files.push({ name: 'fullmix.wav', data: encodeWav(full.left, full.right, full.sampleRate) });
	entries.push({ id: 'fullmix', file: 'fullmix.wav', peak: full.peak, rms: full.rms });
	for (let index = 0; index < layers.length; index++) {
		const layer = layers[index]!;
		const isolated = normalizeConfig({ ...config, exhaustGain: 0, intakeGain: 0, mechanicalGain: 0, turboGain: 0,
			[layer.gain]: config[layer.gain] });
		const clip = renderClip(isolated, options, (value) => onProgress?.((index + 1 + value) / 5));
		const name = `stems/${layer.id}.wav`;
		files.push({ name, data: encodeWav(clip.left, clip.right, clip.sampleRate) });
		entries.push({ id: layer.id, file: name, gain: config[layer.gain], peak: clip.peak, rms: clip.rms });
	}
	const render = { ...options, sampleRate: full.sampleRate, duration: full.left.length / full.sampleRate };
	const manifest = { schemaVersion: 1, model: MODEL_VERSION, backend:getBackendIdentity(), kind: 'procedural-engine-isolated-layers', config,
		contentKeySource: contentKeySource(config, options, 'stems'), render, sampleRate: full.sampleRate,
		channels: 2, encoding: 'pcm-s16le', seed: config.seed, frames: full.left.length, note, files: entries };
	const encoder = new TextEncoder();
	files.push({ name: 'config.json', data: encoder.encode(JSON.stringify({ schemaVersion: 1, model: MODEL_VERSION, config, render }, null, 2)) });
	files.unshift({ name: 'manifest.json', data: encoder.encode(JSON.stringify(manifest, null, 2)) });
	onProgress?.(1);
	return { files, stats: { stems: 4, sampleRate: full.sampleRate, frames: full.left.length,
		duration: full.left.length / full.sampleRate, peak: full.peak, rms: full.rms,
		bytes: files.reduce((sum, file) => sum + file.data.length, 0) } };
}

/** Cosine overlap splice: shortens a capture, preserving a continuous wrap region.
 * Noise, idle jitter and turbo oscillators are not cycle-locked, so this is an
 * audition-ready seam treatment, not a guarantee of phase-perfect runtime loops.
 */
function spliceLoop(left: Float32Array, right: Float32Array, overlap: number): { left: Float32Array; right: Float32Array } {
	const frames = left.length - overlap;
	const channels = [left, right].map((source) => {
		const output = source.slice(overlap);
		for (let index = 0; index < overlap; index++) {
			const mix = 0.5 - 0.5 * Math.cos(Math.PI * index / Math.max(1, overlap - 1));
			output[frames - overlap + index] = source[frames + index]! * (1 - mix) + source[index]! * mix;
		}
		return output;
	});
	return { left: channels[0]!, right: channels[1]! };
}

export interface BankResult { files: ExportFile[]; stats: { points: number; sampleRate: number; peak: number; bytes: number } }

/** Prototype bank: 12 RPM anchors x four load anchors, stereo 48 kHz PCM16. */
export function renderBank(input: EngineConfig, onProgress?: (fraction: number) => void): BankResult {
	const config = normalizeConfig(input), sampleRate = 48000;
	const rpms = Array.from({ length: 12 }, (_, index) => Math.round(config.idleRpm + (config.redline * 0.96 - config.idleRpm) * index / 11));
	const loads = [0.15, 0.4, 0.7, 1];
	const files: ExportFile[] = [];
	const points: Record<string, unknown>[] = [];
	let maximumPeak = 0;
	onProgress?.(0);
	for (const rpm of rpms) {
		for (const load of loads) {
			const dsp = new EngineDSP(sampleRate, config);
			try {
			dsp.setState({ rpm, load, throttle: load });
			const a = new Float32Array(256), b = new Float32Array(256);
			// Six turbo attack constants reach >99.7% of the target spool. Large
			// turbines must not be baked while still spooling below their target boost.
			const warmup = config.boostBar > 0 ? Math.max(2, 6 * (0.22 + config.turboSize * 1.65)) : 2;
			for (let warm = 0; warm < sampleRate * warmup; warm += 256) dsp.process(a, b);
			// Integral nominal four-stroke cycles, plus an overlap used at the seam.
			const cycles = Math.max(1, Math.round(rpm / 120));
			const frames = Math.round(cycles * 120 / rpm * sampleRate);
			const overlap = Math.round(sampleRate * 0.018);
			const left = new Float32Array(frames + overlap), right = new Float32Array(frames + overlap);
			for (let frame = 0; frame < left.length; frame += 256) {
				dsp.process(a, b); const count = Math.min(256, left.length - frame);
				left.set(a.subarray(0, count), frame); right.set(b.subarray(0, count), frame);
			}
			const loop = spliceLoop(left, right, overlap);
			const levels = stats(loop.left, loop.right);
			maximumPeak = Math.max(maximumPeak, levels.peak);
			const name = `loops/rpm-${rpm}-load-${Math.round(load * 100)}.wav`;
			files.push({ name, data: encodeWav(loop.left, loop.right, sampleRate) });
			points.push({ file: name, rpm, load, frames: loop.left.length, duration: loop.left.length / sampleRate,
				nominalCycles: cycles, loopStart: 0, loopEnd: loop.left.length, peak: levels.peak, rms: levels.rms });
			onProgress?.(points.length / (rpms.length * loads.length));
			} finally { dsp.dispose(); }
		}
	}
	const manifest = { schemaVersion: 1, model: MODEL_VERSION, backend:getBackendIdentity(), kind: 'procedural-engine-prototype-bank',
		contentKeySource: contentKeySource(config, undefined, 'bank'),
		sampleRate, channels: 2, encoding: 'pcm-s16le', config, rpmAnchors: rpms, loadAnchors: loads,
		throttlePolicy: 'equals load at each anchor',
		loopTreatment: 'nominal 720-degree cycle length; 18ms cosine overlap splice',
		limitations: ['Not calibrated to recordings of a real engine.', 'Noise/turbo layers are not phase-locked; audition seams before production.',
			'Prototype schema; runtime integration and RPM/load crossfades are a separate step.'], points };
	files.unshift({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
	return { files, stats: { points: points.length, sampleRate, peak: maximumPeak, bytes: files.reduce((sum, file) => sum + file.data.length, 0) } };
}
