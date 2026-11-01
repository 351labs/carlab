import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { loadEngineLab } from './api/dist/index.js';
import { presets,defaultConfig,normalizeConfig } from './presets.ts';
import { normalizeCylinderCycleConfig,solveCylinderCycle } from './cylinder-cycle.ts';
import { normalizePhysicalConfig,evaluateEngine,Powertrain } from './powertrain.ts';
import { EngineDSP } from './dsp.ts';
import { screenMaterial } from './materials.ts';
import { DERIVED_ABSOLUTE_FLOORS,DYNAMIC_ABSOLUTE_FLOORS,fieldAbsoluteFloor } from './parity-policy.mjs';

const wasmPath=new URL('./native/dist/carlab_engine_lab.wasm',import.meta.url);
const binary=new URL('./native/dist/carlab-engine',import.meta.url);
const core=await loadEngineLab({wasm:new Uint8Array(await readFile(wasmPath))});
function close(actual,expected,path='root',relative=2e-7,absolute=1e-10,floors){
 if(typeof expected==='number'){
  assert.equal(typeof actual,'number',`${path} numeric type`);assert.ok(Number.isFinite(actual),`${path} finite`);
  assert.ok(Math.abs(actual-expected)<=fieldAbsoluteFloor(path,floors,absolute)+relative*Math.max(Math.abs(actual),Math.abs(expected)),`${path}: ${actual} != ${expected}`);return;
 }
 if(Array.isArray(expected)){assert.ok(Array.isArray(actual),`${path} array`);assert.equal(actual.length,expected.length,`${path} length`);expected.forEach((v,i)=>close(actual[i],v,`${path}[${i}]`,relative,absolute,floors));return;}
 if(expected&&typeof expected==='object'){assert.ok(actual&&typeof actual==='object',`${path} object`);for(const [key,value]of Object.entries(expected))if(value!==undefined)close(actual[key],value,`${path}.${key}`,relative,absolute,floors);return;}
 assert.equal(actual,expected,path);
}
function rmsError(a,b){let square=0,maximum=0;for(let i=0;i<a.length;i++){const e=a[i]-b[i];square+=e*e;maximum=Math.max(maximum,Math.abs(e));}return {rms:Math.sqrt(square/a.length),maximum};}

test('Rust/WASM normalization preserves all eleven original instruments and nested physics assumptions',()=>{
 for(const preset of presets){const engine=normalizeConfig(preset.config);close(core.normalizeConfig(engine),engine,preset.id);close(core.normalizePhysicalConfig(engine),normalizePhysicalConfig(engine),`${preset.id}.physical`);}
 assert.equal(core.request('version',{apiVersion:99}).apiVersion,1,'typed client always sends its supported API version');
});
test('Rust/WASM full pressure, flow, heat and work traces agree with the TypeScript oracle',()=>{
 for(const patch of [{},{rpm:1700,variableHeatCapacity:true,wallTemperatureK:390},{rpm:6000,exhaustPressurePa:180000,intakePressurePa:140000},{fuelMassKg:0,rpm:3400}]){
  const config=normalizeCylinderCycleConfig(patch),reference=solveCylinderCycle(config),rust=core.solveCylinderCycle(config);
  close(rust,reference,`cycle.${JSON.stringify(patch)}`);
 }
});
test('Rust/WASM cycle-derived torque and fuel estimates agree for V2, I4, turbo and V12',()=>{
 for(const index of presets.keys()){const engine=presets[index].config,physical=normalizePhysicalConfig(engine);for(const [rpm,throttle]of [[engine.idleRpm,.2],[3000,.7],[engine.redline*.95,1]])close(core.evaluateEngine(engine,physical,rpm,throttle),evaluateEngine(engine,physical,rpm,throttle),`${presets[index].id}.${rpm}`,5e-7,1e-9,DERIVED_ABSOLUTE_FLOORS);}
});
test('Rust/WASM fixed-step driveline, reservoirs, shared variation and thermal state agree with TypeScript',()=>{
 const engine=defaultConfig,physical=normalizePhysicalConfig(engine),reference=new Powertrain(engine,physical),rust=core.createPowertrain(engine,physical);
 try{for(let step=0;step<480;step++){const throttle=step<180?.65:step<320?.1:.9,gear=step<240?1:2;const a=rust.step(1/240,throttle,0,gear),b=reference.step(1/240,throttle,0,gear);if(step%20===0||step===479)for(const key of ['rpm','speedMs','torqueNm','powerKw','physical','thermal','gasPath','quantitativelyValid'])close(a[key],b[key],`dynamic.${step}.${key}`,2e-5,1e-7,DYNAMIC_ABSOLUTE_FLOORS);}
  close(rust.step(0,.5),rust.getState(),'zero-step',0,0);
 }finally{rust.dispose();}
});
test('Rust/WASM full DSP PCM and event clocks agree with the TypeScript oracle',()=>{
 for(const index of [1,2,8]){const engine=presets[index].config,reference=new EngineDSP(48000,engine),rust=core.createSynth(engine,48000),a=new Float32Array(128),b=new Float32Array(128),l=new Float32Array(128),r=new Float32Array(128);let squared=0,count=0,max=0;
  try{reference.trigger('start');rust.trigger('start');for(let block=0;block<375;block++){const state={rpm:block<190?2800:4200,load:block<190?.55:.82,throttle:.7};reference.setState(state,true);rust.setState(state,true);reference.process(a,b);rust.processStereo(l,r);for(const [x,y]of [[a,l],[b,r]]){const error=rmsError(x,y);squared+=error.rms**2*x.length;count+=x.length;max=Math.max(max,error.maximum);}}
   assert.ok(Math.sqrt(squared/count)<1e-6,`${presets[index].id} PCM RMS error`);assert.ok(max<1e-5,`${presets[index].id} PCM peak error ${max}`);const actual=rust.getTelemetry(),expected=reference.getTelemetry();for(const key of ['rpm','firingEvents','combustionEvents','cycle','limiter'])close(actual[key],expected[key],`dsp.${key}`,1e-8,1e-9);
  }finally{rust.dispose();}
 }
});
test('Rust/WASM physical PCM preserves shared combustion, gas transfer and fuel-cut transitions',()=>{
 const config=presets[8].config,reference=new EngineDSP(48000,config),rust=core.createSynth(config,48000),a=new Float32Array(128),b=new Float32Array(128),l=new Float32Array(128),r=new Float32Array(128);let squared=0,count=0,maximum=0;
 try{for(let block=0;block<375;block++){const physical={boostBar:block<220?.3:0,fuelCut:block>=240&&block<310,intakePressureBar:1.1,exhaustPressureBar:1.4,exhaustMassFlowKgs:.12,exhaustTemperatureK:750+block,cycleEnergyScale:1+.04*Math.sin(block*.03),burnDurationScale:1.05,combustionPhaseDeg:1.2,residualFraction:.08,cycleIndex:Math.floor(block/12)};const state={rpm:3200,load:.6,throttle:block>=240&&block<310?0:.7,physical};reference.setState(state,true);rust.setState(state,true);reference.process(a,b);rust.processStereo(l,r);for(const [x,y]of [[a,l],[b,r]]){const error=rmsError(x,y);squared+=error.rms**2*x.length;count+=x.length;maximum=Math.max(maximum,error.maximum);}}
 assert.ok(Math.sqrt(squared/count)<1e-6,`physical PCM RMS error ${Math.sqrt(squared/count)}`);assert.ok(maximum<1e-5,`physical PCM max error ${maximum}`);assert.equal(rust.getTelemetry().combustionEvents,reference.getTelemetry().combustionEvents);
 }finally{rust.dispose();}
});
test('Rust/WASM partial physical controls preserve config-derived gas temperature and explicit clearing',()=>{
 const config=normalizeConfig({...defaultConfig,temperature:900}),reference=new EngineDSP(48000,config),rust=core.createSynth(config,48000),left=new Float32Array(128),right=new Float32Array(128);
 try{for(const temperature of [900,500]){const next=normalizeConfig({...config,temperature});reference.setConfig(next);rust.setConfig(next);const reset={rpm:3000,load:.6,throttle:.6,physical:null};reference.setState(reset,true);rust.setState(reset,true);const patch={rpm:3000,load:.6,throttle:.6,physical:{boostBar:.2}};reference.setState(patch,true);rust.setState(patch,true);reference.process(left,right);rust.processStereo(left,right);close(rust.getTelemetry().physical,reference.getTelemetry().physical,`partial.${temperature}`,2e-7,1e-8);}}
 finally{rust.dispose();}
});
test('Rust/WASM nominal material loads and unsupported evidence status agree with TypeScript',()=>{
 const c=solveCylinderCycle(normalizeCylinderCycleConfig()),input={angleDeg:c.trace.angleDeg,pressurePa:c.trace.pressurePa,boreM:c.config.boreM,strokeM:c.config.strokeM,rodLengthM:c.config.rodLengthM,reciprocatingMassKg:.6,rpm:c.config.rpm};
 const cfg=normalizePhysicalConfig(defaultConfig).materialScreen;close(core.screenMaterial(input,cfg),screenMaterial(input,cfg),'material',2e-6,1e-8);
});
test('native CLI and WASM dispatch the same pressure-cycle and engine requests',()=>{
 const requests=[{op:'version'},{op:'cycle',config:normalizeCylinderCycleConfig({rpm:3100})},{op:'evaluate',engine:defaultConfig,physical:normalizePhysicalConfig(defaultConfig),rpm:3200,throttle:.7}];
 const result=spawnSync(binary.pathname,['request','--jsonl'],{input:requests.map(v=>JSON.stringify(v)).join('\n')+'\n',encoding:'utf8',maxBuffer:16*1024*1024});assert.equal(result.status,0,result.stderr);const lines=result.stdout.trim().split('\n').map(JSON.parse);assert.equal(lines.length,requests.length);
 for(let i=0;i<requests.length;i++){const response=lines[i];assert.equal(response.ok,true,JSON.stringify(response));const {op,...fields}=requests[i];close(response.result,core.request(op,fields),`native.${op}`,2e-7,1e-9);}
});

test.after(()=>core.dispose());
