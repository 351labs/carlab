import type { EngineConfig } from './dsp.ts';
import { EngineDSP,normalizeConfig } from './backend.ts';
import { renderBank, scenarioState, type RenderOptions } from './offline.ts';

/** In-memory media only. No DOM, storage, network, file names or upload API. */
export interface StereoClip { left: Float32Array; right: Float32Array; sampleRate: number }
export interface LoudnessAnalysis {
	integratedLufs: number | null;
	momentaryMaxLufs: number | null;
	absoluteGatedLufs: number | null;
	relativeGateLufs: number | null;
	totalBlocks: number;
	gatedBlocks: number;
	method: string;
	warnings: string[];
}
export interface ClipAnalysis {
	duration: number;
	frames: number;
	sampleRate: number;
	rms: number;
	rmsDbfs: number;
	samplePeak: number;
	samplePeakDbfs: number;
	/** No oversampling true-peak meter is implemented; never label sample peak dBTP. */
	truePeakDbtp: null;
	loudness: LoudnessAnalysis;
	bands: { label: string; lowHz: number; highHz: number; power: number; fraction: number }[];
	waveform: { min: number[]; max: number[] };
	spectrum: { frequencyHz: number[]; powerDb: number[]; resolutionHz: number };
	envelope: { timesSeconds: number[]; rms: number[]; relativeRms: number; activeCv: number; dipCandidates: number };
	warnings: string[];
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const ampDb = (value: number): number => 20 * Math.log10(Math.max(value, 1e-12));
const loudnessDb = (power: number): number => -0.691 + 10 * Math.log10(Math.max(power, 1e-30));

function validateClip(clip: StereoClip): void {
	if (!clip || !(clip.left instanceof Float32Array) || !(clip.right instanceof Float32Array)
		|| clip.left.length !== clip.right.length || clip.left.length === 0
		|| !Number.isInteger(clip.sampleRate) || clip.sampleRate < 8000 || clip.sampleRate > 192000) {
		throw new RangeError('Áudio estéreo inválido: canais iguais e frequência de 8–192 kHz são necessários.');
	}
	for (let index = 0; index < clip.left.length; index++) {
		if (!Number.isFinite(clip.left[index]) || !Number.isFinite(clip.right[index])) throw new RangeError('O áudio contém amostras não finitas.');
	}
}

/** Copy a selected region. Input arrays remain intact and are never retained. */
export function cropSegment(clip: StereoClip, startSeconds = 0, endSeconds = clip.left.length / clip.sampleRate): StereoClip {
	validateClip(clip);
	if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) throw new RangeError('Seleção temporal inválida.');
	const first = clamp(Math.floor(startSeconds * clip.sampleRate), 0, clip.left.length);
	const last = clamp(Math.floor(endSeconds * clip.sampleRate), 0, clip.left.length);
	if (last <= first) throw new RangeError('O fim da seleção deve vir depois do início.');
	return { left: clip.left.slice(first, last), right: clip.right.slice(first, last), sampleRate: clip.sampleRate };
}

type Biquad = [number, number, number, number, number]; // b0,b1,b2,a1,a2; a0=1
// ITU-R BS.1770-4 Annex1 Tables1/2, and equations2–7 (stereo channel weights1).
// https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-4-201510-S!!PDF-E.pdf
// https://tech.ebu.ch/docs/tech/tech3343v4_1.pdf §11.1.1
const SHELF_48: Biquad = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
const HIGH_PASS_48: Biquad = [1, -2, 1, -1.99004745483398, 0.99007225036621];

/** Map the published48kHz digital filter through its bilinear analog prototype.
 * Substitution q48=(k+q)/(1+kq), k=(48000-fs)/(48000+fs), q=z^-1.
 * This preserves the prototype instead of reusing48k coefficients at44.1k.
 */
function adaptBiquad(coefficients: Biquad, sampleRate: number): Biquad {
	if (sampleRate === 48000) return coefficients;
	const k = (48000 - sampleRate) / (48000 + sampleRate), k2 = k * k;
	const [b0, b1, b2, a1, a2] = coefficients;
	const denominator = 1 + a1 * k + a2 * k2;
	return [(b0 + b1 * k + b2 * k2) / denominator,
		(2 * k * b0 + b1 * (1 + k2) + 2 * k * b2) / denominator,
		(b0 * k2 + b1 * k + b2) / denominator,
		(2 * k + a1 * (1 + k2) + 2 * k * a2) / denominator,
		(k2 + a1 * k + a2) / denominator];
}

/** BS.1770-compatible stereo loudness, not a certified EBU meter or LRA meter.
 * Short excerpts yield excerpt-specific estimates; incomplete400ms blocks are
 * discarded. The stereo energy sum intentionally differs from average RMS.
 */
export function measureLoudness(clip: StereoClip): LoudnessAnalysis {
	validateClip(clip);
	const blockFrames = Math.round(clip.sampleRate * 0.4), hopFrames = Math.round(clip.sampleRate * 0.1);
	const warnings: string[] = [];
	if (clip.left.length < clip.sampleRate * 3) warnings.push('Trecho curto: LUFS descreve somente esta seleção; não substitui a sonoridade de um programa completo.');
	const result: LoudnessAnalysis = { integratedLufs: null, momentaryMaxLufs: null, absoluteGatedLufs: null,
		relativeGateLufs: null, totalBlocks: 0, gatedBlocks: 0,
		method: 'BS.1770-4 estéreo: K-weighting, blocos 400 ms / passo 100 ms, gates −70 LUFS e −10 LU relativos; não certificado.', warnings };
	if (clip.left.length < blockFrames) {
		warnings.push('Menos de 400 ms: sem bloco completo para medir LUFS.');
		return result;
	}
	const shelf = adaptBiquad(SHELF_48, clip.sampleRate), highPass = adaptBiquad(HIGH_PASS_48, clip.sampleRate);
	const sums = new Float64Array(clip.left.length + 1);
	for (const channel of [clip.left, clip.right]) {
		let s1 = 0, s2 = 0, h1 = 0, h2 = 0, running = 0;
		for (let frame = 0; frame < channel.length; frame++) {
			const first = shelf[0] * channel[frame] + s1;
			s1 = shelf[1] * channel[frame] - shelf[3] * first + s2;
			s2 = shelf[2] * channel[frame] - shelf[4] * first;
			const weighted = highPass[0] * first + h1;
			h1 = highPass[1] * first - highPass[3] * weighted + h2;
			h2 = highPass[2] * first - highPass[4] * weighted;
			running += weighted * weighted;
			sums[frame + 1] += running;
		}
	}
	const powers: number[] = [];
	let maximum = -Infinity;
	for (let start = 0; start + blockFrames <= clip.left.length; start += hopFrames) {
		const power = Math.max(0, (sums[start + blockFrames] - sums[start]) / blockFrames);
		powers.push(power);
		maximum = Math.max(maximum, loudnessDb(power));
	}
	result.totalBlocks = powers.length;
	if (maximum > -70) result.momentaryMaxLufs = maximum;
	const absolute = powers.filter((power) => loudnessDb(power) > -70);
	if (!absolute.length) { warnings.push('Áudio abaixo do gate absoluto; LUFS integrado indisponível.'); return result; }
	result.absoluteGatedLufs = loudnessDb(absolute.reduce((sum, power) => sum + power, 0) / absolute.length);
	result.relativeGateLufs = result.absoluteGatedLufs - 10;
	const gated = absolute.filter((power) => loudnessDb(power) > result.relativeGateLufs!);
	result.gatedBlocks = gated.length;
	if (gated.length) result.integratedLufs = loudnessDb(gated.reduce((sum, power) => sum + power, 0) / gated.length);
	return result;
}

function fft(real: Float64Array, imaginary: Float64Array): void {
	const size = real.length;
	for (let index = 1, reverse = 0; index < size; index++) {
		let bit = size >> 1;
		for (; reverse & bit; bit >>= 1) reverse ^= bit;
		reverse ^= bit;
		if (index < reverse) {
			[real[index], real[reverse]] = [real[reverse], real[index]];
			[imaginary[index], imaginary[reverse]] = [imaginary[reverse], imaginary[index]];
		}
	}
	for (let width = 2; width <= size; width *= 2) {
		const angle = -2 * Math.PI / width, stepReal = Math.cos(angle), stepImaginary = Math.sin(angle);
		for (let start = 0; start < size; start += width) {
			let wr = 1, wi = 0;
			for (let offset = 0; offset < width / 2; offset++) {
				const a = start + offset, b = a + width / 2;
				const tr = wr * real[b] - wi * imaginary[b], ti = wr * imaginary[b] + wi * real[b];
				real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti;
				real[a] += tr; imaginary[a] += ti;
				const next = wr * stepReal - wi * stepImaginary;
				wi = wr * stepImaginary + wi * stepReal; wr = next;
			}
		}
	}
}

function spectrumOf(clip: StereoClip): { frequencyHz: number[]; power: Float64Array; resolutionHz: number } {
	const size = Math.min(16384, 2 ** Math.floor(Math.log2(clip.left.length)));
	if (size < 2) return { frequencyHz: [0], power: new Float64Array(1), resolutionHz: clip.sampleRate };
	const real = new Float64Array(size), imaginary = new Float64Array(size), window = new Float64Array(size);
	const power = new Float64Array(size / 2 + 1);
	let windowPower = 0, windows = 0;
	for (let index = 0; index < size; index++) { window[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (size - 1)); windowPower += window[index] ** 2; }
	for (const channel of [clip.left, clip.right]) {
		for (let start = 0; start + size <= channel.length; start += size / 2) {
			let mean = 0;
			for (let index = 0; index < size; index++) mean += channel[start + index];
			mean /= size;
			for (let index = 0; index < size; index++) real[index] = (channel[start + index] - mean) * window[index];
			imaginary.fill(0); fft(real, imaginary);
			for (let bin = 0; bin < power.length; bin++) power[bin] += (real[bin] ** 2 + imaginary[bin] ** 2) * (bin && bin !== size / 2 ? 2 : 1) / (clip.sampleRate * windowPower);
			windows++;
		}
	}
	for (let bin = 0; bin < power.length; bin++) power[bin] /= Math.max(1, windows);
	return { frequencyHz: Array.from({ length: power.length }, (_, index) => index * clip.sampleRate / size), power, resolutionHz: clip.sampleRate / size };
}

function waveformOf(clip: StereoClip, columns = 720): ClipAnalysis['waveform'] {
	const count = Math.min(columns, clip.left.length), min: number[] = [], max: number[] = [];
	for (let column = 0; column < count; column++) {
		let low = Infinity, high = -Infinity;
		for (let frame = Math.floor(column * clip.left.length / count); frame < Math.floor((column + 1) * clip.left.length / count); frame++) {
			low = Math.min(low, clip.left[frame], clip.right[frame]); high = Math.max(high, clip.left[frame], clip.right[frame]);
		}
		min.push(low); max.push(high);
	}
	return { min, max };
}

function envelopeOf(clip: StereoClip): ClipAnalysis['envelope'] {
	const width = Math.max(1, Math.round(clip.sampleRate * 0.01)), hop = Math.max(1, Math.round(clip.sampleRate * 0.0025));
	const cumulative = new Float64Array(clip.left.length + 1);
	for (let index = 0; index < clip.left.length; index++) cumulative[index + 1] = cumulative[index] + (clip.left[index] ** 2 + clip.right[index] ** 2) * 0.5;
	const timesSeconds: number[] = [], rms: number[] = [];
	for (let start = 0; start + width <= clip.left.length; start += hop) {
		timesSeconds.push((start + width / 2) / clip.sampleRate);
		rms.push(Math.sqrt(Math.max(0, (cumulative[start + width] - cumulative[start]) / width)));
	}
	if (!rms.length) { timesSeconds.push(clip.left.length / clip.sampleRate / 2); rms.push(Math.sqrt(cumulative.at(-1)! / clip.left.length)); }
	const sorted = [...rms].sort((a, b) => a - b), floor = Math.max(1e-12, sorted[Math.floor((sorted.length - 1) * 0.95)] * 10 ** (-25 / 20));
	const prefix = [0]; for (const value of rms) prefix.push(prefix.at(-1)! + value);
	let kernel = Math.min(rms.length, Math.max(1, Math.round(clip.sampleRate / hop)));
	if (kernel % 2 === 0) kernel--;
	const half = (kernel - 1) / 2;
	let relativeSquare = 0, activeSum = 0, activeSquare = 0, activeCount = 0, dipStart = -1, dipCandidates = 0;
	for (let index = 0; index < rms.length; index++) {
		const first = Math.max(0, index - half), last = Math.min(rms.length, index + half + 1);
		const baseline = (prefix[last] - prefix[first] + Math.max(0, half - index) * rms[0] + Math.max(0, index + half + 1 - rms.length) * rms.at(-1)!) / kernel;
		if (rms[index] > floor) {
			relativeSquare += (rms[index] / Math.max(baseline, floor) - 1) ** 2;
			activeSum += rms[index]; activeSquare += rms[index] ** 2; activeCount++;
		}
		const dip = baseline > floor * 2 && rms[index] < baseline * 10 ** (-10 / 20);
		if (dip && dipStart < 0) dipStart = index;
		if ((!dip || index === rms.length - 1) && dipStart >= 0) {
			const duration = (index - dipStart) * hop / clip.sampleRate;
			if (duration >= 0.008 && duration <= 0.25 && timesSeconds[dipStart] > 0.25 && timesSeconds[index] < clip.left.length / clip.sampleRate - 0.25) dipCandidates++;
			dipStart = -1;
		}
	}
	const mean = activeSum / Math.max(1, activeCount);
	return { timesSeconds, rms, relativeRms: Math.sqrt(relativeSquare / Math.max(1, activeCount)),
		activeCv: Math.sqrt(Math.max(0, activeSquare / Math.max(1, activeCount) - mean ** 2)) / Math.max(mean, 1e-12), dipCandidates };
}

/** Actual PCM analysis, no inferred RPM/firing/misfire from acoustic dips. */
export function analyzeClip(clip: StereoClip): ClipAnalysis {
	validateClip(clip);
	let square = 0, samplePeak = 0;
	for (let index = 0; index < clip.left.length; index++) { square += clip.left[index] ** 2 + clip.right[index] ** 2; samplePeak = Math.max(samplePeak, Math.abs(clip.left[index]), Math.abs(clip.right[index])); }
	const rms = Math.sqrt(square / clip.left.length / 2), spectrum = spectrumOf(clip);
	const definitions: [number, number][] = [[20, 80], [80, 200], [200, 500], [500, 2000], [2000, 8000], [8000, 20000]];
	const bands = definitions.map(([lowHz, highHz]) => {
		let power = 0;
		for (let bin = 0; bin < spectrum.power.length; bin++) if (spectrum.frequencyHz[bin] >= lowHz && spectrum.frequencyHz[bin] < Math.min(highHz, clip.sampleRate / 2)) power += spectrum.power[bin] * spectrum.resolutionHz;
		return { label: `${lowHz}–${highHz} Hz`, lowHz, highHz, power, fraction: 0 };
	});
	const bandPower = bands.reduce((sum, band) => sum + band.power, 0);
	for (const band of bands) band.fraction = band.power / Math.max(1e-30, bandPower);
	const loudness = measureLoudness(clip);
	const warnings = ['Pico por amostras em dBFS; true peak/dBTP não medido.', 'Energia por faixa descreve a gravação, incluindo microfone, ambiente e compressão.', 'Quedas de envelope não provam falhas de ignição.'];
	if (samplePeak < 1e-8) warnings.push('Seleção silenciosa: não é possível igualar sonoridade.');
	if (samplePeak > 1) warnings.push('Há amostras acima de 0 dBFS no PCM decodificado; o ganho de comparação deve preservar margem.');
	return { duration: clip.left.length / clip.sampleRate, frames: clip.left.length, sampleRate: clip.sampleRate,
		rms, rmsDbfs: ampDb(rms), samplePeak, samplePeakDbfs: ampDb(samplePeak), truePeakDbtp: null, loudness, bands,
		waveform: waveformOf(clip), spectrum: { frequencyHz: spectrum.frequencyHz, powerDb: Array.from(spectrum.power, (power) => 10 * Math.log10(Math.max(power, 1e-24))), resolutionHz: spectrum.resolutionHz },
		envelope: envelopeOf(clip), warnings };
}

export interface MatchOptions { mode?: 'lufs' | 'rms'; targetDb?: number; peakCeilingDbfs?: number }
export interface MatchedLevels {
	clips: StereoClip[];
	gains: number[];
	gainDb: number[];
	mode: 'lufs' | 'rms';
	requestedTargetDb: number;
	actualTargetDb: number;
	commonReductionDb: number;
	peakCeilingDbfs: number;
	warnings: string[];
}

/** Constant-gain level matching; a common reduction preserves comparisons when
 * any sample peak would exceed the ceiling. No compression or per-clip limiting.
 * Ceiling is sample-peak safety, not certified reconstruction/true-peak safety.
 */
export function matchLevels(clips: StereoClip[], options: MatchOptions = {}): MatchedLevels {
	if (!clips.length) throw new RangeError('Nenhum áudio para comparar.');
	const requestedTargetDb = Number.isFinite(options.targetDb) ? clamp(options.targetDb!, -60, -6) : -23;
	const peakCeilingDbfs = Number.isFinite(options.peakCeilingDbfs) ? clamp(options.peakCeilingDbfs!, -24, -0.1) : -1;
	const warnings: string[] = [], stats = clips.map((clip) => { validateClip(clip); let square = 0, peak = 0; for (let i = 0; i < clip.left.length; i++) { square += clip.left[i] ** 2 + clip.right[i] ** 2; peak = Math.max(peak, Math.abs(clip.left[i]), Math.abs(clip.right[i])); } return { rms: Math.sqrt(square / clip.left.length / 2), peak }; });
	let mode = options.mode ?? 'lufs';
	const measured = mode === 'lufs' ? clips.map((clip) => measureLoudness(clip).integratedLufs) : stats.map((stat) => ampDb(stat.rms));
	if (mode === 'lufs' && measured.some((value, index) => value === null && stats[index].rms > 1e-10)) {
		mode = 'rms'; warnings.push('LUFS indisponível em pelo menos uma seleção; todos os áudios foram igualados por RMS.');
	}
	const levels = mode === 'rms' ? stats.map((stat) => ampDb(stat.rms)) : measured;
	const proposed = levels.map((value, index) => stats[index].rms <= 1e-10 || value === null ? 1 : 10 ** ((requestedTargetDb - value) / 20));
	let predictedPeak = 0;
	for (let index = 0; index < clips.length; index++) predictedPeak = Math.max(predictedPeak, stats[index].peak * proposed[index]);
	const reduction = Math.min(1, 10 ** (peakCeilingDbfs / 20) / Math.max(predictedPeak, 1e-30));
	const gains = proposed.map((gain) => gain * reduction);
	if (reduction < 1) warnings.push('Alvo reduzido igualmente para todos os áudios para preservar o pico por amostras.');
	if (stats.some((stat) => stat.rms <= 1e-10)) warnings.push('Áudio silencioso preservado; não existe correspondência perceptiva com silêncio.');
	return { clips: clips.map((clip, index) => ({ sampleRate: clip.sampleRate,
		left: Float32Array.from(clip.left, (sample) => sample * gains[index]), right: Float32Array.from(clip.right, (sample) => sample * gains[index]) })),
		gains, gainDb: gains.map(ampDb), mode, requestedTargetDb, actualTargetDb: requestedTargetDb + ampDb(reduction), commonReductionDb: ampDb(reduction), peakCeilingDbfs, warnings };
}

/** Lock absolute targets over the common valid range. Different presets must
 * not silently map one requestedRPM to different idle/redline fractions.
 */
export interface LockedRenderOptions extends RenderOptions { controlIdleRpm: number; controlRedlineRpm: number }
export function lockRenderOptions(configs: EngineConfig[], options: RenderOptions): LockedRenderOptions {
	if (!configs.length) throw new RangeError('Configurações vazias.');
	const normalized = configs.map((config) => normalizeConfig(config));
	const low = Math.max(...normalized.map((config) => config.idleRpm));
	const high = Math.min(...normalized.map((config) => config.redline * 0.97));
	if (high <= low) throw new RangeError('As configurações não têm faixa de RPM em comum.');
	const load = clamp(Number.isFinite(options.load) ? options.load! : 0.65, 0, 1);
	return { ...options, duration: clamp(Number.isFinite(options.duration) ? options.duration! : 10, 0.05, 30),
		sampleRate: Math.round(clamp(Number.isFinite(options.sampleRate) ? options.sampleRate! : 48000, 8000, 96000)),
		rpm: clamp(Number.isFinite(options.rpm) ? options.rpm! : low + (high - low) * 0.4, low, high),
		load, throttle: clamp(Number.isFinite(options.throttle) ? options.throttle! : load, 0, 1),
		controlIdleRpm: low, controlRedlineRpm: high / 0.97 };
}

/** Shared absolute trajectory for dynamic scenarios. The candidate DSP retains
 * its own actual idle/redline/material configuration; only the external driver
 * uses the common range. This avoids changing the compared sound instrument.
 */
export function renderLockedCandidate(config: EngineConfig, options: LockedRenderOptions,
	onProgress?: (fraction: number) => void): StereoClip {
	const normalized = normalizeConfig(config), sampleRate = options.sampleRate!, duration = options.duration!;
	const profile = { ...normalized, idleRpm: options.controlIdleRpm, redline: options.controlRedlineRpm };
	const frames = Math.round(duration * sampleRate), left = new Float32Array(frames), right = new Float32Array(frames);
	const dsp = new EngineDSP(sampleRate, normalized);
 try {
 const a = new Float32Array(256), b = new Float32Array(256);
	dsp.setState(scenarioState(profile, options.scenario, 0, duration, options.rpm, options.load, options.throttle),true);
	const warmup=options.scenario==='steady'&&normalized.boostBar>0?Math.max(1.5,6*(.22+normalized.turboSize*1.65)):1.5;
	for (let frame = 0; frame < sampleRate * warmup; frame += 256) dsp.process(a, b);
	let previousGear = 0; onProgress?.(0);
	for (let frame = 0; frame < frames; frame += 256) {
		const seconds = frame / sampleRate;
		dsp.setState(scenarioState(profile, options.scenario, seconds, duration, options.rpm, options.load, options.throttle),true);
		const gear = Math.floor(seconds / duration * 4);
		if (options.scenario === 'drive' && gear !== previousGear) dsp.trigger('shift');
		previousGear = gear; dsp.process(a, b);
		const count = Math.min(256, frames - frame);
		left.set(a.subarray(0, count), frame); right.set(b.subarray(0, count), frame);
		if ((frame / 256) % 64 === 0) onProgress?.(frame / frames);
	}
	const edge = Math.min(Math.floor(sampleRate * 0.008), Math.floor(frames / 2));
	for (let index = 0; index < edge; index++) {
		const gain = 0.5 - 0.5 * Math.cos(Math.PI * index / Math.max(1, edge - 1));
		left[index] *= gain; right[index] *= gain; left[frames - 1 - index] *= gain; right[frames - 1 - index] *= gain;
	}
	if (frames) { left[0] = 0; right[0] = 0; left[frames - 1] = 0; right[frames - 1] = 0; }
	onProgress?.(1);
	return { left, right, sampleRate };
 } finally { dsp.dispose(); }
}

export function renderLockedPair(a: EngineConfig, b: EngineConfig, options: RenderOptions,
	onProgress?: (fraction: number) => void): { clips: [StereoClip, StereoClip]; options: LockedRenderOptions } {
	const locked = lockRenderOptions([a, b], options);
	const first = renderLockedCandidate(a, locked, (progress) => onProgress?.(progress * 0.5));
	const second = renderLockedCandidate(b, locked, (progress) => onProgress?.(0.5 + progress * 0.5));
	return { clips: [first, second], options: locked };
}

export interface BlindTrial { version: 1; seed: number; labels: string[]; assignments: Record<string, string> }
export interface BlindRating { label: string; score: number; note?: string }
export function createBlindTrial(ids: string[], seed: number): BlindTrial {
	if (ids.length < 2 || ids.length > 26 || new Set(ids).size !== ids.length || ids.some((id) => !id)) throw new RangeError('Comparação cega requer 2–26 identificadores únicos.');
	let state = (Number.isFinite(seed) ? Math.trunc(seed) : 1) >>> 0; if (!state) state = 0x9e3779b9;
	const initialSeed = state, order = [...ids];
	for (let index = order.length - 1; index > 0; index--) {
		state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
		const other = Math.floor((state >>> 0) / 0x100000000 * (index + 1));
		[order[index], order[other]] = [order[other], order[index]];
	}
	const labels = order.map((_, index) => String.fromCharCode(65 + index));
	return { version: 1, seed: initialSeed, labels, assignments: Object.fromEntries(labels.map((label, index) => [label, order[index]])) };
}

/** Reveal only after collecting ratings. This is an informal listening trial,
 * not a double-blind study; application memory still contains the assignment.
 */
export function revealBlindTrial(trial: BlindTrial, ratings: BlindRating[]): { label: string; id: string; score: number; note: string }[] {
	if (new Set(ratings.map((rating) => rating.label)).size !== ratings.length) throw new RangeError('Notas duplicadas.');
	return ratings.map((rating) => {
		const id = trial.assignments[rating.label];
		if (!id || !Number.isFinite(rating.score) || rating.score < 0 || rating.score > 10) throw new RangeError('Nota ou rótulo inválido.');
		return { label: rating.label, id, score: rating.score, note: (rating.note ?? '').slice(0, 1000) };
	});
}

export interface DecodedBankPoint { rpm: number; load: number; clip: StereoClip }
export interface BankAuditionOptions { duration?: number; startRpm?: number; endRpm?: number; startLoad?: number; endLoad?: number; sampleRate?: number }
export interface BankAudition {
	clip: StereoClip;
	options: { duration: number; startRpm: number; endRpm: number; startLoad: number; endLoad: number; sampleRate: number };
	trace: { seconds: number; rpm: number; load: number; weights: { rpm: number; load: number; weight: number }[] }[];
	warnings: string[];
}

/** The prototype builder emits fixed-header stereo PCM16 WAVs. This decoder
 * deliberately accepts that format only; user uploads use the browser decoder.
 */
function decodeGeneratedBankWav(data: Uint8Array): StereoClip {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (data.length < 44 || view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645
		|| view.getUint32(12, false) !== 0x666d7420 || view.getUint32(36, false) !== 0x64617461
		|| view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 2 || view.getUint16(34, true) !== 16) throw new RangeError('WAV do banco não é PCM16 estéreo no formato do gerador.');
	const bytes = view.getUint32(40, true);
	if (bytes % 4 || bytes > data.length - 44) throw new RangeError('Comprimento de WAV inválido.');
	const left = new Float32Array(bytes / 4), right = new Float32Array(bytes / 4);
	for (let frame = 0; frame < left.length; frame++) { left[frame] = view.getInt16(44 + frame * 4, true) / 32768; right[frame] = view.getInt16(46 + frame * 4, true) / 32768; }
	return { left, right, sampleRate: view.getUint32(24, true) };
}

/** Audition the actual decoded loops, including their imperfect internal seams.
 * Four neighboring anchors blend linearly. Every loop advances against the
 * same integrated RPM clock and is pitched by targetRPM/anchorRPM; this makes
 * the path continuous when a new anchor becomes audible. It cannot guarantee
 * phase coherence: bank recordings are not all phase-aligned across anchors.
 */
export function auditionDecodedBank(points: DecodedBankPoint[], input: BankAuditionOptions = {},
	onProgress?: (fraction: number) => void): BankAudition {
	if (!points.length) throw new RangeError('Banco vazio.');
	for (const point of points) {
		validateClip(point.clip);
		if (!Number.isFinite(point.rpm) || point.rpm <= 0 || !Number.isFinite(point.load) || point.load < 0 || point.load > 1) throw new RangeError('Âncora de banco inválida.');
	}
	const rpms = [...new Set(points.map((point) => point.rpm))].sort((a, b) => a - b);
	const loads = [...new Set(points.map((point) => point.load))].sort((a, b) => a - b);
	const lookup = new Map(points.map((point) => [`${point.rpm}/${point.load}`, point]));
	if (lookup.size !== points.length || points.length !== rpms.length * loads.length) throw new RangeError('O banco precisa de uma grade completa de RPM × carga, sem âncoras duplicadas.');
	const value = (candidate: number | undefined, fallback: number, low: number, high: number): number => Number.isFinite(candidate) ? clamp(candidate!, low, high) : fallback;
	const options = { duration: value(input.duration, 6, 0.2, 12), sampleRate: Math.round(value(input.sampleRate, 48000, 8000, 96000)),
		startRpm: value(input.startRpm, rpms[0], rpms[0], rpms.at(-1)!), endRpm: value(input.endRpm, rpms.at(-1)!, rpms[0], rpms.at(-1)!),
		startLoad: value(input.startLoad, loads[0], loads[0], loads.at(-1)!), endLoad: value(input.endLoad, loads.at(-1)!, loads[0], loads.at(-1)!) };
	const frames = Math.round(options.duration * options.sampleRate), left = new Float32Array(frames), right = new Float32Array(frames);
	const trace: BankAudition['trace'] = [];
	function bracket(anchors: number[], target: number): [number, number, number] {
		let low = anchors[0], high = anchors.at(-1)!;
		for (let index = 0; index < anchors.length - 1; index++) if (target >= anchors[index] && target <= anchors[index + 1]) { low = anchors[index]; high = anchors[index + 1]; break; }
		return [low, high, high === low ? 0 : clamp((target - low) / (high - low), 0, 1)];
	}
	let rpmSeconds = 0; onProgress?.(0);
	for (let frame = 0; frame < frames; frame++) {
		const fraction = frame / Math.max(1, frames - 1), rpm = options.startRpm + (options.endRpm - options.startRpm) * fraction;
		const load = options.startLoad + (options.endLoad - options.startLoad) * fraction;
		const [r0, r1, rt] = bracket(rpms, rpm), [l0, l1, lt] = bracket(loads, load);
		const anchors = [{ rpm: r0, load: l0, weight: (1 - rt) * (1 - lt) }, { rpm: r1, load: l0, weight: rt * (1 - lt) },
			{ rpm: r0, load: l1, weight: (1 - rt) * lt }, { rpm: r1, load: l1, weight: rt * lt }];
		let a = 0, b = 0;
		for (const anchor of anchors) {
			if (anchor.weight <= 0) continue;
			const point = lookup.get(`${anchor.rpm}/${anchor.load}`)!;
			const position = rpmSeconds / point.rpm * point.clip.sampleRate % point.clip.left.length;
			const index = Math.floor(position), next = (index + 1) % point.clip.left.length, t = position - index;
			a += (point.clip.left[index] + (point.clip.left[next] - point.clip.left[index]) * t) * anchor.weight;
			b += (point.clip.right[index] + (point.clip.right[next] - point.clip.right[index]) * t) * anchor.weight;
		}
		left[frame] = a; right[frame] = b; rpmSeconds += rpm / options.sampleRate;
		if (frame % Math.max(1, Math.round(options.sampleRate * 0.05)) === 0 || frame === frames - 1) trace.push({ seconds: frame / options.sampleRate, rpm, load, weights: anchors.filter((anchor) => anchor.weight > 0) });
		if (frame % 4096 === 0) onProgress?.(frame / frames);
	}
	// Only the outer audition edges fade; internal loop seams remain audible.
	const edge = Math.min(Math.round(options.sampleRate * 0.008), Math.floor(frames / 2));
	for (let index = 0; index < edge; index++) {
		const gain = 0.5 - 0.5 * Math.cos(Math.PI * index / Math.max(1, edge - 1));
		left[index] *= gain; right[index] *= gain; left[frames - 1 - index] *= gain; right[frames - 1 - index] *= gain;
	}
	onProgress?.(1);
	return { clip: { left, right, sampleRate: options.sampleRate }, options, trace,
		warnings: ['Auditoria de banco protótipo: loops reais do gerador, interpolação linear de RPM × carga e pitch por RPM.',
			'Fase e ruído não estão alinhados entre todas as âncoras; cancelamentos e emendas internas podem ser audíveis.',
			'Uma varredura de banco não reproduz os estados dinâmicos de turbo, motor e transmissão em tempo real.'] };
}

/** Build once with the production prototype builder, decode its realWAV bytes,
 * then audition those loops. Never substitute a fresh direct-synthesis sweep.
 */
export function auditionBankTransition(config: EngineConfig, options: BankAuditionOptions = {},
	onProgress?: (fraction: number) => void): BankAudition {
	const bank = renderBank(config, (progress) => onProgress?.(progress * 0.8));
	const manifestFile = bank.files.find((file) => file.name === 'manifest.json')!;
	const manifest = JSON.parse(new TextDecoder().decode(manifestFile.data)) as { points: { rpm: number; load: number; file: string }[] };
	const files = new Map(bank.files.map((file) => [file.name, file.data]));
	const points = manifest.points.map((point) => ({ rpm: point.rpm, load: point.load, clip: decodeGeneratedBankWav(files.get(point.file)!) }));
	return auditionDecodedBank(points, options, (progress) => onProgress?.(0.8 + progress * 0.2));
}
