// Legacy-identity check: model-3 Rust must reproduce model-2 numbers exactly when
// none of the new options is used. `--write` records the reference from the WASM
// in use; otherwise the current WASM is compared bit-for-bit against that file.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngineLab } from '../api/index.ts';

const here=dirname(fileURLToPath(import.meta.url));
const referencePath=resolve(here,'legacy-model2-reference.json');
const core=await loadEngineLab({wasm:await readFile(resolve(here,'../native/dist/carlab_engine_lab.wasm'))});
const digest=values=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
// Keep only fields present in model 2; traces as exact-JSON digests.
const flatten=result=>Object.fromEntries(Object.entries(result).filter(([k,v])=>typeof v==='number').map(([k,v])=>[k,v]));
const traces=result=>Object.fromEntries(Object.entries(result.trace??{}).map(([k,v])=>[k,digest(v)]));
const engines=[{},{cylinders:4,displacement:1.998,compression:13,idleRpm:850,redline:6800},{cylinders:12,displacement:6,compression:11}];
const cases=[];
for(const[index,e]of engines.entries()){
 const engine=core.normalizeConfig(e),physical=core.normalizePhysicalConfig(engine,{});
 for(const[rpm,throttle]of [[1500,0.3],[3000,0.7],[5500,1]]){
  const estimate=core.evaluateEngine(engine,physical,rpm,throttle);
  const cycle=core.getCylinderCycle(engine,physical,rpm,throttle);
  cases.push({id:`engine${index}:${rpm}:${throttle}`,estimate:flatten(estimate),estimateCycle:flatten(estimate.cycle),cycle:flatten(cycle),cycleTrace:traces(cycle),calibration:flatten(cycle.calibration)});
 }
}
for(const config of [{},{variableHeatCapacity:true,rpm:4200},{intakeCloseDeg:250,sparkAdvanceDeg:30,rpm:1800,intakePressurePa:60000}]){
 const raw=core.solveCylinderCycle(config);
 cases.push({id:`raw:${JSON.stringify(config)}`,cycle:flatten(raw),cycleTrace:traces(raw)});
}
core.dispose();
if(process.argv.includes('--write')){
 await writeFile(referencePath,JSON.stringify({schema:'carlab-legacy-identity-1',modelVersion:core.version.modelVersion,cases},null,1)+'\n');
 console.log(`wrote ${cases.length} legacy cases from ${core.version.modelVersion}`);
}else{
 const reference=JSON.parse(await readFile(referencePath,'utf8'));
 let mismatches=0;
 for(const ref of reference.cases){
  const now=cases.find(c=>c.id===ref.id);
  for(const group of Object.keys(ref))if(group!=='id')for(const[key,value]of Object.entries(ref[group]))if(!Object.is(now?.[group]?.[key],value)){mismatches++;console.log(`MISMATCH ${ref.id} ${group}.${key}: ${value} -> ${now?.[group]?.[key]}`);}
 }
 console.log(`legacy identity vs ${reference.modelVersion}: ${reference.cases.length} cases, ${mismatches} mismatches`);
 if(mismatches)process.exit(1);
}
