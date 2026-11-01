/** Portable TypeScript boundary for the original Rust engine/audio model.
 * No DOM, bundler globals, npm runtime packages or TypeScript model execution.
 * JSON crosses the control boundary; audio blocks cross as planar Float32 data.
 */
import type { EngineConfig,EngineState,EngineTelemetry,PhysicalAudioState,CylinderCycleConfig,CylinderCycleResult,PhysicalConfig,EngineGeometry,EngineEstimate,PotentialEnvelope,PowertrainState,CalibratedCylinderCycle,GasPathBoundary,ThermalConfig,MaterialCard,MaterialScreenConfig,MechanicalCycleInput,MaterialScreenResult,CalibrationKind,CalibrationMap,CalibrationSample,CalibrationBundle,EcuConfig,EcuConfigInput,EcuInput,EcuState,EcuSteadyResult,EcuMap,EcuMapKind,EcuMapSample,FuelBlendConfig,FuelProperties,InjectorConfig,InjectorDeliveryInput,InjectorDeliveryResult,EcuFuelObservation,EcuFitOptions,EcuFitResult,EcuSearchOptions,EcuSearchResult } from './types.js';
export type * from './types.js';

export const ENGINE_LAB_API_VERSION=1 as const;
export const MAX_AUDIO_BLOCK_FRAMES=16384;
export const MAX_CONTROL_REQUEST_BYTES=4_000_000;
const MAX_RESPONSE_BYTES=32*1024*1024;
export type WasmSource=URL|string|ArrayBuffer|Uint8Array|WebAssembly.Module;
export interface EngineLabVersion {apiVersion:1;modelVersion:string;backend:'rust';audioLayout:'planar-f32';maxAudioFrames:number}
export interface LoadEngineLabOptions {
 wasm:WasmSource;
 imports?:WebAssembly.Imports;
 /** Override when the application supplies authenticated/custom asset fetching. */
 fetcher?:(url:URL|string)=>Promise<{ok:boolean;status:number;arrayBuffer():Promise<ArrayBuffer>}>;
}
export interface NativeEngineExports extends WebAssembly.Exports {
 memory:WebAssembly.Memory;
 engine_lab_alloc:(length:number)=>number;
 engine_lab_free:(pointer:number,length:number)=>void;
 engine_lab_request:(pointer:number,length:number)=>number;
 engine_lab_result_len:()=>number;
 engine_lab_dsp_process:(handle:number,frames:number)=>number;
 engine_lab_audio_len:()=>number;
}
export class EngineLabError extends Error {
 readonly operation?:string;
 constructor(message:string,operation?:string){super(message);this.name='EngineLabError';this.operation=operation;}
}
function finite(value:number,name:string):number {if(!Number.isFinite(value))throw new RangeError(`${name} must be finite.`);return value;}
function integer(value:number,name:string,min:number,max:number):number {if(!Number.isInteger(value)||value<min||value>max)throw new RangeError(`${name} must be an integer in [${min}, ${max}].`);return value;}
function checkedExports(instance:WebAssembly.Instance):NativeEngineExports {
 const e=instance.exports;
 if(!(e.memory instanceof WebAssembly.Memory))throw new EngineLabError('The WASM module does not export its memory.');
 for(const name of ['engine_lab_alloc','engine_lab_free','engine_lab_request','engine_lab_result_len','engine_lab_dsp_process','engine_lab_audio_len'])if(typeof e[name]!=='function')throw new EngineLabError(`Missing WASM export: ${name}.`);
 return e as NativeEngineExports;
}
// AudioWorkletGlobalScope need not expose the Encoding API. Keep the fallback
// inside this module rather than mutating the application's global objects.
function encodeUtf8(value:string):Uint8Array {
 if(typeof TextEncoder==='function')return new TextEncoder().encode(value);
 const bytes:number[]=[];
 for(let i=0;i<value.length;i++){
  let cp=value.codePointAt(i)!;if(cp>0xffff)i++;else if(cp>=0xd800&&cp<=0xdfff)cp=0xfffd;
  if(cp<0x80)bytes.push(cp);
  else if(cp<0x800)bytes.push(0xc0|(cp>>6),0x80|(cp&63));
  else if(cp<0x10000)bytes.push(0xe0|(cp>>12),0x80|((cp>>6)&63),0x80|(cp&63));
  else bytes.push(0xf0|(cp>>18),0x80|((cp>>12)&63),0x80|((cp>>6)&63),0x80|(cp&63));
 }
 return new Uint8Array(bytes);
}
function decodeUtf8(bytes:Uint8Array):string {
 if(typeof TextDecoder==='function')return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 const chars:string[]=[];
 for(let i=0;i<bytes.length;){
  const first=bytes[i++];let cp=first,count=0,minimum=0;
  if(first<0x80){chars.push(String.fromCharCode(first));continue;}
  if(first>=0xc2&&first<=0xdf){cp=first&31;count=1;minimum=0x80;}
  else if(first>=0xe0&&first<=0xef){cp=first&15;count=2;minimum=0x800;}
  else if(first>=0xf0&&first<=0xf4){cp=first&7;count=3;minimum=0x10000;}
  else throw new TypeError('Invalid UTF-8 leading byte.');
  if(i+count>bytes.length)throw new TypeError('Truncated UTF-8 sequence.');
  for(let j=0;j<count;j++){const byte=bytes[i++];if((byte&0xc0)!==0x80)throw new TypeError('Invalid UTF-8 continuation.');cp=(cp<<6)|(byte&63);}
  if(cp<minimum||cp>0x10ffff||(cp>=0xd800&&cp<=0xdfff))throw new TypeError('Noncanonical UTF-8 sequence.');
  chars.push(String.fromCodePoint(cp));
 }
 return chars.join('');
}
function encodeRequest(value:unknown):Uint8Array {
 let json:string|undefined;
 try{json=JSON.stringify(value,(_key,item:unknown)=>{
  if(typeof item==='number'&&!Number.isFinite(item))throw new TypeError('JSON control inputs must contain finite numbers.');
  if(typeof item==='bigint'||typeof item==='function'||typeof item==='symbol')throw new TypeError('Control inputs must be JSON-compatible.');
  if(ArrayBuffer.isView(item)){
   if(item instanceof DataView)throw new TypeError('Use numeric typed arrays, not DataView, for traces.');
   return Array.from(item as unknown as ArrayLike<number>);
  }
  return item;
 });}catch(error){throw new EngineLabError(error instanceof Error?error.message:String(error),'serialize');}
 if(json===undefined)throw new EngineLabError('The request is not JSON-compatible.','serialize');
 const bytes=encodeUtf8(json);if(bytes.length>MAX_CONTROL_REQUEST_BYTES)throw new RangeError('Engine request exceeds 4,000,000 UTF-8 bytes.');return bytes;
}

/** Compile/fetch once, then instantiate independently on each worker/audio thread.
 * For Node file paths, pass bytes from node:fs/promises; this loader stays portable.
 */
export async function loadEngineLab(options:LoadEngineLabOptions):Promise<EngineLab> {
 const {wasm,imports={}}=options;
 if(wasm instanceof WebAssembly.Module)return instantiateEngineLab(wasm,imports);
 let bytes:Uint8Array;
 if(typeof wasm==='string'||wasm instanceof URL){
  const response=await (options.fetcher??fetch)(wasm);if(!response.ok)throw new EngineLabError(`WASM fetch failed with HTTP ${response.status}.`,'load');bytes=new Uint8Array(await response.arrayBuffer());
 }else if(wasm instanceof ArrayBuffer)bytes=new Uint8Array(wasm);
 else if(wasm instanceof Uint8Array)bytes=Uint8Array.from(wasm);
 else throw new TypeError('wasm must be a URL, string URL, ArrayBuffer, Uint8Array or compiled WebAssembly.Module.');
 const module=await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
 return instantiateEngineLab(module,imports);
}
/** Synchronous initialization for AudioWorklet/worker constructors. No fetch here. */
export function instantiateEngineLab(source:WebAssembly.Module|WebAssembly.Instance,imports:WebAssembly.Imports={}):EngineLab {
 return source instanceof WebAssembly.Module?new EngineLab(new WebAssembly.Instance(source,imports),source):new EngineLab(source);
}

export class EngineLab {
 readonly instance:WebAssembly.Instance;
 readonly module?:WebAssembly.Module;
 readonly exports:NativeEngineExports;
 readonly version:EngineLabVersion;
 private closed=false;
 private readonly resources=new Set<NativeResource>();
 constructor(instance:WebAssembly.Instance,module?:WebAssembly.Module){
  this.instance=instance;this.module=module;
  this.exports=checkedExports(instance);
  this.version=this.request<EngineLabVersion>('version');
 }
 get disposed():boolean{return this.closed;}
 /** Advanced operation escape hatch; typed methods below cover normal usage.
  * Returned data is copied from WASM before another request can invalidate it.
  */
 request<T=unknown>(operation:string,fields:Record<string,unknown>={}):T {
  this.assertOpen();
  if(typeof operation!=='string'||!operation||operation.length>100)throw new TypeError('A bounded operation name is required.');
  const bytes=encodeRequest({...fields,op:operation,apiVersion:ENGINE_LAB_API_VERSION}),e=this.exports,ptr=e.engine_lab_alloc(bytes.length)>>>0;
  if(ptr===0)throw new EngineLabError('WASM request allocation failed.',operation);
  try{
   this.assertRange(ptr,bytes.length);new Uint8Array(e.memory.buffer,ptr,bytes.length).set(bytes);
   const responsePtr=e.engine_lab_request(ptr,bytes.length)>>>0,length=e.engine_lab_result_len()>>>0;
   if(!responsePtr||!length||length>MAX_RESPONSE_BYTES)throw new EngineLabError('Invalid WASM response length.',operation);
   this.assertRange(responsePtr,length);
   let envelope:{apiVersion?:number;ok?:boolean;result?:T;error?:string};
   try{envelope=JSON.parse(decodeUtf8(new Uint8Array(e.memory.buffer,responsePtr,length)));}
   catch{throw new EngineLabError('The WASM response is not valid UTF-8 JSON.',operation);}
   if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))throw new EngineLabError('The WASM response is not an object envelope.',operation);
   if(envelope.apiVersion!==ENGINE_LAB_API_VERSION)throw new EngineLabError(`Unsupported engine API version: ${String(envelope.apiVersion)}.`,operation);
   if(envelope.ok!==true)throw new EngineLabError(typeof envelope.error==='string'?envelope.error:'The native engine rejected the request.',operation);
   if(!('result' in envelope))throw new EngineLabError('The WASM response omitted its result.',operation);
   return envelope.result as T;
  }finally{e.engine_lab_free(ptr,bytes.length);}
 }
 normalizeConfig(config:Partial<EngineConfig>={}):EngineConfig{return this.request('normalizeConfig',{config});}
 normalizePhysicalConfig(engine:Partial<EngineConfig>,physical:Partial<PhysicalConfig>={}):PhysicalConfig{return this.request('normalizePhysical',{engine,physical});}
 engineGeometry(engine:Partial<EngineConfig>,physical:Partial<PhysicalConfig>={}):EngineGeometry{return this.request('geometry',{engine,physical});}
 solveCylinderCycle(config:Partial<CylinderCycleConfig>={}):CylinderCycleResult{return this.request('cycle',{config});}
 cycleConfigFor(engine:Partial<EngineConfig>,physical:Partial<PhysicalConfig>,rpm:number,throttle:number,override?:Partial<GasPathBoundary>,boostFraction=1):CylinderCycleConfig{return this.request('cycleConfig',{engine,physical,rpm,throttle,override,boostFraction});}
 getCylinderCycle(engine:Partial<EngineConfig>,physical:Partial<PhysicalConfig>,rpm:number,throttle:number,override?:Partial<GasPathBoundary>,boostFraction=1):CalibratedCylinderCycle{return this.request('getCylinderCycle',{engine,physical,rpm,throttle,override,boostFraction});}
 /** `override` fixes the intake/exhaust boundary (static measured-condition evaluation) instead of solving the gas path. */
 evaluateEngine(engine:Partial<EngineConfig>,physical:Partial<PhysicalConfig>,rpm:number,throttle:number,boostFraction=1,override?:Partial<GasPathBoundary>):EngineEstimate{return this.request('evaluate',{engine,physical,rpm,throttle,boostFraction,override});}
 /** Converts a measured spark->CA10 delay into the kernel's spark->SOC offset (subtracts the Wiebe SOC->CA10 interval). */
 sparkToSocFromCa10Delay(sparkToCa10Deg:number,burnDurationDeg=50,wiebeEfficiency=6.9,wiebeShape=2):number{return this.request('sparkToSocFromCa10Delay',{sparkToCa10Deg,burnDurationDeg,wiebeEfficiency,wiebeShape});}
 potentialEnvelope(engine:Partial<EngineConfig>,physical:Partial<PhysicalConfig>={},samples=64):PotentialEnvelope{return this.request('potential',{engine,physical,samples});}
 normalizeThermalConfig(config:Partial<ThermalConfig>={}):ThermalConfig{return this.request('normalizeThermal',{config});}
 normalizeMaterialScreenConfig(config:Partial<MaterialScreenConfig>={}):MaterialScreenConfig{return this.request('normalizeMaterialScreen',{config});}
 parseMaterialCard(card:unknown):MaterialCard{return this.request('parseMaterialCard',{card});}
 screenMaterial(input:MechanicalCycleInput,config:Partial<MaterialScreenConfig>={}):MaterialScreenResult{return this.request('material',{input,config});}
 normalizeCalibrationMap(map:unknown,kind:CalibrationKind,fallback?:CalibrationMap):CalibrationMap{return this.request('normalizeMap',{map:map===undefined?fallback:map,kind});}
 sampleCalibrationMap(map:CalibrationMap,rpm:number,pressureBar:number):CalibrationSample{return this.request('sampleMap',{map,rpm,pressureBar});}
 createAssumedVeMap(idleRpm:number,redlineRpm:number,baseVe=.9,mode:'uniform'|'shaped'='shaped'):CalibrationMap{return this.request('assumedVeMap',{idleRpm,redlineRpm,baseVe,mode});}
 parseCalibrationBundle(bundle:unknown):CalibrationBundle{return this.request('parseCalibrationBundle',{bundle});}
 normalizeEcuConfig(engine:Partial<EngineConfig>,config:EcuConfigInput={}):EcuConfig{return this.request('normalizeEcuConfig',{engine,config});}
 evaluateEcuSteady(engine:Partial<EngineConfig>,config:EcuConfigInput,input:Partial<EcuInput>={}):EcuSteadyResult{return this.request('evaluateEcuSteady',{engine,config,input});}
 normalizeEcuMap<K extends EcuMapKind>(map:unknown,kind:K):EcuMap<K>{return this.request('normalizeEcuMap',{map,kind});}
 sampleEcuMap(map:EcuMap,rpm:number,mapPressureBar:number):EcuMapSample{return this.request('sampleEcuMap',{map,rpm,mapPressureBar});}
 fuelBlendProperties(config:FuelBlendConfig):FuelProperties{return this.request('fuelBlendProperties',{config});}
 injectorDelivery(config:InjectorConfig,input:InjectorDeliveryInput):InjectorDeliveryResult{return this.request('injectorDelivery',{config,input});}
 fitEcuFuelMap(engine:Partial<EngineConfig>,config:EcuConfigInput,observations:readonly EcuFuelObservation[],options:EcuFitOptions):EcuFitResult{return this.request('fitEcuFuelMap',{engine,config,observations,options});}
 searchEcuOperatingPoint(engine:Partial<EngineConfig>,physical:Partial<PhysicalConfig>,rpm:number,throttle:number,options:EcuSearchOptions={}):EcuSearchResult{return this.request('searchEcuOperatingPoint',{engine,physical,rpm,throttle,options});}
 createEcuSession(engine:Partial<EngineConfig>,config:EcuConfigInput={}):NativeEcuSession {
  const {handle}=this.request<{handle:number}>('createEcu',{engine,config});return this.own(new NativeEcuSession(this,handle));
 }
 createPowertrain(engine:Partial<EngineConfig>,physical:Partial<PhysicalConfig>={}):NativePowertrain {
  const {handle}=this.request<{handle:number}>('createPowertrain',{engine,physical});return this.own(new NativePowertrain(this,handle));
 }
 createSynth(config:Partial<EngineConfig>,sampleRate=48000):NativeSynth {
  finite(sampleRate,'sampleRate');if(sampleRate<8000||sampleRate>192000)throw new RangeError('sampleRate must be in [8000, 192000].');
  const {handle}=this.request<{handle:number}>('createDsp',{config,sampleRate});return this.own(new NativeSynth(this,handle));
 }
 /** Destroys all owned native handles. The JS-owned module/memory is then GC-able
  * once callers release references; this does not close an application's devices.
  */
 dispose():void {
  if(this.closed)return;let failure:unknown;
  for(const resource of [...this.resources])try{resource.dispose();}catch(error){failure??=error;}
  this.closed=true;if(failure)throw failure;
 }
 /** @internal */ release(resource:NativeResource):void{this.resources.delete(resource);}
 /** @internal */ assertOpen():void {if(this.closed)throw new EngineLabError('This engine instance has been disposed.');}
 /** @internal */ assertRange(pointer:number,length:number):void {if(!Number.isInteger(pointer)||!Number.isInteger(length)||pointer<0||length<0||pointer+length>this.exports.memory.buffer.byteLength)throw new EngineLabError('WASM returned a memory range outside its exported memory.');}
 private own<T extends NativeResource>(resource:T):T{this.resources.add(resource);return resource;}
}
abstract class NativeResource {
 private closed=false;
 protected readonly owner:EngineLab;
 readonly handle:number;
 constructor(owner:EngineLab,handle:number){integer(handle,'native handle',1,0xffffffff);this.owner=owner;this.handle=handle;}
 get disposed():boolean{return this.closed;}
 protected assertOpen():void{this.owner.assertOpen();if(this.closed)throw new EngineLabError('This native handle has been disposed.');}
 dispose():void{if(this.closed)return;this.closed=true;try{this.owner.request('destroy',{handle:this.handle});}finally{this.owner.release(this);}}
}
export interface FixedStepOptions {dt:number;steps:number;throttle:number;brake?:number;gear?:number}
export class NativePowertrain extends NativeResource {
 setConfig(engine:Partial<EngineConfig>,physical:Partial<PhysicalConfig>={}):void{this.assertOpen();this.owner.request('setPowertrainConfig',{handle:this.handle,engine,physical});}
 setConfigAndReset(engine:Partial<EngineConfig>,physical:Partial<PhysicalConfig>={}):PowertrainState{this.assertOpen();return this.owner.request('setPowertrainConfigAndReset',{handle:this.handle,engine,physical});}
 reset(state:{rpm?:number;speedMs?:number}={}):PowertrainState{this.assertOpen();return this.owner.request('resetPowertrain',{handle:this.handle,state});}
 getState():PowertrainState{this.assertOpen();return this.owner.request('powertrainState',{handle:this.handle});}
 getOperatingEstimate():EngineEstimate|null{this.assertOpen();return this.owner.request('powertrainEstimate',{handle:this.handle});}
 step(dt:number,throttle:number,brake=0,gear=0):PowertrainState {
  this.assertOpen();finite(dt,'dt');finite(throttle,'throttle');finite(brake,'brake');integer(gear,'gear',0,8);
  if(dt<0||dt>.25)throw new RangeError('dt must be in [0, 0.25] seconds.');
  return this.owner.request('stepPowertrain',{handle:this.handle,dt,throttle,brake,gear});
 }
 /** Runs fixed steps inside Rust, crossing the JSON boundary only once. */
 stepMany({dt,steps,throttle,brake=0,gear=0}:FixedStepOptions):PowertrainState {
  this.assertOpen();finite(dt,'dt');if(dt<=0||dt>.25)throw new RangeError('dt must be in (0, 0.25] seconds.');integer(steps,'steps',0,100000);finite(throttle,'throttle');finite(brake,'brake');integer(gear,'gear',0,8);
  return this.owner.request('stepPowertrainMany',{handle:this.handle,dt,steps,throttle,brake,gear});
 }
}
/** Physical patches merge with the last target; null clears the shared state. */
export type SynthState=EngineState;
export class NativeSynth extends NativeResource {
 setConfig(config:Partial<EngineConfig>):void{this.assertOpen();this.owner.request('setDspConfig',{handle:this.handle,config});}
 setState(state:SynthState,actualRpm=false):void{this.assertOpen();this.owner.request('setDspState',{handle:this.handle,state,actualRpm});}
 trigger(kind:'start'|'stop'|'blip'|'shift'):void{this.assertOpen();this.owner.request('triggerDsp',{handle:this.handle,kind});}
 getTelemetry():EngineTelemetry{this.assertOpen();return this.owner.request('dspTelemetry',{handle:this.handle});}
 /** Caller-owned outputs avoid allocating output storage each audio callback. Native
  * processing may grow memory, so each block obtains a fresh view afterwards.
  */
 processStereo(left:Float32Array,right:Float32Array):void {
  this.assertOpen();if(!(left instanceof Float32Array)||!(right instanceof Float32Array)||left.length!==right.length)throw new TypeError('Stereo outputs must be equal-length Float32Arrays.');
  this.assertExternalOutput(left);this.assertExternalOutput(right);
  if(left.buffer===right.buffer&&left.byteOffset<right.byteOffset+right.byteLength&&right.byteOffset<left.byteOffset+left.byteLength)throw new TypeError('Stereo output ranges must not overlap.');
  const frames=integer(left.length,'frames',1,MAX_AUDIO_BLOCK_FRAMES),view=this.block(frames);left.set(view.subarray(0,frames));right.set(view.subarray(frames,frames*2));
 }
 processInterleaved(output:Float32Array):void {
  this.assertOpen();if(!(output instanceof Float32Array)||output.length%2)throw new TypeError('Interleaved output must be a Float32Array with an even length.');
  this.assertExternalOutput(output);
  const frames=integer(output.length/2,'frames',1,MAX_AUDIO_BLOCK_FRAMES),view=this.block(frames);
  for(let i=0;i<frames;i++){output[i*2]=view[i];output[i*2+1]=view[frames+i];}
 }
 private assertExternalOutput(output:Float32Array):void{if(output.buffer===this.owner.exports.memory.buffer)throw new TypeError('Audio outputs must use caller-owned memory outside the WASM heap.');}
 private block(frames:number):Float32Array {
  const e=this.owner.exports,ptr=e.engine_lab_dsp_process(this.handle,frames)>>>0,length=e.engine_lab_audio_len()>>>0;
  if(!ptr||ptr%4!==0||length!==frames*2){
   let message='Native audio processing failed or returned an invalid block.';
   const resultPointer=e['engine_lab_result_ptr'];
   if(typeof resultPointer==='function')try{
    const p=Number(resultPointer())>>>0,n=e.engine_lab_result_len()>>>0;
    if(p&&n&&n<=MAX_RESPONSE_BYTES){this.owner.assertRange(p,n);const response=JSON.parse(decodeUtf8(new Uint8Array(e.memory.buffer,p,n)));if(response?.apiVersion===ENGINE_LAB_API_VERSION&&response.ok===false&&typeof response.error==='string')message+=` ${response.error}`;}
   }catch{/* Preserve the primary processing failure if diagnostics are corrupt. */}
   throw new EngineLabError(message,'processDsp');
  }
  this.owner.assertRange(ptr,length*4);return new Float32Array(e.memory.buffer,ptr,length);
 }
}

/** Stateful original EFI controller. Each handle owns its film, sensor and trim
 * history; saving EcuConfig alone does not replay that dynamic state.
 */
export class NativeEcuSession extends NativeResource {
 setConfig(config:EcuConfigInput,engine?:Partial<EngineConfig>):EcuState{this.assertOpen();return this.owner.request('setEcuConfig',{handle:this.handle,config,...(engine?{engine}:{})});}
 setConfigAndReset(config:EcuConfigInput,engine?:Partial<EngineConfig>):EcuState{this.assertOpen();return this.owner.request('setEcuConfigAndReset',{handle:this.handle,config,...(engine?{engine}:{})});}
 reset():EcuState{this.assertOpen();return this.owner.request('resetEcu',{handle:this.handle});}
 getState():EcuState{this.assertOpen();return this.owner.request('getEcuState',{handle:this.handle});}
 step(dt:number,input:Partial<EcuInput>):EcuState{
  this.assertOpen();finite(dt,'dt');if(dt<0||dt>.25)throw new RangeError('dt must be in [0, 0.25] seconds.');return this.owner.request('stepEcu',{handle:this.handle,dt,input});
 }
 stepMany(dt:number,steps:number,input:Partial<EcuInput>):EcuState{
  this.assertOpen();finite(dt,'dt');if(dt<=0||dt>.25)throw new RangeError('dt must be in (0, 0.25] seconds.');integer(steps,'steps',0,100000);return this.owner.request('stepEcuMany',{handle:this.handle,dt,steps,input});
 }
}
