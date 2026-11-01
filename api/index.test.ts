import test from 'node:test';
import assert from 'node:assert/strict';
import {EngineLab,EngineLabError,MAX_AUDIO_BLOCK_FRAMES,MAX_CONTROL_REQUEST_BYTES,loadEngineLab} from './index.ts';
import type {EcuConfig,EcuMap,EcuFuelObservation} from './types.ts';
import {normalizePhysicalConfig} from '../powertrain.ts';
import {defaultConfig} from '../presets.ts';

/** Boundary fixture, not a replacement for root's real native/WASM parity gate. */
function fixture(){
 const memory=new WebAssembly.Memory({initial:2});
 const encoder=new TextEncoder(),decoder=new TextDecoder();
 const calls:Record<string,unknown>[]=[],freed:{pointer:number;length:number}[]=[];
 let responseLength=0,nextHandle=1,growOnAudio=false,badEnvelope:unknown,audioLength=0,audioError=false;
 const exports={memory,
  engine_lab_alloc(length:number){return length>MAX_CONTROL_REQUEST_BYTES?0:64;},
  engine_lab_free(pointer:number,length:number){freed.push({pointer,length});},
  engine_lab_request(pointer:number,length:number){
   const request=JSON.parse(decoder.decode(new Uint8Array(memory.buffer,pointer,length)));calls.push(request);
   let envelope:unknown;
   if(badEnvelope!==undefined)envelope=badEnvelope;
   else if(request.op==='fail')envelope={apiVersion:1,ok:false,error:'Explicit model domain error'};
   else{
    let result:unknown=null;
    if(request.op==='version')result={apiVersion:1,modelVersion:'fixture',backend:'rust',audioLayout:'planar-f32',maxAudioFrames:MAX_AUDIO_BLOCK_FRAMES};
    else if(request.op==='createPowertrain'||request.op==='createDsp'||request.op==='createEcu')result={handle:nextHandle++};
    else if(request.op==='echo')result=request.value;
    else if(request.op==='stepPowertrainMany')result={steps:request.steps};
    else if(['stepEcu','stepEcuMany','getEcuState','setEcuConfig','setEcuConfigAndReset','resetEcu'].includes(request.op))result={mode:'boundary-fixture',enabled:true};
    envelope={apiVersion:1,ok:true,result};
   }
   const bytes=encoder.encode(JSON.stringify(envelope));responseLength=bytes.length;
   new Uint8Array(memory.buffer,32768,bytes.length).set(bytes);return 32768;
  },
  engine_lab_result_len(){return responseLength;},
  engine_lab_dsp_process(_handle:number,frames:number){
   if(audioError){audioLength=0;return 0;}
   if(growOnAudio){memory.grow(1);growOnAudio=false;}
   audioLength=frames*2;const out=new Float32Array(memory.buffer,65536,audioLength);
   for(let i=0;i<frames;i++){out[i]=i+.25;out[frames+i]=-i-.25;}return 65536;
  },
  engine_lab_audio_len(){return audioLength;},
 };
 const core=new EngineLab({exports} as unknown as WebAssembly.Instance);
 return {core,memory,calls,freed,growAudio(){growOnAudio=true;},badEnvelope(value:unknown){badEnvelope=value;},badAudio(){audioError=true;}};
}
test('control boundary copies borrowed results, forwards API version, preserves Unicode and frees each request',()=>{
 const f=fixture(),before=f.freed.length;
 const first=f.core.request<{name:string}>('echo',{value:{name:'Combustão / 東京 / 🏎️'}});
 assert.deepEqual(first,{name:'Combustão / 東京 / 🏎️'});
 f.core.request('echo',{value:{name:'another borrowed response'}});
 assert.equal(first.name,'Combustão / 東京 / 🏎️');assert.equal(f.freed.length,before+2);
 assert.equal(f.calls.at(-1)!.apiVersion,1);
 assert.deepEqual(f.core.request('echo',{value:new Float64Array([1,2,3])}),[1,2,3]);
 const beforeBad=f.freed.length;assert.throws(()=>f.core.request('fail'),error=>error instanceof EngineLabError&&error.operation==='fail'&&error.message==='Explicit model domain error');assert.equal(f.freed.length,beforeBad+1);
 assert.throws(()=>f.core.request('echo',{value:NaN}),/finite/);
 assert.throws(()=>f.core.request('echo',{value:1n}),/JSON-compatible/);
 assert.throws(()=>f.core.request('echo',{value:'x'.repeat(MAX_CONTROL_REQUEST_BYTES)}),/4,000,000/);
});
test('invalid response version or envelope throws and releases input ownership',()=>{
 const f=fixture(),before=f.freed.length;f.badEnvelope({apiVersion:2,ok:true,result:null});assert.throws(()=>f.core.request('echo'),/Unsupported engine API version/);
 f.badEnvelope(null);assert.throws(()=>f.core.request('echo'),/object envelope/);
 f.badEnvelope({apiVersion:1,ok:true});assert.throws(()=>f.core.request('echo'),/omitted its result/);
 assert.equal(f.freed.length,before+3);
});
test('audio blocks copy planar native buffers after memory growth and support caller-owned interleaving',()=>{
 const f=fixture(),synth=f.core.createSynth({},48000),left=new Float32Array(4),right=new Float32Array(4);
 f.growAudio();synth.processStereo(left,right);assert.deepEqual([...left],[.25,1.25,2.25,3.25]);assert.deepEqual([...right],[-.25,-1.25,-2.25,-3.25]);
 const interleaved=new Float32Array(8);synth.processInterleaved(interleaved);assert.deepEqual([...interleaved],[.25,-.25,1.25,-1.25,2.25,-2.25,3.25,-3.25]);
 assert.throws(()=>synth.processStereo(left,left),/overlap/);
 assert.throws(()=>synth.processInterleaved(new Float32Array(f.memory.buffer,65536,8)),/caller-owned/);
 assert.throws(()=>synth.processInterleaved(new Float32Array(3)),/even length/);
 assert.throws(()=>synth.processStereo(new Float32Array(MAX_AUDIO_BLOCK_FRAMES+1),new Float32Array(MAX_AUDIO_BLOCK_FRAMES+1)),/frames/);
 f.badAudio();assert.throws(()=>synth.processStereo(left,right),/Native audio processing failed/);
});
test('fixed batches cross control boundary once and disposed handles cannot execute',()=>{
 const f=fixture(),powertrain=f.core.createPowertrain({}),synth=f.core.createSynth({});
 const before=f.calls.length;const state=powertrain.stepMany({dt:1/240,steps:1000,throttle:.65});assert.equal((state as unknown as {steps:number}).steps,1000);assert.equal(f.calls.length,before+1);
 assert.throws(()=>powertrain.step(-1,.5),/dt/);assert.throws(()=>powertrain.stepMany({dt:1/240,steps:100001,throttle:.5}),/steps/);
 powertrain.dispose();powertrain.dispose();assert.throws(()=>powertrain.getState(),/disposed/);
 f.core.dispose();f.core.dispose();assert.equal(synth.disposed,true);assert.equal(f.calls.filter(c=>c.op==='destroy').length,2);assert.throws(()=>f.core.request('version'),/disposed/);
});
test('Encoding API fallback supports AudioWorklet globals without mutating them',()=>{
 const f=fixture(),encoder=globalThis.TextEncoder,decoder=globalThis.TextDecoder;
 try{
  Object.defineProperty(globalThis,'TextEncoder',{value:undefined,writable:true,configurable:true});Object.defineProperty(globalThis,'TextDecoder',{value:undefined,writable:true,configurable:true});
  assert.equal(f.core.request('echo',{value:'Óleo / 日本語 / 🏎️ / lone \ud800'}),'Óleo / 日本語 / 🏎️ / lone \ud800');
  assert.equal(globalThis.TextEncoder,undefined);assert.equal(globalThis.TextDecoder,undefined);
 }finally{Object.defineProperty(globalThis,'TextEncoder',{value:encoder,writable:true,configurable:true});Object.defineProperty(globalThis,'TextDecoder',{value:decoder,writable:true,configurable:true});}
});
test('portable URL loader reports HTTP failures before instantiation',async()=>{
 await assert.rejects(()=>loadEngineLab({wasm:'https://example.invalid/engine.wasm',fetcher:async()=>({ok:false,status:404,arrayBuffer:async()=>new ArrayBuffer(0)})}),/HTTP 404/);
});

test('EFI session keeps state in Rust, sends one batch request, and owns its native handle',()=>{
 const f=fixture(),ecu=f.core.createEcuSession({cylinders:4},{enabled:true,fuel:{ethanolVolumeFraction:.3}});
 assert.deepEqual(f.calls.at(-1)!.config,{enabled:true,fuel:{ethanolVolumeFraction:.3}});
 const input={rpm:3000,mapPressurePa:80000,actualAirMassFlowKgs:.04,batteryVoltageV:13.8};
 ecu.step(0,input);assert.equal(f.calls.at(-1)!.op,'stepEcu');
 const before=f.calls.length;const state=ecu.stepMany(1/240,1000,input);assert.equal(state.mode,'boundary-fixture');assert.equal(f.calls.length,before+1);assert.equal(f.calls.at(-1)!.op,'stepEcuMany');assert.deepEqual(f.calls.at(-1)!.input,input);
 ecu.setConfig({feedback:{enabled:false}});assert.equal(f.calls.at(-1)!.op,'setEcuConfig');assert.equal('engine' in f.calls.at(-1)!,false);
 ecu.reset();assert.equal(f.calls.at(-1)!.op,'resetEcu');ecu.getState();assert.equal(f.calls.at(-1)!.op,'getEcuState');
 assert.throws(()=>ecu.step(-1,input),/dt/);assert.throws(()=>ecu.stepMany(0,1,input),/dt/);assert.throws(()=>ecu.stepMany(.01,100001,input),/steps/);
 f.core.dispose();assert.equal(ecu.disposed,true);assert.equal(f.calls.filter(c=>c.op==='destroy').length,1);assert.throws(()=>ecu.getState(),/disposed/);
});
test('EFI helper, fit and search operations preserve calibration and evidence payloads',()=>{
 const f=fixture();const map:EcuMap<'fuelCorrection'>={schema:'carlab-ecu-map-1',kind:'fuelCorrection',rpm:[850,7200],pressureBar:[.1,2],values:[[1,1],[1,1]],axisUnits:{rpm:'rpm',pressure:'bar-absolute'},valueUnit:'multiplier',provenance:{source:'assumed',label:'Original boundary fixture',version:'fixture-1'},extrapolation:'clamp'};
 f.core.normalizeEcuMap(map,'fuelCorrection');assert.equal(f.calls.at(-1)!.op,'normalizeEcuMap');
 f.core.sampleEcuMap(map,3000,.8);assert.equal(f.calls.at(-1)!.mapPressureBar,.8);
 const observations:EcuFuelObservation[]=[{rpm:3000,mapBar:.8,observedLambda:1.05,steady:true,valid:true,captureSessionId:'heldout-B',split:'validation',closedLoopActive:true,appliedFuelMultiplier:1.02}];
 const options={source:{kind:'simulated' as const,label:'Original synthetic fixture',fingerprint:'fixture-1'},iterations:2};
 f.core.fitEcuFuelMap({}, {fuelCorrectionMap:map}, observations,options);
 assert.equal(f.calls.at(-1)!.op,'fitEcuFuelMap');assert.deepEqual(f.calls.at(-1)!.observations,observations);assert.deepEqual(f.calls.at(-1)!.options,options);assert.equal(map.values[0][0],1);
 f.core.searchEcuOperatingPoint({}, {},3000,.6,{budget:12,requiredEvidence:['knock']});assert.equal(f.calls.at(-1)!.op,'searchEcuOperatingPoint');assert.deepEqual(f.calls.at(-1)!.options,{budget:12,requiredEvidence:['knock']});
});
test('reference normalization preserves independent opaque EFI JSON and does not manufacture a controller',()=>{
 const metadata={enabled:true,fuel:{ethanolVolumeFraction:.3},lambdaTargetMap:{schema:'carlab-ecu-map-1',values:[[1,1],[1,1]]},provenance:{source:'assumed',label:'Original metadata fixture'}};
 const a=normalizePhysicalConfig(defaultConfig,{ecu:metadata as unknown as EcuConfig});
 assert.deepEqual(a.ecu,metadata);assert.notEqual(a.ecu,metadata);assert.notEqual(a.ecu!.fuel,metadata.fuel);
 (metadata.lambdaTargetMap.values[0])[0]=.8;assert.equal(a.ecu!.lambdaTargetMap.values[0][0],1);
 assert.equal('ecu' in normalizePhysicalConfig(defaultConfig),false);
 assert.throws(()=>normalizePhysicalConfig(defaultConfig,{ecu:{enabled:'true'} as unknown as EcuConfig}),/enabled/);
 assert.throws(()=>normalizePhysicalConfig(defaultConfig,{ecu:{enabled:true,value:NaN} as unknown as EcuConfig}),/finite/);
 assert.throws(()=>normalizePhysicalConfig(defaultConfig,{ecu:{enabled:true,values:[,1]} as unknown as EcuConfig}),/sparse/);
 const cycle:Record<string,unknown>={enabled:true};cycle.self=cycle;assert.throws(()=>normalizePhysicalConfig(defaultConfig,{ecu:cycle as unknown as EcuConfig}),/acyclic/);
});

test('diesel mode, cylinder-side pressure, quantity search and explicit mode reset cross the API unchanged',()=>{
 const f=fixture();const config={enabled:true,combustionMode:'directInjectionDiesel' as const,diesel:{ignitionDelayDeg:8,burnDurationDeg:45,airThrottleFraction:1}};
 const ecu=f.core.createEcuSession({cylinders:4},config);assert.deepEqual(f.calls.at(-1)!.config,config);
 const input={rpm:2000,throttle:.5,mapPressurePa:100000,injectionDownstreamPressurePa:4000000,actualRailPressurePa:80000000};ecu.step(.01,input);assert.deepEqual(f.calls.at(-1)!.input,input);
 ecu.setConfigAndReset({combustionMode:'portInjectionSpark'});assert.equal(f.calls.at(-1)!.op,'setEcuConfigAndReset');
 f.core.searchEcuOperatingPoint({}, {},2000,.5,{dieselQuantityMinMg:5,dieselQuantityMaxMg:40,injectionAdvanceMinDeg:0,injectionAdvanceMaxDeg:20,dieselQuantitySteps:3,injectionAdvanceSteps:3,budget:12});
 assert.equal(f.calls.at(-1)!.op,'searchEcuOperatingPoint');assert.deepEqual(f.calls.at(-1)!.options,{dieselQuantityMinMg:5,dieselQuantityMaxMg:40,injectionAdvanceMinDeg:0,injectionAdvanceMaxDeg:20,dieselQuantitySteps:3,injectionAdvanceSteps:3,budget:12});
 f.core.solveCylinderCycle({combustionStartDeg:362,fuelDeliveryStartDeg:352,fuelDeliveryDurationDeg:20});assert.deepEqual(f.calls.at(-1)!.config,{combustionStartDeg:362,fuelDeliveryStartDeg:352,fuelDeliveryDurationDeg:20});
 const plant=f.core.createPowertrain({});plant.setConfigAndReset({},{});assert.equal(f.calls.at(-1)!.op,'setPowertrainConfigAndReset');f.core.dispose();
});
