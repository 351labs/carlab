import type { EngineConfig, PhysicalAudioState } from './dsp.ts';
import type { EcuConfig,EcuState,EcuCouplingSummary } from './api/types.js';
import { solveCylinderCycle, normalizeCylinderCycleConfig, type CylinderCycleConfig, type CylinderCycleResult } from './cylinder-cycle.ts';
import { createAssumedVeMap, normalizeCalibrationMap, sampleCalibrationMap, type CalibrationMap, type CalibrationProvenance } from './maps.ts';
import { GasPath, compressibleOrificeFlow, exhaustPressureLoss, type GasPathConfig, type GasPathState } from './gas-path.ts';
import { ThermalNetwork, normalizeThermalConfig, type ThermalConfig, type ThermalState } from './thermal.ts';
import { normalizeMaterialScreenConfig, type MaterialScreenConfig } from './materials.ts';

/** Assumed inputs for an uncalibrated four-stroke, spark-ignition screening model.
 * These are not measured specifications or a material/knock safety certificate.
 * Includes finite burn/valve/heat models; gas chemistry and full turbo maps remain absent.
 */
export interface PhysicalConfig {
	/** Opaque EFI configuration is preserved by the reference; execution requires Rust. */
	ecu?: EcuConfig;
	/** Model-3 Rust physics options (NASA-7 properties, Woschni, spark->SOC, cam phasing,
	 * valve-geometry airflow): preserved by this reference, executed only by Rust. */
	propertyModel?: 'air-standard' | 'nasa7-fixed-composition';
	heatTransferModel?: 'constant' | 'woschni';
	airflowModel?: 've-map-fit' | 'valve-geometry';
	sparkToSocDeg?: number;
	intakeCamRetardDeg?: number;
	exhaustCamRetardDeg?: number;
	heatTransferMultiplier?: number;
	fuelHydrogenCarbonRatio?: number;
	fuelOxygenCarbonRatio?: number;
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
	airMassFlowKgs: number;
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
	cycle: { netWorkJ:number;grossWorkJ:number;pumpingWorkJ:number;peakPressurePa:number;peakTemperatureK:number;peakPressureRisePaPerDeg:number;massBalanceResidualKg:number;energyBalanceResidualJ:number;periodicMassRelativeError:number;periodicEnergyRelativeError:number;ca50Deg:number;residualFraction:number;lookupRpm:number;lookupIntakePressureBar:number };
	warnings: string[];
}

/** UI-facing name for one sampled operating point. */
export type EnginePoint = EngineEstimate;

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

const TAU = 2 * Math.PI;
const AIR_R = 287.05;
const G = 9.80665;
const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
const bounded = (value: unknown, fallback: number, minimum: number, maximum: number): number =>
	typeof value === 'number' && Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;

/** Preserve JSON metadata without implementing or approximating the ECU in TS.
 * A provided controller is normalized/validated by the Rust API when executed.
 */
/** Values at which the Rust model-3 options reproduce model-2 physics exactly. */
export const MODEL3_LEGACY_VALUES={propertyModel:'air-standard',heatTransferModel:'constant',airflowModel:'ve-map-fit',sparkToSocDeg:0,intakeCamRetardDeg:0,exhaustCamRetardDeg:0} as const;
const MODEL3_KEYS=[...Object.keys(MODEL3_LEGACY_VALUES),'heatTransferMultiplier','fuelHydrogenCarbonRatio','fuelOxygenCarbonRatio'] as const;
export const usesModel3Physics=(physical:object):boolean=>Object.entries(MODEL3_LEGACY_VALUES).some(([key,value])=>key in physical&&(physical as Record<string,unknown>)[key]!==undefined&&(physical as Record<string,unknown>)[key]!==value);
const MODEL3_DEFAULTS={...MODEL3_LEGACY_VALUES,heatTransferMultiplier:1,fuelHydrogenCarbonRatio:1.85,fuelOxygenCarbonRatio:0};
function preserveModel3(source:Record<string,unknown>):Partial<PhysicalConfig> {
 return {...MODEL3_DEFAULTS,...Object.fromEntries(MODEL3_KEYS.filter(key=>typeof source[key]==='string'||(typeof source[key]==='number'&&Number.isFinite(source[key]))).map(key=>[key,source[key]]))};
}
function preserveEcuMetadata(input:unknown):EcuConfig|undefined {
 if(input===undefined||input===null)return undefined;
 if(typeof input!=='object'||Array.isArray(input)||(Object.getPrototypeOf(input)!==Object.prototype&&Object.getPrototypeOf(input)!==null))throw new TypeError('ECU metadata must be a plain JSON object.');
 if('enabled' in input&&typeof (input as {enabled?:unknown}).enabled!=='boolean')throw new TypeError('ECU enabled must be boolean when provided.');
 const active=new WeakSet<object>();
 function validate(value:unknown,depth:number):void {
  if(depth>32)throw new TypeError('ECU metadata nesting exceeds 32 levels.');
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))throw new TypeError('ECU metadata needs finite JSON numbers.');return;}
  if(typeof value!=='object'||active.has(value))throw new TypeError('ECU metadata must be acyclic JSON.');
  if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw new TypeError('ECU metadata contains a non-JSON object.');
  active.add(value);
  if(Array.isArray(value)){for(let i=0;i<value.length;i++){if(!(i in value))throw new TypeError('ECU metadata arrays cannot be sparse.');validate(value[i],depth+1);}}
  else for(const item of Object.values(value))validate(item,depth+1);
  active.delete(value);
 }
 validate(input,0);const encoded=JSON.stringify(input);if(encoded.length>256000)throw new RangeError('ECU metadata exceeds 256 kB.');
 return JSON.parse(encoded) as EcuConfig;
}

export function normalizePhysicalConfig(engine: EngineConfig, input: Partial<PhysicalConfig> = {}): PhysicalConfig {
	const source = input && typeof input === 'object' ? input : {};
	const thermal=normalizeThermalConfig(source.thermal);
	const ecu=preserveEcuMetadata(source.ecu);
	const g = engineGeometry(engine, {boreStrokeRatio: bounded(source.boreStrokeRatio,1.05,.5,2),rodLengthStrokeRatio:bounded(source.rodLengthStrokeRatio,1.7,1.3,2.5)} as PhysicalConfig);
	const ratios = Array.isArray(source.gearRatios) && source.gearRatios.length > 0 && source.gearRatios.length <= 8
		&& Array.from(source.gearRatios).every((ratio) => typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0.3 && ratio <= 6)
		? source.gearRatios.slice() : [3.5, 2.15, 1.48, 1.13, 0.91, 0.76];
	return {
		...(ecu?{ecu}:{}),
		...preserveModel3(source as Record<string,unknown>),
		boreStrokeRatio: bounded(source.boreStrokeRatio, 1.05, 0.5, 2),
		rodLengthStrokeRatio: bounded(source.rodLengthStrokeRatio, 1.7, 1.3, 2.5),
		reciprocatingMassKg: bounded(source.reciprocatingMassKg, 0.45, 0.08, 2),
		ambientPressureBar: bounded(source.ambientPressureBar, 1.01325, 0.5, 1.2),
		intakeTemperatureK: bounded(source.intakeTemperatureK, 315, 240, 450),
		volumetricEfficiency: bounded(source.volumetricEfficiency, 0.9, 0.3, 1.25),
		combustionEfficiency: bounded(source.combustionEfficiency, 0.96, 0.5, 1),
		thermalUtilization: bounded(source.thermalUtilization, 0.72, 0.2, 1),
		gamma: bounded(source.gamma, 1.33, 1.15, 1.4),
		fuelLhvMJkg: bounded(source.fuelLhvMJkg, 43, 20, 50),
		airFuelRatio: bounded(source.airFuelRatio, 14.7, 8, 22),
		frictionBaseBar: bounded(source.frictionBaseBar, 0.65, 0, 3),
		frictionSpeedBar: bounded(source.frictionSpeedBar, 0.045, 0, 0.2),
		engineInertiaKgM2: bounded(source.engineInertiaKgM2, 0.08 + engine.inertia * 0.45, 0.03, 2),
		vehicleMassKg: bounded(source.vehicleMassKg, 1100 + engine.displacement * 80, 400, 3500),
		tyreRadiusM: bounded(source.tyreRadiusM, 0.315, 0.2, 0.5),
		finalDrive: bounded(source.finalDrive, 3.9, 2, 6),
		gearRatios: ratios,
		driveEfficiency: bounded(source.driveEfficiency, 0.9, 0.65, 1),
		dragCdA: bounded(source.dragCdA, 0.65, 0.2, 1.8),
		rollingResistance: bounded(source.rollingResistance, 0.013, 0, 0.04),
		gradePercent: bounded(source.gradePercent, 0, -20, 20),
		assumedPeakPressureBar: bounded(source.assumedPeakPressureBar, 150, 30, 350),
		assumedMeanPistonSpeedMs: bounded(source.assumedMeanPistonSpeedMs, 23, 8, 40),
		intakeVolumeL:bounded(source.intakeVolumeL,Math.max(1,engine.displacement*1.2),.2,30),
		exhaustVolumeL:bounded(source.exhaustVolumeL,Math.max(1,engine.displacement*1.5),.2,30),
		throttleDiameterMm:bounded(source.throttleDiameterMm,Math.min(100,35+engine.displacement*8),5,150),
		throttleDischarge:bounded(source.throttleDischarge,.72,.1,1),
		throttleLeakFraction:bounded(source.throttleLeakFraction,.01,.001,.1),
		exhaustRestrictionK:bounded(source.exhaustRestrictionK,2,0,100),
		exhaustFrictionFactor:bounded(source.exhaustFrictionFactor,.025,.005,.12),
		compressorEfficiency:bounded(source.compressorEfficiency,.7,.35,.9),
		turbineEfficiency:bounded(source.turbineEfficiency,.65,.3,.9),
		turbineRestrictionK:bounded(source.turbineRestrictionK,engine.boostBar>0?12:0,0,100),
		intercoolerEffectiveness:bounded(source.intercoolerEffectiveness,.65,0,.95),
		turboInertiaKgM2:bounded(source.turboInertiaKgM2,.00002+engine.turboSize*.00008,.000005,.001),
		sparkAdvanceDeg:bounded(source.sparkAdvanceDeg,18,-10,50),
		burnDurationDeg:bounded(source.burnDurationDeg,50,15,120),
		wiebeShape:bounded(source.wiebeShape,2,.5,5),
		wiebeEfficiency:bounded(source.wiebeEfficiency,6.9,2,10),
		intakeOpenDeg:bounded(source.intakeOpenDeg,710,650,719.9),
		intakeCloseDeg:bounded(source.intakeCloseDeg,220,140,280),
		exhaustOpenDeg:bounded(source.exhaustOpenDeg,500,430,590),
		exhaustCloseDeg:bounded(source.exhaustCloseDeg,10,0,70),
		intakeValveDiameterMm:bounded(source.intakeValveDiameterMm,g.boreMm*.36,6,90),
		exhaustValveDiameterMm:bounded(source.exhaustValveDiameterMm,g.boreMm*.32,6,90),
		intakeValveLiftMm:bounded(source.intakeValveLiftMm,g.boreMm*.10,.5,25),
		exhaustValveLiftMm:bounded(source.exhaustValveLiftMm,g.boreMm*.09,.5,25),
		intakeValveCount:Math.round(bounded(source.intakeValveCount,2,1,4)),
		exhaustValveCount:Math.round(bounded(source.exhaustValveCount,2,1,4)),
		valveDischargeCoefficient:bounded(source.valveDischargeCoefficient,.68,.1,1),
		wallTemperatureK:bounded(source.wallTemperatureK,clamp(thermal.initialWallTemperatureK,230,1000),230,1000),
		heatTransferWm2K:bounded(source.heatTransferWm2K,180,0,3000),
		variableHeatCapacity:source.variableHeatCapacity===true,
		cycleVariability:bounded(source.cycleVariability,engine.roughness*.35,0,1),
		veMap:normalizeCalibrationMap(source.veMap,'ve',createAssumedVeMap(engine.idleRpm,engine.redline,bounded(source.volumetricEfficiency,.9,.3,1.25))),
		...(source.fmepMap?{fmepMap:normalizeCalibrationMap(source.fmepMap,'fmep')}:{}),
		...(source.indicatedEfficiencyMap?{indicatedEfficiencyMap:normalizeCalibrationMap(source.indicatedEfficiencyMap,'indicatedEfficiency')}:{}),
		provenance:{source:source.provenance?.source==='measured'||source.provenance?.source==='fitted'?source.provenance.source:'assumed',label:typeof source.provenance?.label==='string'?source.provenance.label.slice(0,160):'Original exploratory assumptions',version:typeof source.provenance?.version==='string'?source.provenance.version.slice(0,60):'physical-2',
   ...(typeof source.provenance?.engineId==='string'?{engineId:source.provenance.engineId.slice(0,120)}:{}),
   ...(typeof source.provenance?.notes==='string'?{notes:source.provenance.notes.slice(0,2000)}:{}),
   ...(typeof source.provenance?.calibratedAt==='string'&&Number.isFinite(Date.parse(source.provenance.calibratedAt))?{calibratedAt:source.provenance.calibratedAt}:{}),
   ...(source.provenance?.validation&&typeof source.provenance.validation.label==='string'&&typeof source.provenance.validation.independent==='boolean'?{validation:{label:source.provenance.validation.label.slice(0,200),independent:source.provenance.validation.independent,...(typeof source.provenance.validation.date==='string'&&Number.isFinite(Date.parse(source.provenance.validation.date))?{date:source.provenance.validation.date}:{})}}:{})},
		thermal,materialScreen:normalizeMaterialScreenConfig(source.materialScreen),
		...(source.cycleCalibration&&source.cycleCalibration.method==='bounded-grid'&&source.cycleCalibration.status==='fitted'?{cycleCalibration:{source:String(source.cycleCalibration.source??'').slice(0,200),referenceHash:String(source.cycleCalibration.referenceHash??'').slice(0,200),rpm:bounded(source.cycleCalibration.rpm,3000,300,18000),throttle:bounded(source.cycleCalibration.throttle,1,0,1),rmseBar:bounded(source.cycleCalibration.rmseBar,0,0,1000),method:'bounded-grid' as const,status:'fitted' as const,sparkAdvanceDeg:bounded(source.cycleCalibration.sparkAdvanceDeg,18,-10,50),burnDurationDeg:bounded(source.cycleCalibration.burnDurationDeg,50,15,120),...(source.cycleCalibration.angleOrigin==='intake-tdc'||source.cycleCalibration.angleOrigin==='firing-tdc'?{angleOrigin:source.cycleCalibration.angleOrigin}:{})}}:{}),
	};
}

export function engineGeometry(engine: EngineConfig, physical: PhysicalConfig): EngineGeometry {
	const displacementM3 = engine.displacement * 0.001;
	const cylinderDisplacementM3 = displacementM3 / engine.cylinders;
	const strokeM = Math.cbrt(4 * cylinderDisplacementM3 / (Math.PI * physical.boreStrokeRatio ** 2));
	const boreM = strokeM * physical.boreStrokeRatio;
	return {
		displacementM3, cylinderDisplacementM3, boreMm: boreM * 1000, strokeMm: strokeM * 1000,
		rodLengthMm: strokeM * physical.rodLengthStrokeRatio * 1000,
		pistonAreaM2: Math.PI * boreM * boreM / 4,
		clearanceVolumeM3: cylinderDisplacementM3 / (engine.compression - 1),
	};
}

/** Absolute boundary conditions. Dynamic reservoirs may override the steady
 * throttle/pipe solution; their exhaust pressure already contains pipe losses. */
export interface GasPathBoundary {
 intakePressurePa:number; intakeTemperatureK:number;
 exhaustPressurePa:number; exhaustTemperatureK:number;
}
export interface CalibratedCylinderCycle extends CylinderCycleResult {
 ecu?:EcuCouplingSummary;
 calibration:{mappedVE:number;actualVE:number;veResidual:number;extrapolated:boolean;
  effectiveIntakeLiftM:number;iterations:number;indicatedEfficiencyTarget?:number;indicatedEfficiencyResidual?:number};
}
export function gasPathConfigFor(engine:EngineConfig,p:PhysicalConfig):GasPathConfig {
 return {ambientPressurePa:p.ambientPressureBar*1e5,ambientTemperatureK:p.intakeTemperatureK,
  intakeVolumeM3:p.intakeVolumeL*.001,exhaustVolumeM3:p.exhaustVolumeL*.001,
  throttleDiameterM:p.throttleDiameterMm*.001,throttleDischarge:p.throttleDischarge,
  throttleLeakFraction:p.throttleLeakFraction,exhaustDiameterM:engine.pipeDiameter*.001,
  exhaustLengthM:engine.exhaustLength+engine.headerLength,exhaustMinorK:p.exhaustRestrictionK+(engine.boostBar>0?p.turbineRestrictionK:0),
  exhaustFrictionFactor:p.exhaustFrictionFactor,gamma:p.gamma,gasConstant:AIR_R};
}
function compressorBoundary(engine:EngineConfig,p:PhysicalConfig,boostFraction:number):{pressurePa:number;temperatureK:number} {
 const pressurePa=(p.ambientPressureBar+engine.boostBar*clamp(boostFraction,0,1))*1e5;
 const ratio=pressurePa/(p.ambientPressureBar*1e5);
 const rise=p.intakeTemperatureK*(ratio**((p.gamma-1)/p.gamma)-1)/p.compressorEfficiency;
 return {pressurePa,temperatureK:p.intakeTemperatureK+rise*(1-p.intercoolerEffectiveness)};
}
function steadyBoundary(engine:EngineConfig,p:PhysicalConfig,rpm:number,throttle:number,boostFraction=1):GasPathBoundary {
 const upstream=compressorBoundary(engine,p,boostFraction),geometry=engineGeometry(engine,p);
 const area=Math.PI*(p.throttleDiameterMm*.001)**2/4*(p.throttleLeakFraction+(1-p.throttleLeakFraction)*throttle**2);
 let lo=15000,hi=upstream.pressurePa;
 for(let i=0;i<32;i++){
  const pressure=(lo+hi)/2,ve=sampleCalibrationMap(p.veMap,rpm,pressure/1e5).value;
  const demand=pressure/(AIR_R*upstream.temperatureK)*geometry.displacementM3*ve*rpm/120;
  const incoming=compressibleOrificeFlow(upstream.pressurePa,upstream.temperatureK,pressure,upstream.temperatureK,area,p.throttleDischarge,p.gamma);
  if(incoming>demand)lo=pressure;else hi=pressure;
 }
 const intakePressurePa=(lo+hi)/2,ve=sampleCalibrationMap(p.veMap,rpm,intakePressurePa/1e5).value;
 const massFlow=intakePressurePa/(AIR_R*upstream.temperatureK)*geometry.displacementM3*ve*rpm/120;
 // Assumed initial exhaust-gas temperature is a boundary, not the gas peak or metal temperature.
 const exhaustTemperatureK=clamp(engine.temperature+273.15,350,1500),ambient=p.ambientPressureBar*1e5;
 const c=gasPathConfigFor(engine,p);
 // Solve p_exh = p_ambient + K*mDot²/(2*rho*A²), with rho=p_exh/(RT).
 const lossAtAmbient=exhaustPressureLoss(massFlow,ambient/(AIR_R*exhaustTemperatureK),c.exhaustDiameterM,c.exhaustLengthM,c.exhaustMinorK,c.exhaustFrictionFactor);
 const exhaustPressurePa=(ambient+Math.sqrt(ambient*ambient+4*ambient*lossAtAmbient))/2;
 return {intakePressurePa,intakeTemperatureK:upstream.temperatureK,exhaustPressurePa,exhaustTemperatureK};
}

/** Pure mapping for inspectors/workers. No cylinder integration or cache access.
 * The un-fitted intake lift is explicit; getCylinderCycle may inverse-fit it. */
export function cycleConfigFor(engine:EngineConfig,p:PhysicalConfig,inputRpm:number,inputThrottle:number,
 override?:Partial<GasPathBoundary>,boostFraction=1):CylinderCycleConfig {
 const rpm=bounded(inputRpm,engine.idleRpm,300,18000),throttle=bounded(inputThrottle,0,0,1);
 const geometry=engineGeometry(engine,p),boundary={...steadyBoundary(engine,p,rpm,throttle,boostFraction),...override};
 return normalizeCylinderCycleConfig({boreM:geometry.boreMm*.001,strokeM:geometry.strokeMm*.001,
  rodLengthM:geometry.rodLengthMm*.001,compressionRatio:engine.compression,rpm,...boundary,
  intakeOpenDeg:p.intakeOpenDeg,intakeCloseDeg:p.intakeCloseDeg,exhaustOpenDeg:p.exhaustOpenDeg,exhaustCloseDeg:p.exhaustCloseDeg,
  intakeValveDiameterM:p.intakeValveDiameterMm*.001,exhaustValveDiameterM:p.exhaustValveDiameterMm*.001,
  intakeValveLiftM:p.intakeValveLiftMm*.001,exhaustValveLiftM:p.exhaustValveLiftMm*.001,
  intakeValveCount:p.intakeValveCount,exhaustValveCount:p.exhaustValveCount,dischargeCoefficient:p.valveDischargeCoefficient,
  sparkAdvanceDeg:p.sparkAdvanceDeg,burnDurationDeg:p.burnDurationDeg,wiebeShape:p.wiebeShape,wiebeEfficiency:p.wiebeEfficiency,
  airFuelRatio:p.airFuelRatio,fuelLhvJkg:p.fuelLhvMJkg*1e6,combustionEfficiency:p.combustionEfficiency,
  wallTemperatureK:p.wallTemperatureK,heatTransferWm2K:p.heatTransferWm2K,gamma:p.gamma,variableHeatCapacity:p.variableHeatCapacity,
  stepDeg:2,settlingCycles:3,...(throttle<.005||inputRpm>=engine.redline?{fuelMassKg:0}:{})});
}
const cycleCache=new Map<string,CalibratedCylinderCycle>();
/** Cached at a bounded 192 operating points. At most three inverse-fit trials;
 * actual mass, pVT, heat and work always come from the same accepted solve. */
export function getCylinderCycle(engine:EngineConfig,p:PhysicalConfig,rpm:number,throttle:number,
 override?:Partial<GasPathBoundary>,boostFraction=1):CalibratedCylinderCycle {
 const config=cycleConfigFor(engine,p,rpm,throttle,override,boostFraction);
 const mapped=sampleCalibrationMap(p.veMap,config.rpm,config.intakePressurePa/1e5);
 const efficiency=p.indicatedEfficiencyMap?sampleCalibrationMap(p.indicatedEfficiencyMap,config.rpm,config.intakePressurePa/1e5):undefined;
 const key=JSON.stringify([config,mapped.value,mapped.extrapolated,efficiency?.value,efficiency?.extrapolated]);
 const hit=cycleCache.get(key);if(hit){cycleCache.delete(key);cycleCache.set(key,hit);return hit;}
 const swept=Math.PI*config.boreM**2/4*config.strokeM,rho=config.intakePressurePa/(AIR_R*config.intakeTemperatureK);
 let candidate={...config},result: CylinderCycleResult|undefined,actualVE=0,iterations=0;
 for(let i=0;i<3;i++){
  result=solveCylinderCycle(candidate);iterations=i+1;
  actualVE=result.freshChargeMassKg/(rho*swept);
  const eff=result.fuelEnergyJ>0?result.netWorkJ/result.fuelEnergyJ:0;
  if(Math.abs(actualVE-mapped.value)<.015&&(!efficiency||result.fuelMassKg===0||Math.abs(eff-efficiency.value)<.015))break;
  candidate={...candidate,intakeValveLiftM:clamp(candidate.intakeValveLiftM*clamp(mapped.value/Math.max(.03,actualVE),.5,2),.0002,.025),
   combustionEfficiency:efficiency&&result.fuelMassKg>0?clamp(candidate.combustionEfficiency*clamp(efficiency.value/Math.max(.03,eff),.5,2),.1,1):candidate.combustionEfficiency};
 }
 const solved=result!,warnings=[...solved.warnings];
 if(Math.abs(actualVE-mapped.value)>.03)warnings.push('VE target not reached by the three bounded effective-intake-area trials; reported mass/work remain the actual solve.');
 if(mapped.extrapolated||efficiency?.extrapolated)warnings.push('Calibration map sampled outside its declared domain; boundary values were clamped.');
 const effResidual=efficiency&&solved.fuelEnergyJ>0?solved.netWorkJ/solved.fuelEnergyJ-efficiency.value:undefined;
 if(effResidual!==undefined&&Math.abs(effResidual)>.03)warnings.push('Indicated-efficiency target not reached within bounded heat-input calibration.');
 const calibrated:CalibratedCylinderCycle={...solved,warnings,calibration:{mappedVE:mapped.value,actualVE,veResidual:actualVE-mapped.value,
  extrapolated:mapped.extrapolated||!!efficiency?.extrapolated,effectiveIntakeLiftM:solved.config.intakeValveLiftM,iterations,
  ...(efficiency?{indicatedEfficiencyTarget:efficiency.value,indicatedEfficiencyResidual:effResidual}:{})}};
 for(const values of Object.values(calibrated.trace))Object.freeze(values);
 Object.freeze(calibrated.trace);Object.freeze(calibrated.config);Object.freeze(calibrated.warnings);Object.freeze(calibrated.calibration);Object.freeze(calibrated);
 cycleCache.set(key,calibrated);if(cycleCache.size>192)cycleCache.delete(cycleCache.keys().next().value!);
 return calibrated;
}
function estimateFromCycle(engine:EngineConfig,p:PhysicalConfig,rpm:number,throttle:number,cycle:CalibratedCylinderCycle):EngineEstimate {
 const geometry=engineGeometry(engine,p),omega=rpm*TAU/60,frequency=engine.cylinders*rpm/120;
 const meanPistonSpeedMs=2*geometry.strokeMm*.001*rpm/60;
 const fmep=p.fmepMap?sampleCalibrationMap(p.fmepMap,rpm,cycle.config.intakePressurePa/1e5):undefined;
 const fmepBar=fmep?.value??(p.frictionBaseBar+p.frictionSpeedBar*meanPistonSpeedMs+.002*meanPistonSpeedMs**2);
 const frictionTorqueNm=fmepBar*1e5*geometry.displacementM3/(4*Math.PI);
 const indicatedTorqueNm=cycle.grossWorkJ*engine.cylinders/(4*Math.PI);
 // Positive value is an open-loop loss; netWork already includes this signed loop.
 const pumpingTorqueNm=-cycle.pumpingWorkJ*engine.cylinders/(4*Math.PI);
 const torqueNm=cycle.netWorkJ*engine.cylinders/(4*Math.PI)-frictionTorqueNm,powerKw=torqueNm*omega/1000;
 const fuelMassFlowKgs=cycle.fuelMassKg*frequency,fuelPowerKw=fuelMassFlowKgs*p.fuelLhvMJkg*1000;
 const sample=(angle:number,values:number[])=>{let best=0;for(let i=1;i<cycle.trace.angleDeg.length;i++)if(Math.abs(cycle.trace.angleDeg[i]-angle)<Math.abs(cycle.trace.angleDeg[best]-angle))best=i;return values[best];};
 const peak=cycle.peakPressurePa/1e5,screenFlags:EngineEstimate['screenFlags']=[];
 if(peak>p.assumedPeakPressureBar)screenFlags.push('pressure-assumption');
 if(meanPistonSpeedMs>p.assumedMeanPistonSpeedMs)screenFlags.push('piston-speed-assumption');
 if(rpm>=engine.redline)screenFlags.push('redline');
 const crankRadiusM=geometry.strokeMm*.001/2,rodM=geometry.rodLengthMm*.001;
 return {rpm,throttle,torqueNm,powerKw,powerHp:powerKw*1000/745.699872,indicatedTorqueNm,frictionTorqueNm,pumpingTorqueNm,
  bmepBar:torqueNm*4*Math.PI/geometry.displacementM3/1e5,fmepBar,manifoldPressureBar:cycle.config.intakePressurePa/1e5,
  ivcPressureBar:sample(p.intakeCloseDeg,cycle.trace.pressurePa)/1e5,
  airMassFlowKgs:cycle.freshChargeMassKg*frequency,fuelMassFlowKgs,fuelPowerKw,
  brakeEfficiency:fuelPowerKw>0?Math.max(0,powerKw)/fuelPowerKw:0,ottoEfficiency:1-engine.compression**(1-p.gamma),
  compressionPressureBar:sample(360-p.sparkAdvanceDeg,cycle.trace.pressurePa)/1e5,
  compressionTemperatureK:sample(360-p.sparkAdvanceDeg,cycle.trace.temperatureK),
  idealPeakPressureBar:peak,idealPeakGasTemperatureK:cycle.peakTemperatureK,meanPistonSpeedMs,
  idealGasForceN:Math.max(0,peak-p.ambientPressureBar)*1e5*geometry.pistonAreaM2,
  inertiaForceTdcN:p.reciprocatingMassKg*crankRadiusM*omega**2*(1+crankRadiusM/rodM),fuelCut:cycle.fuelMassKg===0,screenFlags,geometry,
  exhaustPressureBar:cycle.config.exhaustPressurePa/1e5,exhaustTemperatureK:cycle.exhaustTemperatureK,
  mappedVolumetricEfficiency:cycle.calibration.mappedVE,actualVolumetricEfficiency:cycle.calibration.actualVE,
  veTargetResidual:cycle.calibration.veResidual,mapExtrapolated:cycle.calibration.extrapolated||!!fmep?.extrapolated,
  calibrationSource:p.veMap.provenance.source,wallHeatLossW:cycle.wallHeatLossJ*frequency,
  cycle:{netWorkJ:cycle.netWorkJ,grossWorkJ:cycle.grossWorkJ,pumpingWorkJ:cycle.pumpingWorkJ,
   peakPressurePa:cycle.peakPressurePa,peakTemperatureK:cycle.peakTemperatureK,peakPressureRisePaPerDeg:cycle.peakPressureRisePaPerDeg,
   massBalanceResidualKg:cycle.massBalanceResidualKg,energyBalanceResidualJ:cycle.energyBalanceResidualJ,
   periodicMassRelativeError:cycle.periodicMassRelativeError,periodicEnergyRelativeError:cycle.periodicEnergyRelativeError,
   ca50Deg:cycle.ca50Deg,residualFraction:cycle.residualFractionAtIvc,lookupRpm:cycle.config.rpm,lookupIntakePressureBar:cycle.config.intakePressurePa/1e5},
  warnings:[...cycle.warnings,...(fmep?.extrapolated?['FMEP map outside declared domain; boundary value clamped.']:[])]};
}
/** Steady 720° pressure-cycle estimate. Configured boost is an available target
 * boundary here; only Powertrain integrates a shared turbo shaft state. */
export function evaluateEngine(engine:EngineConfig,p:PhysicalConfig,inputRpm:number,inputThrottle:number,boostFraction=1):EngineEstimate {
 const rpm=bounded(inputRpm,engine.idleRpm,0,engine.redline*1.2),throttle=bounded(inputThrottle,0,0,1);
 return estimateFromCycle(engine,p,rpm,throttle,getCylinderCycle(engine,p,rpm,throttle,undefined,boostFraction));
}

export function potentialEnvelope(engine: EngineConfig, physical: PhysicalConfig, samples = 64): PotentialEnvelope {
	const count = Math.round(bounded(samples, 64, 8, 256));
	const points = Array.from({ length: count }, (_, index) => evaluateEngine(engine, physical,
		engine.idleRpm + (engine.redline * 0.995 - engine.idleRpm) * index / (count - 1), 1));
	let peakPower = points[0], peakTorque = points[0], highestScreenedPoint: EngineEstimate | null = null;
	for (const point of points) {
		if (point.powerKw > peakPower.powerKw) peakPower = point;
		if (point.torqueNm > peakTorque.torqueNm) peakTorque = point;
		if (point.screenFlags.length === 0 && (!highestScreenedPoint || point.powerKw > highestScreenedPoint.powerKw)) highestScreenedPoint = point;
	}
	return { points, peakPower, peakTorque, screenedPeakPower: highestScreenedPoint,
		limitingCauses: [...new Set(points.flatMap((point) => point.screenFlags))], status: 'uncalibrated-assumptions' };
}

/** Engine-side clutch torque to wheel torque. Losses reverse direction when the
 * wheels back-drive the engine; multiplying by efficiency in both directions
 * would create mechanical energy during engine braking near locked speed. */
export function transmittedWheelTorque(clutchTorqueNm: number, ratio: number, efficiency: number): number {
	return clutchTorqueNm * ratio * (clutchTorqueNm >= 0 ? efficiency : 1 / efficiency);
}

/** A bounded analytic viscous-clutch impulse, additionally limited before slip
 * reversal using both relative and kinetic-energy effective inertias. This
 * preserves discrete passivity even at the smallest allowed engine inertia. */
export function passiveClutchImpulse(engineOmega:number,wheelOmega:number,ratio:number,engineInertia:number,
 vehicleMass:number,tyreRadius:number,efficiency:number,engagement:number,dt:number):number {
 if(dt<=0||engagement<=0)return 0;
 const slip=engineOmega-wheelOmega*ratio,transfer=slip>=0?efficiency:1/efficiency;
 const wheelInverse=ratio**2/(vehicleMass*tyreRadius**2);
 const relativeInverse=1/engineInertia+transfer*wheelInverse;
 const energyInverse=1/engineInertia+transfer**2*wheelInverse;
 const analytic=slip*(-Math.expm1(-5*engagement*relativeInverse*dt))/relativeInverse;
 const noCross=Math.abs(slip)/Math.max(relativeInverse,energyInverse);
 return Math.sign(slip)*Math.min(Math.abs(analytic),450*dt,noCross);
}

/** SI longitudinal dynamics with mean-value gas inventories and a shared turbo
 * shaft. Cylinder integration is lazy/quantized and refreshed at <=20Hz; it is
 * never performed at every <=1/240s mechanical substep. This is not real-time CFD. */
export class Powertrain {
 private engine:EngineConfig;
 private physical:PhysicalConfig;
 private omega:number;
 private speed=0;
 private turboEnergyJ=0;
 private boostFraction=0;
 private gas:GasPath;
 private thermal:ThermalNetwork;
 private last:PowertrainState;
 private cycleProgress=0;
 private cycleIndex=0;
 private variation={energy:1,duration:1,phase:0};
 private lookupElapsed=1;
 private operating:EngineEstimate|null=null;
 private operatingCycle:CalibratedCylinderCycle|null=null;
 private readonly onlineCache=new Map<string,CalibratedCylinderCycle>();

 constructor(engine:EngineConfig,physical=normalizePhysicalConfig(engine)){
  this.engine=engine;this.physical=normalizePhysicalConfig(engine,physical);
  this.omega=engine.idleRpm*TAU/60;
  this.gas=new GasPath(gasPathConfigFor(engine,this.physical));
  this.gas.reset(steadyBoundary(engine,this.physical,engine.idleRpm,.036,0));this.thermal=new ThermalNetwork(this.physical.thermal);
  this.last=this.emptyState();
 }
 private audioState(fuelCut=false):PhysicalAudioState {
  const gas=this.gas.getState();
  return {boostBar:this.engine.boostBar*this.boostFraction,fuelCut,intakePressureBar:gas.intake.pressurePa/1e5,
   exhaustPressureBar:gas.exhaust.pressurePa/1e5,exhaustMassFlowKgs:Math.max(0,gas.cylinderExhaustMassFlowKgs),
   exhaustTemperatureK:gas.exhaust.temperatureK,cycleEnergyScale:this.variation.energy,burnDurationScale:this.variation.duration,
   combustionPhaseDeg:this.variation.phase,residualFraction:this.operating?.cycle.residualFraction??0,cycleIndex:this.cycleIndex};
 }
 private emptyState():PowertrainState {
  const physical=this.audioState();
  return {rpm:this.omega*60/TAU,load:.14,throttle:0,speedMs:this.speed,speedKmh:this.speed*3.6,
   accelerationMs2:0,gear:0,clutch:0,torqueNm:0,powerKw:0,resistanceN:0,tractionN:0,boostFraction:this.boostFraction,quantitativelyValid:true,
   physical,physicalAudio:physical,gasPath:this.gas.getState(),thermal:this.thermal.getState(),warnings:[]};
 }
 setConfig(engine:EngineConfig,physical:Partial<PhysicalConfig>=this.physical):void {
  const normalized=normalizePhysicalConfig(engine,physical);
  if(JSON.stringify([engine,normalized])!==JSON.stringify([this.engine,this.physical])){
   this.operating=null;this.operatingCycle=null;this.onlineCache.clear();this.lookupElapsed=1;
  }
  this.engine=engine;this.physical=normalized;this.gas.configure(gasPathConfigFor(engine,normalized));this.thermal.setConfig(normalized.thermal);
  this.omega=clamp(this.omega,engine.idleRpm*TAU/60,engine.redline*TAU/60);
  if(engine.boostBar===0){this.turboEnergyJ=0;this.boostFraction=0;}
 }
 reset(state:{rpm?:number;speedMs?:number}={}):PowertrainState {
  this.omega=bounded(state.rpm,this.engine.idleRpm,this.engine.idleRpm,this.engine.redline)*TAU/60;
  this.speed=bounded(state.speedMs,0,0,150);this.turboEnergyJ=0;this.boostFraction=0;
  this.cycleProgress=0;this.cycleIndex=0;this.variation={energy:1,duration:1,phase:0};this.lookupElapsed=1;
  this.operating=null;this.operatingCycle=null;this.gas.reset(steadyBoundary(this.engine,this.physical,this.omega*60/TAU,.036,0));this.thermal.reset();
  this.last=this.emptyState();return this.getState();
 }
 getState():PowertrainState {
  return {...this.last,physical:{...this.last.physical},physicalAudio:{...this.last.physicalAudio},thermal:{...this.last.thermal},
   gasPath:{...this.last.gasPath,intake:{...this.last.gasPath.intake},exhaust:{...this.last.gasPath.exhaust},warnings:[...this.last.gasPath.warnings]},warnings:[...this.last.warnings]};
 }
 /** Snapshot of the currently held cycle estimate; never triggers a solve. */
 getOperatingEstimate():EngineEstimate|null {return this.operating?{...this.operating,geometry:{...this.operating.geometry},cycle:{...this.operating.cycle},screenFlags:[...this.operating.screenFlags],warnings:[...this.operating.warnings]}:null;}
 private refreshOperating(rpm:number,throttle:number):void {
  const gas=this.gas.getState(),p=this.physical;
  const q=(x:number,step:number)=>Math.round(x/step)*step;
  const cut=throttle<.005||rpm>=this.engine.redline;
  // A fueled sample must not round onto/above the limiter and trigger an early cut.
  const lookupRpm=Math.min(this.engine.redline-1,clamp(q(rpm,500),300,18000));
  const boundary={intakePressurePa:clamp(q(gas.intake.pressurePa,10000),15000,500000),
   intakeTemperatureK:clamp(q(gas.intake.temperatureK,25),230,600),
   exhaustPressurePa:clamp(q(gas.exhaust.pressurePa,10000),30000,700000),
   exhaustTemperatureK:clamp(q(gas.exhaust.temperatureK,100),240,1800)};
  const key=JSON.stringify([lookupRpm,cut,boundary]);
  let cycle=this.onlineCache.get(key);
  if(!cycle){cycle=getCylinderCycle(this.engine,p,lookupRpm,cut?0:Math.max(.01,throttle),boundary,this.boostFraction);
   this.onlineCache.set(key,cycle);if(this.onlineCache.size>96)this.onlineCache.delete(this.onlineCache.keys().next().value!);}
  this.operatingCycle=cycle;this.operating=estimateFromCycle(this.engine,p,rpm,throttle,cycle);this.lookupElapsed=0;
 }
 private advanceVariation(rpm:number,dt:number):void {
  this.cycleProgress+=rpm/120*dt;
  while(this.cycleProgress>=1){
   this.cycleProgress-=1;this.cycleIndex++;
   let bits=(this.engine.seed^Math.imul(this.cycleIndex,0x9e3779b1))>>>0;
   const random=()=>{bits^=bits<<13;bits^=bits>>>17;bits^=bits<<5;return (bits>>>0)/4294967296*2-1;};
   const cold=clamp((370-this.thermal.getState().wallTemperatureK)/150,0,1);
   const mixture=clamp(Math.abs(this.physical.airFuelRatio-14.7)/7,0,1),residual=this.operating?.cycle.residualFraction??0;
   const intensity=this.physical.cycleVariability*(.4+.3*cold+.35*mixture+.35*residual);
   const joint=random()*intensity,independent=random()*intensity;
   this.variation={energy:clamp(1+joint*.18,.75,1.2),duration:clamp(1-joint*.12+independent*.05,.8,1.25),phase:clamp((-joint+independent*.4)*2,-3,3)};
  }
 }
 private advanceTurbo(dt:number,gas:GasPathState):void {
  const p=this.physical,e=this.engine;
  if(e.boostBar<=0){this.turboEnergyJ=0;this.boostFraction=0;return;}
  const cp=p.gamma*AIR_R/(p.gamma-1),ambient=p.ambientPressureBar*1e5;
  const ratio=Math.max(1,gas.exhaust.pressurePa/ambient),supply=compressorBoundary(e,p,this.boostFraction);
  const turbine=Math.max(0,gas.outletMassFlowKgs)*cp*gas.exhaust.temperatureK*(1-ratio**(-(p.gamma-1)/p.gamma))*p.turbineEfficiency;
  const compressor=Math.max(0,gas.throttleMassFlowKgs)*cp*p.intakeTemperatureK*((supply.pressurePa/ambient)**((p.gamma-1)/p.gamma)-1)/p.compressorEfficiency;
  // Original speed-to-pressure surrogate, not compressor/turbine performance maps.
  const referenceSpeed=12000,maximumEnergy=.5*p.turboInertiaKgM2*referenceSpeed**2;
  const bearingLoss=.08*this.turboEnergyJ;
  this.turboEnergyJ=clamp(this.turboEnergyJ+(turbine-compressor-bearingLoss)*dt,0,maximumEnergy);
  // Excess turbine power at this configured cap represents ideal wastegate rejection.
  this.boostFraction=maximumEnergy>0?Math.sqrt(this.turboEnergyJ/maximumEnergy):0;
 }
 step(inputDt:number,inputThrottle:number,inputBrake=0,inputGear=0,inputGrade=this.physical.gradePercent):PowertrainState {
  const dt=bounded(inputDt,0,0,.25);if(dt===0)return this.getState();
  const p=this.physical,e=this.engine,requested=bounded(inputThrottle,0,0,1),brake=bounded(inputBrake,0,0,1);
  const gear=Math.round(bounded(inputGear,0,0,p.gearRatios.length)),grade=bounded(inputGrade,p.gradePercent,-20,20);
  const steps=Math.ceil(dt*240),h=dt/steps,startSpeed=this.speed;
  let clutch=0,tractionN=0,resistanceN=0,actualThrottle=requested,actualTorque=0,fuelCut=false,flowLimited=false;
  const stepWarnings=new Set<string>();
  for(let i=0;i<steps;i++){
   const rpm=this.omega*60/TAU,idleError=clamp((e.idleRpm*1.03-rpm)/(e.idleRpm*.2),0,1);
   actualThrottle=Math.max(requested,idleError*.24);fuelCut=actualThrottle<.005||rpm>=e.redline;
   if(this.operating===null||this.lookupElapsed>=.05||fuelCut!==this.operating.fuelCut)this.refreshOperating(rpm,actualThrottle);
   const point=this.operating!,cycle=this.operatingCycle!;
   this.advanceVariation(rpm,h);
   const variation=fuelCut?1:this.variation.energy*(1-(this.variation.duration-1)*.08)*(1-Math.abs(this.variation.phase)*.002);
   actualTorque=(fuelCut?Math.min(0,point.indicatedTorqueNm):point.indicatedTorqueNm*variation)-point.pumpingTorqueNm-point.frictionTorqueNm;
   const oldGas=this.gas.getState(),metal=this.thermal.getState(),frequency=e.cylinders*rpm/120;
   // Net admitted working gas, distinct from fresh charge used for fueling.
   const airDemand=Math.max(0,cycle.intakeMassInKg-cycle.intakeReverseMassKg)*frequency;
   const supply=compressorBoundary(e,p,this.boostFraction);
   let exchange=p.thermal.exhaustHeatTransferEffectiveness*Math.max(0,oldGas.outletMassFlowKgs)*p.thermal.exhaustGasHeatCapacityJKgK*(oldGas.exhaust.temperatureK-metal.exhaustWallTemperatureK);
   exchange=clamp(exchange,-1e6,Math.min(1e6,oldGas.exhaust.internalEnergyJ*.1/h));
   const gas=this.gas.step(h,{rpm,throttle:actualThrottle,engineDisplacementM3:point.geometry.displacementM3,
    volumetricEfficiency:point.actualVolumetricEfficiency,cylinderAirMassFlowKgs:airDemand,
    // Air-standard cycle: fuel is equivalent heat and does not add inventory mass.
    fuelMassFlowKgs:0,exhaustTemperatureK:cycle.exhaustTemperatureK,compressorPressurePa:supply.pressurePa,
    compressorTemperatureK:supply.temperatureK,exhaustHeatW:-exchange});
   if(gas.limitedOutflowKg>1e-12){flowLimited=true;stepWarnings.add('Flow-limited operating point: cached torque/fueling exceeds available inventory and is invalid for quantitative power comparisons.');}
   for(const warning of gas.warnings)stepWarnings.add(warning);
   const actualExchange=exchange-gas.limitedCoolingJ/h;
   this.thermal.step(h,{gasHeatW:point.wallHeatLossW*(fuelCut?1:variation),frictionHeatW:point.frictionTorqueNm*this.omega,
    coupledExhaustGasHeatW:actualExchange,exhaustGasTemperatureK:gas.exhaust.temperatureK});
   this.advanceTurbo(h,gas);
   const rho=p.ambientPressureBar*1e5/(AIR_R*293.15),slope=Math.atan(grade/100);
   const aero=.5*rho*p.dragCdA*this.speed**2,rolling=p.vehicleMassKg*G*p.rollingResistance*Math.cos(slope);
   resistanceN=aero+p.vehicleMassKg*G*Math.sin(slope)+(this.speed>.001?rolling:0);
   const brakeForce=brake*p.vehicleMassKg*G*.9;
   if(gear===0){clutch=0;tractionN=0;this.omega+=actualTorque/p.engineInertiaKgM2*h;
    this.speed=Math.max(0,this.speed+(-resistanceN-brakeForce)/p.vehicleMassKg*h);
   }else{
    const ratio=p.gearRatios[gear-1]*p.finalDrive,coupledOmega=this.speed/p.tyreRadiusM*ratio;
    clutch=clamp((rpm-e.idleRpm*1.08)/(e.idleRpm*.65),0,1);
    const clutchTorque=passiveClutchImpulse(this.omega,coupledOmega/ratio,ratio,p.engineInertiaKgM2,p.vehicleMassKg,p.tyreRadiusM,p.driveEfficiency,clutch,h)/h;
    tractionN=transmittedWheelTorque(clutchTorque,ratio,p.driveEfficiency)/p.tyreRadiusM;
    const staticRolling=this.speed<=.001&&tractionN>0?Math.min(rolling,tractionN):0;
    this.speed=Math.max(0,this.speed+(tractionN-resistanceN-brakeForce-staticRolling)/p.vehicleMassKg*h);
    this.omega+=(actualTorque-clutchTorque)/p.engineInertiaKgM2*h;
   }
   this.omega=clamp(this.omega,e.idleRpm*TAU/60,e.redline*1.04*TAU/60);this.speed=Math.min(this.speed,150);this.lookupElapsed+=h;
  }
  const rpm=this.omega*60/TAU,physical=this.audioState(fuelCut),gasPath=this.gas.getState();
  const load=clamp(gasPath.intake.pressurePa/((p.ambientPressureBar+e.boostBar*this.boostFraction)*1e5),0,1);
  this.last={rpm,load,throttle:actualThrottle,speedMs:this.speed,speedKmh:this.speed*3.6,accelerationMs2:(this.speed-startSpeed)/dt,
   gear,clutch,torqueNm:actualTorque,powerKw:actualTorque*this.omega/1000,resistanceN,tractionN,boostFraction:this.boostFraction,
   quantitativelyValid:!flowLimited&&(this.operating?.cycle.periodicMassRelativeError??1)<=.02&&(this.operating?.cycle.periodicEnergyRelativeError??1)<=.02,
   physical,physicalAudio:physical,gasPath,thermal:this.thermal.getState(),
   warnings:[...new Set([...(this.operating?.warnings??[]),...stepWarnings,
    'Online cycle lookup: 500rpm / 0.1bar / 25K intake / 100K exhaust bins, held at up to20Hz; reference cylinder wall temperature is not dynamically refitted.',
    'Mean gas inventories close their own ledgers; cached cylinder/shaft and air-standard fuel approximations do not establish a whole-engine energy closure.'])]};
  return this.getState();
 }
}
