/** Standalone public DTOs for the original Rust engine/audio model.
 * Versioned Rust API DTOs retain the legacy v4 fields; no implementation imports.
 * Keep in sync with the Rust API schema and the parity contract tests.
 */

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

export interface CylinderCycleConfig {
 boreM:number; strokeM:number; rodLengthM:number; compressionRatio:number; rpm:number;
 intakePressurePa:number; intakeTemperatureK:number; exhaustPressurePa:number; exhaustTemperatureK:number;
 intakeOpenDeg:number; intakeCloseDeg:number; exhaustOpenDeg:number; exhaustCloseDeg:number;
 intakeValveDiameterM:number; exhaustValveDiameterM:number; intakeValveLiftM:number; exhaustValveLiftM:number;
 intakeValveCount:number; exhaustValveCount:number; dischargeCoefficient:number;
 sparkAdvanceDeg:number; burnDurationDeg:number; wiebeShape:number; wiebeEfficiency:number;
 airFuelRatio:number; fuelLhvJkg:number; combustionEfficiency:number; fuelMassKg?:number; oxygenLimitAfr?:number; combustionStartDeg?:number; fuelDeliveryStartDeg?:number; fuelDeliveryDurationDeg?:number;
 wallTemperatureK:number; heatTransferWm2K:number; gamma:number; variableHeatCapacity:boolean;
 /** Model 3. 'air-standard' is the legacy gamma/linear-cv air. */
 propertyModel:PropertyModel; fuelHydrogenCarbonRatio:number; fuelOxygenCarbonRatio:number;
 heatTransferModel:HeatTransferModel; heatTransferMultiplier:number;
 /** SI prescribed heat-release start = 360 - sparkAdvanceDeg + sparkToSocDeg. Not applied to diesel SOC. */
 sparkToSocDeg:number;
 initialPressurePa:number; initialTemperatureK:number; stepDeg:number; settlingCycles:number;
}

export interface CylinderCycleTrace {
 angleDeg:number[]; pressurePa:number[]; temperatureK:number[]; volumeM3:number[]; massKg:number[];
 /** Cumulative heat released since this recorded cycle's start. */
 heatReleaseJ:number[]; heatReleaseRateJPerDeg:number[]; intakeFlowKgs:number[]; exhaustFlowKgs:number[];
}

export interface CylinderCycleResult {
 oxygenLimitedFuelMassKg?:number;oxygenUnburnedFuelMassKg?:number;
 config:CylinderCycleConfig; trace:CylinderCycleTrace;
 /** Per cylinder, per 720 degrees. Net already includes the pumping loop. */
 netWorkJ:number; grossWorkJ:number; pumpingWorkJ:number; netIndicatedWorkJ:number; imepPa:number;
 peakPressurePa:number; peakTemperatureK:number; peakPressureAngleDeg:number; peakPressureRisePaPerDeg:number;
 ca10Deg:number; ca50Deg:number; ca90Deg:number;
 /** Model 3: prescribed heat-release start used, peak wall coefficient W/(m²K). */
 socDeg:number; peakHeatTransferWm2K:number;
 /** NASA property model only: burned-gas equivalence ratio and fraction of LHV released (rich CO/H2 retained). */
 burnedGasEquivalenceRatio?:number; releasedLhvFraction?:number;
 freshChargeMassKg:number; airMassKg:number; fuelMassKg:number; fuelEnergyJ:number; releasedHeatJ:number;
 residualFractionAtIvc:number; wallHeatLossJ:number;
 intakeMassInKg:number; intakeReverseMassKg:number; exhaustMassKg:number; exhaustReverseMassKg:number;
 exhaustTemperatureK:number; inletEnthalpyJ:number; outletEnthalpyJ:number;
 massBalanceResidualKg:number; energyBalanceResidualJ:number;
 periodicMassRelativeError:number; periodicEnergyRelativeError:number;
 initialMassKg:number; finalMassKg:number; initialInternalEnergyJ:number; finalInternalEnergyJ:number;
 steps:number; warnings:string[]; status:'uncalibrated-air-standard'|'uncalibrated-fixed-composition';
}
export type PropertyModel='air-standard'|'nasa7-fixed-composition';
export type HeatTransferModel='constant'|'woschni';
export type AirflowModel='ve-map-fit'|'valve-geometry';

export type CycleResult=CylinderCycleResult;

export interface CalibrationProvenance {
	readonly source: ParameterSource;
	readonly label: string;
	readonly version: string;
	readonly engineId?: string;
	readonly notes?: string;
	readonly calibratedAt?: string;
	readonly validation?: { readonly label: string; readonly date?: string; readonly independent: boolean };
}

export interface CalibrationMap {
	readonly schema: 'carlab-calibration-map-1';
	readonly kind: CalibrationKind;
	readonly rpm: readonly number[];
	readonly pressureBar: readonly number[];
	/** values[rpmIndex][pressureIndex]. */
	readonly values: readonly (readonly number[])[];
	readonly axisUnits: { readonly rpm: 'rpm'; readonly pressure: 'bar-absolute' };
	readonly valueUnit: 'fraction' | 'bar';
	readonly provenance: CalibrationProvenance;
	readonly extrapolation: 'clamp';
}

export interface CalibrationSample {
	readonly value: number;
	readonly extrapolated: boolean;
	readonly extrapolatedAxes: readonly ('rpm' | 'pressure')[];
	readonly clampedRpm: number;
	readonly clampedPressureBar: number;
	readonly source: ParameterSource;
	readonly mapLabel: string;
	readonly provenance: CalibrationProvenance;
}

export interface CalibrationBundle {
	readonly schema: 'carlab-calibration-bundle-1';
	readonly maps: Readonly<Partial<Record<CalibrationKind, CalibrationMap>>>;
}

export type CalibrationKind = 've' | 'indicatedEfficiency' | 'fmep';

export type ParameterSource = 'assumed' | 'fitted' | 'measured';

export interface GasPathConfig {
	ambientPressurePa: number;
	ambientTemperatureK: number;
	intakeVolumeM3: number;
	exhaustVolumeM3: number;
	throttleDiameterM: number;
	throttleDischarge: number;
	throttleLeakFraction: number;
	exhaustDiameterM: number;
	exhaustLengthM: number;
	exhaustMinorK: number;
	exhaustFrictionFactor: number;
	gamma: number;
	gasConstant: number;
}

export interface ReservoirState {
	massKg: number;
	internalEnergyJ: number;
	pressurePa: number;
	temperatureK: number;
	volumeM3: number;
}

export interface ReservoirInflow { massFlowKgs: number; temperatureK: number }

export interface ReservoirBalance {
	massInKg: number;
	massOutKg: number;
	energyInJ: number;
	energyOutJ: number;
	heatJ: number;
	limitedOutflowKg: number;
	limitedCoolingJ: number;
	massResidualKg: number;
	energyResidualJ: number;
}

export interface GasPathInput {
	rpm:number;
	throttle:number;
	engineDisplacementM3:number;
	volumetricEfficiency:number;
	fuelMassFlowKgs?:number;
	exhaustTemperatureK?:number;
	/** Supplied by the ONE turbo state in the physical model, not another lag. */
	compressorPressurePa?:number;
	compressorTemperatureK?:number;
	/** Optional mean demand from the cylinder cycle; otherwise speed-density. */
	cylinderAirMassFlowKgs?:number;
	intakeHeatW?:number;
	exhaustHeatW?:number;
}

export interface GasPathState {
	intake:ReservoirState;
	exhaust:ReservoirState;
	throttleMassFlowKgs:number;
	cylinderAirMassFlowKgs:number;
	cylinderExhaustMassFlowKgs:number;
	fuelMassFlowKgs:number;
	outletMassFlowKgs:number;
	exhaustPressureLossPa:number;
	massBalanceResidualKg:number;
	energyBalanceResidualJ:number;
	/** Signed heat actually applied after cooling limits over this step. */
	intakeHeatJ:number;
	exhaustHeatJ:number;
	limitedOutflowKg:number;
	limitedCoolingJ:number;
	warnings:string[];
}

export interface ThermalConfig {
 provenance:'assumed'|'fitted'|'measured';
 source:string;
 ambientTemperatureK:number;
 initialWallTemperatureK:number;
 initialCoolantTemperatureK:number;
 initialOilTemperatureK:number;
 initialExhaustWallTemperatureK:number;
 wallHeatCapacityJK:number;
 coolantHeatCapacityJK:number;
 oilHeatCapacityJK:number;
 exhaustWallHeatCapacityJK:number;
 wallToCoolantWK:number;
 wallToOilWK:number;
 wallToExhaustWK:number;
 exhaustToCoolantWK:number;
 coolantToAmbientWK:number;
 oilToAmbientWK:number;
 exhaustToAmbientWK:number;
 coolantMassFlowKgs:number;
 coolantSpecificHeatJKgK:number;
 coolantInletTemperatureK:number;
 oilMassFlowKgs:number;
 oilSpecificHeatJKgK:number;
 oilInletTemperatureK:number;
 frictionToOilFraction:number;
 exhaustGasHeatCapacityJKgK:number;
 exhaustHeatTransferEffectiveness:number;
}

export interface ThermalLoads {
 /** Signed heat delivered from cylinder gas to metal; wall rejection is positive. */
 gasHeatW?:number;
 /** Dissipated mechanical power, nonnegative. */
 frictionHeatW?:number;
 /** Already-deposited heat into exhaust wall, not the gas enthalpy flow. */
 exhaustHeatW?:number;
 /** Actual signed gas→wall exchange already applied with opposite sign to the
  * gas-path energy ledger. Use this instead of the optional gas-boundary flow.
  */
 coupledExhaustGasHeatW?:number;
 /** An external gas boundary; a coupled gas-path model must lose the same heat. */
 exhaustGasTemperatureK?:number;
 exhaustMassFlowKgs?:number;
}

export interface ThermalState {
 wallTemperatureK:number;
 coolantTemperatureK:number;
 oilTemperatureK:number;
 exhaustWallTemperatureK:number;
 /** Observed boundary gas temperature; never substituted for component metal. */
 exhaustGasTemperatureK:number;
 elapsedSeconds:number;
 storedEnergyJ:number;
 deltaStoredEnergyJ:number;
 cumulativeInputJ:number;
 cumulativeRejectedJ:number;
 ambientRejectedJ:number;
 fluidRejectedJ:number;
 energyResidualJ:number;
 exhaustGasToWallHeatW:number;
 status:'unvalidated-lumped-model';
}

export interface MaterialProvenance {
 kind:'assumed'|'fitted'|'measured';
 source:string;
 conditions:string;
}

export interface AllowableStressPoint { temperatureK:number; value:number }

export interface FatiguePoint { stressAmplitudeMPa:number; cycles:number }

export interface FatigueCurve {
 temperatureK:number;
 /** Explicit applicability band supplied with the card, not inferred. */
 temperatureToleranceK:number;
 stressRatio:number;
 stressRatioTolerance:number;
 conditions:string;
 points:FatiguePoint[];
}

export interface MaterialCard {
 schema:1;
 name:string;
 provenance:MaterialProvenance;
 /** Owner-specified nominal uniaxial design limits. Not automatically yield,
  * ultimate strength, a fatigue limit, or a component-safe stress.
  */
 allowableStressMPa:AllowableStressPoint[];
 fatigueCurves?:FatigueCurve[];
}

export interface MaterialScreenConfig {
 netSectionMm2:number;
 stressConcentration:number;
 componentTemperatureK:number;
 componentTemperatureSource:string;
 crankcasePressurePa:number;
 durationSeconds:number;
 /** Explicit constant-amplitude envelope-count assumption; no rainflow model. */
 cyclesPerEngineCycle:number;
 material:MaterialCard|null;
}

export interface MechanicalCycleInput {
 angleDeg:ArrayLike<number>;
 pressurePa:ArrayLike<number>;
 boreM:number;
 strokeM:number;
 rodLengthM:number;
 reciprocatingMassKg:number;
 rpm:number;
}

export interface MaterialScreenResult {
 status:'not-evaluated'|'within-card'|'exceeds-card';
 reason:string;
 materialName:string|null;
 provenance:MaterialProvenance|null;
 allowableStressMPa:number|null;
 peakTensileStressMPa:number;
 peakCompressiveStressMPa:number;
 maximumAbsoluteStressMPa:number;
 stressAmplitudeMPa:number;
 meanStressMPa:number;
 stressRatio:number|null;
 peakTensileAngleDeg:number|null;
 peakCompressiveAngleDeg:number|null;
 trace:{angleDeg:number[];gasForceN:number[];inertiaForceN:number[];rodCompressionForceN:number[];stressMPa:number[]};
 fatigue:{
  status:'not-evaluated'|'evaluated';
  reason:string;
  curveTemperatureK:number|null;
  cyclesAtAmplitude:number|null;
  appliedEnvelopeCycles:number;
  damageFraction:number|null;
 };
 assumptions:string[];
}

export interface PhysicalConfig {
	ecu?:EcuConfig;
	boreStrokeRatio: number;
	/** Connecting-rod centre distance divided by stroke, NOT crank radius. */
	rodLengthStrokeRatio: number;
	reciprocatingMassKg: number;
	ambientPressureBar: number;
	intakeTemperatureK: number;
	volumetricEfficiency: number;
	combustionEfficiency: number;
	/** Legacy import field, retained but ignored by the pressure-cycle solver. */
	thermalUtilization: number;
	gamma: number;
	fuelLhvMJkg: number;
	airFuelRatio: number;
	frictionBaseBar: number;
	/** FMEP coefficient, bar per (m/s) of mean piston speed. */
	frictionSpeedBar: number;
	engineInertiaKgM2: number;
	vehicleMassKg: number;
	tyreRadiusM: number;
	finalDrive: number;
	gearRatios: number[];
	driveEfficiency: number;
	dragCdA: number;
	rollingResistance: number;
	gradePercent: number;
	/** User-assumed screening thresholds. Never inferred from alloy names. */
	assumedPeakPressureBar: number;
	assumedMeanPistonSpeedMs: number;
	intakeVolumeL: number;
	exhaustVolumeL: number;
	throttleDiameterMm: number;
	throttleDischarge: number;
	throttleLeakFraction: number;
	exhaustRestrictionK: number;
	exhaustFrictionFactor: number;
	compressorEfficiency: number;
	turbineEfficiency: number;
	turbineRestrictionK: number;
	intercoolerEffectiveness: number;
	turboInertiaKgM2: number;
	sparkAdvanceDeg: number;
	burnDurationDeg: number;
	wiebeShape: number;
	wiebeEfficiency: number;
	intakeOpenDeg: number;
	intakeCloseDeg: number;
	exhaustOpenDeg: number;
	exhaustCloseDeg: number;
	intakeValveDiameterMm: number;
	exhaustValveDiameterMm: number;
	intakeValveLiftMm: number;
	exhaustValveLiftMm: number;
	intakeValveCount: number;
	exhaustValveCount: number;
	valveDischargeCoefficient: number;
	wallTemperatureK: number;
	heatTransferWm2K: number;
	variableHeatCapacity: boolean;
	/** Model 3 (Rust only). Defaults reproduce model 2 exactly. */
	propertyModel: PropertyModel;
	/** Fuel CH_yO_z for NASA products/stoichiometry; default 1.85 is an assumed generic gasoline. */
	fuelHydrogenCarbonRatio: number;
	fuelOxygenCarbonRatio: number;
	heatTransferModel: HeatTransferModel;
	/** Scales the Woschni coefficient only. */
	heatTransferMultiplier: number;
	/** Degrees from electrical spark to prescribed Wiebe SOC (not to CA10). */
	sparkToSocDeg: number;
	/** Cam phaser shift added to BOTH opening and closing; positive = later. */
	intakeCamRetardDeg: number;
	exhaustCamRetardDeg: number;
	/** 've-map-fit' scales intake lift toward the VE map; 'valve-geometry' solves the declared valves untargeted. */
	airflowModel: AirflowModel;
	cycleVariability: number;
	veMap: CalibrationMap;
	fmepMap?: CalibrationMap;
	indicatedEfficiencyMap?: CalibrationMap;
	provenance: CalibrationProvenance;
	thermal: ThermalConfig;
	materialScreen: MaterialScreenConfig;
	cycleCalibration?: {source:string;referenceHash:string;rpm:number;throttle:number;rmseBar:number;method:'bounded-grid';status:'fitted';sparkAdvanceDeg:number;burnDurationDeg:number;angleOrigin?:'intake-tdc'|'firing-tdc'};
}

export interface EngineGeometry {
	displacementM3: number;
	cylinderDisplacementM3: number;
	boreMm: number;
	strokeMm: number;
	rodLengthMm: number;
	pistonAreaM2: number;
	clearanceVolumeM3: number;
}

export interface EngineEstimate {
	ecu?:EcuCouplingSummary;
	rpm: number;
	throttle: number;
	torqueNm: number;
	powerKw: number;
	/** Mechanical horsepower, 745.699872 W/hp; not metric cv. */
	powerHp: number;
	indicatedTorqueNm: number;
	frictionTorqueNm: number;
	pumpingTorqueNm: number;
	bmepBar: number;
	fmepBar: number;
	manifoldPressureBar: number;
	/** Computed pressure at the configured intake-valve closure. */
	ivcPressureBar: number;
	/** Fresh air retained at IVC (not an airbox meter observable). */
	airMassFlowKgs: number;
	/** Signed net intake-valve flow, comparable with a steady inlet air meter. */
	netInletAirMassFlowKgs: number;
	fuelMassFlowKgs: number;
	fuelPowerKw: number;
	brakeEfficiency: number;
	/** Constant-gamma air-standard comparison, not a universal real-engine bound. */
	ottoEfficiency: number;
	compressionPressureBar: number;
	compressionTemperatureK: number;
	/** Legacy UI name: peak of the computed finite-burn pressure cycle, uncalibrated. */
	idealPeakPressureBar: number;
	idealPeakGasTemperatureK: number;
	meanPistonSpeedMs: number;
	/** Separate components at their own extrema; never combined into rod stress. */
	idealGasForceN: number;
	inertiaForceTdcN: number;
	fuelCut: boolean;
	screenFlags: Array<'pressure-assumption' | 'piston-speed-assumption' | 'redline'>;
	geometry: EngineGeometry;
	exhaustPressureBar: number;
	exhaustTemperatureK: number;
	mappedVolumetricEfficiency: number;
	actualVolumetricEfficiency: number;
	veTargetResidual: number;
	mapExtrapolated: boolean;
	calibrationSource: CalibrationProvenance['source'];
	wallHeatLossW: number;
	cycle: { netWorkJ:number;grossWorkJ:number;pumpingWorkJ:number;peakPressurePa:number;peakTemperatureK:number;peakPressureRisePaPerDeg:number;massBalanceResidualKg:number;energyBalanceResidualJ:number;periodicMassRelativeError:number;periodicEnergyRelativeError:number;ca50Deg:number;residualFraction:number;lookupRpm:number;lookupIntakePressureBar:number;
		/** Model 3 diagnostics; masses per cylinder per 720°. valveEventsDeg = [IVO, IVC, EVO, EVC] actually solved. */
		socDeg:number;ca10Deg:number;ca90Deg:number;valveEventsDeg:[number,number,number,number];trappedFreshMassKg:number;intakeInMassKg:number;intakeReverseMassKg:number;wallHeatLossJ:number;peakHeatTransferWm2K:number };
	warnings: string[];
}

export interface PotentialEnvelope {
	points: EngineEstimate[];
	peakPower: EngineEstimate;
	peakTorque: EngineEstimate;
	/** Highest-power sampled point satisfying ONLY the two assumed screens. */
	screenedPeakPower: EngineEstimate | null;
	limitingCauses: EngineEstimate['screenFlags'];
	status: 'uncalibrated-assumptions';
}

export interface PowertrainState {
	ecu?:EcuState;
	ecuCoupling?:EcuCouplingSummary;
	rpm: number;
	load: number;
	throttle: number;
	speedMs: number;
	speedKmh: number;
	accelerationMs2: number;
	gear: number;
	clutch: number;
	torqueNm: number;
	powerKw: number;
	resistanceN: number;
	tractionN: number;
	boostFraction: number;
	/** False for an inventory-limited or unsettled cached operating point. */
	quantitativelyValid: boolean;
	physical: PhysicalAudioState;
	physicalAudio: PhysicalAudioState;
	thermal: ThermalState;
	gasPath: GasPathState;
	warnings: string[];
}

export interface GasPathBoundary {
 intakePressurePa:number; intakeTemperatureK:number;
 exhaustPressurePa:number; exhaustTemperatureK:number;
}

export interface CalibratedCylinderCycle extends CylinderCycleResult {
 ecu?:EcuCouplingSummary;
 calibration:{mappedVE:number;actualVE:number;veResidual:number;extrapolated:boolean;
  effectiveIntakeLiftM:number;iterations:number;indicatedEfficiencyTarget?:number;indicatedEfficiencyResidual?:number;
  airflowModel:AirflowModel;trials:VeTrial[];
  /** Present only when a VE-map target was missed; derived from the trial log, otherwise 'unproven'. */
  missClassification?:'lift-bound'|'step-ratio-limit'|'sub-proportional-lift-response'|'unproven'};
}
export interface VeTrial {liftM:number;actualVE:number;seatCappedFraction:number;stepRatioClamped:boolean;liftBoundHit:boolean}

export type EnginePoint = EngineEstimate;

/** Original opt-in port-fuel-injection controller. These are simulator DTOs,
 * not hardware ECU firmware or a certified tune/calibration format.
 */
export type EcuMapKind='lambdaTarget'|'fuelCorrection'|'sparkAdvance'|'veEstimate'|'dieselFuelQuantity'|'dieselMinimumLambda'|'dieselInjectionAdvance';
export interface EcuMap<K extends EcuMapKind=EcuMapKind> {
 schema:'carlab-ecu-map-1';kind:K;rpm:number[];pressureBar:number[];values:number[][];
 axisUnits:{rpm:'rpm';pressure:'bar-absolute'};
 valueUnit:'lambda'|'multiplier'|'degBTDC'|'fraction'|'mgPerCylinderCycle';
 provenance:CalibrationProvenance;extrapolation:'clamp';
}
export interface EcuMapSample {value:number;extrapolated:boolean;extrapolatedAxes:('rpm'|'pressureBar')[];clampedRpm:number;clampedPressureBar:number}
export interface EcuMaps {
 lambdaTargetMap:EcuMap<'lambdaTarget'>;
 fuelCorrectionMap:EcuMap<'fuelCorrection'>;
 sparkAdvanceMap:EcuMap<'sparkAdvance'>;
 veEstimateMap:EcuMap<'veEstimate'>;
}
export interface FuelComponent {densityKgM3:number;stoichAfr:number;lhvJkg:number;provenance:CalibrationProvenance}
export interface FuelBlendConfig {ethanolVolumeFraction:number;gasoline:FuelComponent;ethanol:FuelComponent}
export interface FuelBlendProperties {
 ethanolVolumeFraction:number;ethanolMassFraction:number;densityKgM3:number;stoichAfr:number;lhvJkg:number;
 status:string;
}
export type FuelProperties=FuelBlendProperties;
export interface InjectorDeadTimeMap {voltageV:number[];deltaPressureBar:number[];valuesMs:number[][];provenance:CalibrationProvenance}
export type InjectorRailMode='mapReferenced'|'fixedAbsolute';
export interface InjectorConfig {
 referenceFlowCcMin:number;referenceDensityKgM3:number;referenceDeltaPressurePa:number;
 railMode:InjectorRailMode;nominalDeltaPressurePa:number;fixedRailPressurePa:number;
 injectorCount:number;squirtsPerCycle:number;maxDutyFraction:number;
 actualFlowScale:number;actualDeadTimeOffsetMs:number;
 deadTimeMap:InjectorDeadTimeMap;provenance:CalibrationProvenance;
}
export interface InjectorInput {
 requestedFuelMassFlowKgs:number;rpm:number;batteryVoltageV:number;manifoldPressurePa:number;
 actualRailPressurePa?:number|null;downstreamPressurePa?:number|null;fuelDensityKgM3:number;injectorCut:boolean;
}
export interface InjectorDelivery {
 requestedFuelMassFlowKgs:number;injectedFuelMassFlowKgs:number;
 pulseWidthMs:number;requestedPulseWidthMs:number;effectivePulseWidthMs:number;dutyFraction:number;
 deltaPressurePa:number;railPressurePa:number;deadTimeMs:number;actualDeadTimeMs:number;
 nominalMassFlowPerInjectorKgs:number;actuatorSaturated:boolean;calibrationExtrapolated:boolean;flags:string[];
}
export type InjectorDeliveryInput=InjectorInput;
export type InjectorDeliveryResult=InjectorDelivery;
export interface FilmConfig {
 depositedFraction:number;evaporationTimeSeconds:number;coldDepositionGain:number;coldTauGain:number;
 referenceTemperatureK:number;initialFilmMassKg:number;provenance:CalibrationProvenance;
}
export interface LambdaSensorConfig {
 baseDelaySeconds:number;cycleDelayDegrees:number;transportDelayScaleKg:number;maximumDelaySeconds:number;
 timeConstantSeconds:number;warmupSeconds:number;provenance:CalibrationProvenance;
}
export interface FeedbackConfig {
 enabled:boolean;kp:number;kiPerSecond:number;trimMin:number;trimMax:number;samplePeriodSeconds:number;
 warmupSeconds:number;minCoolantTemperatureK:number;transientThrottleRatePerSecond:number;
 transientMapRatePaPerSecond:number;transientRpmRatePerSecond:number;steadyHoldSeconds:number;
}
export type CombustionMode='portInjectionSpark'|'directInjectionDiesel';
export interface DieselConfig {
 fuel:FuelComponent;injector:InjectorConfig;
 fuelQuantityMap:EcuMap<'dieselFuelQuantity'>;minimumLambdaMap:EcuMap<'dieselMinimumLambda'>;injectionAdvanceMap:EcuMap<'dieselInjectionAdvance'>;
 ignitionDelayDeg:number;burnDurationDeg:number;airThrottleFraction:number;idleFuelMgPerCycle:number;
 idleTargetRpm:number;maxInjectionDurationDeg:number;provenance:CalibrationProvenance;
}
export interface EcuConfig extends EcuMaps {
 combustionMode:CombustionMode;diesel:DieselConfig;enabled:boolean;batteryVoltageV:number;fuel:FuelBlendConfig;injector:InjectorConfig;film:FilmConfig;
 sensor:LambdaSensorConfig;feedback:FeedbackConfig;provenance:CalibrationProvenance;
}
/** Nested scalar settings can be patched against defaults. A supplied map or
 * dead-time grid is validated as a complete calibration surface by Rust.
 */
export type EcuConfigInput=Partial<Omit<EcuConfig,keyof EcuMaps|'fuel'|'injector'|'film'|'sensor'|'feedback'|'diesel'>> & Partial<EcuMaps> & {
 fuel?:Partial<Omit<FuelBlendConfig,'gasoline'|'ethanol'>> & {gasoline?:Partial<FuelComponent>;ethanol?:Partial<FuelComponent>};
 injector?:Partial<InjectorConfig>;film?:Partial<FilmConfig>;sensor?:Partial<LambdaSensorConfig>;feedback?:Partial<FeedbackConfig>;
 diesel?:Partial<Omit<DieselConfig,'fuel'|'injector'>> & {fuel?:Partial<FuelComponent>;injector?:Partial<InjectorConfig>};
};
export interface EcuInput {
 rpm:number;cylinders:number;displacementL:number;mapPressurePa:number;intakeTemperatureK:number;
 coolantTemperatureK:number;throttle:number;batteryVoltageV:number;actualAirMassFlowKgs:number;
 injectorCut:boolean;combustionCut:boolean;actualRailPressurePa?:number|null;injectionDownstreamPressurePa?:number|null;requestedFuelQuantityOverrideMg?:number|null;sensorValid:boolean;
}
export interface EcuState {
 combustionMode:CombustionMode;minimumLambda:number|null;
 requestedFuelMgPerCylinderCycle:number;airLimitedFuelMgPerCylinderCycle:number;deliveredFuelMgPerCylinderCycle:number;
 injectionAdvanceDeg:number|null;injectionStartAngleDeg:number|null;startOfCombustionDeg:number|null;
 prescribedIgnitionDelayDeg:number|null;prescribedBurnDurationDeg:number|null;injectionDurationDeg:number|null;effectiveInjectionDurationDeg:number|null;airThrottleFraction:number;fuelQuantityLimited:boolean;
 enabled:boolean;elapsedSeconds:number;estimatedAirMassFlowKgs:number;actualAirMassFlowKgs:number;
 targetLambda:number;sparkAdvanceDeg:number;fuelCorrection:number;feedbackTrim:number;
 requestedFuelMassFlowKgs:number;injectedFuelMassFlowKgs:number;deliveredFuelMassFlowKgs:number;
 burnableFuelMassFlowKgs:number;unburnedFuelMassFlowKgs:number;fuelEnergyW:number;burnableFuelEnergyW:number;
 stoichAfr:number;fuelLhvJkg:number;fuelDensityKgM3:number;ethanolMassFraction:number;
 feedFuelProperties:FuelBlendProperties;deliveredFuelProperties:FuelBlendProperties;
 fuelMassPerCylinderCycleKg:number;burnableFuelMassPerCylinderCycleKg:number;
 wallFilmMassKg:number;filmGasolineMassKg:number;filmEthanolMassKg:number;
 trueLambda:number|null;observedLambda:number|null;sensorReady:boolean;
 injectorCut:boolean;combustionCut:boolean;pulseWidthMs:number;effectivePulseWidthMs:number;
 dutyFraction:number;deltaPressurePa:number;railPressurePa:number;deadTimeMs:number;
 injectedMassKg:number;deliveredMassKg:number;cumulativeInjectedMassKg:number;cumulativeDeliveredMassKg:number;
 cumulativeUnburnedMassKg:number;fuelMassResidualKg:number;
 mode:string;feedbackActive:boolean;canLearn:boolean;appliedFuelMultiplier:number;sensorDelaySeconds:number;gates:string[];learningGates:string[];flags:string[];mapsExtrapolated:boolean;
 actuatorSaturated:boolean;quantitativelyValid:boolean;
}
/** Warm open-loop actuator/film-equilibrium evaluation; not a converged PI run. */
export type EcuSteadyResult=EcuState;
export interface EcuCouplingSummary extends EcuState {
 couplingMode:'steady-open-loop'|'dynamic-held-cycle';
 plantLambda?:number|null;cycleReleasedHeatJ:number;cycleFuelEnergyJ:number;
 cycleFuelMassKg:number;demandedCycleFuelMassKg:number;fuelMassRelativeMismatch:number;
 freshAirMassFlowKgs:number;combustionEnergyScale:number;oxygenLimited:boolean;
 couplingQuantitativelyValid:boolean;couplingFlags:string[];
}
export type ECUConfig=EcuConfig;
export type ECUState=EcuState;
export type ECUInput=EcuInput;

export interface EcuFuelObservation {
 id?:string;captureSessionId?:string;rpm:number;mapBar:number;observedLambda:number;steady:boolean;valid:boolean;
 injectorCut?:boolean;combustionCut?:boolean;saturated?:boolean;transient?:boolean;
 warmup?:boolean;closedLoopActive?:boolean;appliedFuelMultiplier?:number|null;split?:'train'|'validation';targetLambda?:number|null;weight?:number;
}
export interface EcuObservationSource {kind:'measured'|'simulated';label:string;fingerprint:string;conditions?:string}
export interface EcuFitOptions {source:EcuObservationSource;regularization?:number;iterations?:number}
export type EcuSearchObjective='pareto'|'maxPower'|'minFuelAtTorque';
export type EcuUnsupportedEvidence='knock'|'emissions'|'materialLife';
export interface EcuSearchOptions {
 objective?:EcuSearchObjective;lambdaBounds?:[number,number];sparkBounds?:[number,number];
 lambdaSteps?:number;sparkSteps?:number;budget?:number;refinementLevels?:number;
 requestedTorqueNm?:number|null;torqueToleranceNm?:number;torqueResolutionNm?:number;
 dieselQuantityMinMg?:number;dieselQuantityMaxMg?:number;injectionAdvanceMinDeg?:number;injectionAdvanceMaxDeg?:number;
 dieselQuantitySteps?:number;injectionAdvanceSteps?:number;maxDutyFraction?:number;maxPressureBar?:number|null;
 maxPressureRiseBarPerDeg?:number|null;maxMeanPistonSpeedMs?:number|null;requiredEvidence?:EcuUnsupportedEvidence[];
}
export interface EcuSearchConstraint {
 name:string;status:'satisfied'|'violated'|'not-evaluated';value:number|null;limit:number|null;unit:string;source:string;
}
export interface EcuSearchCandidate {
 id:number;mode:CombustionMode;lambdaTarget:number|null;sparkAdvanceDeg:number|null;
 dieselQuantityMg:number|null;injectionAdvanceDeg:number|null;actualQuantityMg:number|null;minimumLambda:number|null;torqueNm:number|null;powerKw:number|null;
 fuelMassFlowKgs:number|null;bsfcGkwh:number|null;actualLambda:number|null;dutyFraction:number|null;
 peakPressureBar:number|null;pressureRiseBarPerDeg:number|null;meanPistonSpeedMs:number|null;
 valid:boolean;feasible:boolean;boundary:boolean;constraints:EcuSearchConstraint[];warnings:string[];error?:string|null;
}
export interface EcuSearchResult {
 mode:CombustionMode;axisLabels:[string,string];axisBounds:[[number,number],[number,number]];
 candidates:EcuSearchCandidate[];paretoIds:number[];selectedId:number|null;evaluated:number;budget:number;
 boundaryOptimum:boolean;unsupportedConstraints:EcuSearchConstraint[];contextFingerprint:string;model:string;backend:string;
 status:string;engine:EngineConfig;physical:PhysicalConfig;rpm:number;throttle:number;options:EcuResolvedSearchOptions;assumptions:string[];
}

export interface RejectedEcuObservation {index:number;id:string;reasons:string[]}
export interface EcuFitMetrics {
 status:'not-evaluated'|'predicted';samples:number;observedRmseLambda:number|null;
 beforeRmseLambda:number|null;afterRmseLambda:number|null;beforeMaeLambda:number|null;
 afterMaeLambda:number|null;maximumAfterErrorLambda:number|null;
}
export interface EcuFitCoverage {
 rpmNodes:number;pressureNodes:number;supportedNodes:number;totalNodes:number;supportedNodeFraction:number;
 supportedNodeIndices:[number,number][];observedCells:[number,number][];totalCells:number;
 trainingSamples:number;validationSamples:number;rejectedSamples:number;
 validationConditionOverlap:number;validationCellOverlap:number;validationSessionOverlap:number;unknownSessionSamples:number;
 trainingRpmRange:[number,number]|null;trainingMapRangeBar:[number,number]|null;
}
export interface EcuFitResult {
 map:EcuMap<'fuelCorrection'>;coverage:EcuFitCoverage;rejected:RejectedEcuObservation[];
 training:EcuFitMetrics;validation:EcuFitMetrics;source:EcuObservationSource & {conditions:string};
 contextFingerprint:string;model:string;backend:string;method:string;status:string;
 boundedNodes:number;independentValidation:boolean;validationStatus:string;validationWarnings:string[];assumptions:string[];
}
export type EcuFuelMapFit=EcuFitResult;
export type EcuLambdaObservation=EcuFuelObservation;

export type EcuConstraintResult=EcuSearchConstraint;
export interface EcuResolvedSearchOptions {
 dieselQuantityMinMg?:number;dieselQuantityMaxMg?:number;injectionAdvanceMinDeg?:number;injectionAdvanceMaxDeg?:number;
 dieselQuantitySteps?:number;injectionAdvanceSteps?:number;
 objective:EcuSearchObjective;lambdaBounds?:[number,number];sparkBounds?:[number,number];
 lambdaSteps?:number;sparkSteps?:number;budget:number;refinementLevels:number;
 requestedTorqueNm:number|null;torqueToleranceNm:number;torqueResolutionNm:number;
 maxDutyFraction:number;maxPressureBar:number|null;maxPressureRiseBarPerDeg:number|null;
 maxMeanPistonSpeedMs:number|null;requiredEvidence:EcuUnsupportedEvidence[];
}

/** Direct-injection callers must supply the declared cylinder-side pressure;
 * manifold pressure is not an implicit DI downstream boundary.
 */
export type DieselEcuInput=Omit<EcuInput,'injectionDownstreamPressurePa'> & {injectionDownstreamPressurePa:number};
export type DieselInjectorInput=Omit<InjectorInput,'downstreamPressurePa'> & {downstreamPressurePa:number};
