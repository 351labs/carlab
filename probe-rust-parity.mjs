// Diagnostic only: gathers every numeric error without weakening a parity gate.
// Run through lm-remote; no performance result is produced here.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loadEngineLab} from './api/dist/index.js';
import {presets,defaultConfig,normalizeConfig} from './presets.ts';
import {normalizeCylinderCycleConfig,solveCylinderCycle} from './cylinder-cycle.ts';
import {normalizePhysicalConfig,evaluateEngine,getCylinderCycle,Powertrain} from './powertrain.ts';
import {exhaustPressureLoss} from './gas-path.ts';
import {DERIVED_ABSOLUTE_FLOORS,DYNAMIC_ABSOLUTE_FLOORS,fieldAbsoluteFloor} from './parity-policy.mjs';

const path='output/proof/rust/parity-diagnostics.json';
const core=await loadEngineLab({wasm:new Uint8Array(await readFile(new URL('./native/dist/carlab_engine_lab.wasm',import.meta.url)))});
const fields=new Map(),structuralMismatches=[],exceptions=[],binDivergences=[],cases=[],trajectories=[],conditionedV12=[];
const tolerance={normalization:[2e-7,1e-10],raw:[2e-7,1e-10],cycle:[5e-7,1e-9],estimate:[5e-7,1e-9],dynamic:[2e-5,1e-7],held:[2e-5,1e-7]};
let numbers=0;
function compare(actual,expected,stage,key,context){
 if(typeof expected==='number'){
  const name=`${stage}.${key.replace(/\[\d+\]/g,'[]')}`;
  const row=fields.get(name)??{field:name,samples:0,maxAbsolute:0,maxRelative:0,maxReferenceMagnitude:0,minReferenceMagnitude:null,maxGateRatio:0,gateFailures:0};
  if(typeof actual!=='number'||!Number.isFinite(actual)||!Number.isFinite(expected)){structuralMismatches.push({context,key,actual,expected,issue:'nonfinite/type'});return;}
  const absolute=Math.abs(actual-expected),scale=Math.max(Math.abs(actual),Math.abs(expected)),relative=scale?absolute/scale:0;
  const [rel,abs]=tolerance[stage.split('.')[0]]??tolerance.dynamic,gateRatio=absolute/(abs+rel*scale);
  const floors=stage.startsWith('estimate')||stage.startsWith('held')?DERIVED_ABSOLUTE_FLOORS:stage.startsWith('dynamic')?DYNAMIC_ABSOLUTE_FLOORS:undefined;
  const parityRatio=absolute/(fieldAbsoluteFloor(key,floors,abs)+rel*scale);row.maxUnitAwareGateRatio=Math.max(row.maxUnitAwareGateRatio??0,parityRatio);if(parityRatio>1)row.unitAwareGateFailures=(row.unitAwareGateFailures??0)+1;
  row.samples++;numbers++;row.maxReferenceMagnitude=Math.max(row.maxReferenceMagnitude,Math.abs(expected));row.minReferenceMagnitude=Math.min(row.minReferenceMagnitude??Infinity,Math.abs(expected));
  if(absolute>row.maxAbsolute){row.maxAbsolute=absolute;row.absoluteAt={context,key,actual,expected,relative};}
  if(relative>row.maxRelative){row.maxRelative=relative;row.relativeAt={context,key,actual,expected,absolute};}
  if(gateRatio>row.maxGateRatio){row.maxGateRatio=gateRatio;row.gateAt={context,key,actual,expected,absolute,relative};}
  if(gateRatio>1)row.gateFailures++;
  fields.set(name,row);return;
 }
 if(Array.isArray(expected)){
  if(!Array.isArray(actual)||actual.length!==expected.length){structuralMismatches.push({context,key,issue:'array shape',actualLength:actual?.length,expectedLength:expected.length});return;}
  for(let i=0;i<expected.length;i++)compare(actual[i],expected[i],stage,`${key}[${i}]`,context);return;
 }
 if(expected&&typeof expected==='object'){
  if(!actual||typeof actual!=='object'){structuralMismatches.push({context,key,actual,issue:'object type'});return;}
  for(const [property,value]of Object.entries(expected))if(value!==undefined)compare(actual[property],value,stage,key?`${key}.${property}`:property,context);return;
 }
 if(actual!==expected)structuralMismatches.push({context,key,actual,expected,issue:'value'});
}
function guard(context,work){try{work();}catch(error){exceptions.push({context,message:String(error),stack:error.stack});}}
const headlines=s=>({rpm:s.rpm,speedMs:s.speedMs,torqueNm:s.torqueNm,powerKw:s.powerKw,intakePressurePa:s.gasPath.intake.pressurePa,exhaustPressurePa:s.gasPath.exhaust.pressurePa,exhaustPressureLossPa:s.gasPath.exhaustPressureLossPa,outletMassFlowKgs:s.gasPath.outletMassFlowKgs,wallTemperatureK:s.thermal.wallTemperatureK,oilTemperatureK:s.thermal.oilTemperatureK,deltaStoredEnergyJ:s.thermal.deltaStoredEnergyJ,benchmarkChecksum:s.rpm+s.speedMs+s.thermal.deltaStoredEnergyJ/1000,cycleIndex:s.physical.cycleIndex,quantitativelyValid:s.quantitativelyValid,checksum:s.rpm+s.speedMs+s.torqueNm});
function difference(a,b){const out={};for(const [key,value]of Object.entries(a)){if(typeof value==='number')out[key]={actual:value,expected:b[key],absolute:Math.abs(value-b[key]),relative:Math.abs(value-b[key])/Math.max(Math.abs(value),Math.abs(b[key]),1e-300)};else out[key]={actual:value,expected:b[key]};}return out;}
try{
 for(const preset of presets){guard(`normalization.${preset.id}`,()=>{const e=normalizeConfig(preset.config);compare(core.normalizeConfig(e),e,'normalization','engine',preset.id);compare(core.normalizePhysicalConfig(e),normalizePhysicalConfig(e),'normalization','physical',preset.id);});}
 for(const patch of [{},{rpm:1700,variableHeatCapacity:true,wallTemperatureK:390},{rpm:6000,exhaustPressurePa:180000,intakePressurePa:140000},{fuelMassKg:0,rpm:3400}])guard(`raw.${JSON.stringify(patch)}`,()=>{const config=normalizeCylinderCycleConfig(patch);compare(core.solveCylinderCycle(config),solveCylinderCycle(config),'raw','',JSON.stringify(patch));});
 for(const preset of presets){const engine=preset.config,physical=normalizePhysicalConfig(engine);for(const [rpm,throttle]of [[engine.idleRpm,.2],[3000,.7],[engine.redline*.95,1]])guard(`${preset.id}.${rpm}`,()=>{
  const context={preset:preset.id,rpm,throttle},a=core.evaluateEngine(engine,physical,rpm,throttle),b=evaluateEngine(engine,physical,rpm,throttle);compare(a,b,'estimate','',context);
  const ac=core.getCylinderCycle(engine,physical,rpm,throttle),bc=getCylinderCycle(engine,physical,rpm,throttle);compare(ac,bc,'cycle','',context);
  cases.push({context,estimate:{rust:a,typescript:b},periodicMassClosure:{rust:{initial:ac.initialMassKg,final:ac.finalMassKg,error:ac.periodicMassRelativeError},typescript:{initial:bc.initialMassKg,final:bc.finalMassKg,error:bc.periodicMassRelativeError}}});
 });}
 guard('conditioned-v12-classic',()=>{
  const preset=presets.find(p=>p.id==='v12-classic'),engine=preset.config,physical=normalizePhysicalConfig(engine),rpm=engine.idleRpm,throttle=.2;
  const tsFinal=getCylinderCycle(engine,physical,rpm,throttle),rustFinal=core.getCylinderCycle(engine,physical,rpm,throttle);
  const configDeltas={};for(const key of new Set([...Object.keys(tsFinal.config),...Object.keys(rustFinal.config)])){const a=rustFinal.config[key],b=tsFinal.config[key];if(typeof a==='number'&&typeof b==='number')configDeltas[key]={rust:a,typescript:b,absolute:Math.abs(a-b),relative:Math.abs(a-b)/Math.max(Math.abs(a),Math.abs(b),1e-300)};else configDeltas[key]={rust:a,typescript:b,equal:JSON.stringify(a)===JSON.stringify(b)};}
  const traceError=(a,b,angles)=>{let maxAbsolute=0,maxRelative=0,index=-1;for(let i=0;i<a.length;i++){const absolute=Math.abs(a[i]-b[i]),relative=absolute/Math.max(Math.abs(a[i]),Math.abs(b[i]),1e-300);if(absolute>maxAbsolute){maxAbsolute=absolute;index=i;}maxRelative=Math.max(maxRelative,relative);}return {maxAbsolute,maxRelative,index,angleDeg:index<0?null:angles[index]};};
  const summary=c=>({steps:c.steps,netWorkJ:c.netWorkJ,grossWorkJ:c.grossWorkJ,pumpingWorkJ:c.pumpingWorkJ,peakPressurePa:c.peakPressurePa,exhaustTemperatureK:c.exhaustTemperatureK,initialMassKg:c.initialMassKg,finalMassKg:c.finalMassKg,periodicMassRelativeError:c.periodicMassRelativeError,periodicEnergyRelativeError:c.periodicEnergyRelativeError,freshChargeMassKg:c.freshChargeMassKg,exhaustMassKg:c.exhaustMassKg});
  const solves=[];
  for(const [origin,source]of [['typescript-final',tsFinal.config],['rust-final',rustFinal.config]])for(const stepDeg of [2,1]){
   const config=normalizeCylinderCycleConfig({...source,stepDeg}),a=core.solveCylinderCycle(config),b=solveCylinderCycle(config),context={preset:preset.id,rpm,throttle,origin,stepDeg};
   compare(a,b,`raw.conditioned-v12.${origin}.step${stepDeg}`,'',context);
   const traceDifferences={};for(const key of ['pressurePa','temperatureK','massKg','intakeFlowKgs','exhaustFlowKgs','heatReleaseJ'])traceDifferences[key]=traceError(a.trace[key],b.trace[key],a.trace.angleDeg);
   solves.push({origin,stepDeg,config,summary:{rust:summary(a),typescript:summary(b)},traceDifferences,traces:{angleDeg:a.trace.angleDeg,rust:{pressurePa:a.trace.pressurePa,temperatureK:a.trace.temperatureK,exhaustFlowKgs:a.trace.exhaustFlowKgs},typescript:{pressurePa:b.trace.pressurePa,temperatureK:b.trace.temperatureK,exhaustFlowKgs:b.trace.exhaustFlowKgs}}});
  }
  const conditioning=[];for(const backend of ['rust','typescript'])for(const stepDeg of [2,1]){const a=solves.find(x=>x.origin==='rust-final'&&x.stepDeg===stepDeg),b=solves.find(x=>x.origin==='typescript-final'&&x.stepDeg===stepDeg);conditioning.push({backend,stepDeg,geometryPerturbation:a.config.boreM-b.config.boreM,summary:difference(a.summary[backend],b.summary[backend])});}
  conditionedV12.push({rpm,throttle,configDeltas,calibration:{rust:rustFinal.calibration,typescript:tsFinal.calibration},calibratedSummary:{rust:summary(rustFinal),typescript:summary(tsFinal)},solves,conditioning});
 });
 for(const scenario of ['switch','constant'])guard(`dynamic.${scenario}`,()=>{
  const engine=defaultConfig,physical=normalizePhysicalConfig(engine),reference=new Powertrain(engine,physical),rust=core.createPowertrain(engine,physical),checkpoints=[];
  let checksumRust=0,checksumTs=0;
  try{for(let step=0;step<2400;step++){
   const throttle=scenario==='constant'?.6:step<180?.65:step<320?.1:.9,gear=scenario==='constant'?1:step<240?1:2;
   const a=rust.step(1/240,throttle,0,gear),b=reference.step(1/240,throttle,0,gear),context={scenario,step,timeSeconds:(step+1)/240,throttle,gear};
   compare(a,b,`dynamic.${scenario}.2400`,'',context);if(step<480)compare(a,b,`dynamic.${scenario}.480`,'',context);
   checksumRust+=a.rpm+a.speedMs+a.torqueNm;checksumTs+=b.rpm+b.speedMs+b.torqueNm;
   const heldA=rust.getOperatingEstimate(),heldB=reference.getOperatingEstimate();compare(heldA,heldB,`held.${scenario}`,'',context);
   if(heldA&&heldB&&(heldA.cycle.lookupRpm!==heldB.cycle.lookupRpm||heldA.cycle.lookupIntakePressureBar!==heldB.cycle.lookupIntakePressureBar))binDivergences.push({...context,rust:{rpm:heldA.cycle.lookupRpm,intake:heldA.cycle.lookupIntakePressureBar},typescript:{rpm:heldB.cycle.lookupRpm,intake:heldB.cycle.lookupIntakePressureBar}});
   if(step%20===0||step===479||step===2399){
    const recompute=s=>exhaustPressureLoss(s.gasPath.outletMassFlowKgs,s.gasPath.exhaust.massKg/(physical.exhaustVolumeL*.001),engine.pipeDiameter*.001,engine.exhaustLength+engine.headerLength,physical.exhaustRestrictionK+(engine.boostBar>0?physical.turbineRestrictionK:0),physical.exhaustFrictionFactor);
    checkpoints.push({context,headline:difference(headlines(a),headlines(b)),lossRecomputedWithTypeScriptFunction:{fromRustState:recompute(a),fromTsState:recompute(b),rustPublished:a.gasPath.exhaustPressureLossPa,tsPublished:b.gasPath.exhaustPressureLossPa}});
   }
  }
  trajectories.push({scenario,steps:2400,dt:1/240,checkpoints,final:difference(headlines(rust.getState()),headlines(reference.getState())),accumulatedChecksum:{rust:checksumRust,typescript:checksumTs,absolute:Math.abs(checksumRust-checksumTs),relative:Math.abs(checksumRust-checksumTs)/Math.max(Math.abs(checksumRust),Math.abs(checksumTs))}});
  }finally{rust.dispose();}
 });
}finally{
 core.dispose();
 const perField=[...fields.values()].sort((a,b)=>b.maxGateRatio-a.maxGateRatio);
 const report={scope:'Diagnostic f64 Rust/WASM versus TypeScript v5; original generic diagnostics plus documented unit-aware aggregate gates; model equations unchanged; no timing/performance claim.',configuration:{presets:presets.map(x=>x.id),pointsPerPreset:3,rawCycleCases:4,dynamicCases:['switch','constant'],stepsEach:2400,dt:1/240},numberComparisons:numbers,structuralMismatches,exceptions,binDivergences,parityPolicy:{derivedAbsoluteFloors:DERIVED_ABSOLUTE_FLOORS,dynamicAbsoluteFloors:DYNAMIC_ABSOLUTE_FLOORS,rawTraceConditioning:'Diagnostic only; no claim that every instantaneous calibrated valve-flow trace meets the generic gate.'},summary:{fields:perField.length,aggregateFieldsOutsideUnitAwareGate:perField.filter(x=>x.field.startsWith('estimate.')||x.field.startsWith('held.')||x.field.startsWith('dynamic.')).filter(x=>x.unitAwareGateFailures).length,fieldsOutsideCurrentGenericGate:perField.filter(x=>x.gateFailures).length,maxGateRatio:perField[0]?.maxGateRatio},perField,cases,trajectories,conditionedV12};
 await mkdir('output/proof/rust',{recursive:true});await mkdir('output',{recursive:true});
 const fullText=JSON.stringify(report,null,2)+'\n',fullPath='output/parity-diagnostics-full.json';await writeFile(fullPath,fullText);
 const {perField:allFields,cases:allCases,trajectories:allTrajectories,...header}=report;
 const compact={...header,conditionedV12:conditionedV12.map(c=>({...c,configDeltas:Object.fromEntries(Object.entries(c.configDeltas).filter(([,x])=>x.absolute>0||x.equal===false)),solves:c.solves.map(({traces,config,...summary})=>summary)})),format:'compact-parity-diagnostic-1',fullDiagnostic:{path:fullPath,sha256:createHash('sha256').update(fullText).digest('hex'),bytes:Buffer.byteLength(fullText),reproduce:'node probe-rust-parity.mjs (through lm-remote)'},derivedFields:allFields.filter(x=>x.field.startsWith('estimate.')),worstGenericFields:allFields.slice(0,16),trajectorySummaries:allTrajectories.map(({checkpoints,...summary})=>summary),operatingPoints:allCases.map(x=>x.context).filter(Boolean)};
 await writeFile(path,JSON.stringify(compact,null,2)+'\n');
 if(structuralMismatches.length||exceptions.length||binDivergences.length||report.summary.aggregateFieldsOutsideUnitAwareGate)process.exitCode=1;
 console.log(JSON.stringify({report:path,numberComparisons:numbers,structuralMismatches:structuralMismatches.length,exceptions,binDivergences:binDivergences.length,summary:report.summary,conditionedV12:conditionedV12.map(c=>({configDeltas:Object.fromEntries(Object.entries(c.configDeltas).filter(([,x])=>x.absolute>0||x.equal===false)),calibration:c.calibration,calibratedSummary:c.calibratedSummary,solves:c.solves.map(x=>({origin:x.origin,stepDeg:x.stepDeg,summary:x.summary,traceDifferences:x.traceDifferences})),conditioning:c.conditioning})),worstFields:perField.slice(0,24).map(x=>({field:x.field,maxAbsolute:x.maxAbsolute,maxRelative:x.maxRelative,maxGateRatio:x.maxGateRatio,gateFailures:x.gateFailures,gateAt:x.gateAt})),final:trajectories.map(t=>({scenario:t.scenario,final:t.final,accumulatedChecksum:t.accumulatedChecksum}))},null,2));
}
