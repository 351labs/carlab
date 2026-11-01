import { readFile,writeFile,mkdir,access } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEngineLab } from './api/dist/index.js';
import { presets } from './presets.ts';
import * as current from './powertrain.ts';
import { solveCylinderCycle } from './cylinder-cycle.ts';
import { fieldAbsoluteFloor } from './parity-policy.mjs';
// Preserve the original 0.5 comparison policy even after adding host-aware
// unit floors to the current regression suite.
const baselineFloors={exhaustTemperatureK:.02,wallHeatLossW:.05,'cycle.residualFraction':1e-6,veTargetResidual:1e-6,'cycle.periodicMassRelativeError':1e-5,'cycle.periodicEnergyRelativeError':5e-7};
// A standalone checkout has no historical parent repository. Supply an immutable
// baseline explicitly; the script never creates, overwrites or deletes it.
const fixture=resolve(process.env.ENGINE_LAB_LEGACY_FIXTURE ?? 'legacy-probe-fixture');
const required=['powertrain.ts','cylinder-cycle.ts','maps.ts','gas-path.ts','thermal.ts','materials.ts','presets.ts','dsp.ts','carlab_engine_lab.wasm'];
for(const name of required){
 try{await access(join(fixture,name));}
 catch{throw new Error(`Missing baseline ${join(fixture,name)}. Set ENGINE_LAB_LEGACY_FIXTURE to an independently obtained immutable baseline directory.`);}
}
const previous=await import(pathToFileURL(join(fixture,'powertrain.ts')).href);
const [oldCore,newCore]=await Promise.all([join(fixture,'carlab_engine_lab.wasm'),new URL('./native/dist/carlab_engine_lab.wasm',import.meta.url)].map(async path=>loadEngineLab({wasm:new Uint8Array(await readFile(path))})));
const rows=[],legacyDifferences=[],baselineCrossBackendViolations=[];let comparisons=0;
function compare(a,b,path,exact,failures){if(typeof b==='number'){comparisons++;const delta=Math.abs(a-b),bound=exact?0:fieldAbsoluteFloor(path,baselineFloors,1e-9)+5e-7*Math.max(Math.abs(a),Math.abs(b));if(typeof a!=='number'||!Number.isFinite(a)||delta>bound)failures.push({path,actual:a,expected:b,delta,bound});}else if(Array.isArray(b))b.forEach((v,i)=>compare(a?.[i],v,`${path}[${i}]`,exact,failures));else if(b&&typeof b==='object')for(const[k,v]of Object.entries(b))if(v!==undefined)compare(a?.[k],v,`${path}.${k}`,exact,failures);}
try{
 for(const preset of presets){const engine=preset.config;for(const[rpm,throttle]of[[engine.idleRpm,.2],[3000,.7],[engine.redline*.95,1]]){
  const physical=previous.normalizePhysicalConfig(engine),estimates={oldWasm:oldCore.evaluateEngine(engine,physical,rpm,throttle),newWasm:newCore.evaluateEngine(engine,physical,rpm,throttle),oldTs:previous.evaluateEngine(engine,physical,rpm,throttle),newTs:current.evaluateEngine(engine,physical,rpm,throttle)};
  const fields={};for(const key of ['torqueNm','powerKw','pumpingTorqueNm','fuelMassFlowKgs','exhaustTemperatureK'])fields[key]=Object.fromEntries(Object.entries(estimates).map(([name,e])=>[name,e[key]]));
  compare(estimates.newWasm,estimates.oldWasm,`${preset.id}.${rpm}.wasm`,true,legacyDifferences);compare(estimates.newTs,estimates.oldTs,`${preset.id}.${rpm}.typescript`,true,legacyDifferences);compare(estimates.oldWasm,estimates.oldTs,`${preset.id}.${rpm}`,false,baselineCrossBackendViolations);
  rows.push({preset:preset.id,rpm,throttle,fields});
 }}
 const engine=presets.find(p=>p.id==='v-twin-1-2').config,physical=previous.normalizePhysicalConfig(engine),accepted=oldCore.getCylinderCycle(engine,physical,engine.idleRpm,.2),refinement=[];
 for(const stepDeg of [2,.5,.25]){const config={...accepted.config,stepDeg};for(const[backend,cycle]of[['wasm',newCore.solveCylinderCycle(config)],['typescript',solveCylinderCycle(config)]])refinement.push({backend,stepDeg,pumpingWorkJ:cycle.pumpingWorkJ,pumpingTorqueNm:-cycle.pumpingWorkJ*engine.cylinders/(4*Math.PI),peakTemperatureK:cycle.peakTemperatureK,periodicMassRelativeError:cycle.periodicMassRelativeError});}
 const summary={baseline:'user-supplied legacy fixture (provenance not verified by this script)',comparisons,legacyDifferences,baselineCrossBackendViolations,refinement,rows,scope:'Same-host original 0.5 WASM/source versus EFI disabled WASM/source; numerical diagnostic, not timing.'};
 await mkdir('docs/efi/proof',{recursive:true});await writeFile('docs/efi/proof/legacy-comparison.json',JSON.stringify(summary,null,2)+'\n');
 console.log(JSON.stringify({comparisons,legacyDifferences,baselineCrossBackendViolations,refinement},null,2));
}finally{oldCore.dispose();newCore.dispose();}
