// Run only inside ONE lm-remote --bench job on remix-mac2 after functional gates.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus,hostname,tmpdir } from 'node:os';
import { mkdtemp,writeFile,readFile,mkdir,rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { defaultConfig } from './presets.ts';
import { normalizeCylinderCycleConfig,solveCylinderCycle } from './cylinder-cycle.ts';
import { Powertrain,normalizePhysicalConfig } from './powertrain.ts';
import { EngineDSP } from './dsp.ts';
import { loadEngineLab } from './api/dist/index.js';
const iterations=7,warmup=3,frames=240000,steps=2400,dt=1/240,sampleRate=48000;
const config=defaultConfig,physical=normalizePhysicalConfig(config),cycle=normalizeCylinderCycleConfig({rpm:3000}),state={rpm:3000,load:.6,throttle:.6};
const temporary=await mkdtemp(join(tmpdir(),'carlab-rust-bench-')),out=process.env.ENGINE_LAB_BENCH_PROOF??'output/proof/rust';
await mkdir(out,{recursive:true});const wasm=await readFile(new URL('./native/dist/carlab_engine_lab.wasm',import.meta.url)),core=await loadEngineLab({wasm:new Uint8Array(wasm)});
function measure(run){const elapsedMs=[],checksums=[];for(let i=-warmup;i<iterations;i++){const start=performance.now(),checksum=run(),elapsed=performance.now()-start;assert.ok(Number.isFinite(checksum));if(i>=0){elapsedMs.push(elapsed);checksums.push(checksum);}}return {elapsedMs,checksums};}
const cases={
 cycle:{typescript:()=>{const c=solveCylinderCycle(cycle);return c.netWorkJ+c.peakPressurePa/1e5;},wasm:()=>{const c=core.solveCylinderCycle(cycle);return c.netWorkJ+c.peakPressurePa/1e5;}},
 simulation:{typescript:()=>{const model=new Powertrain(config,physical);let s;for(let i=0;i<steps;i++)s=model.step(dt,.6,0,1);return s.rpm+s.speedMs+s.thermal.deltaStoredEnergyJ/1000;},wasm:()=>{const model=core.createPowertrain(config,physical);try{const s=model.stepMany({dt,steps,throttle:.6,gear:1});return s.rpm+s.speedMs+s.thermal.deltaStoredEnergyJ/1000;}finally{model.dispose();}}},
 dsp:{typescript:()=>{const synth=new EngineDSP(sampleRate,config),left=new Float32Array(128),right=new Float32Array(128);synth.trigger('start');synth.setState(state,true);let sum=0;for(let frame=0;frame<frames;frame+=128){const n=Math.min(128,frames-frame),l=left.subarray(0,n),r=right.subarray(0,n);synth.process(l,r);for(let i=0;i<n;i++)sum+=l[i]*l[i]+r[i]*r[i];}return sum;},wasm:()=>{const synth=core.createSynth(config,sampleRate),left=new Float32Array(128),right=new Float32Array(128);try{synth.trigger('start');synth.setState(state,true);let sum=0;for(let frame=0;frame<frames;frame+=128){const n=Math.min(128,frames-frame),l=left.subarray(0,n),r=right.subarray(0,n);synth.processStereo(l,r);for(let i=0;i<n;i++)sum+=l[i]*l[i]+r[i]*r[i];}return sum;}finally{synth.dispose();}}}
};
try{
 const results={};for(const [name,variants]of Object.entries(cases)){results[name]={};for(const [variant,run]of Object.entries(variants))results[name][variant]=measure(run);}
 const configPath=join(temporary,'config.json'),cyclePath=join(temporary,'cycle.json');await writeFile(configPath,JSON.stringify({config,physical}));await writeFile(cyclePath,JSON.stringify(cycle));
 const native=spawnSync(new URL('./native/dist/carlab-engine',import.meta.url).pathname,['benchmark','--case','all','--iterations',String(iterations),'--warmup',String(warmup),'--frames',String(frames),'--steps',String(steps),'--dt',String(dt),'--actual-rpm','--rpm','3000','--throttle','.6','--gear','1','--config',configPath,'--cycle-config',cyclePath],{encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(native.status,0,native.stderr);const nativeReport=JSON.parse(native.stdout);
 for(const result of nativeReport.cases){assert.ok(results[result.case],`known native case ${result.case}`);results[result.case].native=result;}
 for(const [name,variants]of Object.entries(results)){const expected=variants.typescript.checksums[0];for(const [variant,data]of Object.entries(variants))for(const sum of data.checksums)assert.ok(Math.abs(sum-expected)<=1e-5*Math.max(1,Math.abs(expected)),`${name}/${variant}: benchmark workload checksum differs`);}
 const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
 const summary={};for(const [name,variants]of Object.entries(results)){summary[name]={};for(const [variant,data]of Object.entries(variants)){assert.equal(data.elapsedMs.length,iterations);summary[name][variant]={medianMs:median(data.elapsedMs),minMs:Math.min(...data.elapsedMs),maxMs:Math.max(...data.elapsedMs)};}}
 const report={host:hostname(),cpu:cpus()[0]?.model,node:process.version,kind:'single exclusive lm-remote --bench job; not a browser frame-rate or end-to-end latency benchmark',iterations,warmup,workload:{cycle:'one raw 720-degree cycle plus settling; no VE fit or cycle cache',simulation:{steps,dt,throttle:.6,gear:1},dsp:{frames,sampleRate,seconds:frames/sampleRate,blockFrames:128,state}},boundary:{typescript:'TypeScript reference in Node/V8, with the same v5 integration cap',wasm:'Rust WASM via shipped TS API; includes control JSON and PCM copying; simulation batched in one call',native:'same Rust crate; internal Instant measurements exclude process startup and file IO'},source:'See RUST.md for final source snapshot and job ID.',wasmBytes:wasm.length,results,summary};
 await writeFile(join(out,'benchmark.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({host:report.host,cpu:report.cpu,summary,wasmBytes:report.wasmBytes},null,2));
}finally{core.dispose();await rm(temporary,{recursive:true,force:true});}
