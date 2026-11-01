/** Exact previous-model captures versus v2, with the same targets and equal RMS.
 * Run through lm-remote; retained clips are generated audio, never reference samples.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { presets, normalizeConfig } from './presets.ts';
import { renderClip, MODEL_VERSION } from './offline.ts';
import { encodeWav } from './export.ts';

const rawRoot = 'output/comparison/raw';
const out = 'output/analysis/comparison';
await mkdir(out, {recursive:true});
await mkdir(join(rawRoot,'after'), {recursive:true});

function decodePcm16(bytes:Uint8Array):{left:Float32Array;right:Float32Array;sampleRate:number} {
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(new TextDecoder().decode(bytes.subarray(0,4))!=='RIFF'||view.getUint16(22,true)!==2||view.getUint16(34,true)!==16)throw new Error('Expected generated stereo PCM16 WAV.');
 const frames=view.getUint32(40,true)/4,left=new Float32Array(frames),right=new Float32Array(frames);
 for(let i=0;i<frames;i++){left[i]=view.getInt16(44+i*4,true)/32768;right[i]=view.getInt16(46+i*4,true)/32768;}
 return {left,right,sampleRate:view.getUint32(24,true)};
}
function levels(left:Float32Array,right:Float32Array):{rms:number;peak:number} {
 let sum=0,peak=0;
 for(let i=0;i<left.length;i++){sum+=left[i]**2+right[i]**2;peak=Math.max(peak,Math.abs(left[i]),Math.abs(right[i]));}
 return {rms:Math.sqrt(sum/(left.length*2)),peak};
}
const baseline=JSON.parse(await readFile('output/baseline-v1/source.json','utf8'));
const manifest:{model:string;baseline:unknown;levelMatching:string;pairs:unknown[];examples:unknown[]}={
 model:MODEL_VERSION,baseline,levelMatching:'Equal stereo RMS, not perceptual LUFS; shared target lowered if either peak would exceed0.92.',pairs:[],examples:[],
};
for(const [id,presetId,scenario] of [
 ['v12-steady','v12-highrev','steady'],['v12-idle','v12-highrev','idle'],
 ['v10-steady','v10-5','steady'],['v10-idle','v10-5','idle'],
] as const){
 const folder=join(rawRoot,'before',id);
 const previous=JSON.parse(await readFile(join(folder,`${presetId}-${scenario}.json`),'utf8'));
 const beforeBytes=await readFile(join(folder,`${presetId}-${scenario}.wav`));
 const before=decodePcm16(beforeBytes);
 const voice=presets.find(preset=>preset.id===presetId)!.config;
 const config=normalizeConfig({...previous.config,roughness:voice.roughness,timingJitter:voice.timingJitter,lowBody:voice.lowBody,wear:voice.wear,combustionDetail:0,perspective:'exhaust'});
 const legacy=renderClip(normalizeConfig({...previous.config,roughness:0,timingJitter:0,lowBody:0,wear:0,combustionDetail:0,perspective:'exhaust'}),previous.options);
 const legacyBytes=encodeWav(legacy.left,legacy.right,legacy.sampleRate);
 const legacyZeroByteIdentical=legacyBytes.length===beforeBytes.length&&legacyBytes.every((value,index)=>value===beforeBytes[index]);
 const after=renderClip(config,previous.options);
 const beforeLevels=levels(before.left,before.right),afterLevels=levels(after.left,after.right);
 const maxCrest=Math.max(beforeLevels.peak/beforeLevels.rms,afterLevels.peak/afterLevels.rms);
 const targetRms=Math.min(.08,.92/maxCrest);
 const beforeGain=targetRms/beforeLevels.rms,afterGain=targetRms/afterLevels.rms;
 const scale=(signal:Float32Array,gain:number)=>Float32Array.from(signal,value=>value*gain);
 await writeFile(join(out,`${id}-before.wav`),encodeWav(scale(before.left,beforeGain),scale(before.right,beforeGain),before.sampleRate));
 await writeFile(join(out,`${id}-after.wav`),encodeWav(scale(after.left,afterGain),scale(after.right,afterGain),after.sampleRate));
 await writeFile(join(rawRoot,'after',`${id}.wav`),encodeWav(after.left,after.right,after.sampleRate));
 manifest.pairs.push({id,beforeModel:previous.model,afterModel:MODEL_VERSION,legacyZeroByteIdentical,beforeConfig:previous.config,afterConfig:config,options:previous.options,frames:before.left.length,sampleRate:before.sampleRate,targetRms,beforeGain,afterGain,beforeLevels,afterLevels,beforeFile:`${id}-before.wav`,afterFile:`${id}-after.wav`,note:'Base geometry, firing order and operating targets preserved; only the four new character controls added.'});
}
for(const scenario of ['idle','rev'] as const){
 const config=presets.find(preset=>preset.id==='v12-classic')!.config;
 const options={scenario,duration:scenario==='rev'?8:6,sampleRate:48000};
 const clip=renderClip(config,options);
 const name=`v12-classic-${scenario}.wav`;
 await writeFile(join(out,name),encodeWav(clip.left,clip.right,clip.sampleRate));
 manifest.examples.push({id:`v12-classic-${scenario}`,config,options,file:name,peak:clip.peak,rms:clip.rms,note:'New original low-rev classic voice; not an imitation of a named manufacturer.'});
}
await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({model:MODEL_VERSION,pairs:manifest.pairs.length,examples:manifest.examples.length,out},null,2));
