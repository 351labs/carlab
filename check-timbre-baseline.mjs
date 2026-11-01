// Validate that the disposable TypeScript baseline represents the shipped Rust DSP.
// Run through lm-remote after probe-timbre.mjs, not in the live audio callback.
import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadEngineLab } from './api/index.ts';
import { encodeWav } from './export.ts';
const root='output/timbre-prototypes';
const manifest=JSON.parse(await readFile(`${root}/manifest.json`));
const wasm=await readFile('native/dist/carlab_engine_lab.wasm');
const core=await loadEngineLab({wasm});
const rows=[];
try{
 for(const row of manifest.rows.filter(r=>r.variant==='baseline')){
  const synth=core.createSynth(row.config,row.sampleRate),block=manifest.render.blockFrames;
  const left=new Float32Array(row.frames),right=new Float32Array(row.frames),l=new Float32Array(block),r=new Float32Array(block);
  try{
   synth.setState({rpm:row.rpm,load:row.load,throttle:row.throttle,physical:row.physicalState},row.controlMode==='physical');synth.trigger('start');
   for(let i=0;i<manifest.render.warmupFrames;i+=block){const n=Math.min(block,manifest.render.warmupFrames-i);synth.processStereo(l.subarray(0,n),r.subarray(0,n));}
   for(let i=0;i<row.frames;i+=block){const n=Math.min(block,row.frames-i);synth.processStereo(l.subarray(0,n),r.subarray(0,n));left.set(l.subarray(0,n),i);right.set(r.subarray(0,n),i);}
   const candidate=encodeWav(left,right,row.sampleRate),baseline=await readFile(row.rawPath);
   assert.equal(candidate.length,baseline.length);
   const a=new DataView(candidate.buffer,candidate.byteOffset,candidate.byteLength),b=new DataView(baseline.buffer,baseline.byteOffset,baseline.byteLength);
   let maximumPcm16Difference=0,differences=0;
   for(let i=44;i<candidate.length;i+=2){const delta=Math.abs(a.getInt16(i,true)-b.getInt16(i,true));maximumPcm16Difference=Math.max(maximumPcm16Difference,delta);if(delta)differences++;}
   assert.ok(maximumPcm16Difference<=2,`${row.id}: baseline differs from Rust by ${maximumPcm16Difference} PCM16 steps`);
   rows.push({id:row.id,maximumPcm16Difference,differences,samples:(candidate.length-44)/2,admitted:true});
  }finally{synth.dispose();}
 }
 const proof={schema:'carlab-timbre-baseline-parity-1',api:core.version,wasmSha256:createHash('sha256').update(wasm).digest('hex'),baselineDspSha256:manifest.source.sha256,scope:'Current TypeScript DSP versus shipped Rust/WASM at identical synthetic mean physical controls; bounded PCM agreement, not engine acoustic fidelity.',maximumAllowedPcm16Difference:2,rows};
 await writeFile(`${root}/baseline-rust-check.json`,JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
}finally{core.dispose();}
