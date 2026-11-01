import type { EngineConfig } from './dsp.ts';

/** Original procedural instruments. These are configurations, never recordings. */
export interface EnginePreset {
	id: string;
	name: string;
	description: string;
	config: EngineConfig;
}

export const defaultConfig: EngineConfig = {
	cylinders: 4,
	layout: 'inline',
	bankAngle: 0,
	displacement: 2,
	compression: 10.5,
	idleRpm: 850,
	redline: 7200,
	cam: 0.28,
	irregularity: 0.08,
	roughness: 0.12,
	timingJitter: 0.1,
	lowBody: 0.2,
	wear: 0,
	combustionDetail: 0.4,
	exhaustLength: 1.7,
	headerLength: 0.58,
	pipeDiameter: 57,
	muffler: 0.46,
	crossover: 0,
	intakeLength: 0.32,
	temperature: 540,
	boostBar: 0,
	turboSize: 0.4,
	bov: 0.5,
	exhaustGain: 0.78,
	intakeGain: 0.3,
	mechanicalGain: 0.22,
	turboGain: 0.36,
	firingAngles: [0, 180, 360, 540],
	firingOrder: [1, 3, 4, 2],
	cylinderBanks: [0, 0, 0, 0],
	damping: 0.34,
	overrun: 0.22,
	inertia: 0.42,
	stereoWidth: 0.72,
	perspective: 'exhaust',
	seed: 23761,
};

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.min(maximum, Math.max(minimum, value))
		: fallback;
}

function defaultOrder(cylinders: number, layout: EngineConfig['layout']): number[] {
	if (cylinders === 4) return layout === 'boxer' ? [1, 3, 2, 4] : [1, 3, 4, 2];
	if (cylinders === 3) return [1, 3, 2];
	if (cylinders === 6 && layout === 'inline') return [1, 5, 3, 6, 2, 4];
	return Array.from({ length: cylinders }, (_, index) => index + 1);
}

function validOrder(order: unknown, cylinders: number): order is number[] {
	return Array.isArray(order) && order.length === cylinders
		&& order.every((value) => Number.isInteger(value) && value >= 1 && value <= cylinders)
		&& new Set(order).size === cylinders;
}

function validAngles(angles: unknown, cylinders: number): angles is number[] {
	return Array.isArray(angles) && angles.length === cylinders
		&& angles.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 720)
		&& new Set(angles).size === cylinders;
}

/**
 * Sanitize imported/user-edited settings and return fresh topology arrays.
 * A four-stroke cycle is 720 crank degrees. Angles and their cylinder identifiers
 * are sorted together, preserving an explicitly supplied uneven firing schedule.
 */
export function normalizeConfig(input: Partial<EngineConfig> = {}): EngineConfig {
	const source = input && typeof input === 'object' ? input : {};
	const cylinders = Math.round(bounded(source.cylinders, defaultConfig.cylinders, 1, 12));
	const layout = source.layout === 'v' || source.layout === 'boxer' || source.layout === 'inline'
		? source.layout : defaultConfig.layout;
	let firingAngles: number[];
	let firingOrder: number[];
	if (validAngles(source.firingAngles, cylinders) && validOrder(source.firingOrder, cylinders)) {
		const events = source.firingAngles.map((angle, index) => ({ angle, cylinder: source.firingOrder![index]! }));
		events.sort((a, b) => a.angle - b.angle);
		firingAngles = events.map((event) => event.angle);
		firingOrder = events.map((event) => event.cylinder);
	} else {
		firingAngles = Array.from({ length: cylinders }, (_, index) => index * 720 / cylinders);
		firingOrder = defaultOrder(cylinders, layout);
	}
	const suppliedBanks = source.cylinderBanks;
	const banksValid = Array.isArray(suppliedBanks) && suppliedBanks.length === cylinders
		&& suppliedBanks.every((bank) => bank === 0 || bank === 1)
		&& (cylinders === 1 || (suppliedBanks.includes(0) && suppliedBanks.includes(1)));
	const cylinderBanks = layout === 'inline'
		? Array.from({ length: cylinders }, () => 0)
		: banksValid ? suppliedBanks!.slice() : Array.from({ length: cylinders }, (_, index) => index % 2);
	const idleRpm = bounded(source.idleRpm, defaultConfig.idleRpm, 400, 2400);
	return {
		cylinders,
		layout,
		bankAngle: layout === 'inline' ? 0 : bounded(
			source.bankAngle && source.bankAngle > 0 ? source.bankAngle : undefined,
			layout === 'boxer' ? 180 : 60, 10, 180,
		),
		displacement: bounded(source.displacement, defaultConfig.displacement, 0.1, 12),
		compression: bounded(source.compression, defaultConfig.compression, 6, 16),
		idleRpm,
		redline: Math.max(idleRpm + 500, bounded(source.redline, defaultConfig.redline, 2000, 18000)),
		cam: bounded(source.cam, defaultConfig.cam, 0, 1),
		irregularity: bounded(source.irregularity, defaultConfig.irregularity, 0, 1),
		roughness: bounded(source.roughness, defaultConfig.roughness, 0, 1),
		timingJitter: bounded(source.timingJitter, defaultConfig.timingJitter, 0, 1),
		lowBody: bounded(source.lowBody, defaultConfig.lowBody, 0, 1),
		wear: bounded(source.wear, defaultConfig.wear, 0, 1),
		combustionDetail: bounded(source.combustionDetail, defaultConfig.combustionDetail, 0, 1),
		exhaustLength: bounded(source.exhaustLength, defaultConfig.exhaustLength, 0.15, 4),
		headerLength: bounded(source.headerLength, defaultConfig.headerLength, 0.1, 2),
		pipeDiameter: bounded(source.pipeDiameter, defaultConfig.pipeDiameter, 20, 140),
		muffler: bounded(source.muffler, defaultConfig.muffler, 0, 1),
		crossover: bounded(source.crossover, defaultConfig.crossover, 0, 1),
		intakeLength: bounded(source.intakeLength, defaultConfig.intakeLength, 0.05, 1.5),
		temperature: bounded(source.temperature, defaultConfig.temperature, 100, 1000),
		boostBar: bounded(source.boostBar, defaultConfig.boostBar, 0, 2.5),
		turboSize: bounded(source.turboSize, defaultConfig.turboSize, 0, 1),
		bov: bounded(source.bov, defaultConfig.bov, 0, 1),
		exhaustGain: bounded(source.exhaustGain, defaultConfig.exhaustGain, 0, 1),
		intakeGain: bounded(source.intakeGain, defaultConfig.intakeGain, 0, 1),
		mechanicalGain: bounded(source.mechanicalGain, defaultConfig.mechanicalGain, 0, 1),
		turboGain: bounded(source.turboGain, defaultConfig.turboGain, 0, 1),
		firingAngles,
		firingOrder,
		cylinderBanks,
		damping: bounded(source.damping, defaultConfig.damping, 0, 1),
		overrun: bounded(source.overrun, defaultConfig.overrun, 0, 1),
		inertia: bounded(source.inertia, defaultConfig.inertia, 0, 1),
		stereoWidth: bounded(source.stereoWidth, defaultConfig.stereoWidth, 0, 1),
		perspective: source.perspective === 'exhaust' || source.perspective === 'engine'
			|| source.perspective === 'cabin' || source.perspective === 'roadside'
			? source.perspective : defaultConfig.perspective,
		seed: Math.round(bounded(source.seed, defaultConfig.seed, 1, 0xffffffff)),
	};
}

function preset(id: string, name: string, description: string, values: Partial<EngineConfig>): EnginePreset {
	return { id, name, description, config: normalizeConfig({ ...defaultConfig, ...values }) };
}

export const presets: EnginePreset[] = [
	preset('i3-turbo-1', 'Inline three · 1.0 turbo',
		'An even 240° three-cylinder cadence with a compact exhaust and a small, quick-spooling turbo.', {
			cylinders: 3, displacement: 1, compression: 10, idleRpm: 920, redline: 6700,
			firingAngles: [0, 240, 480], firingOrder: [1, 3, 2], cylinderBanks: [0, 0, 0],
			boostBar: 1.05, turboSize: 0.24, bov: 0.62, turboGain: 0.52,
			exhaustLength: 1.8, headerLength: 0.32, pipeDiameter: 48, muffler: 0.52,
			intakeLength: 0.38, cam: 0.18, irregularity: 0.12, inertia: 0.36, seed: 1031,
		}),
	preset('i4-na-2', 'Inline four · 2.0 naturally aspirated',
		'A balanced 180° pulse train, medium-length headers and an audible intake resonance.', {}),
	preset('v-twin-1-2', 'V twin · 1.2 uneven fire',
		'A 45° shared-pin twin with alternating 315° and 405° gaps and separate, long exhaust paths.', {
			cylinders: 2, layout: 'v', bankAngle: 45, displacement: 1.2, compression: 9.4,
			idleRpm: 850, redline: 5900, firingAngles: [0, 315], firingOrder: [1, 2], cylinderBanks: [0, 1],
			exhaustLength: 1.85, headerLength: 0.85, pipeDiameter: 44, muffler: 0.22,
			crossover: 0.08, cam: 0.4, irregularity: 0.23, inertia: 0.68, mechanicalGain: 0.3,
			intakeLength: 0.26, seed: 1212,
		}),
	preset('boxer-4', 'Boxer four · 2.4',
		'An even 180° firing cycle with paired bank arrivals and unequal acoustic travel between the banks.', {
			layout: 'boxer', bankAngle: 180, displacement: 2.4, compression: 11.5,
			idleRpm: 820, redline: 7500, firingOrder: [1, 3, 2, 4], cylinderBanks: [0, 1, 0, 1],
			exhaustLength: 1.6, headerLength: 0.65, pipeDiameter: 60, crossover: 0.16,
			muffler: 0.32, cam: 0.37, intakeGain: 0.4, irregularity: 0.1, seed: 2404,
		}),
	preset('v6-3', 'V six · 3.0',
		'An even-fire 60° V6 with 120° global spacing, alternating banks and a mild crossover.', {
			cylinders: 6, layout: 'v', bankAngle: 60, displacement: 3, compression: 10.8,
			idleRpm: 780, redline: 7600, firingAngles: [0, 120, 240, 360, 480, 600],
			firingOrder: [1, 2, 3, 4, 5, 6], cylinderBanks: [0, 1, 0, 1, 0, 1],
			headerLength: 0.48, exhaustLength: 1.9, pipeDiameter: 60, crossover: 0.28,
			muffler: 0.4, intakeLength: 0.29, inertia: 0.46, seed: 3060,
		}),
	preset('v8-crossplane', 'Crossplane V eight · 5.0',
		'Even 90° combustion events with uneven 90°/180°/270° spacing in each bank; the crossover blends those arrivals.', {
			cylinders: 8, layout: 'v', bankAngle: 90, displacement: 5, compression: 10.8,
			idleRpm: 720, redline: 6900, firingAngles: [0, 90, 180, 270, 360, 450, 540, 630],
			firingOrder: [1, 8, 4, 3, 6, 5, 7, 2], cylinderBanks: [0, 1, 0, 1, 0, 1, 0, 1],
			headerLength: 0.72, exhaustLength: 2.25, pipeDiameter: 70, crossover: 0.32,
			muffler: 0.26, cam: 0.52, irregularity: 0.19, inertia: 0.62,
			intakeLength: 0.42, intakeGain: 0.32, seed: 5090,
		}),
	preset('v8-flatplane', 'Flatplane V eight · 4.0',
		'Alternating banks turn the even 90° cycle into regular 180° pulses in each exhaust path.', {
			cylinders: 8, layout: 'v', bankAngle: 90, displacement: 4, compression: 12.3,
			idleRpm: 1050, redline: 9200, firingAngles: [0, 90, 180, 270, 360, 450, 540, 630],
			firingOrder: [1, 2, 3, 4, 5, 6, 7, 8], cylinderBanks: [0, 1, 0, 1, 0, 1, 0, 1],
			headerLength: 0.44, exhaustLength: 1.35, pipeDiameter: 64, crossover: 0.46,
			muffler: 0.18, cam: 0.72, irregularity: 0.1, inertia: 0.24,
			intakeLength: 0.18, intakeGain: 0.48, mechanicalGain: 0.28, seed: 4092,
		}),
	preset('v10-5', 'V ten · 5.0',
		'A dense 72° even-fire sequence with alternating banks, short intake runners and a full lower exhaust voice.', {
			cylinders: 10, layout: 'v', bankAngle: 72, displacement: 5, compression: 12.2,
			idleRpm: 1050, redline: 9800, firingAngles: [0, 72, 144, 216, 288, 360, 432, 504, 576, 648],
			firingOrder: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], cylinderBanks: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
			headerLength: 0.4, exhaustLength: 1.4, pipeDiameter: 70, crossover: 0.36,
			muffler: 0.16, damping: 0.23, cam: 0.74, irregularity: 0.07, inertia: 0.27,
			roughness: 0.18, timingJitter: 0.12, lowBody: 0.45, combustionDetail: 0.5,
			intakeLength: 0.16, intakeGain: 0.48, seed: 5010,
		}),
	preset('v12-highrev', 'V twelve · 6.0 high rev',
		'A smooth 60° event train with alternating banks, a rounded lower voice and high-rev intake detail.', {
			cylinders: 12, layout: 'v', bankAngle: 60, displacement: 6, compression: 12.6,
			idleRpm: 1100, redline: 11200, firingAngles: [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660],
			firingOrder: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], cylinderBanks: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
			headerLength: 0.35, exhaustLength: 1.25, pipeDiameter: 72, crossover: 0.45,
			muffler: 0.2, damping: 0.22, cam: 0.78, irregularity: 0.05, inertia: 0.31,
			roughness: 0.18, timingJitter: 0.12, lowBody: 0.5, combustionDetail: 0.5,
			intakeLength: 0.13, intakeGain: 0.52, mechanicalGain: 0.3, seed: 6012,
		}),
	preset('v12-classic', 'V twelve · 5.0 classic',
		'A relaxed 60° twelve-cylinder cadence with long collectors, deep exhaust body and a lightly worn mechanical texture.', {
			cylinders: 12, layout: 'v', bankAngle: 60, displacement: 5, compression: 9.6,
			idleRpm: 760, redline: 7000, firingAngles: [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660],
			firingOrder: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], cylinderBanks: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
			headerLength: 0.9, exhaustLength: 2.65, pipeDiameter: 63, crossover: 0.18,
			muffler: 0.4, damping: 0.3, cam: 0.3, irregularity: 0.14, inertia: 0.6,
			roughness: 0.5, timingJitter: 0.35, lowBody: 0.75, wear: 0.15, combustionDetail: 0.55,
			intakeLength: 0.44, intakeGain: 0.34, mechanicalGain: 0.3, temperature: 500, seed: 501276,
		}),
	preset('i4-compact-1-2', 'Inline four · 1.2 compact',
		'A light naturally aspirated four with even 180° firing, a narrow muffled exhaust and gentle healthy combustion texture.', {
			cylinders: 4, layout: 'inline', bankAngle: 0, displacement: 1.2, compression: 9.8,
			idleRpm: 820, redline: 6000, firingAngles: [0, 180, 360, 540],
			firingOrder: [1, 3, 4, 2], cylinderBanks: [0, 0, 0, 0],
			headerLength: 0.5, exhaustLength: 2.05, pipeDiameter: 42, crossover: 0,
			muffler: 0.62, damping: 0.42, cam: 0.15, irregularity: 0.09, inertia: 0.4,
			roughness: 0.18, timingJitter: 0.12, lowBody: 0.25, wear: 0, combustionDetail: 0.3,
			boostBar: 0, intakeLength: 0.38, intakeGain: 0.28, mechanicalGain: 0.2,
			temperature: 480, seed: 1204,
		}),
];
