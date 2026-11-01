/** Lab execution routing. Production lab startup explicitly initializes Rust;
 * uninitialized direct module consumers retain the v4 TypeScript test oracle. */
import { EngineDSP as ReferenceDsp,type EngineConfig,type EngineState,type EngineTelemetry } from './dsp.ts';
import { normalizeConfig as referenceNormalizeConfig } from './presets.ts';
import * as referencePowertrain from './powertrain.ts';
import * as referenceMaps from './maps.ts';
import * as referenceThermal from './thermal.ts';
import * as referenceMaterials from './materials.ts';
import { loadEngineLab,instantiateEngineLab,type EngineLab,type NativePowertrain,type NativeSynth } from './api/index.ts';
import type { PhysicalConfig,PowertrainState,EngineEstimate } from './powertrain.ts';
export type { EngineConfig,EngineState,EngineTelemetry } from './dsp.ts';
export type { PhysicalConfig,PowertrainState,EngineEstimate } from './powertrain.ts';
export type BackendName='rust'|'typescript';
let name:BackendName='typescript',core:EngineLab|undefined,pending:Promise<void>|undefined;
export const getBackendName=():BackendName=>name;
export const getBackendIdentity=()=>name==='rust'?'rust-wasm-v3':'typescript-reference-v5';
export const getBackendModule=()=>core?.module;
export function requestedBackend():BackendName{return typeof location!=='undefined'&&new URLSearchParams(location.search).get('backend')==='typescript'?'typescript':'rust';}
export async function initializeBackend(next:BackendName='rust'):Promise<void>{
 if(next==='typescript'){name='typescript';return;}
 if(core){name='rust';return;}
 if(!pending)pending=loadEngineLab({wasm:new URL('./native/dist/carlab_engine_lab.wasm',import.meta.url)}).then(value=>{core=value;name='rust';}).catch(error=>{pending=undefined;throw error;});
 await pending;
}
/** Worklet startup has a precompiled module and cannot perform an async fetch. */
export function initializeBackendSync(next:BackendName,module?:WebAssembly.Module):void{
 if(next==='typescript'){name=next;return;}
 if(!module)throw new Error('Rust audio requires the compiled engine WASM module.');
 core=instantiateEngineLab(module);name='rust';
}
function rust():EngineLab{if(!core)throw new Error('Initialize the Rust engine before using the lab.');return core;}
/** EFI and the model-3 physics options exist only in Rust; the TS reference keeps them but never runs legacy physics in their place. */
export function isReferenceEcuBlocked(physical:unknown):boolean{return name==='typescript'&&!!physical&&typeof physical==='object'&&((physical as {ecu?:{enabled?:unknown}}).ecu?.enabled===true||referencePowertrain.usesModel3Physics(physical));}
function requireEcuBackend(physical?:unknown):void{if(isReferenceEcuBlocked(physical))throw new Error('EFI e as opções do modelo 3 requerem o núcleo Rust. A referência TypeScript preserva a configuração, mas não as executa.');}
/** Additive EFI operations stay in Rust; the TypeScript path is only a reference. */
export function ecuRequest<T=unknown>(operation:string,fields:Record<string,unknown>={}):T{if(name!=='rust')throw new Error('EFI requer o núcleo Rust; a referência TypeScript não executa este controlador.');return rust().request<T>(operation,fields);}

export const normalizeConfig:typeof referenceNormalizeConfig=(input)=>name==='rust'?rust().normalizeConfig(input):referenceNormalizeConfig(input);
export const normalizePhysicalConfig:typeof referencePowertrain.normalizePhysicalConfig=(engine,input)=>name==='rust'?rust().normalizePhysicalConfig(engine,input):referencePowertrain.normalizePhysicalConfig(engine,input);
export const engineGeometry:typeof referencePowertrain.engineGeometry=(engine,physical)=>name==='rust'?rust().engineGeometry(engine,physical):referencePowertrain.engineGeometry(engine,physical);
export const cycleConfigFor:typeof referencePowertrain.cycleConfigFor=(...args)=>{requireEcuBackend(args[1]);return name==='rust'?rust().cycleConfigFor(...args):referencePowertrain.cycleConfigFor(...args);};
export const getCylinderCycle:typeof referencePowertrain.getCylinderCycle=(...args)=>{requireEcuBackend(args[1]);return name==='rust'?rust().getCylinderCycle(...args):referencePowertrain.getCylinderCycle(...args);};
export const evaluateEngine:typeof referencePowertrain.evaluateEngine=(...args)=>{requireEcuBackend(args[1]);return name==='rust'?rust().evaluateEngine(...args):referencePowertrain.evaluateEngine(...args);};
export const potentialEnvelope:typeof referencePowertrain.potentialEnvelope=(...args)=>{requireEcuBackend(args[1]);return name==='rust'?rust().potentialEnvelope(...args):referencePowertrain.potentialEnvelope(...args);};
export const normalizeThermalConfig:typeof referenceThermal.normalizeThermalConfig=(input)=>name==='rust'?rust().request('normalizeThermal',{config:input??{}}):referenceThermal.normalizeThermalConfig(input);
export const normalizeMaterialScreenConfig:typeof referenceMaterials.normalizeMaterialScreenConfig=(input)=>name==='rust'?rust().request('normalizeMaterialScreen',{config:input??{}}):referenceMaterials.normalizeMaterialScreenConfig(input);
export const parseMaterialCard:typeof referenceMaterials.parseMaterialCard=(input)=>name==='rust'?rust().request('parseMaterialCard',{card:input}):referenceMaterials.parseMaterialCard(input);
export const screenMaterial:typeof referenceMaterials.screenMaterial=(input,config)=>name==='rust'?rust().request('material',{input,config:config??{}}):referenceMaterials.screenMaterial(input,config);
export const normalizeCalibrationMap:typeof referenceMaps.normalizeCalibrationMap=(...args)=>name==='rust'?rust().normalizeCalibrationMap(...args):referenceMaps.normalizeCalibrationMap(...args);
export const parseCalibrationBundle:typeof referenceMaps.parseCalibrationBundle=(input)=>name==='rust'?rust().parseCalibrationBundle(input):referenceMaps.parseCalibrationBundle(input);
export const createAssumedVeMap:typeof referenceMaps.createAssumedVeMap=(...args)=>name==='rust'?rust().createAssumedVeMap(...args):referenceMaps.createAssumedVeMap(...args);

/** Compatibility adapters keep the existing interface while every Rust-mode
 * model operation is executed by the native crate through its WASM boundary. */
export class Powertrain {
 private readonly reference?:referencePowertrain.Powertrain;
 private readonly native?:NativePowertrain;
 private readonly owner?:EngineLab;
 private referenceEcuBlocked=false;
 constructor(engine:EngineConfig,physical?:Partial<PhysicalConfig>){if(name==='rust'){this.owner=rust();this.native=this.owner.createPowertrain(engine,physical);}else {this.referenceEcuBlocked=isReferenceEcuBlocked(physical);this.reference=new referencePowertrain.Powertrain(engine,referencePowertrain.normalizePhysicalConfig(engine,physical));}}
 setConfig(engine:EngineConfig,physical:Partial<PhysicalConfig>){if(this.native)this.native.setConfig(engine,physical);else {this.referenceEcuBlocked=isReferenceEcuBlocked(physical);this.reference!.setConfig(engine,physical);}}
 setConfigAndReset(engine:EngineConfig,physical:Partial<PhysicalConfig>):PowertrainState{if(this.native)return this.owner!.request('setPowertrainConfigAndReset',{handle:this.native.handle,engine,physical});this.setConfig(engine,physical);return this.reset();}
 reset(state:{rpm?:number;speedMs?:number}={}):PowertrainState{if(this.native)return this.native.reset(state);this.reference!.reset(state);return this.getState();}
 getState():PowertrainState{const state=this.native?this.native.getState():this.reference!.getState();return this.referenceEcuBlocked?{...state,torqueNm:0,powerKw:0,quantitativelyValid:false,warnings:['EFI indisponível na referência TypeScript; integração física pausada.'],physical:{...state.physical,fuelCut:true,cycleEnergyScale:0}}:state;}
 getOperatingEstimate():EngineEstimate|null{if(this.referenceEcuBlocked)return null;return this.native?this.owner!.request('powertrainOperatingEstimate',{handle:this.native.handle}):this.reference!.getOperatingEstimate();}
 step(dt:number,throttle:number,brake=0,gear=0):PowertrainState{if(this.referenceEcuBlocked)return this.getState();return this.native?this.native.step(dt,throttle,brake,gear):this.reference!.step(dt,throttle,brake,gear);}
 dispose(){this.native?.dispose();}
}
export type EngineTelemetryWithDiagnostics=EngineTelemetry & {character:ReturnType<ReferenceDsp['getCharacterTelemetry']>;pulse:ReturnType<ReferenceDsp['getPulseTelemetry']>};
export class EngineDSP {
 private readonly reference?:ReferenceDsp;
 private readonly native?:NativeSynth;
 private readonly owner?:EngineLab;
 constructor(sampleRate:number,config:EngineConfig){if(name==='rust'){this.owner=rust();this.native=this.owner.createSynth(config,sampleRate);}else this.reference=new ReferenceDsp(sampleRate,config);}
 setConfig(config:EngineConfig){if(this.native)this.native.setConfig(config);else this.reference!.setConfig(config);}
 setState(state:EngineState,actualRpm=false){if(this.native)this.native.setState(state as Parameters<NativeSynth['setState']>[0],actualRpm);else this.reference!.setState(state,actualRpm);}
 trigger(kind:'start'|'stop'|'blip'|'shift'){if(this.native)this.native.trigger(kind);else this.reference!.trigger(kind);}
 process(left:Float32Array,right:Float32Array){if(this.native)this.native.processStereo(left,right);else this.reference!.process(left,right);}
 getTelemetry():EngineTelemetry{return this.native?this.native.getTelemetry():this.reference!.getTelemetry();}
 /** One Rust control crossing supplies the complete worklet telemetry packet. */
 getTelemetryWithDiagnostics():EngineTelemetryWithDiagnostics{return this.native?this.owner!.request('dspTelemetry',{handle:this.native.handle}):{...this.reference!.getTelemetry(),character:this.reference!.getCharacterTelemetry(),pulse:this.reference!.getPulseTelemetry()};}
 getCharacterTelemetry():ReturnType<ReferenceDsp['getCharacterTelemetry']>{return this.native?this.owner!.request('dspCharacterTelemetry',{handle:this.native.handle}):this.reference!.getCharacterTelemetry();}
 getPulseTelemetry():ReturnType<ReferenceDsp['getPulseTelemetry']>{return this.native?this.owner!.request('dspPulseTelemetry',{handle:this.native.handle}):this.reference!.getPulseTelemetry();}
 dispose(){this.native?.dispose();}
}
