import type { EngineConfig } from './dsp.ts';
import type { PhysicalConfig,PowertrainState } from './powertrain.ts';
import { EngineDSP,normalizeConfig,normalizePhysicalConfig,Powertrain,getBackendIdentity } from './backend.ts';
import { MODEL_VERSION, type RenderedClip } from './offline.ts';

export interface PhysicalRenderOptions { duration?:number; sampleRate?:number; throttle?:number; brake?:number; gear?:number }
export const PHYSICAL_MODEL_VERSION='mean-value-3';
const physicalNumbers=['boostBar','intakePressureBar','exhaustPressureBar','exhaustMassFlowKgs','exhaustTemperatureK','cycleEnergyScale','burnDurationScale','combustionPhaseDeg','residualFraction','cycleIndex'] as const;
function requireFiniteState(state:PowertrainState):void {
 if(!Number.isFinite(state.rpm)||!Number.isFinite(state.load)||!Number.isFinite(state.throttle)
  ||!Number.isFinite(state.speedMs)||!Number.isFinite(state.powerKw))throw new Error('Estado físico não finito; exportação interrompida.');
 const audio=state.physical;
 if(!audio||typeof audio.fuelCut!=='boolean')throw new Error('Estado acústico físico compartilhado ausente.');
 for(const key of physicalNumbers)if(!Number.isFinite(audio[key]))throw new Error(`Estado acústico físico não finito: ${key}.`);
 if(audio.intakePressureBar<=0||audio.exhaustPressureBar<=0||audio.exhaustTemperatureK<=0
  ||audio.exhaustMassFlowKgs<0||audio.burnDurationScale<=0)throw new Error('Estado acústico físico fora do domínio.');
}
const bounded=(v:number|undefined,fallback:number,lo:number,hi:number)=>typeof v==='number'&&Number.isFinite(v)?Math.max(lo,Math.min(hi,v)):fallback;
export function physicalRenderOptions(options:PhysicalRenderOptions={}) {
 return {duration:bounded(options.duration,12,.1,30),sampleRate:Math.round(bounded(options.sampleRate,48000,8000,96000)),throttle:bounded(options.throttle,.65,0,1),brake:bounded(options.brake,0,0,1),gear:Math.round(bounded(options.gear,1,0,8))};
}

/** Starts from rest at idle; driver demand stays fixed for this reproducible take.
 * Uses the same reduced powertrain and acoustic DSP as live, without claiming an
 * exact replay of a previously driven browser session.
 */
export function renderPhysicalClip(input:EngineConfig, physicalInput:Partial<PhysicalConfig>, requested:PhysicalRenderOptions={},onProgress?:(value:number)=>void):RenderedClip {
 const engine=normalizeConfig(input),physical=normalizePhysicalConfig(engine,physicalInput),options=physicalRenderOptions(requested);
 options.gear=Math.min(options.gear,physical.gearRatios.length);
 const model=new Powertrain(engine,physical),dsp=new EngineDSP(options.sampleRate,engine);
 try {
 const frames=Math.round(options.duration*options.sampleRate),left=new Float32Array(frames),right=new Float32Array(frames),a=new Float32Array(128),b=new Float32Array(128);
 const initial=model.getState();requireFiniteState(initial);
 dsp.setState({rpm:initial.rpm,load:initial.load,throttle:initial.throttle,physical:initial.physical},true);
 for(let i=0;i<Math.ceil(options.sampleRate*1.5/a.length);i++)dsp.process(a,b);
 let peak=0,square=0;onProgress?.(0);
 for(let frame=0;frame<frames;frame+=a.length){
  const count=Math.min(a.length,frames-frame),state=model.step(count/options.sampleRate,options.throttle,options.brake,options.gear);
  requireFiniteState(state);
  dsp.setState({rpm:state.rpm,load:state.load,throttle:state.throttle,physical:state.physical},true);dsp.process(a,b);
  left.set(a.subarray(0,count),frame);right.set(b.subarray(0,count),frame);
  if(frame%(128*64)===0)onProgress?.(frame/frames);
 }
 const edge=Math.min(Math.floor(options.sampleRate*.008),Math.floor(frames/2));
 for(let i=0;i<edge;i++){const gain=.5-.5*Math.cos(Math.PI*i/edge);left[i]*=gain;right[i]*=gain;left[frames-1-i]*=gain;right[frames-1-i]*=gain;}
 left[0]=0;right[0]=0;left[frames-1]=0;right[frames-1]=0;
 for(let i=0;i<frames;i++){if(!Number.isFinite(left[i])||!Number.isFinite(right[i]))throw new Error('Condução física produziu áudio não finito.');peak=Math.max(peak,Math.abs(left[i]),Math.abs(right[i]));square+=left[i]**2+right[i]**2;}
 onProgress?.(1);return {left,right,sampleRate:options.sampleRate,peak,rms:Math.sqrt(square/(frames*2))};
 } finally { dsp.dispose();model.dispose(); }
}

export function physicalContentKeySource(input:EngineConfig,physicalInput:Partial<PhysicalConfig>,requested:PhysicalRenderOptions={}) {
 const config=normalizeConfig(input),physical=normalizePhysicalConfig(config,physicalInput),render=physicalRenderOptions(requested);render.gear=Math.min(render.gear,physical.gearRatios.length);
 return JSON.stringify({model:MODEL_VERSION,backend:getBackendIdentity(),physicalModel:PHYSICAL_MODEL_VERSION,kind:'physical-drive',config,physical,render});
}
