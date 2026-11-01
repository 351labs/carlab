/// <reference lib="webworker" />
import { encodeWav, type ExportFile } from './export.ts';
import { MODEL_VERSION, contentKeySource, renderBank, renderClip, renderStemSet, type RenderOptions } from './offline.ts';
import { initializeBackend,normalizeConfig,getBackendIdentity,type BackendName } from './backend.ts';
import type { EngineConfig } from './dsp.ts';
import { renderPhysicalClip, physicalContentKeySource, PHYSICAL_MODEL_VERSION, type PhysicalRenderOptions } from './physical-offline.ts';
import type { PhysicalConfig } from './powertrain.ts';

type Request = { backend?:BackendName;type: 'render' | 'bank' | 'stems'; id: number | string; config: EngineConfig; physical?:Partial<PhysicalConfig>; options?: RenderOptions | (PhysicalRenderOptions & {scenario:'physical'}) };
const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<Request>): Promise<void> => {
	const message = event.data;
	if (!message || (message.type !== 'render' && message.type !== 'bank' && message.type !== 'stems')) return;
	const { id } = message;
	try {
		await initializeBackend(message.backend??'rust');
		const config = normalizeConfig(message.config);
		const progress = (fraction: number): void => scope.postMessage({ type: 'progress', id, progress: fraction });
		let result: { files: ExportFile[]; stats: Record<string, number> };
		if (message.type === 'bank') result = renderBank(config, progress);
		else if(message.options?.scenario==='physical') {
			const options=message.options,physical=message.physical??{},files:ExportFile[]=[];
			const layers=message.type==='stems'?['mix','exhaust','intake','mechanical','turbo'] as const:['mix'] as const;
			let stats:Record<string,number>={};
			for(const [index,layer] of layers.entries()) {
				const mapped=layer==='mix'?config:normalizeConfig({...config,exhaustGain:layer==='exhaust'?config.exhaustGain:0,intakeGain:layer==='intake'?config.intakeGain:0,mechanicalGain:layer==='mechanical'?config.mechanicalGain:0,turboGain:layer==='turbo'?config.turboGain:0});
				const clip=renderPhysicalClip(mapped,physical,options,value=>progress((index+value)/layers.length));
				files.push({name:message.type==='stems'?`${layer}.wav`:'engine-physical.wav',data:encodeWav(clip.left,clip.right,clip.sampleRate)});
				if(layer==='mix')stats={sampleRate:clip.sampleRate,frames:clip.left.length,duration:clip.left.length/clip.sampleRate,peak:clip.peak,rms:clip.rms};
			}
			files.push({name:'config.json',data:new TextEncoder().encode(JSON.stringify({schemaVersion:2,model:MODEL_VERSION,backend:getBackendIdentity(),physicalModel:PHYSICAL_MODEL_VERSION,contentKeySource:physicalContentKeySource(config,physical,options),config,physical,render:options,note:'Starts at rest/idle with fixed current pedal, brake and gear; not a recording/replay. Isolated layers need not sum exactly after nonlinear processing.'},null,2))});
			result={files,stats};
		}
		else if (message.type === 'stems') result = renderStemSet(config, message.options ?? { scenario: 'rev', duration: 12 }, progress);
		else {
			const options = message.options ?? { scenario: 'rev' as const, duration: 12 };
			const clip = renderClip(config, options, progress);
			const data = encodeWav(clip.left, clip.right, clip.sampleRate);
			result = { files: [{ name: `engine-${options.scenario}.wav`, data }, {
				name: 'config.json', data: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, model: MODEL_VERSION,backend:getBackendIdentity(),
					contentKeySource: contentKeySource(config, options), config, render: options }, null, 2)),
			}], stats: { sampleRate: clip.sampleRate, frames: clip.left.length, duration: clip.left.length / clip.sampleRate, peak: clip.peak, rms: clip.rms } };
		}
		scope.postMessage({ type: 'complete', id, ...result }, result.files.map((file) => file.data.buffer as ArrayBuffer));
	} catch (error) {
		scope.postMessage({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
	}
};
