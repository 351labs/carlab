import { normalizeConfig } from './presets.ts';

/** All lengths are metres, pipeDiameter is millimetres, temperature is °C. */
export interface EngineConfig {
	cylinders: number;
	layout: 'inline' | 'v' | 'boxer';
	bankAngle: number;
	displacement: number;
	compression: number;
	idleRpm: number;
	redline: number;
	cam: number;
	irregularity: number;
	/** Slow cylinder imbalance, idle hunting and load-dependent mechanical texture. */
	roughness: number;
	/** Bounded cycle-to-cycle arrival variation in crank degrees; never missing events. */
	timingJitter: number;
	/** Collector/chassis low-order resonance, driven by actual pulses and crank motion. */
	lowBody: number;
	/** Occasional mildly weak idle combustion; high load suppresses this behaviour. */
	wear: number;
	/** RPM/load-dependent blowdown, exhaust-flow and intake-valve pulse shape. */
	combustionDetail: number;
	/** Static listening transfer. Roadside has no moving-source Doppler model. */
	perspective: 'exhaust' | 'engine' | 'cabin' | 'roadside';
	exhaustLength: number;
	headerLength: number;
	pipeDiameter: number;
	muffler: number;
	crossover: number;
	intakeLength: number;
	temperature: number;
	boostBar: number;
	turboSize: number;
	bov: number;
	exhaustGain: number;
	intakeGain: number;
	mechanicalGain: number;
	turboGain: number;
	/** One ignition per cylinder per 720 crank degrees, paired with firingOrder. */
	firingAngles: number[];
	/** One-based cylinder identifiers, in event order. */
	firingOrder: number[];
	/** Bank 0 or 1 for cylinder id minus one. */
	cylinderBanks: number[];
	damping: number;
	overrun: number;
	inertia: number;
	stereoWidth: number;
	seed: number;
}

/** Control-state inputs from the reduced physical model, not measured CFD data.
 * Pressures are absolute except boostBar, which is gauge pressure. Cycle phase
 * is a perturbation around the mean pressure arrival, never an absolute CA50.
 */
export interface PhysicalAudioState {
	boostBar: number;
	fuelCut: boolean;
	intakePressureBar: number;
	exhaustPressureBar: number;
	exhaustMassFlowKgs: number;
	exhaustTemperatureK: number;
	cycleEnergyScale: number;
	burnDurationScale: number;
	combustionPhaseDeg: number;
	residualFraction: number;
	cycleIndex: number;
}

export interface EngineState {
	rpm: number;
	load: number;
	throttle: number;
	physical?: Partial<PhysicalAudioState> | null;
}

export interface EngineTelemetry extends EngineState {
	/** Estimated boost pressure in bar, with a persistent spool state. */
	boost: number;
	turboRpm: number;
	/** Ideal four-stroke event frequency, before limiter/fuel cuts. */
	firingHz: number;
	peak: number;
	limiter: boolean;
	cycle: number;
	firingEvents: number;
	combustionEvents: number;
	bov: number;
}

const TAU = 2 * Math.PI;
const MAX_CYLINDERS = 12;
const PARAMS = 37;
const PRESSURE = 0, ATTACK = 1, DECAY = 2, IRREGULARITY = 3, CAM = 4;
const MUFFLER = 5, DAMPING = 6, CROSSOVER = 7, BOOST = 8, TURBO_SIZE = 9;
const BOV = 10, EXHAUST_GAIN = 11, INTAKE_GAIN = 12, MECHANICAL_GAIN = 13;
const TURBO_GAIN = 14, WIDTH = 15, OVERRUN = 16, REDLINE = 17, INERTIA = 18;
const IDLE = 19, BALANCE = 20, BANK_PRESENCE = 21;
const ROUGHNESS = 22, TIMING_JITTER = 23, LOW_BODY = 24, WEAR = 25;
const DETAIL = 26, ENGINE_VIEW = 27, CABIN_VIEW = 28, ROADSIDE_VIEW = 29;
const PHYSICAL_MIX = 30, PHYSICAL_BOOST = 31, INTAKE_PRESSURE = 32;
const EXHAUST_PRESSURE = 33, EXHAUST_FLOW = 34, EXHAUST_TEMPERATURE = 35, RESIDUAL = 36;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function physicalValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
}

/** A lossy open-ended pipe: a fractional round trip with an inverted reflection.
 * Geometry affects travel time and junction impedance; wall/muffler losses filter
 * the reflected wave. This is an acoustic instrument, not a gas-flow simulator.
 */
class Pipe {
	private readonly sampleRate: number;
	private readonly buffer: Float64Array;
	private position = 0;
	private low = 0;
	private delay = 1;
	private targetDelay = 1;
	private cutoff = 0.3;
	private targetCutoff = 0.3;
	private reflection = 0.5;
	private targetReflection = 0.5;
	private nominalDelay = 1;
	private nominalCutoffHz = 1000;
	private nominalReflection = 0.5;
	private readonly smoothing: number;

	constructor(sampleRate: number) {
		this.sampleRate = sampleRate;
		this.buffer = new Float64Array(Math.ceil(sampleRate * 0.09) + 4);
		this.smoothing = 1 - Math.exp(-1 / (sampleRate * 0.035));
	}

	configure(length: number, speed: number, cutoffHz: number, reflection: number, immediate: boolean): void {
		this.nominalDelay = clamp(2 * length / speed * this.sampleRate, 1, this.buffer.length - 2);
		this.nominalCutoffHz = cutoffHz;
		this.nominalReflection = reflection;
		this.targetDelay = clamp(2 * length / speed * this.sampleRate, 1, this.buffer.length - 2);
		this.targetCutoff = 1 - Math.exp(-TAU * clamp(cutoffHz, 80, this.sampleRate * 0.42) / this.sampleRate);
		this.targetReflection = clamp(reflection, 0, 0.86);
		if (immediate) {
			this.delay = this.targetDelay;
			this.cutoff = this.targetCutoff;
			this.reflection = this.targetReflection;
		}
	}

	/** Bounded mean-flow/temperature correction of this same geometric pipe.
	 * Called at a fixed control interval, never an acoustic CFD calculation.
	 */
	setEnvironment(speedRatio: number, flowLoss: number): void {
		this.targetDelay = clamp(this.nominalDelay / speedRatio, 1, this.buffer.length - 2);
		const cutoff = clamp(this.nominalCutoffHz * (1 - flowLoss * 0.24), 80, this.sampleRate * 0.42);
		this.targetCutoff = 1 - Math.exp(-TAU * cutoff / this.sampleRate);
		this.targetReflection = clamp(this.nominalReflection * (1 - flowLoss * 0.32), 0, 0.86);
	}

	tick(input: number): number {
		const smoothing = this.smoothing;
		this.delay += (this.targetDelay - this.delay) * smoothing;
		this.cutoff += (this.targetCutoff - this.cutoff) * smoothing;
		this.reflection += (this.targetReflection - this.reflection) * smoothing;
		let read = this.position - this.delay;
		if (read < 0) read += this.buffer.length;
		const index = Math.floor(read);
		const fraction = read - index;
		const next = index + 1 === this.buffer.length ? 0 : index + 1;
		const wave = this.buffer[index]! + (this.buffer[next]! - this.buffer[index]!) * fraction;
		this.low += (wave - this.low) * this.cutoff;
		const write = input - this.low * this.reflection;
		// Gentle pressure saturation also bounds energy while dragging pipe length.
		this.buffer[this.position] = write / (1 + Math.abs(write) * 0.13);
		if (++this.position === this.buffer.length) this.position = 0;
		return this.low;
	}
}

/** A damped collector/body mode. A band-pass numerator rejects DC; its centre
 * comes from exhaust travel length, not a divided or transposed ignition clock.
 */
class BodyMode {
	private b = 0;
	private a1 = 0;
	private a2 = 0;
	private targetB = 0;
	private targetA1 = 0;
	private targetA2 = 0;
	private x1 = 0;
	private x2 = 0;
	private y1 = 0;
	private y2 = 0;
	private readonly smoothing: number;
	private readonly sampleRate: number;

	constructor(sampleRate: number) {
		this.sampleRate = sampleRate;
		this.smoothing = 1 - Math.exp(-1 / (sampleRate * 0.05));
	}

	configure(frequency: number, q: number, immediate: boolean): void {
		const omega = TAU * frequency / this.sampleRate;
		const alpha = Math.sin(omega) / (2 * q);
		this.targetB = alpha / (1 + alpha);
		this.targetA1 = -2 * Math.cos(omega) / (1 + alpha);
		this.targetA2 = (1 - alpha) / (1 + alpha);
		if (immediate) { this.b = this.targetB; this.a1 = this.targetA1; this.a2 = this.targetA2; }
	}

	tick(input: number): number {
		this.b += (this.targetB - this.b) * this.smoothing;
		this.a1 += (this.targetA1 - this.a1) * this.smoothing;
		this.a2 += (this.targetA2 - this.a2) * this.smoothing;
		const value = this.b * (input - this.x2) - this.a1 * this.y1 - this.a2 * this.y2;
		this.x2 = this.x1; this.x1 = input;
		this.y2 = this.y1; this.y1 = clamp(value, -8, 8);
		return this.y1;
	}
}

/** Clean-room, sample-free four-stroke engine sound synthesizer.
 *
 * RPM determines event timing. Displacement/compression/load determine pulse
 * energy and shape, and the selected exhaust/intake geometry colours those
 * pressure pulses. There is deliberately no horsepower-to-pitch shortcut.
 * process() is allocation-free; a single DSP instance must persist across blocks.
 */
export class EngineDSP {
	readonly sampleRate: number;
	private config: EngineConfig;
	private readonly parameters = new Float64Array(PARAMS);
	private readonly targets = new Float64Array(PARAMS);
	private readonly angles = new Float64Array(MAX_CYLINDERS);
	private readonly arrivals = new Float64Array(MAX_CYLINDERS);
	private readonly timingOffsets = new Float64Array(MAX_CYLINDERS);
	private readonly cylinderTrim = new Float64Array(MAX_CYLINDERS);
	private readonly cycleEnergy = new Float64Array(MAX_CYLINDERS);
	private readonly pulseWidth = new Float64Array(MAX_CYLINDERS);
	private readonly banks = new Uint8Array(MAX_CYLINDERS);
	private readonly bankMix = new Float64Array(MAX_CYLINDERS);
	private readonly slowPulses = new Float64Array(MAX_CYLINDERS);
	private readonly fastPulses = new Float64Array(MAX_CYLINDERS);
	private readonly intakeSlowPulses = new Float64Array(MAX_CYLINDERS);
	private readonly intakeFastPulses = new Float64Array(MAX_CYLINDERS);
	private readonly blowdown = new Float64Array(MAX_CYLINDERS);
	private readonly blowdownRise = new Float64Array(MAX_CYLINDERS);
	private readonly exhaustFlow = new Float64Array(MAX_CYLINDERS);
	private readonly exhaustReturn = new Float64Array(MAX_CYLINDERS);
	private readonly blowdownDecay = new Float64Array(MAX_CYLINDERS);
	private readonly blowdownAttack = new Float64Array(MAX_CYLINDERS);
	private readonly flowDecay = new Float64Array(MAX_CYLINDERS);
	private readonly returnCoefficient = new Float64Array(MAX_CYLINDERS);
	private readonly intakeDetailSlow = new Float64Array(MAX_CYLINDERS);
	private readonly intakeDetailFast = new Float64Array(MAX_CYLINDERS);
	private readonly intakeDetailDecay = new Float64Array(MAX_CYLINDERS);
	private readonly intakeDetailAttack = new Float64Array(MAX_CYLINDERS);
	private readonly headerA: Pipe;
	private readonly headerB: Pipe;
	private readonly exhaustA: Pipe;
	private readonly exhaustB: Pipe;
	private readonly intake: Pipe;
	private readonly bodyA: BodyMode;
	private readonly bodyB: BodyMode;
	private readonly bodyTailA: BodyMode;
	private readonly bodyTailB: BodyMode;
	private readonly cabinStructure: BodyMode;
	private readonly parameterSmoothing: number;
	private readonly controlSmoothing: number;
	private readonly actualRpmSmoothing: number;
	private readonly dcCoefficient: number;
	private readonly noiseCoefficient: number;
	private readonly intakeLowCoefficient: number;
	private readonly mufflerSmoothing: number;
	private readonly cabinCoefficient: number;
	private readonly airCoefficient: number;
	private cabinLowL = 0;
	private cabinLowR = 0;
	private cabinLow2L = 0;
	private cabinLow2R = 0;
	private airLowL = 0;
	private airLowR = 0;
	private pulseBlowdownSeconds = 0;
	private pulseFlowSeconds = 0;
	private pulseIntakeSeconds = 0;
	private physicalActive = false;
	private physicalFuelCut = false;
	private pendingEnergyScale = 1;
	private pendingBurnScale = 1;
	private pendingPhaseDeg = 0;
	private pendingCycleIndex = 0;
	private sharedEnergyScale = 1;
	private sharedBurnScale = 1;
	private sharedPhaseDeg = 0;
	private sharedCycleIndex = 0;
	private physicalFlowAmplitude = 0;
	private transferCountdown = 0;
	private transferWasPhysical = false;
	private referenceSoundSpeed = 500;
	private randomState: number;
	private characterState: number;
	private jitterBoundary = 0.9;
	private maximumTiming = 0.01;
	private timingMean = 0;
	private timingRms = 0;
	private timingMaximum = 0;
	private weakCombustions = 0;
	private idleHuntRpm = 0;
	private huntPhase = 0;
	private huntPhase2 = 0;
	private targetRpm: number;
	private trackActualRpm = false;
	private targetLoad = 0.25;
	private targetThrottle = 0.25;
	private rpm: number;
	private load = 0.25;
	private throttle = 0.25;
	private crank = 0;
	private cycles = 0;
	private firingEvents = 0;
	private combustionEvents = 0;
	private activeCylinders = 4;
	private pulseScale = 0.5;
	private exhaustLowA = 0;
	private exhaustLowB = 0;
	private noiseLow = 0;
	private intakeLow = 0;
	private spool = 0;
	private turboPhase = 0;
	private turboHarmonicPhase = 0;
	private bovEnvelope = 0;
	private bovArmed = false;
	private blipEnvelope = 0;
	private shiftRemaining = 0;
	private runningTarget = 1;
	private runningGain = 0;
	private dcInL = 0;
	private dcInR = 0;
	private dcOutL = 0;
	private dcOutR = 0;
	private peak = 0;
	private limiter = false;

	constructor(sampleRate: number, config: EngineConfig) {
		if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000) {
			throw new RangeError('EngineDSP sample rate must be between 8000 and 384000 Hz.');
		}
		this.sampleRate = sampleRate;
		this.config = normalizeConfig(config);
		this.randomState = this.config.seed >>> 0;
		this.characterState = (this.config.seed ^ 0x6d2b79f5) >>> 0 || 1;
		this.rpm = this.config.idleRpm;
		this.targetRpm = this.rpm;
		this.headerA = new Pipe(sampleRate);
		this.headerB = new Pipe(sampleRate);
		this.exhaustA = new Pipe(sampleRate);
		this.exhaustB = new Pipe(sampleRate);
		this.intake = new Pipe(sampleRate);
		this.bodyA = new BodyMode(sampleRate);
		this.bodyB = new BodyMode(sampleRate);
		this.bodyTailA = new BodyMode(sampleRate);
		this.bodyTailB = new BodyMode(sampleRate);
		this.cabinStructure = new BodyMode(sampleRate);
		this.cabinStructure.configure(118, 1.9, true);
		this.parameterSmoothing = 1 - Math.exp(-1 / (sampleRate * 0.035));
		this.controlSmoothing = 1 - Math.exp(-1 / (sampleRate * 0.024));
		this.actualRpmSmoothing = 1 - Math.exp(-1 / (sampleRate * 0.005));
		this.dcCoefficient = Math.exp(-TAU * 18 / sampleRate);
		this.noiseCoefficient = 1 - Math.exp(-TAU * 1200 / sampleRate);
		this.intakeLowCoefficient = 1 - Math.exp(-TAU * 190 / sampleRate);
		this.mufflerSmoothing = 1 - Math.exp(-TAU * 950 / sampleRate);
		this.cabinCoefficient = 1 - Math.exp(-TAU * 1350 / sampleRate);
		this.airCoefficient = 1 - Math.exp(-TAU * 3700 / sampleRate);
		this.targets[INTAKE_PRESSURE] = 1.01325;
		this.targets[EXHAUST_PRESSURE] = 1.01325;
		this.targets[EXHAUST_TEMPERATURE] = this.config.temperature + 273.15;
		this.configure(true);
	}

	/** Configuration changes preserve phase, pipe memory and turbo spool. */
	setConfig(config: EngineConfig): void {
		const next = normalizeConfig(config);
		if (next.seed !== this.config.seed) {
			this.randomState = next.seed >>> 0;
			this.characterState = (next.seed ^ 0x6d2b79f5) >>> 0 || 1;
		}
		this.config = next;
		this.configure(false);
	}

	/** Non-finite values are ignored. Pass actualRpm=true on every coupled physical
	 * update: RPM then follows a 5 ms interpolation, without adding a second engine
	 * inertia or artistic RPM movement. Default calls retain the legacy target path.
	 */
	setState(state: Partial<EngineState>, actualRpm = false): void {
		this.trackActualRpm = actualRpm === true;
		if (!this.trackActualRpm || state.physical === null) {
			this.physicalActive = false;
			this.physicalFuelCut = false;
			this.targets[PHYSICAL_MIX] = 0;
		} else if (state.physical && typeof state.physical === 'object') {
			const input = state.physical;
			const first = !this.physicalActive;
			const t = this.targets;
			t[PHYSICAL_BOOST] = physicalValue(input.boostBar, first ? 0 : t[PHYSICAL_BOOST]!, 0, 6);
			t[INTAKE_PRESSURE] = physicalValue(input.intakePressureBar, first ? 1.01325 : t[INTAKE_PRESSURE]!, 0.05, 10);
			t[EXHAUST_PRESSURE] = physicalValue(input.exhaustPressureBar, first ? 1.01325 : t[EXHAUST_PRESSURE]!, 0.1, 15);
			t[EXHAUST_FLOW] = physicalValue(input.exhaustMassFlowKgs, first ? 0 : t[EXHAUST_FLOW]!, 0, 10);
			t[EXHAUST_TEMPERATURE] = physicalValue(input.exhaustTemperatureK,
				first ? this.config.temperature + 273.15 : t[EXHAUST_TEMPERATURE]!, 200, 1800);
			t[RESIDUAL] = physicalValue(input.residualFraction, first ? 0 : t[RESIDUAL]!, 0, 0.8);
			this.pendingEnergyScale = physicalValue(input.cycleEnergyScale, first ? 1 : this.pendingEnergyScale, 0, 3);
			this.pendingBurnScale = physicalValue(input.burnDurationScale, first ? 1 : this.pendingBurnScale, 0.4, 2.5);
			this.pendingPhaseDeg = physicalValue(input.combustionPhaseDeg, first ? 0 : this.pendingPhaseDeg, -12, 12);
			this.pendingCycleIndex = Math.floor(physicalValue(input.cycleIndex, first ? 0 : this.pendingCycleIndex, 0, Number.MAX_SAFE_INTEGER));
			if (typeof input.fuelCut === 'boolean') this.physicalFuelCut = input.fuelCut;
			else if (first) this.physicalFuelCut = false;
			if (first) {
				for (let i = PHYSICAL_BOOST; i <= RESIDUAL; i++) this.parameters[i] = t[i]!;
				this.sharedEnergyScale = this.pendingEnergyScale;
				this.sharedBurnScale = this.pendingBurnScale;
				this.sharedCycleIndex = this.pendingCycleIndex;
				// Arrival phase is latched only in an empty gap; current events stay put.
			}
			this.physicalActive = true;
			t[PHYSICAL_MIX] = 1;
			if (first && this.cycles === 0 && this.crank === 0 && this.firingEvents === 0) this.refreshCharacter();
		}
		if (typeof state.rpm === 'number' && Number.isFinite(state.rpm)) {
			this.targetRpm = clamp(state.rpm, 0, 22000);
		}
		if (typeof state.load === 'number' && Number.isFinite(state.load)) {
			this.targetLoad = clamp(state.load, 0, 1);
		}
		if (typeof state.throttle === 'number' && Number.isFinite(state.throttle)) {
			this.targetThrottle = clamp(state.throttle, 0, 1);
		}
	}

	trigger(kind: 'shift' | 'blip' | 'start' | 'stop'): void {
		if (kind === 'shift') {
			this.shiftRemaining = 0.14;
			if (!this.physicalActive) this.bovEnvelope = Math.max(this.bovEnvelope, this.spool * 0.75);
		} else if (kind === 'blip') {
			this.blipEnvelope = 1;
		} else if (kind === 'stop') {
			this.runningTarget = 0;
		} else if (kind === 'start') {
			this.runningTarget = 1;
			if (this.targetRpm < this.config.idleRpm) this.targetRpm = this.config.idleRpm;
		}
	}

	getTelemetry(): EngineTelemetry {
		return {
			rpm: this.rpm,
			load: this.load,
			throttle: this.throttle,
			boost: this.physicalActive ? this.parameters[PHYSICAL_BOOST]! : this.spool * this.spool * this.parameters[BOOST]!,
			turboRpm: (this.physicalActive ? this.parameters[PHYSICAL_BOOST]! > 0 : this.config.boostBar > 0)
				? this.spool * (150000 + 75000 * (1 - this.parameters[TURBO_SIZE]!)) : 0,
			firingHz: this.rpm * this.activeCylinders / 120,
			peak: this.peak,
			limiter: this.limiter,
			cycle: this.cycles + this.crank,
			firingEvents: this.firingEvents,
			combustionEvents: this.combustionEvents,
			bov: this.bovEnvelope,
			physical: this.getPhysicalAudioTelemetry(),
		};
	}

	/** Low-rate diagnostics; phase/count telemetry above always describes the engine clock. */
	getCharacterTelemetry(): { timingMeanDeg: number; timingRmsDeg: number; timingMaxDeg: number; weakCombustions: number; idleHuntRpm: number } {
		return { timingMeanDeg: this.timingMean * 720, timingRmsDeg: this.timingRms * 720,
			timingMaxDeg: this.timingMaximum * 720, weakCombustions: this.weakCombustions, idleHuntRpm: this.idleHuntRpm };
	}

	/** Effective pulse time constants for calibration, not measured valve timings. */
	getPulseTelemetry(): { blowdownMs: number; flowMs: number; intakeMs: number } {
		return { blowdownMs: this.pulseBlowdownSeconds * 1000, flowMs: this.pulseFlowSeconds * 1000,
			intakeMs: this.pulseIntakeSeconds * 1000 };
	}

	getPhysicalAudioTelemetry(): PhysicalAudioState | null {
		if (!this.physicalActive) return null;
		return { boostBar: this.parameters[PHYSICAL_BOOST]!, fuelCut: this.physicalFuelCut,
			intakePressureBar: this.parameters[INTAKE_PRESSURE]!, exhaustPressureBar: this.parameters[EXHAUST_PRESSURE]!,
			exhaustMassFlowKgs: this.parameters[EXHAUST_FLOW]!, exhaustTemperatureK: this.parameters[EXHAUST_TEMPERATURE]!,
			cycleEnergyScale: this.sharedEnergyScale, burnDurationScale: this.sharedBurnScale,
			combustionPhaseDeg: this.sharedPhaseDeg, residualFraction: this.parameters[RESIDUAL]!, cycleIndex: this.sharedCycleIndex };
	}

	private configure(immediate: boolean): void {
		const c = this.config;
		let topologyChanged = this.activeCylinders !== c.cylinders;
		for (let i = 0; i < c.cylinders; i++) {
			if (this.angles[i] !== c.firingAngles[i]! / 720 || this.banks[i] !== c.cylinderBanks[c.firingOrder[i]! - 1]) topologyChanged = true;
		}
		const t = this.targets;
		const perCylinder = c.displacement / c.cylinders;
		t[PRESSURE] = Math.pow(perCylinder / 0.5, 0.45) * Math.sqrt(c.compression / 10.5);
		t[ATTACK] = Math.exp(-1 / (this.sampleRate * (0.000075 + (1 - c.cam) * 0.00013)));
		t[DECAY] = Math.exp(-1 / (this.sampleRate * (0.0014 + Math.sqrt(perCylinder) * 0.0022)));
		t[IRREGULARITY] = c.irregularity;
		t[ROUGHNESS] = c.roughness;
		t[TIMING_JITTER] = c.timingJitter;
		t[LOW_BODY] = c.lowBody;
		t[WEAR] = c.wear;
		t[DETAIL] = c.combustionDetail;
		t[ENGINE_VIEW] = c.perspective === 'engine' ? 1 : 0;
		t[CABIN_VIEW] = c.perspective === 'cabin' ? 1 : 0;
		t[ROADSIDE_VIEW] = c.perspective === 'roadside' ? 1 : 0;
		t[PHYSICAL_MIX] = this.physicalActive ? 1 : 0;
		if (!this.physicalActive) t[EXHAUST_TEMPERATURE] = c.temperature + 273.15;
		t[CAM] = c.cam;
		t[MUFFLER] = c.muffler;
		t[DAMPING] = c.damping;
		t[CROSSOVER] = c.layout === 'inline' ? 0 : c.crossover;
		t[BOOST] = c.boostBar;
		t[TURBO_SIZE] = c.turboSize;
		t[BOV] = c.bov;
		t[EXHAUST_GAIN] = c.exhaustGain;
		t[INTAKE_GAIN] = c.intakeGain;
		t[MECHANICAL_GAIN] = c.mechanicalGain;
		t[TURBO_GAIN] = c.turboGain;
		t[WIDTH] = c.stereoWidth;
		t[OVERRUN] = c.overrun;
		t[REDLINE] = c.redline;
		t[INERTIA] = c.inertia;
		t[IDLE] = c.idleRpm;
		// A modest layout-dependent vibration layer; event timing stays explicit.
		t[BALANCE] = c.layout === 'inline' ? (c.cylinders % 2 ? 0.55 : 0.28)
			: c.layout === 'boxer' ? 0.12 : 0.2 + Math.abs(Math.cos(c.bankAngle * Math.PI / 180)) * 0.3;
		t[BANK_PRESENCE] = c.layout !== 'inline' && c.cylinderBanks.includes(1) ? 1 : 0;
		if (immediate) this.parameters.set(t);
		this.activeCylinders = c.cylinders;
		this.pulseScale = 1 / Math.sqrt(c.cylinders);
		let largestGap = 0, smallestGap = 1, trimMean = 0;
		for (let i = 0; i < c.cylinders; i++) {
			this.angles[i] = c.firingAngles[i]! / 720;
			this.banks[i] = c.cylinderBanks[c.firingOrder[i]! - 1]!;
			if (immediate) this.bankMix[i] = this.banks[i]!;
			const gap = ((c.firingAngles[(i + 1) % c.cylinders]! - c.firingAngles[i]!) / 720 + 1) % 1 || 1;
			if (gap > largestGap) { largestGap = gap; this.jitterBoundary = (this.angles[i]! + gap * 0.5) % 1; }
			smallestGap = Math.min(smallestGap, gap);
			let trim = (c.seed + c.firingOrder[i]! * 0x9e3779b9) | 0;
			trim ^= trim >>> 16; trim = Math.imul(trim, 0x45d9f3b); trim ^= trim >>> 16;
			this.cylinderTrim[i] = (trim >>> 0) / 2147483648 - 1;
			trimMean += this.cylinderTrim[i]!;
		}
		for (let i = 0; i < c.cylinders; i++) this.cylinderTrim[i] -= trimMean / c.cylinders;
		// Refresh in the widest empty crank-angle gap, so jittered events cannot
		// cross the refresh boundary. Mean arrival offset is zero in every cycle.
		this.maximumTiming = Math.min(7.2 / 720, smallestGap * 0.16);
		if (immediate || topologyChanged) this.refreshCharacter();
		const speed = 343 * Math.sqrt((c.temperature + 273.15) / 293.15);
		this.referenceSoundSpeed = speed;
		const diameter = c.pipeDiameter / 57;
		const junction = clamp(0.68 - Math.abs(Math.log(diameter)) * 0.12, 0.38, 0.74);
		const headerCutoff = (9500 - c.damping * 6100) * Math.sqrt(diameter);
		const tailCutoff = (8500 - c.muffler * 6100 - c.damping * 1300) * Math.sqrt(diameter);
		const headerReflection = junction * (1 - c.damping * 0.44);
		const tailReflection = (0.76 - c.muffler * 0.32) * (1 - c.damping * 0.36);
		// The boxer instrument deliberately uses unequal bank collectors; other
		// layouts use a small collector offset to avoid perfectly identical paths.
		const bankTravel = c.layout === 'boxer' ? 1.16 : 1.025;
		this.headerA.configure(c.headerLength, speed, headerCutoff, headerReflection, immediate);
		this.headerB.configure(c.headerLength * bankTravel, speed, headerCutoff, headerReflection, immediate);
		this.exhaustA.configure(c.exhaustLength, speed, tailCutoff, tailReflection, immediate);
		this.exhaustB.configure(c.exhaustLength * 1.018, speed, tailCutoff, tailReflection, immediate);
		this.intake.configure(c.intakeLength, 343, 4200 - c.damping * 1400, 0.72, immediate);
		this.configureBodyModes(speed, immediate);
	}

	private configureBodyModes(speed: number, immediate: boolean): void {
		const c = this.config;
		const bodyHz = clamp(speed * 0.72 / (4 * (c.exhaustLength + c.headerLength + 0.45)), 48, 145);
		const bodyQ = 2.6 + c.lowBody * (4.4 + (1 - c.damping) * 3.2);
		// The third pipe mode carries chest/low-mid richness; the fundamental
		// contributes only a quiet, longer tail, avoiding an artificial sub-bass bed.
		const chestHz = clamp(bodyHz * 3, 85, 210);
		this.bodyA.configure(chestHz, 2.1 + c.lowBody * 3.1, immediate);
		this.bodyB.configure(chestHz * 1.08, 2 + c.lowBody * 2.8, immediate);
		this.bodyTailA.configure(bodyHz, bodyQ, immediate);
		this.bodyTailB.configure(bodyHz * 1.12, bodyQ * 0.91, immediate);
	}

	private characterRandom(): number {
		let value = this.characterState;
		value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
		this.characterState = value >>> 0;
		return this.characterState / 2147483648 - 1;
	}

	private refreshCharacter(): void {
		const n = this.activeCylinders;
		if (this.physicalActive) {
			this.sharedEnergyScale = this.pendingEnergyScale;
			this.sharedBurnScale = this.pendingBurnScale;
			this.sharedCycleIndex = this.pendingCycleIndex;
			const offset = clamp(this.pendingPhaseDeg / 720, -this.maximumTiming, this.maximumTiming);
			this.sharedPhaseDeg = offset * 720;
			for (let i = 0; i < n; i++) {
				this.timingOffsets[i] = offset;
				this.cycleEnergy[i] = 0;
				this.arrivals[i] = offset === 0 ? this.angles[i]! : (this.angles[i]! + offset + 1) % 1;
			}
			this.timingMean = offset;
			this.timingRms = Math.abs(offset);
			this.timingMaximum = Math.abs(offset);
			return;
		}
		let mean = 0, energyMean = 0, maximum = 0;
		for (let i = 0; i < n; i++) {
			this.timingOffsets[i] = this.characterRandom(); mean += this.timingOffsets[i]!;
			this.cycleEnergy[i] = this.characterRandom(); energyMean += this.cycleEnergy[i]!;
		}
		mean /= n; energyMean /= n;
		for (let i = 0; i < n; i++) {
			this.timingOffsets[i] -= mean;
			maximum = Math.max(maximum, Math.abs(this.timingOffsets[i]!));
			this.cycleEnergy[i] -= energyMean;
		}
		const idle = clamp((this.parameters[IDLE]! * 1.8 - this.rpm) / (this.parameters[IDLE]! * 0.8), 0, 1);
		const extent = this.maximumTiming * this.parameters[TIMING_JITTER]! * (0.22 + idle * 0.78);
		let square = 0, offsetMean = 0;
		for (let i = 0; i < n; i++) {
			const offset = maximum > 0 ? this.timingOffsets[i]! / maximum * extent : 0;
			this.timingOffsets[i] = offset;
			this.arrivals[i] = offset === 0 ? this.angles[i]! : (this.angles[i]! + offset + 1) % 1;
			square += offset * offset; offsetMean += offset;
		}
		this.timingMean = offsetMean / n;
		this.timingRms = Math.sqrt(square / n);
		this.timingMaximum = extent;
	}

	private random(): number {
		let value = this.randomState;
		value ^= value << 13;
		value ^= value >>> 17;
		value ^= value << 5;
		this.randomState = value >>> 0;
		return this.randomState / 2147483648 - 1;
	}

	private exciteExhaustDetail(cylinder: number, amplitude: number, rpm: number, load: number, age: number): void {
		const sr = this.sampleRate;
		const cam = this.parameters[CAM]!;
		const degreesPerSecond = Math.max(300, rpm) * 6;
		const volume = clamp(Math.sqrt(this.config.displacement / this.activeCylinders / 0.5), 0.6, 1.7);
		const variation = this.physicalActive ? this.sharedBurnScale : 1 + this.pulseWidth[cylinder]!;
		// Higher pressure gives a more abrupt blowdown; increasing RPM shortens
		// a valve's crank-angle window in seconds. Bounds retain a finite bandwidth.
		const blowdown = clamp((16 + (1 - load) * 12 + cam * 7) * volume / degreesPerSecond, 0.0007, 0.006) * variation;
		const rise = clamp((0.8 + (1 - load) * 1.2) / degreesPerSecond, 0.000035, 0.00035)
			* (this.physicalActive ? this.sharedBurnScale * (1 + this.parameters[RESIDUAL]! * 0.75) : 1);
		const flow = Math.max(blowdown * 1.45, clamp((52 + cam * 10) * Math.pow(volume, 0.25) / degreesPerSecond, 0.0014, 0.014));
		this.blowdownDecay[cylinder] = Math.exp(-1 / (sr * blowdown));
		this.blowdownAttack[cylinder] = Math.exp(-1 / (sr * rise));
		this.flowDecay[cylinder] = Math.exp(-1 / (sr * flow));
		this.returnCoefficient[cylinder] = 1 - Math.exp(-1 / (sr * flow * 1.15));
		const pressure = amplitude * (0.92 + load * 0.08);
		this.blowdown[cylinder] += pressure * Math.pow(this.blowdownDecay[cylinder]!, age);
		this.blowdownRise[cylinder] += pressure * Math.pow(this.blowdownAttack[cylinder]!, age);
		this.exhaustFlow[cylinder] += pressure * Math.pow(this.flowDecay[cylinder]!, age);
		this.pulseBlowdownSeconds = blowdown;
		this.pulseFlowSeconds = flow;
	}

	private exciteIntakeDetail(cylinder: number, amplitude: number, rpm: number, load: number, age: number): void {
		const degreesPerSecond = Math.max(300, rpm) * 6;
		const duration = clamp((38 + this.parameters[CAM]! * 30) / degreesPerSecond, 0.0014, 0.018);
		const rise = clamp(3.2 / degreesPerSecond, 0.00012, 0.0025);
		this.intakeDetailDecay[cylinder] = Math.exp(-1 / (this.sampleRate * duration));
		this.intakeDetailAttack[cylinder] = Math.exp(-1 / (this.sampleRate * rise));
		const suction = amplitude * (0.65 + load * 0.35) * 0.82;
		this.intakeDetailSlow[cylinder] += suction * Math.pow(this.intakeDetailDecay[cylinder]!, age);
		this.intakeDetailFast[cylinder] += suction * Math.pow(this.intakeDetailAttack[cylinder]!, age);
		this.pulseIntakeSeconds = duration;
	}

	private updatePhysicalTransfer(): void {
		const p = this.parameters;
		const mix = p[PHYSICAL_MIX]!;
		if (!this.physicalActive && mix < 0.0001 && !this.transferWasPhysical) return;
		if (!this.physicalActive && mix < 0.0001) {
			this.headerA.setEnvironment(1, 0); this.headerB.setEnvironment(1, 0);
			this.exhaustA.setEnvironment(1, 0); this.exhaustB.setEnvironment(1, 0);
			this.configureBodyModes(this.referenceSoundSpeed, false);
			this.physicalFlowAmplitude = 0;
			this.transferWasPhysical = false;
			return;
		}
		this.transferWasPhysical = true;
		const temperature = p[EXHAUST_TEMPERATURE]!;
		const speed = 343 * Math.sqrt(temperature / 293.15);
		const diameterM = this.config.pipeDiameter / 1000;
		const area = Math.PI * diameterM * diameterM / 4 * (this.config.layout === 'inline' ? 1 : 2);
		const density = p[EXHAUST_PRESSURE]! * 1e5 / (287.05 * temperature);
		const velocity = clamp(p[EXHAUST_FLOW]! / Math.max(0.00001, density * area), 0, 350);
		const machLoss = clamp(velocity / speed, 0, 0.8);
		const speedRatio = 1 + (speed / this.referenceSoundSpeed - 1) * mix;
		this.headerA.setEnvironment(speedRatio, machLoss * mix);
		this.headerB.setEnvironment(speedRatio, machLoss * mix);
		this.exhaustA.setEnvironment(speedRatio, machLoss * mix);
		this.exhaustB.setEnvironment(speedRatio, machLoss * mix);
		this.configureBodyModes(this.referenceSoundSpeed * speedRatio, false);
		this.physicalFlowAmplitude = Math.pow(velocity / 140, 1.2) * 0.024 * mix;
	}

	process(left: Float32Array, right: Float32Array): void {
		const frames = Math.min(left.length, right.length);
		const sr = this.sampleRate;
		const dt = 1 / sr;
		const p = this.parameters;
		const t = this.targets;
		for (let frame = 0; frame < frames; frame++) {
			for (let parameter = 0; parameter < PARAMS; parameter++) {
				p[parameter] += (t[parameter]! - p[parameter]!) * this.parameterSmoothing;
			}
			if (--this.transferCountdown <= 0) { this.transferCountdown = 128; this.updatePhysicalTransfer(); }
			const physical = this.physicalActive;
			const detail = Math.max(p[DETAIL]!, p[PHYSICAL_MIX]!);
			const blip = this.blipEnvelope;
			this.blipEnvelope *= 1 - dt * 5.8;
			const shift = this.shiftRemaining > 0;
			if (shift) this.shiftRemaining -= dt;
			this.huntPhase = (this.huntPhase + dt * 0.61) % 1;
			this.huntPhase2 = (this.huntPhase2 + dt * 1.07) % 1;
			const idleDemand = clamp((p[IDLE]! * 1.8 - this.targetRpm) / (p[IDLE]! * 0.8), 0, 1)
				* (1 - this.load) * (1 - this.throttle) * (1 - blip);
			this.idleHuntRpm = this.trackActualRpm ? 0 : p[ROUGHNESS]! * idleDemand * (10 + p[ROUGHNESS]! * 48 + p[WEAR]! * 20)
				* (Math.sin(TAU * this.huntPhase) + Math.sin(TAU * this.huntPhase2) * 0.38);
			const tracking = this.trackActualRpm && this.runningTarget === 1;
			const rpmWanted = tracking ? this.targetRpm : this.runningTarget * Math.max((this.targetRpm + this.idleHuntRpm) * (shift ? 0.88 : 1),
				blip * Math.min(p[REDLINE]! * 0.65, p[IDLE]! + 3800));
			// Inertia controls tracking speed, without moving the event clock by steps.
			const rpmCoefficient = tracking ? this.actualRpmSmoothing : dt / (0.028 + p[INERTIA]! * 0.23);
			this.rpm += (rpmWanted - this.rpm) * rpmCoefficient;
			this.load += ((physical ? this.targetLoad : Math.max(this.targetLoad, blip * 0.75)) - this.load) * this.controlSmoothing;
			this.throttle += ((physical ? this.targetThrottle : Math.max(this.targetThrottle, blip)) - this.throttle) * this.controlSmoothing;
			this.runningGain += (this.runningTarget - this.runningGain) * dt / (this.runningTarget ? 0.045 : 0.14);
			const rpm = this.rpm;
			const load = this.load;
			const throttle = this.throttle;
			const rpmFraction = clamp(rpm / p[REDLINE]!, 0, 1.3);
			const noise = this.random();
			this.noiseLow += (noise - this.noiseLow) * this.noiseCoefficient;
			const highNoise = noise - this.noiseLow;

			if (physical) this.spool = Math.sqrt(clamp(p[PHYSICAL_BOOST]! / 2.5, 0, 1));
			else {
				const spoolWanted = p[BOOST]! > 0 ? clamp((rpmFraction - 0.12) / (0.62 + p[TURBO_SIZE]! * 0.2), 0, 1)
					* Math.sqrt(throttle * load) * this.runningTarget : 0;
				const spoolTime = spoolWanted > this.spool ? 0.22 + p[TURBO_SIZE]! * 1.65 : 0.52 + p[TURBO_SIZE]! * 0.65;
				this.spool += (spoolWanted - this.spool) * dt / spoolTime;
			}
			if (throttle > 0.55) this.bovArmed = true;
			if (this.bovArmed && throttle < 0.3 && this.spool > 0.12) {
				this.bovEnvelope = Math.max(this.bovEnvelope, this.spool);
				this.bovArmed = false;
			}
			this.bovEnvelope *= 1 - dt / (0.09 + p[TURBO_SIZE]! * 0.22);
			const boost = physical ? p[PHYSICAL_BOOST]! : this.spool * this.spool * p[BOOST]!;

			const before = this.crank;
			const step = rpm / (120 * sr);
			let after = before + step;
			const wrapped = after >= 1;
			if (wrapped) { after -= 1; this.cycles++; }
			this.crank = after;
			const refresh = wrapped ? this.jitterBoundary > before || this.jitterBoundary <= after
				: this.jitterBoundary > before && this.jitterBoundary <= after;
			if (refresh) this.refreshCharacter();
			this.limiter = rpm >= p[REDLINE]!;
			const coast = throttle < 0.12 && load < 0.2 && rpm > p[IDLE]! + 650;
			const idleActivity = clamp((p[IDLE]! * 1.8 - rpm) / (p[IDLE]! * 0.8), 0, 1)
				* (1 - load) * (1 - throttle);
			let bankA = 0, bankB = 0, intakePulseSum = 0;
			for (let cylinder = 0; cylinder < MAX_CYLINDERS; cylinder++) {
				if (cylinder < this.activeCylinders && step > 0) {
					const angle = this.angles[cylinder]!;
					// Intake suction is displaced by one crank revolution from ignition.
					// It continues through an ignition cut because the pistons still move.
					const inletAngle = angle < 0.5 ? angle + 0.5 : angle - 0.5;
					const inletEvent = wrapped ? inletAngle > before || inletAngle <= after
						: inletAngle > before && inletAngle <= after;
					if (inletEvent) {
						const distance = after >= inletAngle ? after - inletAngle : after + 1 - inletAngle;
						const age = clamp(distance / step, 0, 1);
						const amplitude = this.pulseScale * Math.sqrt(p[PRESSURE]!)
							* (physical ? clamp(p[INTAKE_PRESSURE]! / 1.01325, 0.05, 4) : 0.25 + throttle * 0.75);
						this.intakeSlowPulses[cylinder] += amplitude * Math.pow(p[DECAY]!, age);
						this.intakeFastPulses[cylinder] += amplitude * Math.pow(p[ATTACK]!, age);
						this.exciteIntakeDetail(cylinder, amplitude, rpm, load, age);
					}
					const arrival = this.arrivals[cylinder]!;
					const fired = wrapped ? arrival > before || arrival <= after : arrival > before && arrival <= after;
					if (fired) {
						this.firingEvents++;
						const variation = physical ? 0 : this.random();
						const cut = physical ? this.physicalFuelCut || this.sharedEnergyScale <= 0
							: shift || (this.limiter && this.firingEvents % 3 !== 0);
						const backfire = !physical && coast && variation > 1 - p[OVERRUN]! * 0.27;
						const fuel = !physical && coast ? (backfire ? 1.1 + p[OVERRUN]! * 1.5 : 0.035) : 0.23 + load * 0.95;
						if (!cut || backfire) {
							this.combustionEvents++;
							const idleRoughness = Math.max(0, 1 - rpm / (p[IDLE]! * 2));
							let combustionQuality = physical ? this.sharedEnergyScale : 1 + p[ROUGHNESS]! * (this.cylinderTrim[cylinder]! * 0.12
								+ this.cycleEnergy[cylinder]! * (0.055 + idleActivity * 0.11));
							// Weak burns retain at least72% pressure. They are an idle-only
							// wear characteristic, never randomly missing combustion events.
							if (!physical && p[WEAR]! > 0 && this.characterRandom() > 1 - p[WEAR]! * idleActivity * 0.09) {
								combustionQuality *= 0.72 + (this.characterRandom() + 1) * 0.07;
								this.weakCombustions++;
							}
							this.pulseWidth[cylinder] = physical ? 0 : this.cycleEnergy[cylinder]! * p[ROUGHNESS]! * 0.12;
							const amplitude = this.pulseScale * p[PRESSURE]! * fuel * (1 + boost * 0.2) * combustionQuality
								* (1 + variation * p[IRREGULARITY]! * (0.12 + idleRoughness * 0.5))
								* (physical ? 1 : 1 + p[CAM]! * idleRoughness * Math.sin(TAU * before * 3) * 0.35);
							// Fractional sample timing prevents quantized pulse timing as RPM changes.
							const distance = after >= arrival ? after - arrival : after + 1 - arrival;
							const age = step > 0 ? clamp(distance / step, 0, 1) : 0;
							this.slowPulses[cylinder] += amplitude * Math.pow(p[DECAY]!, age);
							this.fastPulses[cylinder] += amplitude * Math.pow(p[ATTACK]!, age);
							this.exciteExhaustDetail(cylinder, amplitude, rpm, load, age);
						}
					}
				}
				const legacyPulse = this.slowPulses[cylinder]! - this.fastPulses[cylinder]!;
				const flow = this.exhaustFlow[cylinder]! - this.blowdown[cylinder]!;
				this.exhaustReturn[cylinder] += (flow - this.exhaustReturn[cylinder]!) * this.returnCoefficient[cylinder]!;
				const detailedPulse = this.blowdown[cylinder]! - this.blowdownRise[cylinder]!
					+ flow * 0.28 - this.exhaustReturn[cylinder]! * 0.12;
				const pulse = legacyPulse + (detailedPulse - legacyPulse) * detail;
				this.blowdown[cylinder] *= this.blowdownDecay[cylinder]!;
				this.blowdownRise[cylinder] *= this.blowdownAttack[cylinder]!;
				this.exhaustFlow[cylinder] *= this.flowDecay[cylinder]!;
				this.slowPulses[cylinder] *= p[DECAY]! + (1 - p[DECAY]!) * this.pulseWidth[cylinder]!;
				this.fastPulses[cylinder] *= p[ATTACK]!;
				const legacyIntake = this.intakeSlowPulses[cylinder]! - this.intakeFastPulses[cylinder]!;
				const detailedIntake = this.intakeDetailSlow[cylinder]! - this.intakeDetailFast[cylinder]!;
				intakePulseSum += legacyIntake + (detailedIntake - legacyIntake) * detail;
				this.intakeDetailSlow[cylinder] *= this.intakeDetailDecay[cylinder]!;
				this.intakeDetailFast[cylinder] *= this.intakeDetailAttack[cylinder]!;
				this.intakeSlowPulses[cylinder] *= p[DECAY]!;
				this.intakeFastPulses[cylinder] *= p[ATTACK]!;
				const textured = physical ? pulse : pulse * (1 + highNoise * (0.06 + load * 0.1));
				this.bankMix[cylinder] += (this.banks[cylinder]! - this.bankMix[cylinder]!) * this.parameterSmoothing;
				bankB += textured * this.bankMix[cylinder]!;
				bankA += textured * (1 - this.bankMix[cylinder]!);
			}
			if (physical || p[PHYSICAL_MIX]! > 0.0001) {
				const airflow = (this.noiseLow * 0.45 + highNoise * 0.55) * this.physicalFlowAmplitude;
				if (this.config.layout === 'inline') bankA += airflow;
				else { bankA += airflow * 0.5; bankB += airflow * 0.5; }
			}

			// A passive pressure mix models the crossover junction. Feeding amplified
			// resonator outputs back into each other could inject energy indefinitely.
			const coupling = p[CROSSOVER]! * 0.42;
			const headA = this.headerA.tick(bankA * (1 - coupling) + bankB * coupling);
			const headB = this.headerB.tick(bankB * (1 - coupling) + bankA * coupling);
			const tailA = this.exhaustA.tick(headA * 0.72 + bankA * 0.28);
			const tailB = this.exhaustB.tick(headB * 0.72 + bankB * 0.28);
			let exhaustA = bankA * 0.24 + headA * 0.54 + tailA * 0.9;
			let exhaustB = bankB * 0.24 + headB * 0.54 + tailB * 0.9;
			const crankPhase = after * 2 * TAU;
			const crankOrder1 = Math.sin(crankPhase), crankOrder2 = Math.sin(crankPhase * 2);
			// Low engine orders are real crank/block motion, not divided ignition.
			// Bank pulses excite a damped, length-derived collector mode as well.
			const flowCharge = physical ? clamp(p[EXHAUST_FLOW]! / Math.max(0.001, this.config.displacement * 0.001 * rpm / 120 * 1.2), 0, 2) : 1;
			const bodyMotion = Math.sqrt(this.config.displacement) * 0.035 * (0.28 + load * 0.72) * flowCharge;
			const bodyInputA = bankA + bodyMotion * (crankOrder1 * 0.42 + crankOrder2 * 0.72);
			const bodyInputB = bankB + bodyMotion * (-crankOrder1 * 0.32 + crankOrder2 * 0.72);
			const bodyA = this.bodyA.tick(bodyInputA) + this.bodyTailA.tick(bodyInputA) * 0.18;
			const bodyB = this.bodyB.tick(bodyInputB) + this.bodyTailB.tick(bodyInputB) * 0.18;
			const bodyGain = p[LOW_BODY]! * (1.7 + load * 1.8);
			exhaustA += bodyA * bodyGain;
			exhaustB += bodyB * bodyGain;
			this.exhaustLowA += (exhaustA - this.exhaustLowA) * this.mufflerSmoothing;
			this.exhaustLowB += (exhaustB - this.exhaustLowB) * this.mufflerSmoothing;
			exhaustA += (this.exhaustLowA - exhaustA) * p[MUFFLER]! * 0.78;
			exhaustB += (this.exhaustLowB - exhaustB) * p[MUFFLER]! * 0.78;
			const exhaustMid = (exhaustA + exhaustB) * (1 - p[BANK_PRESENCE]! * 0.22);
			const exhaustSide = (exhaustA - exhaustB) * p[WIDTH]! * 0.54 * p[BANK_PRESENCE]!;

			const pulseSum = bankA + bankB;
			const intakeInput = -intakePulseSum * (0.15 + throttle * 0.65)
				+ (physical ? this.noiseLow * this.physicalFlowAmplitude * 0.55 : this.noiseLow * throttle * load * 0.15)
				+ highNoise * Math.abs(intakePulseSum) * throttle * detail * 0.045;
			const intake = this.intake.tick(intakeInput);
			this.intakeLow += (intake - this.intakeLow) * this.intakeLowCoefficient;
			const intakeSound = (intake - this.intakeLow * 0.6) * (0.3 + throttle * 0.7);
			const mechanical = (crankOrder1 * p[BALANCE]! + crankOrder2 * 0.24
				+ Math.sin(crankPhase * this.activeCylinders * 0.5) * 0.13) * (0.025 + rpmFraction * 0.07)
				+ highNoise * (0.007 + rpmFraction * 0.025) * (0.3 + pulseSum)
				+ (physical ? 0 : p[ROUGHNESS]!) * (highNoise * Math.abs(crankOrder2) * (0.006 + load * 0.026)
					+ (noise - this.noiseLow) * pulseSum * load * 0.12);

			// Blade-rate tone is bounded below Nyquist, plus a separate broadband rush.
			const whistleHz = Math.min(sr * 0.3, 1100 + this.spool * (5200 - p[TURBO_SIZE]! * 1700));
			this.turboPhase += whistleHz / sr;
			if (this.turboPhase >= 1) this.turboPhase -= 1;
			this.turboHarmonicPhase += Math.min(sr * 0.42, whistleHz * 1.91) / sr;
			if (this.turboHarmonicPhase >= 1) this.turboHarmonicPhase -= 1;
			const physicalTurboSound = physical ? boost
				* ((Math.sin(TAU * this.turboPhase) + Math.sin(TAU * this.turboHarmonicPhase) * 0.18) * 0.024
					+ highNoise * 0.075 * throttle)
				+ highNoise * this.bovEnvelope * p[BOV]! * Math.min(boost, 1.5) * 0.29 : 0;
			const turboSound = physical ? physicalTurboSound : p[BOOST]! * this.spool * this.spool
				* ((Math.sin(TAU * this.turboPhase) + Math.sin(TAU * this.turboHarmonicPhase) * 0.18) * 0.024
					+ highNoise * 0.075 * throttle)
				+ highNoise * this.bovEnvelope * p[BOV]! * Math.min(p[BOOST]!, 1.5) * 0.29;
			const common = intakeSound * p[INTAKE_GAIN]! * 0.65
				+ mechanical * p[MECHANICAL_GAIN]! + turboSound * p[TURBO_GAIN]!;
			const baseL = (exhaustMid + exhaustSide) * p[EXHAUST_GAIN]! + common;
			const baseR = (exhaustMid - exhaustSide) * p[EXHAUST_GAIN]! + common;
			const intakeLayer = intakeSound * p[INTAKE_GAIN]! * 0.65;
			const mechanicalLayer = mechanical * p[MECHANICAL_GAIN]!;
			const turboLayer = turboSound * p[TURBO_GAIN]!;
			// Static transfer perspectives retain the user's individual source gains.
			// The engine view favours intake/valvetrain rather than the tailpipe.
			const engineCommon = intakeLayer * 1.65 + mechanicalLayer * 2.25 + turboLayer * 1.4;
			const engineL = (exhaustMid + exhaustSide * 0.55) * p[EXHAUST_GAIN]! * 0.48 + engineCommon;
			const engineR = (exhaustMid - exhaustSide * 0.55) * p[EXHAUST_GAIN]! * 0.48 + engineCommon;
			const cabinCommon = intakeLayer * 0.6 + mechanicalLayer * 0.9 + turboLayer * 0.45;
			const cabinL = (exhaustMid + exhaustSide * 0.18) * p[EXHAUST_GAIN]! * 0.64 + cabinCommon;
			const cabinR = (exhaustMid - exhaustSide * 0.18) * p[EXHAUST_GAIN]! * 0.64 + cabinCommon;
			this.cabinLowL += (cabinL - this.cabinLowL) * this.cabinCoefficient;
			this.cabinLowR += (cabinR - this.cabinLowR) * this.cabinCoefficient;
			this.cabinLow2L += (this.cabinLowL - this.cabinLow2L) * this.cabinCoefficient;
			this.cabinLow2R += (this.cabinLowR - this.cabinLow2R) * this.cabinCoefficient;
			const structure = this.cabinStructure.tick(mechanicalLayer * 2.5
				+ (bodyA + bodyB) * p[EXHAUST_GAIN]! * 0.1) * 0.48;
			// Roadside is a fixed distance/air-loss view. No moving pan or Doppler.
			const roadCommon = intakeLayer * 0.35 + mechanicalLayer * 0.22 + turboLayer * 0.4;
			const roadL = (exhaustMid + exhaustSide * 0.2) * p[EXHAUST_GAIN]! * 0.55 + roadCommon;
			const roadR = (exhaustMid - exhaustSide * 0.2) * p[EXHAUST_GAIN]! * 0.55 + roadCommon;
			this.airLowL += (roadL - this.airLowL) * this.airCoefficient;
			this.airLowR += (roadR - this.airLowR) * this.airCoefficient;
			const gain = this.runningGain * 1.12;
			const inputL = (baseL + (engineL - baseL) * p[ENGINE_VIEW]!
				+ (this.cabinLow2L + structure - baseL) * p[CABIN_VIEW]!
				+ (this.airLowL * 0.65 - baseL) * p[ROADSIDE_VIEW]!) * gain;
			const inputR = (baseR + (engineR - baseR) * p[ENGINE_VIEW]!
				+ (this.cabinLow2R + structure - baseR) * p[CABIN_VIEW]!
				+ (this.airLowR * 0.65 - baseR) * p[ROADSIDE_VIEW]!) * gain;
			const dcL = inputL - this.dcInL + this.dcCoefficient * this.dcOutL;
			const dcR = inputR - this.dcInR + this.dcCoefficient * this.dcOutR;
			this.dcInL = inputL; this.dcInR = inputR;
			this.dcOutL = dcL; this.dcOutR = dcR;
			const outputL = dcL / Math.sqrt(1 + dcL * dcL);
			const outputR = dcR / Math.sqrt(1 + dcR * dcR);
			left[frame] = outputL;
			right[frame] = outputR;
			this.peak = Math.max(Math.abs(outputL), Math.abs(outputR), this.peak * (1 - dt * 3));
		}
		// A malformed host block cannot leave stale data in the longer channel.
		for (let i = frames; i < left.length; i++) left[i] = 0;
		for (let i = frames; i < right.length; i++) right[i] = 0;
	}
}
