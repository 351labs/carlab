// Run through lm-remote. This conditions the Rust plant on measured boundaries;
// no measured torque/air/fuel is supplied to the solver or any fitting target.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngineLab } from '../api/index.ts';
import { finiteNumber, scoreField, powerKwFromTorque, bsfcGkwh } from './metrics.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const sourceCommit=()=>{try{return execFileSync('git',['rev-parse','HEAD'],{cwd:here,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return null;}};
const output=resolve(process.argv[2]??'docs/validation-real-engines/proof/mazda-unfitted.json');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const protocolBytes=await readFile(resolve(here,'mazda-protocol.json'));
const protocol=JSON.parse(protocolBytes);
const fixtureBytes=await readFile(resolve(here,protocol.fixture));
const fixture=JSON.parse(fixtureBytes);
if(fixture.schema!==protocol.expectedFixtureSchema)throw new Error('Unexpected measured fixture schema.');
if(!fixture.selection.declaredBeforeAnyModelOutputs||fixture.points.length!==12)throw new Error('Frozen twelve-point selection required.');
const wasmBytes=await readFile(resolve(here,'../native/dist/carlab_engine_lab.wasm'));
const core=await loadEngineLab({wasm:wasmBytes});
if(core.version.modelVersion!=='carlab-engine-lab-rust-2')throw new Error('Protocol requires the reviewed model baseline.');
const close=(a,b)=>finiteNumber(a)&&finiteNumber(b)&&Math.abs(a-b)<=1e-10*Math.max(1,Math.abs(a),Math.abs(b));
function checkRequested(actual,requested,label){
 for(const[key,value]of Object.entries(requested)){
  if(typeof value==='number'&&!close(actual[key],value))throw new Error(`${label}.${key}: requested ${value} normalized to ${actual[key]}`);
  if(typeof value==='boolean'||typeof value==='string')if(actual[key]!==value)throw new Error(`${label}.${key} normalized unexpectedly.`);
  if(value&&typeof value==='object'&&!Array.isArray(value))checkRequested(actual[key]??{},value,`${label}.${key}`);
 }
}
const measuredFor=p=>({torqueNm:p.brakeTorqueNm,fuelMassFlowGs:p.fuelMassFlowGs,airMassFlowGs:p.airMassFlowGs,powerKw:powerKwFromTorque(p.brakeTorqueNm,p.rpm),bsfcGkwh:p.bsfcGkwh});
function derive(cycle,engine,physical){
 const geometry=core.engineGeometry(engine,physical),frequency=engine.cylinders*cycle.config.rpm/120;
 const pistonSpeed=2*geometry.strokeMm*.001*cycle.config.rpm/60;
 const fmepBar=physical.frictionBaseBar+physical.frictionSpeedBar*pistonSpeed+.002*pistonSpeed**2;
 const frictionTorqueNm=fmepBar*1e5*geometry.displacementM3/(4*Math.PI);
 const torqueNm=cycle.netWorkJ*engine.cylinders/(4*Math.PI)-frictionTorqueNm;
 const powerKw=powerKwFromTorque(torqueNm,cycle.config.rpm),fuelMassFlowGs=cycle.fuelMassKg*frequency*1000;
 return {torqueNm,powerKw,fuelMassFlowGs,bsfcGkwh:bsfcGkwh(fuelMassFlowGs,powerKw),
  // EPA inlet MAF is compared to signed net inlet flow, not retained IVC air.
  airMassFlowGs:(cycle.intakeMassInKg-cycle.intakeReverseMassKg)*frequency*1000,
  retainedAirMassFlowGs:cycle.freshChargeMassKg*frequency*1000,fmepBar,frictionTorqueNm};
}
function admission(cycle,expected,extra){
 const reasons=[...extra];
 for(const[key,value]of Object.entries(expected))if(!close(cycle.config[key],value))reasons.push(`normalized ${key}`);
 for(const[key,value]of Object.entries(cycle))if(typeof value==='number'&&!finiteNumber(value))reasons.push(`nonfinite ${key}`);
 for(const[key,values]of Object.entries(cycle.trace))if(!Array.isArray(values)||values.some(v=>!finiteNumber(v)))reasons.push(`nonfinite trace ${key}`);
 for(const key of ['periodicMassRelativeError','periodicEnergyRelativeError'])if(!finiteNumber(cycle[key])||Math.abs(cycle[key])>protocol.numerics.maxPeriodicRelativeError)reasons.push(`${key}>2%`);
 for(const[key,limit]of [['massBalanceResidualKg',protocol.numerics.maxMassLedgerResidualKg],['energyBalanceResidualJ',protocol.numerics.maxEnergyLedgerResidualJ]])if(!finiteNumber(cycle[key])||Math.abs(cycle[key])>limit)reasons.push(`${key} exceeds numerical ledger gate`);
 if(cycle.calibration?.extrapolated)reasons.push('generic VE map extrapolation');
 if(cycle.calibration?.indicatedEfficiencyTarget!==undefined)reasons.push('unexpected optional efficiency target');
 return [...new Set(reasons)];
}
const rows=[],conditions=[];
const engine=core.normalizeConfig(protocol.engine);checkRequested(engine,protocol.engine,'engine');
try{
 for(const point of fixture.points){
  for(const key of ['rpm','mapKpaAbsolute','intakeC','cellKpaAbsolute','catalystInletKpaAbsolute','exhaustPort1C','exhaustPort2C','exhaustPort3C','exhaustPort4C'])if(!finiteNumber(point[key]))throw new Error(`Missing measured condition row${point.excelRow}.${key}`);
  const request={...protocol.physical,ambientPressureBar:point.cellKpaAbsolute/100,intakeTemperatureK:point.intakeC+273.15};
  const physical=core.normalizePhysicalConfig(engine,request);checkRequested(physical,request,'physical');
  if(physical.indicatedEfficiencyMap||physical.fmepMap||physical.cycleCalibration||physical.ecu.enabled)throw new Error('No efficiency/friction fit or ECU input is allowed.');
  const geometry=core.engineGeometry(engine,physical);
  for(const[key,nominal]of [['boreMm',fixture.engine.geometryOem.boreMm],['strokeMm',fixture.engine.geometryOem.strokeMm]])if(Math.abs(geometry[key]-nominal)>protocol.geometryRoundingToleranceMm)throw new Error(`Geometry mismatch ${key}`);
  const boundary={intakePressurePa:point.mapKpaAbsolute*1000,intakeTemperatureK:point.intakeC+273.15,exhaustPressurePa:point.catalystInletKpaAbsolute*1000,exhaustTemperatureK:(point.exhaustPort1C+point.exhaustPort2C+point.exhaustPort3C+point.exhaustPort4C)/4+273.15};
  const base=core.cycleConfigFor(engine,physical,point.rpm,1,boundary,0);
  if('fuelMassKg'in base)throw new Error('Unexpected supplied fuel mass; baseline must predict fuel.');
  conditions.push({excelRow:point.excelRow,engine,physical,boundary,geometry,rawCycleConfig:base,measuredControlsNotUsed:{sparkAdvanceDegBtdc:point.sparkAdvanceDegBtdc,intakeCamPhaseDeg:point.intakeCamPhaseDeg,exhaustCamPhaseDeg:point.exhaustCamPhaseDeg,exhaustLambda:point.exhaustLambda},measuredDerivedConsistency:{reportedBsfcGkwh:point.bsfcGkwh,recomputedBsfcGkwh:bsfcGkwh(point.fuelMassFlowGs,powerKwFromTorque(point.brakeTorqueNm,point.rpm))}});
  for(const variant of protocol.variants){
   const row={id:`${variant}:row${point.excelRow}`,variant,excelRow:point.excelRow,rpm:point.rpm,mapKpaAbsolute:point.mapKpaAbsolute,measured:measuredFor(point),valid:false,reasons:[]};
   try{
    const isLab=variant==='lab-generic-ve';
    const requested={...base,stepDeg:protocol.numerics.fixedValveStepDeg,settlingCycles:variant==='fixed-valve-settled'?protocol.numerics.settledDiagnosticCycles:protocol.numerics.fixedValveSettlingCycles};
    const cycle=isLab?core.getCylinderCycle(engine,physical,point.rpm,1,boundary,0):core.solveCylinderCycle(requested);
    const expected={...boundary,rpm:point.rpm,compressionRatio:engine.compression,...(isLab?{}:{stepDeg:requested.stepDeg,settlingCycles:requested.settlingCycles})};
    row.predicted=derive(cycle,engine,physical);
    row.reasons=admission(cycle,expected,[]);row.valid=row.reasons.length===0;
    row.config=cycle.config;
    row.diagnostics=Object.fromEntries(['netWorkJ','grossWorkJ','pumpingWorkJ','fuelMassKg','freshChargeMassKg','intakeMassInKg','intakeReverseMassKg','peakPressurePa','peakTemperatureK','ca50Deg','periodicMassRelativeError','periodicEnergyRelativeError','massBalanceResidualKg','energyBalanceResidualJ','steps','warnings','calibration'].filter(k=>k in cycle).map(k=>[k,cycle[k]]));
   }catch(error){row.reasons=[String(error.message??error)];row.predicted=null;}
   rows.push(row);
   console.log(`${row.id} ${row.valid?'admitted':'excluded'} torque=${row.predicted?.torqueNm??'n/a'} ${row.reasons.join(';')}`);
  }
 }
 const summary=Object.fromEntries(protocol.variants.map(variant=>[variant,Object.fromEntries(protocol.metrics.map(field=>[field,scoreField(rows.filter(r=>r.variant===variant),field,{minRelativeDenominator:1e-9}).metrics]))]));
 const sourceFiles=['config.rs','powertrain.rs','cylinder_cycle.rs','maps.rs','lib.rs'];
 const modelSourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async name=>[name,sha(await readFile(resolve(here,'../native/src',name)))])));
 const report={schema:'carlab-engine-measurement-1',createdUtc:new Date().toISOString(),host:hostname(),node:process.version,sourceCommit:sourceCommit(),api:core.version,wasmSha256:sha(wasmBytes),protocolSha256:sha(protocolBytes),fixtureSha256:sha(fixtureBytes),adapterSha256:sha(await readFile(fileURLToPath(import.meta.url))),metricsSha256:sha(await readFile(resolve(here,'metrics.mjs'))),modelSourceHashes,protocol,source:fixture.source,selection:fixture.selection,conditions,summary,rows,interpretation:{status:'unfitted-conditional-discrepancy',realEngineAccuracyPass:null,parameterFit:false,heldOutCalibration:false,notEvaluated:['EFI actuator calibration/film','DI transients','predictive spark response','live inventory/held-cycle coupling','knock/emissions/acoustics/durability'],warning:'Numerical admission is not real-engine fidelity. Measured sensor proxies, generic valve/phase/friction assumptions, and DI/PFI mismatch limit attribution; exclusions stay visible.'}};
 await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({output,summary},null,2));
}finally{core.dispose();}
