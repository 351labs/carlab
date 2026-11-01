import { EngineDSP,initializeBackendSync,getBackendIdentity,type BackendName } from './backend.ts';
import type { EngineConfig } from './dsp.ts';
import { defaultConfig } from './presets.ts';

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(); }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
interface ProcessorOptions {processorOptions?:{backend?:BackendName;wasmModule?:WebAssembly.Module}}

class EngineProcessor extends AudioWorkletProcessor {
 private readonly engine:EngineDSP;
 private blocks = 0;
 constructor(options?:ProcessorOptions) {
  super();
  initializeBackendSync(options?.processorOptions?.backend??'rust',options?.processorOptions?.wasmModule);
  this.engine=new EngineDSP(sampleRate,defaultConfig);
  this.port.onmessage = ({data}) => {
   if (data.type === 'config') this.engine.setConfig(data.config as EngineConfig);
   if (data.type === 'state') this.engine.setState(data.state, data.actualRpm===true);
   if (data.type === 'trigger') this.engine.trigger(data.kind);
  };
 }
 process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
  const output = outputs[0];
  if (output?.[0] && output[1]) this.engine.process(output[0], output[1]);
  if (++this.blocks % 16 === 0) this.port.postMessage({type:'telemetry',backend:getBackendIdentity(), ...this.engine.getTelemetryWithDiagnostics()});
  return true;
 }
}
registerProcessor('carlab-engine', EngineProcessor);
