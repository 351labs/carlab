import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, normalizeConfig, presets } from './presets.ts';
import {EngineDSP} from './dsp.ts';
import {solveCylinderCycle} from './cylinder-cycle.ts';
import { engineGeometry, evaluateEngine, normalizePhysicalConfig, potentialEnvelope, Powertrain, transmittedWheelTorque, cycleConfigFor, getCylinderCycle, passiveClutchImpulse } from './powertrain.ts';

const close = (actual: number, expected: number, tolerance = 1e-10) =>
	assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

test('geometry exactly preserves total displacement and input bore/stroke ratio', () => {
	for (const engine of presets.map((preset) => preset.config)) {
		const physical = normalizePhysicalConfig(engine, { boreStrokeRatio: 1.2 });
		const g = engineGeometry(engine, physical);
		close(g.boreMm / g.strokeMm, 1.2);
		close(Math.PI * (g.boreMm / 1000) ** 2 / 4 * g.strokeMm / 1000 * engine.cylinders, engine.displacement * 0.001);
		close(g.rodLengthMm / g.strokeMm, physical.rodLengthStrokeRatio);
		close((g.clearanceVolumeM3 + g.cylinderDisplacementM3) / g.clearanceVolumeM3, engine.compression);
	}
});

test('power, torque, BMEP and fuel energy use coherent SI identities', () => {
	const engine = defaultConfig, physical = normalizePhysicalConfig(engine);
	const point = evaluateEngine(engine, physical, 4000, 0.8);
	close(point.powerKw, point.torqueNm * 4000 * 2 * Math.PI / 60 / 1000);
	close(point.powerHp * 745.699872 / 1000, point.powerKw);
	close(point.bmepBar * 1e5 * point.geometry.displacementM3 / (4 * Math.PI), point.torqueNm);
	close(point.fuelPowerKw, point.fuelMassFlowKgs * physical.fuelLhvMJkg * 1000);
	close(point.brakeEfficiency, point.powerKw / point.fuelPowerKw);
	close(point.airMassFlowKgs / point.fuelMassFlowKgs, physical.airFuelRatio);
	assert.ok(point.brakeEfficiency > 0 && point.brakeEfficiency < point.ottoEfficiency);
});

test('computed pressure cycle preserves pVT and derives torque from net work without double pumping loss', () => {
 const engine=defaultConfig,physical=normalizePhysicalConfig(engine);
 const cycle=getCylinderCycle(engine,physical,3000,1),point=evaluateEngine(engine,physical,3000,1);
 for(let i=0;i<cycle.trace.angleDeg.length;i++)close(cycle.trace.pressurePa[i]*cycle.trace.volumeM3[i],cycle.trace.massKg[i]*287.05*cycle.trace.temperatureK[i],1e-9);
 close(cycle.netWorkJ,cycle.grossWorkJ+cycle.pumpingWorkJ,1e-9);
 close(point.torqueNm,cycle.netWorkJ*engine.cylinders/(4*Math.PI)-point.frictionTorqueNm);
 close(point.indicatedTorqueNm-point.pumpingTorqueNm-point.frictionTorqueNm,point.torqueNm);
 close(point.idealPeakPressureBar,cycle.peakPressurePa/1e5);
 close(point.idealPeakGasTemperatureK,cycle.peakTemperatureK);
 close(point.actualVolumetricEfficiency,cycle.freshChargeMassKg/(cycle.config.intakePressurePa/(287.05*cycle.config.intakeTemperatureK)*point.geometry.cylinderDisplacementM3));
 assert.ok(cycle.calibration.iterations<=3);
 assert.ok(Math.abs(cycle.massBalanceResidualKg)<1e-10);
 assert.ok(Math.abs(cycle.energyBalanceResidualJ)<1e-5);
 const legacy=evaluateEngine(engine,{...physical,thermalUtilization:.2},3000,1);
 close(legacy.torqueNm,point.torqueNm);
});

test('cycleConfigFor maps valves and absolute boundaries without applying a VE post-multiplier',()=>{
 const p=normalizePhysicalConfig(defaultConfig,{sparkAdvanceDeg:24,burnDurationDeg:60,exhaustRestrictionK:8});
 const c=cycleConfigFor(defaultConfig,p,4000,.8,{intakePressurePa:80000,exhaustPressurePa:135000});
 assert.equal(c.intakePressurePa,80000);assert.equal(c.exhaustPressurePa,135000);
 assert.equal(c.sparkAdvanceDeg,24);assert.equal(c.burnDurationDeg,60);
 close(c.intakeValveLiftM,p.intakeValveLiftMm*.001);
 assert.equal(c.fuelMassKg,undefined);
 const cut=cycleConfigFor(defaultConfig,p,4000,0);assert.equal(cut.fuelMassKg,0);
});

test('more load at the same RPM increases filling, torque, fuel and ideal pressure', () => {
	const physical = normalizePhysicalConfig(defaultConfig);
	const low = evaluateEngine(defaultConfig, physical, 3500, 0.2);
	const high = evaluateEngine(defaultConfig, physical, 3500, 0.9);
	for (const key of ['airMassFlowKgs', 'fuelMassFlowKgs', 'torqueNm', 'idealPeakPressureBar'] as const) assert.ok(high[key] > low[key], key);
	close(low.meanPistonSpeedMs, high.meanPistonSpeedMs);
	close(low.inertiaForceTdcN, high.inertiaForceTdcN);
});

test('larger displacement increases potential with the same explicitly limited valves; hotter intake reduces density', () => {
	const engine = normalizeConfig({ ...defaultConfig, displacement: 4 });
	const physical = normalizePhysicalConfig(defaultConfig, { frictionBaseBar: 0, frictionSpeedBar: 0 });
	const normal = evaluateEngine(defaultConfig, physical, 4000, 1);
	const large = evaluateEngine(engine, physical, 4000, 1);
	assert.ok(large.airMassFlowKgs > normal.airMassFlowKgs);
	assert.ok(large.indicatedTorqueNm > normal.indicatedTorqueNm);
	const hot = evaluateEngine(defaultConfig, { ...physical, intakeTemperatureK: 400 }, 4000, 1);
	assert.ok(hot.indicatedTorqueNm < normal.indicatedTorqueNm);
});

test('assumed pressure/speed screens label potential without secretly changing the engine', () => {
	const physical = normalizePhysicalConfig(defaultConfig);
	const conservative = normalizePhysicalConfig(defaultConfig, { assumedPeakPressureBar: 30, assumedMeanPistonSpeedMs: 8 });
	const a = evaluateEngine(defaultConfig, physical, 5000, 1);
	const b = evaluateEngine(defaultConfig, conservative, 5000, 1);
	close(a.torqueNm, b.torqueNm);
	assert.deepEqual(b.screenFlags, ['pressure-assumption', 'piston-speed-assumption']);
	const envelope = potentialEnvelope(defaultConfig, conservative, 12);
	assert.equal(envelope.status, 'uncalibrated-assumptions');
	assert.equal(envelope.points.length, 12);
	assert.equal(envelope.screenedPeakPower, null);
	assert.ok(envelope.limitingCauses.includes('pressure-assumption'));
	assert.ok(envelope.peakPower.powerKw >= envelope.points[0].powerKw);
});

test('closed-throttle and limiter points cut fuel and produce braking torque', () => {
	const p = normalizePhysicalConfig(defaultConfig);
	for (const point of [evaluateEngine(defaultConfig, p, 4000, 0), evaluateEngine(defaultConfig, p, defaultConfig.redline, 1)]) {
		assert.equal(point.fuelMassFlowKgs, 0);
		assert.equal(point.brakeEfficiency, 0);
		assert.ok(point.torqueNm < 0);
		assert.equal(point.fuelCut, true);
	}
});

test('configuration normalization rejects non-finite values and clones transmission inputs', () => {
	const ratios = [3, 2, 1];
	const physical = normalizePhysicalConfig(defaultConfig, { vehicleMassKg: NaN, gamma: Infinity, gradePercent: 99, gearRatios: ratios });
	assert.ok(Number.isFinite(physical.vehicleMassKg) && Number.isFinite(physical.gamma));
	assert.equal(physical.gradePercent, 20);
	ratios[0] = 99;
	assert.equal(physical.gearRatios[0], 3);
	assert.equal(normalizePhysicalConfig(defaultConfig, { gearRatios: [-1] }).gearRatios[0], 3.5);
	assert.equal(normalizePhysicalConfig(defaultConfig, { gearRatios: new Array(3) }).gearRatios[0], 3.5);
});

test('free-rev acceleration responds to actual torque and assumed inertia', () => {
	const light = new Powertrain(defaultConfig, normalizePhysicalConfig(defaultConfig, { engineInertiaKgM2: 0.12 }));
	const heavy = new Powertrain(defaultConfig, normalizePhysicalConfig(defaultConfig, { engineInertiaKgM2: 0.8 }));
	for (let index = 0; index < 40; index++) { light.step(1 / 120, 1); heavy.step(1 / 120, 1); }
	assert.ok(light.getState().rpm > heavy.getState().rpm + 200);
	assert.equal(light.getState().speedMs, 0);
	assert.ok(heavy.getState().rpm > defaultConfig.idleRpm);
});

test('vehicle mass and road grade change acceleration while driving', () => {
	const physical = normalizePhysicalConfig(defaultConfig);
	const flat = new Powertrain(defaultConfig, physical);
	const hill = new Powertrain(defaultConfig, physical);
	const heavy = new Powertrain(defaultConfig, { ...physical, vehicleMassKg: physical.vehicleMassKg * 1.8 });
	// Compare before either car reaches first-gear limiter; at a terminal speed
	// the effect of mass is intentionally smaller than during acceleration.
	for (let index = 0; index < 360; index++) {
		flat.step(1 / 120, 0.8, 0, 1, 0);
		hill.step(1 / 120, 0.8, 0, 1, 12);
		heavy.step(1 / 120, 0.8, 0, 1, 0);
	}
	assert.ok(flat.getState().speedMs > 1);
	assert.ok(flat.getState().speedMs > hill.getState().speedMs);
	assert.ok(flat.getState().speedMs > heavy.getState().speedMs);
	assert.equal(flat.getState().gear, 1);
});

test('the idle governor does not drive the vehicle through a stalled slipping clutch', () => {
	const car = new Powertrain(defaultConfig);
	for (let index = 0; index < 600; index++) car.step(1 / 120, 0, 0, 1);
	assert.equal(car.getState().speedMs, 0);
	assert.equal(car.getState().clutch, 0);
});

test('engine braking and service brakes reduce speed, shifts remain finite, stop never reverses', () => {
	const car = new Powertrain(defaultConfig);
	car.reset({ rpm: 3500, speedMs: 20 });
	for (let index = 0; index < 120; index++) car.step(1 / 120, 0, 0, 3);
	const coast = car.getState();
	assert.ok(coast.speedMs < 20);
	const beforeShift = coast.rpm;
	const shift = car.step(1 / 120, 0.6, 0, 4);
	assert.ok(Math.abs(shift.rpm - beforeShift) < 500);
	for (let index = 0; index < 1200; index++) car.step(1 / 120, 0, 1, 2);
	assert.equal(car.getState().speedMs, 0);
	assert.ok(Number.isFinite(car.getState().rpm));
});

test('transmission is passive in both drive and engine-braking power directions', () => {
	const ratio = 7, efficiency = 0.88;
	for (const [engineOmega, coupledOmega] of [[300, 280], [280, 300], [300, 299.99], [299.99, 300]]) {
		const clutchTorque = (engineOmega - coupledOmega) * 5;
		const wheelOmega = coupledOmega / ratio;
		const wheelTorque = transmittedWheelTorque(clutchTorque, ratio, efficiency);
		const mechanicalPowerChange = -clutchTorque * engineOmega + wheelTorque * wheelOmega;
		assert.ok(mechanicalPowerChange <= 0, `driveline created ${mechanicalPowerChange} W`);
	}
});

test('repeated integration is deterministic and bounded at idle, limiter and invalid step inputs', () => {
	const a = new Powertrain(defaultConfig), b = new Powertrain(defaultConfig);
	// Allow a full coast-down under friction. The model deliberately preserves
	// inertia rather than forcing an arbitrary five-second return-to-idle ramp.
	for (let index = 0; index < 3000; index++) {
		const throttle = index < 600 ? 0 : index < 1200 ? 1 : 0;
		assert.deepEqual(a.step(1 / 120, throttle, 0, 0), b.step(1 / 120, throttle, 0, 0));
		assert.ok(a.getState().rpm >= defaultConfig.idleRpm && a.getState().rpm <= defaultConfig.redline * 1.04);
	}
	const before = a.getState();
	assert.deepEqual(a.step(NaN, NaN, NaN, NaN, NaN), before);
	assert.deepEqual(a.step(-1, 1), before);
	assert.ok(a.getState().rpm < defaultConfig.idleRpm * 1.15);
});


test('exhaust geometry loss changes computed pumping work independently of acoustic attenuation',()=>{
 const p=normalizePhysicalConfig(defaultConfig),free=evaluateEngine(defaultConfig,{...p,exhaustRestrictionK:0},4000,1);
 const restricted=evaluateEngine(defaultConfig,{...p,exhaustRestrictionK:50},4000,1);
 assert.ok(restricted.exhaustPressureBar>free.exhaustPressureBar);
 assert.ok(restricted.cycle.pumpingWorkJ<free.cycle.pumpingWorkJ);
 assert.ok(restricted.torqueNm<free.torqueNm);
 const muffled=evaluateEngine({...defaultConfig,muffler:.99},p,4000,1),plain=evaluateEngine({...defaultConfig,muffler:0},p,4000,1);
 close(muffled.torqueNm,plain.torqueNm);
});

test('map and fitted-cycle provenance survive normalization and old snapshots acquire assumed maps',()=>{
 const p=normalizePhysicalConfig(defaultConfig),saved=JSON.parse(JSON.stringify(p));
 saved.veMap.provenance={source:'fitted',label:'Local declared fit',version:'1',notes:'Not independently validated'};
 saved.cycleCalibration={source:'CSV test',referenceHash:'abc',rpm:3000,throttle:.8,rmseBar:.9,method:'bounded-grid',status:'fitted',sparkAdvanceDeg:17,burnDurationDeg:55,angleOrigin:'firing-tdc'};
 const roundtrip=normalizePhysicalConfig(defaultConfig,saved);
 assert.deepEqual(roundtrip.veMap,saved.veMap);assert.deepEqual(roundtrip.cycleCalibration,saved.cycleCalibration);
 assert.equal(normalizePhysicalConfig(defaultConfig,{volumetricEfficiency:.82}).veMap.provenance.source,'assumed');
 const outside=evaluateEngine(defaultConfig,p,defaultConfig.redline*1.15,1);assert.equal(outside.mapExtrapolated,true);
});

test('physical audio shares gas/turbo/cycle variation and reset is reproducible',()=>{
 const e=normalizeConfig({...defaultConfig,boostBar:.8,seed:99}),p=normalizePhysicalConfig(e,{cycleVariability:.7});
 const a=new Powertrain(e,p),b=new Powertrain(e,p);
 let sawVariation=false;
 for(let i=0;i<120;i++){
  const x=a.step(1/120,.8),y=b.step(1/120,.8);assert.deepEqual(x,y);
  assert.deepEqual(x.physical,x.physicalAudio);assert.equal(x.physical.intakePressureBar,x.gasPath.intake.pressurePa/1e5);
  assert.equal(x.physical.exhaustTemperatureK,x.gasPath.exhaust.temperatureK);
  close(x.physical.boostBar,e.boostBar*x.boostFraction);
  assert.ok(x.boostFraction>=0&&x.boostFraction<=1);assert.ok(x.physical.cycleIndex>=0);
  assert.ok(Math.abs(x.thermal.energyResidualJ)<1e-4);
  assert.ok(Math.abs(x.gasPath.massBalanceResidualKg)<1e-10);
  if(x.physical.cycleEnergyScale!==1)sawVariation=true;
 }
 assert.ok(sawVariation);assert.ok(a.getState().physical.cycleIndex>0);
 assert.deepEqual(a.reset(),b.reset());assert.equal(a.getState().physical.cycleIndex,0);
 assert.equal(a.getState().physical.cycleEnergyScale,1);
});

test('intake inventory has a finite throttle-step response while RPM and demand evolve',()=>{
 const e=defaultConfig,p=normalizePhysicalConfig(e),car=new Powertrain(e,p);
 const before=car.getState(),first=car.step(.005,1),later=car.step(.05,1);
 assert.ok(first.gasPath.intake.pressurePa>before.gasPath.intake.pressurePa);
 // RPM/demand changes during this interval: MAP need not be monotonic.
 assert.ok(later.gasPath.intake.pressurePa>before.gasPath.intake.pressurePa);
 assert.ok(Number.isFinite(later.gasPath.intake.pressurePa));
 assert.ok(Math.abs(later.gasPath.energyBalanceResidualJ)<1e-6);
 assert.ok(Math.abs(later.thermal.energyResidualJ)<1e-4);
});


test('online RPM quantization never cuts a fueled engine before its actual limiter',()=>{
 const e=normalizeConfig({...defaultConfig,redline:6500}),car=new Powertrain(e);
 car.reset({rpm:6400});car.step(.001,1);
 assert.equal(car.getOperatingEstimate()!.fuelCut,false);
 assert.equal(car.getState().physical.fuelCut,false);
 assert.ok(car.getOperatingEstimate()!.cycle.lookupRpm<e.redline);
});


test('thermal fallback is normalized before it becomes a flat cylinder-wall reference',()=>{
 for(const value of [NaN,Infinity,1800]){
  const p=normalizePhysicalConfig(defaultConfig,{thermal:{initialWallTemperatureK:value} as never});
  assert.ok(Number.isFinite(p.wallTemperatureK));assert.ok(p.wallTemperatureK>=230&&p.wallTemperatureK<=1000);
 }
});

test('discrete clutch exchange dissipates kinetic energy at normalized inertia/ratio extremes',()=>{
 const inertia=.03,mass=400,radius=.2,ratio=36,dt=1/240;
 for(const efficiency of [1,.65,.9])for(const slip of [-10,-.001,.001,10]){
  const omega=300,wheel=(omega-slip)/ratio;
  const impulse=passiveClutchImpulse(omega,wheel,ratio,inertia,mass,radius,efficiency,1,dt);
  const wheelImpulse=transmittedWheelTorque(impulse,ratio,efficiency);
  const change=-impulse*omega+impulse**2/(2*inertia)+wheelImpulse*wheel+wheelImpulse**2/(2*mass*radius**2);
  assert.ok(change<=1e-10,`clutch created ${change} J for efficiency${efficiency}/slip${slip}`);
  assert.ok(Math.abs(impulse)<=450*dt);
 }
});


test('coupled exhaust heat removed from gas equals independent thermal energy gain over a flow window',()=>{
 const e=defaultConfig,base=normalizePhysicalConfig(e);
 const zeroFriction={...base.veMap,kind:'fmep' as const,valueUnit:'bar' as const,values:base.veMap.values.map(row=>row.map(()=>0))};
 const p=normalizePhysicalConfig(e,{heatTransferWm2K:0,fmepMap:zeroFriction,thermal:{...base.thermal,
  wallToCoolantWK:0,wallToOilWK:0,wallToExhaustWK:0,exhaustToCoolantWK:0,coolantToAmbientWK:0,
  oilToAmbientWK:0,exhaustToAmbientWK:0,coolantMassFlowKgs:0,oilMassFlowKgs:0}});
 const car=new Powertrain(e,p),initial=car.getState().thermal.storedEnergyJ,dt=1/240;
 let gasRemoved=0,wallReceived=0;
 for(let i=0;i<160;i++){
  const before=car.getState(),s=car.step(dt,.8);
  const measuredGasHeat=-s.gasPath.exhaustHeatJ,measuredWallGain=s.thermal.storedEnergyJ-before.thermal.storedEnergyJ;
  close(s.thermal.exhaustGasToWallHeatW*dt,measuredGasHeat,1e-9);
  assert.ok(Math.abs(measuredWallGain-measuredGasHeat)<1e-7);
  gasRemoved+=measuredGasHeat;wallReceived+=measuredWallGain;
 }
 assert.ok(gasRemoved>0,'a complete short flow window must transfer some hot exhaust energy');
 assert.ok(Math.abs(gasRemoved-wallReceived)<1e-6);
 assert.ok(Math.abs(car.getState().thermal.storedEnergyJ-initial-gasRemoved)<1e-6);
});


test('all original presets have finite cycle and shared-audio integration at three representative operating points',()=>{
 assert.equal(presets.length,11);
 for(const preset of presets){
  const e=preset.config,p=normalizePhysicalConfig(e),car=new Powertrain(e,p),dsp=new EngineDSP(24000,e);
  for(const [rpm,throttle] of [[e.idleRpm,.1],[(e.idleRpm+e.redline)/2,.75],[e.redline*.98,1]]){
   const point=evaluateEngine(e,p,rpm,throttle);
   for(const value of Object.values(point.cycle))assert.ok(Number.isFinite(value),`${preset.id} cycle at${rpm}`);
   assert.ok(point.airMassFlowKgs>=0&&point.fuelMassFlowKgs>=0);
   car.reset({rpm});const state=car.step(1/240,throttle);
   for(const [key,value] of Object.entries(state.physical))if(typeof value==='number')assert.ok(Number.isFinite(value),`${preset.id}/${key}`);
   assert.ok(state.physical.intakePressureBar>0&&state.physical.exhaustPressureBar>0&&state.physical.exhaustTemperatureK>0);
   dsp.setState({rpm:state.rpm,load:state.load,throttle:state.throttle,physical:state.physical},true);
   const left=new Float32Array(256),right=new Float32Array(256);dsp.process(left,right);
   assert.ok(left.every(Number.isFinite)&&right.every(Number.isFinite),`${preset.id} physical DSP at${rpm}`);
  }
 }
});

test('classic V12 idle cycle uses a resolved internal step independent of plot sampling',t=>{
 const engine=presets.find(p=>p.id==='v12-classic')!.config,physical=normalizePhysicalConfig(engine);
 const fitted=getCylinderCycle(engine,physical,engine.idleRpm,.2),base=fitted.config;
 const coarse=solveCylinderCycle({...base,stepDeg:2}),densePlot=solveCylinderCycle({...base,stepDeg:1}),finer=solveCylinderCycle({...base,stepDeg:.5});
 assert.ok(coarse.steps>=2880);assert.equal(coarse.steps,densePlot.steps);
 for(const key of ['netWorkJ','peakPressurePa','exhaustTemperatureK','freshChargeMassKg','exhaustMassKg'] as const)close(coarse[key],densePlot[key],1e-12);
 assert.ok(finer.steps>=coarse.steps*2);
 assert.ok(finer.netWorkJ>0&&Number.isFinite(finer.exhaustTemperatureK));
 // A sanity envelope for this fixture, not an absolute accuracy certificate.
 assert.ok(Math.abs(finer.netWorkJ-coarse.netWorkJ)/Math.abs(finer.netWorkJ)<.002);
 assert.ok(Math.abs(finer.peakPressurePa-coarse.peakPressurePa)/finer.peakPressurePa<.002);
 assert.ok(Math.abs(finer.exhaustTemperatureK-coarse.exhaustTemperatureK)<15);
 t.diagnostic(JSON.stringify({condition:'original classic V12 / 760rpm / 20% throttle',internalQuarterDegree:{steps:coarse.steps,workJ:coarse.netWorkJ,peakPa:coarse.peakPressurePa,exhaustK:coarse.exhaustTemperatureK},internalEighthDegree:{steps:finer.steps,workJ:finer.netWorkJ,peakPa:finer.peakPressurePa,exhaustK:finer.exhaustTemperatureK}}));
});

test('TS reference preserves model-3 options and the backend refuses to run legacy physics in their place',async()=>{
	const {isReferenceEcuBlocked,getBackendName}=await import('./backend.ts');
	const legacy=normalizePhysicalConfig(defaultConfig,{});
	const nasa=normalizePhysicalConfig(defaultConfig,{propertyModel:'nasa7-fixed-composition',sparkToSocDeg:6,intakeCamRetardDeg:12});
	assert.equal(getBackendName(),'typescript');
	assert.equal(legacy.propertyModel,'air-standard');
	assert.ok(nasa.propertyModel==='nasa7-fixed-composition'&&nasa.sparkToSocDeg===6&&nasa.intakeCamRetardDeg===12);
	assert.equal(isReferenceEcuBlocked(legacy),false);
	assert.equal(isReferenceEcuBlocked(nasa),true);
	assert.equal(isReferenceEcuBlocked({...legacy,heatTransferMultiplier:2}),false,'multiplier only acts with Woschni');
	assert.equal(isReferenceEcuBlocked({...legacy,airflowModel:'valve-geometry'}),true);
});
