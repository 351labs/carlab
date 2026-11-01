import test from 'node:test';
import assert from 'node:assert/strict';
import { compressibleOrificeFlow, exhaustPressureLoss, GasPath, IdealGasReservoir, normalizeGasPathConfig } from './gas-path.ts';

const close=(a:number,b:number,tolerance=1e-10)=>assert.ok(Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(b)),`${a} != ${b}`);

test('fixed-volume gas inventory satisfies ideal gas and accounts for inflow enthalpy',()=>{
	const r=new IdealGasReservoir(.004,101325,300,1.4,287.05),before=r.getState();
	close(before.pressurePa*before.volumeM3,before.massKg*287.05*before.temperatureK);
	const balance=r.advance(.01,[{massFlowKgs:.01,temperatureK:350}],.002,50),after=r.getState();
	close(after.massKg-before.massKg,.00008);
	close(after.internalEnergyJ-before.internalEnergyJ,balance.energyInJ-balance.energyOutJ+balance.heatJ);
	close(balance.energyInJ,.0001*(287.05/(1.4-1)+287.05)*350);
	assert.ok(Math.abs(balance.massResidualKg)<1e-16);assert.ok(Math.abs(balance.energyResidualJ)<1e-12);
	assert.equal(balance.limitedOutflowKg,0);assert.equal(balance.limitedCoolingJ,0);
});

test('closed inventory retains mass/energy; positivity guards report numerical flow/cooling limits',()=>{
	const r=new IdealGasReservoir(.001,100000,300),before=r.getState();
	r.advance(.1,[],0);assert.deepEqual(r.getState(),before);
	const limited=r.advance(.1,[],100,-1e12),after=r.getState();
	assert.ok(limited.limitedOutflowKg>0&&limited.limitedCoolingJ>0);
	assert.ok(after.massKg>0&&after.internalEnergyJ>0&&Number.isFinite(after.pressurePa));
	assert.ok(Math.abs(limited.energyResidualJ)<1e-9);
	assert.throws(()=>r.advance(-1,[],0));assert.throws(()=>new IdealGasReservoir(0,1e5,300));
	assert.throws(()=>new IdealGasReservoir(.001,1e5,300,6));
	assert.throws(()=>new IdealGasReservoir(1e308,1e300,300));
});

test('compressible orifice reverses with upstream temperature and reaches a choked plateau',()=>{
	const a=compressibleOrificeFlow(200000,400,100000,300,.0005,.7,1.4);
	const reverse=compressibleOrificeFlow(100000,300,200000,400,.0005,.7,1.4);
	close(a,-reverse);assert.ok(a>0);
	const lower=compressibleOrificeFlow(200000,400,10000,300,.0005,.7,1.4);
	close(a,lower);
	const subcritical=compressibleOrificeFlow(200000,400,180000,300,.0005,.7,1.4);
	assert.ok(subcritical<a);
	close(compressibleOrificeFlow(200000,800,10000,300,.0005,.7,1.4),a/Math.sqrt(2));
	assert.equal(compressibleOrificeFlow(1e5,300,1e5,500,.1,.8),0);
	assert.throws(()=>compressibleOrificeFlow(0,300,1e5,300,.001,.8));
});

test('mean exhaust pressure loss scales with mass-flow square and independent geometry',()=>{
	const loss=exhaustPressureLoss(.04,.7,.06,2,3,.025);
	close(exhaustPressureLoss(.08,.7,.06,2,3,.025),loss*4);
	close(exhaustPressureLoss(-.04,.7,.06,2,3,.025),-loss);
	assert.ok(exhaustPressureLoss(.04,.7,.045,2,3,.025)>loss);
	assert.ok(exhaustPressureLoss(.04,.7,.06,2,8,.025)>loss);
});

test('opening a throttle fills a depleted manifold and retains an actual pressure transient',()=>{
	const c=normalizeGasPathConfig({intakeVolumeM3:.006}),path=new GasPath(c);
	path.reset({intakePressurePa:40000,intakeTemperatureK:300});
	const initial=path.getState().intake.pressurePa;
	const first=path.step(.001,{rpm:2500,throttle:1,engineDisplacementM3:.002,volumetricEfficiency:.85});
	assert.ok(first.intake.pressurePa>initial&&first.intake.pressurePa<c.ambientPressurePa);
	for(let i=0;i<80;i++)path.step(.01,{rpm:2500,throttle:1,engineDisplacementM3:.002,volumetricEfficiency:.85});
	const open=path.getState();
	for(let i=0;i<80;i++)path.step(.01,{rpm:2500,throttle:0,engineDisplacementM3:.002,volumetricEfficiency:.85});
	const closed=path.getState();
	assert.ok(open.intake.pressurePa>closed.intake.pressurePa*1.5);
	assert.ok(open.cylinderAirMassFlowKgs>closed.cylinderAirMassFlowKgs);
	assert.ok(Math.abs(closed.massBalanceResidualKg)<1e-14&&Math.abs(closed.energyBalanceResidualJ)<1e-8);
});

test('exhaust restriction raises stored exhaust pressure and flows conserve gas-path inventories',()=>{
	const open=new GasPath({exhaustMinorK:.5}),restricted=new GasPath({exhaustMinorK:20});
	for(let i=0;i<120;i++){
		const input={rpm:4000,throttle:.8,engineDisplacementM3:.003,volumetricEfficiency:.9,fuelMassFlowKgs:.002,exhaustTemperatureK:950};
		open.step(.01,input);restricted.step(.01,input);
	}
	const a=open.getState(),b=restricted.getState();
	assert.ok(b.exhaust.pressurePa>a.exhaust.pressurePa);
	assert.ok(b.exhaustPressureLossPa>a.exhaustPressureLossPa);
	for(const state of [a,b]){
		assert.ok(Number.isFinite(state.intake.temperatureK)&&state.exhaust.temperatureK>300);
		close(state.cylinderExhaustMassFlowKgs,state.cylinderAirMassFlowKgs+state.fuelMassFlowKgs);
		assert.ok(Math.abs(state.massBalanceResidualKg)<1e-13&&Math.abs(state.energyBalanceResidualJ)<1e-8);
	}
});

test('same external turbo supply drives identical deterministic gas paths without another lag state',()=>{
	const a=new GasPath(),b=new GasPath();
	for(let i=0;i<100;i++){
		const input={rpm:3000,throttle:.7,engineDisplacementM3:.002,volumetricEfficiency:.9,compressorPressurePa:150000,compressorTemperatureK:335};
		assert.deepEqual(a.step(.005,input),b.step(.005,input));
	}
	assert.ok(a.getState().intake.pressurePa>101325);
	const before=a.getState();assert.deepEqual(a.step(NaN,{rpm:0,throttle:0,engineDisplacementM3:.002,volumetricEfficiency:.9}),before);
});
