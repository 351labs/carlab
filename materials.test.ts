import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMaterialScreenConfig,parseMaterialCard,screenMaterial,type MaterialCard,type MechanicalCycleInput } from './materials.ts';

const near=(a:number,b:number,tol=1e-9)=>assert.ok(Math.abs(a-b)<=tol*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const card=():MaterialCard=>({schema:1,name:'Fictitious test material',provenance:{kind:'assumed',source:'Synthetic unit-test fixture, not an alloy measurement',conditions:'Nominal axial stress only'},allowableStressMPa:[{temperatureK:293.15,value:100},{temperatureK:393.15,value:80}]});
const staticCycle=():MechanicalCycleInput=>({angleDeg:[0,360,720],pressurePa:[1_101_325,1_101_325,1_101_325],boreM:.1,strokeM:.1,rodLengthM:.3,reciprocatingMassKg:.5,rpm:0});
const inertiaCycle=():MechanicalCycleInput=>({...staticCycle(),angleDeg:[0,180,360,540,720],pressurePa:[101325,101325,101325,101325,101325],rpm:3000});

test('material import clones validated fields and rejects absent provenance, malformed tables and sparse arrays',()=>{
 const input=card(),parsed=parseMaterialCard(input);input.allowableStressMPa[0].value=1;
 assert.equal(parsed.allowableStressMPa[0].value,100);
 assert.throws(()=>parseMaterialCard({...card(),provenance:{kind:'measured',source:''}}));
 assert.throws(()=>parseMaterialCard({...card(),allowableStressMPa:[{temperatureK:300,value:NaN}]}));
 assert.throws(()=>parseMaterialCard({...card(),allowableStressMPa:[{temperatureK:300,value:1},{temperatureK:300,value:2}]}));
 assert.throws(()=>parseMaterialCard({...card(),allowableStressMPa:new Array(2)}));
 assert.equal(normalizeMaterialScreenConfig().material,null);
});

test('nominal stress preserves pressure-area-force units and remains not evaluated without material evidence',()=>{
 const result=screenMaterial(staticCycle(),{netSectionMm2:100,componentTemperatureK:343.15});
 near(result.trace.gasForceN[0],1e6*Math.PI*.1**2/4);
 near(result.peakCompressiveStressMPa,1e6*Math.PI*.1**2/4/100);
 assert.equal(result.peakTensileStressMPa,0);assert.equal(result.peakTensileAngleDeg,null);assert.equal(result.status,'not-evaluated');assert.equal(result.fatigue.status,'not-evaluated');assert.equal(result.fatigue.damageFraction,null);
});

test('pressure and inertia combine at the same crank angle instead of summing separate maxima',()=>{
 const cycle=inertiaCycle(),omega=cycle.rpm*2*Math.PI/60,r=cycle.strokeM/2,area=Math.PI*cycle.boreM**2/4;
 const tdcInertia=cycle.reciprocatingMassKg*r*omega**2*(1+r/cycle.rodLengthM);
 cycle.pressurePa=[101325+tdcInertia/area,101325,101325+tdcInertia/area,101325,101325+tdcInertia/area];
 const result=screenMaterial(cycle,{netSectionMm2:100});
 near(result.trace.rodCompressionForceN[0],0);
 const maximumRod=Math.max(...result.trace.rodCompressionForceN.map(Math.abs));
 const independentSum=Math.max(...result.trace.gasForceN.map(Math.abs))+Math.max(...result.trace.inertiaForceN.map(Math.abs));
 assert.ok(maximumRod<independentSum*.6);
 assert.throws(()=>screenMaterial({...cycle,rodLengthM:r}));
 assert.throws(()=>screenMaterial({...cycle,angleDeg:[0,180,180,540,720]}));
});

test('slider-crank inertia agrees with an independent finite difference of piston position',()=>{
 const angles=[0,30,90,130,180,225,360,540,720],cycle:MechanicalCycleInput={...inertiaCycle(),angleDeg:angles,pressurePa:angles.map(()=>101325),reciprocatingMassKg:1,rpm:60/(2*Math.PI)};
 const result=screenMaterial(cycle),r=cycle.strokeM/2,l=cycle.rodLengthM,h=1e-4;
 const position=(theta:number)=>r*(1-Math.cos(theta))+l-Math.sqrt(l*l-r*r*Math.sin(theta)**2);
 for(let i=0;i<angles.length;i++){
  const theta=angles[i]*Math.PI/180,second=(position(theta+h)-2*position(theta)+position(theta-h))/(h*h);
  near(result.trace.inertiaForceN[i],second,1e-6);
 }
});

test('allowable interpolation stays inside the supplied temperature domain and never fabricates an alloy limit',()=>{
 const input={material:card(),netSectionMm2:100,componentTemperatureK:343.15};
 const within=screenMaterial(staticCycle(),input);near(within.allowableStressMPa!,90);assert.equal(within.status,'within-card');
 const outside=screenMaterial(staticCycle(),{...input,componentTemperatureK:450});assert.equal(outside.status,'not-evaluated');assert.equal(outside.allowableStressMPa,null);
 const over=screenMaterial(staticCycle(),{...input,netSectionMm2:50});assert.equal(over.status,'exceeds-card');
});

test('fatigue interpolation is conditional on amplitude, temperature and stress ratio and records envelope-count assumptions',()=>{
 const cycle=inertiaCycle(),omega=cycle.rpm*2*Math.PI/60,r=cycle.strokeM/2,amplitude=cycle.reciprocatingMassKg*r*omega**2/100;
 const ratio=-(1-r/cycle.rodLengthM)/(1+r/cycle.rodLengthM),material=card();
 material.fatigueCurves=[{temperatureK:343.15,temperatureToleranceK:1,stressRatio:ratio,stressRatioTolerance:.001,conditions:'Synthetic constant-amplitude fixture at stated R and temperature',points:[{stressAmplitudeMPa:20,cycles:1e7},{stressAmplitudeMPa:40,cycles:1e5}]}];
 const input={material,netSectionMm2:100,componentTemperatureK:343.15,durationSeconds:60,cyclesPerEngineCycle:1};
 const result=screenMaterial(cycle,input),weight=Math.log(amplitude/20)/Math.log(40/20),expected=Math.exp(Math.log(1e7)+(Math.log(1e5)-Math.log(1e7))*weight);
 near(result.stressAmplitudeMPa,amplitude);near(result.stressRatio!,ratio);
 assert.equal(result.fatigue.status,'evaluated');near(result.fatigue.cyclesAtAmplitude!,expected);near(result.fatigue.appliedEnvelopeCycles,1500);near(result.fatigue.damageFraction!,1500/expected);
 assert.equal(screenMaterial(cycle,{...input,componentTemperatureK:350}).fatigue.status,'not-evaluated');
 assert.equal(screenMaterial(cycle,{...input,netSectionMm2:1000}).fatigue.status,'not-evaluated');
 const wrongRatio=structuredClone(material);wrongRatio.fatigueCurves![0].stressRatio=-1;
 assert.equal(screenMaterial(cycle,{...input,material:wrongRatio}).fatigue.status,'not-evaluated');
});

test('fatigue table validation rejects increasing life at increasing amplitude and nonfinite trace inputs',()=>{
 const material=card();material.fatigueCurves=[{temperatureK:300,temperatureToleranceK:0,stressRatio:-1,stressRatioTolerance:0,conditions:'Fixture',points:[{stressAmplitudeMPa:10,cycles:10},{stressAmplitudeMPa:20,cycles:20}]}];
 assert.throws(()=>parseMaterialCard(material));
 assert.throws(()=>screenMaterial({...staticCycle(),pressurePa:[101325,NaN,101325]}));
 assert.throws(()=>screenMaterial({...staticCycle(),rpm:Infinity}));
});
