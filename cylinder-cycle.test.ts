import assert from 'node:assert/strict';
import test from 'node:test';
import { cylinderVolume,compressibleOrificeFlow,normalizeCylinderCycleConfig,solveCylinderCycle,valveEffectiveArea } from './cylinder-cycle.ts';

const relative=(a:number,b:number)=>Math.abs(a-b)/Math.max(1e-12,Math.abs(b));

test('slider-crank geometry preserves swept volume, compression and720degree closure',()=>{
 const c=normalizeCylinderCycleConfig(),tdc=cylinderVolume(c,0),bdc=cylinderVolume(c,180),swept=Math.PI*c.boreM**2/4*c.strokeM;
 assert.ok(relative(bdc-tdc,swept)<1e-12);assert.ok(relative(bdc/tdc,c.compressionRatio)<1e-12);
 assert.equal(cylinderVolume(c,360),tdc);assert.equal(cylinderVolume(c,720),tdc);
 assert.ok(relative(cylinderVolume(c,90),cylinderVolume(c,630))<1e-12);
});

test('signed compressible valve flow reverses consistently and chokes continuously',()=>{
 const area=.0001,cd=.7,gamma=1.33,critical=(2/(gamma+1))**(gamma/(gamma-1));
 assert.equal(compressibleOrificeFlow(1e5,300,1e5,600,area,cd),0);
 const a=compressibleOrificeFlow(2e5,350,1e5,500,area,cd);
 assert.ok(a>0);assert.equal(compressibleOrificeFlow(1e5,500,2e5,350,area,cd),-a);
 const deep=compressibleOrificeFlow(2e5,350,10000,500,area,cd,gamma);
 assert.equal(deep,compressibleOrificeFlow(2e5,350,20000,500,area,cd,gamma));
 assert.ok(relative(deep,compressibleOrificeFlow(2e5,350,2e5*critical*(1+1e-6),500,area,cd,gamma))<1e-8);
 assert.equal(compressibleOrificeFlow(2e5,350,1e5,300,0,cd),0);
 assert.throws(()=>compressibleOrificeFlow(-1,300,1e5,300,area,cd));
});

test('valve curtain area handles wraparound, smooth closure and seat-area cap',()=>{
 assert.equal(valveEffectiveArea(710,710,220,.032,.009,2),0);
 assert.equal(valveEffectiveArea(220,710,220,.032,.009,2),0);
 assert.equal(valveEffectiveArea(400,710,220,.032,.009,2),0);
 assert.ok(valveEffectiveArea(0,710,220,.032,.009,2)>0);
 assert.ok(valveEffectiveArea(100,710,220,.032,.009,2)<=2*Math.PI*.032**2/4);
});

test('closed motored cylinder follows the adiabatic invariant without mass or heat sources',()=>{
 const c=normalizeCylinderCycleConfig({intakeValveLiftM:0,exhaustValveLiftM:0,fuelMassKg:0,heatTransferWm2K:0,initialPressurePa:1e5,initialTemperatureK:315,settlingCycles:0,stepDeg:1});
 const r=solveCylinderCycle(c),invariant=r.trace.pressurePa[0]*r.trace.volumeM3[0]**c.gamma;
 for(let i=0;i<r.trace.angleDeg.length;i++){
  assert.ok(relative(r.trace.pressurePa[i]*r.trace.volumeM3[i]**c.gamma,invariant)<.0001);
  assert.equal(r.trace.massKg[i],r.initialMassKg);
 }
 assert.equal(r.releasedHeatJ,0);assert.equal(r.wallHeatLossJ,0);
 assert.ok(Math.abs(r.netWorkJ)<.01);assert.ok(Math.abs(r.energyBalanceResidualJ)<1e-10);
});

test('full720degree cycle closes numerical mass/energy budgets with finite heat and pumping',()=>{
 const r=solveCylinderCycle();
 assert.equal(r.trace.angleDeg[0],0);assert.equal(r.trace.angleDeg.at(-1),720);assert.equal(r.trace.angleDeg.length,361);
 assert.ok(r.freshChargeMassKg>0&&r.fuelMassKg>0&&r.exhaustMassKg>0);
 assert.ok(r.netWorkJ>0&&r.peakPressurePa>5e5&&r.peakTemperatureK>800);
 assert.ok(relative(r.releasedHeatJ,r.fuelEnergyJ*r.config.combustionEfficiency)<1e-10);
 assert.ok(Math.abs(r.massBalanceResidualKg)<1e-12);assert.ok(Math.abs(r.energyBalanceResidualJ)<1e-8);
 assert.ok(relative(r.grossWorkJ+r.pumpingWorkJ,r.netWorkJ)<1e-12);
 assert.ok(relative(r.imepPa,r.netWorkJ/(Math.PI*r.config.boreM**2/4*r.config.strokeM))<1e-12);
 assert.ok(r.residualFractionAtIvc>=0&&r.residualFractionAtIvc<1);
 assert.ok(r.periodicMassRelativeError<.02&&r.periodicEnergyRelativeError<.02);
 for(let i=0;i<r.trace.angleDeg.length;i++)assert.ok(relative(r.trace.pressurePa[i]*r.trace.volumeM3[i],r.trace.massKg[i]*287.05*r.trace.temperatureK[i])<1e-12);
});

test('wall heat transfer reduces finite-burn peak temperature and delivered work at fixed fuel',()=>{
 const input={fuelMassKg:.000025,wallTemperatureK:400},adiabatic=solveCylinderCycle({...input,heatTransferWm2K:0}),cooled=solveCylinderCycle({...input,heatTransferWm2K:350});
 assert.ok(cooled.wallHeatLossJ>0);assert.equal(adiabatic.wallHeatLossJ,0);
 assert.ok(cooled.peakTemperatureK<adiabatic.peakTemperatureK);
 assert.ok(cooled.netWorkJ<adiabatic.netWorkJ);
 assert.ok(relative(cooled.releasedHeatJ,adiabatic.releasedHeatJ)<1e-12);
});

test('combustion phasing changes pressure/work and has orderedfinite burn quantiles',()=>{
 const early=solveCylinderCycle({fuelMassKg:.00003,sparkAdvanceDeg:18}),late=solveCylinderCycle({fuelMassKg:.00003,sparkAdvanceDeg:-15});
 assert.ok(early.ca10Deg<early.ca50Deg&&early.ca50Deg<early.ca90Deg);
 assert.ok(early.ca10Deg>=342&&early.ca90Deg<=392);
 assert.ok(late.ca50Deg>early.ca50Deg+30);
 assert.ok(late.netWorkJ<early.netWorkJ);assert.ok(late.peakPressurePa<early.peakPressurePa);
 assert.ok(late.peakPressureAngleDeg>early.peakPressureAngleDeg);
});

test('step refinement preserves the predicted cycle and explicit property approximation conserves energy',()=>{
 const coarse=solveCylinderCycle({stepDeg:2}),fine=solveCylinderCycle({stepDeg:.25});
 assert.ok(relative(coarse.netWorkJ,fine.netWorkJ)<.01);assert.ok(relative(coarse.peakPressurePa,fine.peakPressurePa)<.01);
 const variable=solveCylinderCycle({variableHeatCapacity:true});
 assert.ok(variable.trace.temperatureK.every(Number.isFinite));assert.ok(Math.abs(variable.energyBalanceResidualJ)<1e-8);
 assert.ok(variable.warnings.some(w=>w.includes('linear air approximation')));
});

test('independent trace quadrature reproduces net work and open-system energy change',()=>{
 const r=solveCylinderCycle({stepDeg:.5}),c=r.config,tr=r.trace,cv=287.05/(c.gamma-1),cp=cv+287.05;
 let work=0,wall=0,incoming=0,outgoing=0,massChange=0;
 for(let i=1;i<tr.angleDeg.length;i++){
  const dAngle=tr.angleDeg[i]-tr.angleDeg[i-1],dt=dAngle/(6*c.rpm),p=(tr.pressurePa[i]+tr.pressurePa[i-1])/2,t=(tr.temperatureK[i]+tr.temperatureK[i-1])/2;
  const volume=(tr.volumeM3[i]+tr.volumeM3[i-1])/2,area=2*Math.PI*c.boreM**2/4+Math.PI*c.boreM*volume/(Math.PI*c.boreM**2/4);
  work+=p*(tr.volumeM3[i]-tr.volumeM3[i-1]);wall+=c.heatTransferWm2K*area*(t-c.wallTemperatureK)*dt;
  const fi=(tr.intakeFlowKgs[i]+tr.intakeFlowKgs[i-1])/2,fe=(tr.exhaustFlowKgs[i]+tr.exhaustFlowKgs[i-1])/2;
  incoming+=((fi>0?fi*cp*c.intakeTemperatureK:0)+(fe<0?-fe*cp*c.exhaustTemperatureK:0))*dt;
  outgoing+=((fi<0?-fi*cp*t:0)+(fe>0?fe*cp*t:0))*dt;massChange+=(fi-fe)*dt;
 }
 assert.ok(relative(work,r.netWorkJ)<.002);
 const deltaU=cv*(tr.massKg.at(-1)!*tr.temperatureK.at(-1)!-tr.massKg[0]*tr.temperatureK[0]);
 assert.ok(Math.abs(deltaU-(r.releasedHeatJ-wall-work+incoming-outgoing))<.003*(r.releasedHeatJ+incoming));
 assert.ok(Math.abs((tr.massKg.at(-1)!-tr.massKg[0])-massChange)<r.airMassKg*.002);
});

test('fuel cut is a heat-free pumping cycle and elevated exhaust pressure raises pumping loss',()=>{
 const normal=solveCylinderCycle({fuelMassKg:0,exhaustPressurePa:106000}),restricted=solveCylinderCycle({fuelMassKg:0,exhaustPressurePa:180000});
 assert.equal(normal.releasedHeatJ,0);assert.equal(restricted.releasedHeatJ,0);
 assert.ok(normal.netWorkJ<0);assert.ok(restricted.pumpingWorkJ<normal.pumpingWorkJ);
 assert.ok(Math.abs(restricted.massBalanceResidualKg)<1e-12&&Math.abs(restricted.energyBalanceResidualJ)<1e-8);
});

test('normalization is finite, independent and declares unsettled/nonphysical modelling limits',()=>{
 const c=normalizeCylinderCycleConfig({boreM:NaN,rpm:Infinity,compressionRatio:99,rodLengthM:0,dischargeCoefficient:-1,stepDeg:0});
 assert.ok(Number.isFinite(c.boreM)&&Number.isFinite(c.rpm));assert.equal(c.compressionRatio,18);assert.equal(c.dischargeCoefficient,0);
 assert.ok(c.rodLengthM>c.strokeM/2);assert.ok(c.stepDeg>=.125);
 const unsettled=solveCylinderCycle({settlingCycles:0,initialPressurePa:500000});
 assert.ok(unsettled.warnings.some(w=>w.includes('not settled')));
 const a=solveCylinderCycle({stepDeg:4}),b=solveCylinderCycle({stepDeg:4});assert.deepEqual(a,b);
});

test('explicit zero combustion retains supplied fuel energy but releases no heat',()=>{
 const cycle=solveCylinderCycle({fuelMassKg:.00004,combustionEfficiency:0});assert.equal(cycle.fuelMassKg,.00004);assert.ok(cycle.fuelEnergyJ>0);assert.equal(cycle.releasedHeatJ,0);assert.ok(Math.abs(cycle.energyBalanceResidualJ)<1e-7);
});
test('optional oxygen cap acts at actual IVC charge and preserves excess fuel accounting',()=>{
 const a=solveCylinderCycle({fuelMassKg:.0002,oxygenLimitAfr:14.7}),b=solveCylinderCycle({fuelMassKg:.0004,oxygenLimitAfr:14.7});
 assert.equal(a.netWorkJ,b.netWorkJ);assert.equal(a.releasedHeatJ,b.releasedHeatJ);assert.equal(a.peakPressurePa,b.peakPressurePa);assert.equal(b.fuelMassKg,a.fuelMassKg*2);assert.equal(b.fuelEnergyJ,a.fuelEnergyJ*2);assert.ok(Math.abs(a.oxygenLimitedFuelMassKg!-a.freshChargeMassKg/14.7)<1e-12);assert.ok(b.oxygenUnburnedFuelMassKg!>a.oxygenUnburnedFuelMassKg!);assert.ok(Math.abs(b.energyBalanceResidualJ)<1e-7);
});

test('prescribed DI heat follows actual cumulative single-main delivery and causal quantiles',()=>{
 const cfg={fuelMassKg:.00003,combustionStartDeg:350,burnDurationDeg:20,fuelDeliveryStartDeg:345,fuelDeliveryDurationDeg:80},c=solveCylinderCycle(cfg);
 for(let i=0;i<c.trace.angleDeg.length;i++){const angle=c.trace.angleDeg[i],heat=c.trace.heatReleaseJ[i],delivered=Math.max(0,Math.min(1,(angle-345)/80));if(angle<=345)assert.equal(heat,0);assert.ok(heat<=c.fuelEnergyJ*c.config.combustionEfficiency*delivered+1e-8);}
 assert.ok(Math.abs(c.ca50Deg-385)<1e-8);assert.ok(Math.abs(c.ca90Deg-417)<1e-8);assert.ok(Math.abs(c.energyBalanceResidualJ)<1e-7);
 assert.throws(()=>normalizeCylinderCycleConfig({fuelDeliveryStartDeg:345}));
});
