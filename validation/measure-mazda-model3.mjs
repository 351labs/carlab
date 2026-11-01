// Run through lm-remote. Model-3 Mazda evaluation per mazda-protocol-model3.json.
// The historical measure-mazda.mjs (model 2, JS friction) stays the unchanged baseline adapter.
// Torque, fuel and air come from the Rust evaluateEngine at the measured boundary.
// `--smoke` evaluates E0/E1/E2a on the 12 already-inspected development rows only and writes nothing.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngineLab } from '../api/index.ts';
import { finiteNumber, scoreField, powerKwFromTorque, bsfcGkwh } from './metrics.mjs';
import { nelderMead, singularValues } from './fit.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const sourceCommit=()=>{try{return execFileSync('git',['rev-parse','HEAD'],{cwd:here,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return null;}};
const smoke=process.argv.includes('--smoke');
const output=resolve(process.argv.slice(2).find(a=>a.endsWith('.json'))??'docs/research-improvements/proof/mazda-model3.json');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async name=>{const bytes=await readFile(resolve(here,name));return {bytes,json:JSON.parse(bytes)};};
const {bytes:protocolBytes,json:protocol}=await read('mazda-protocol-model3.json');
const {bytes:fixtureBytes,json:fixture}=await read(protocol.fixture);
const {bytes:splitBytes,json:split}=await read(protocol.split);
const baselinePath=process.env.ENGINE_LAB_MAZDA_BASELINE;
if(!baselinePath)throw new Error('Set ENGINE_LAB_MAZDA_BASELINE to an independently supplied model-2 measurement report.');
const historicalBytes=await readFile(resolve(baselinePath));
const historical=JSON.parse(historicalBytes);
if(fixture.schema!==protocol.expectedFixtureSchema||split.schema!==protocol.expectedSplitSchema)throw new Error('Unexpected fixture or split schema.');
if(split.fixtureSha256!==sha(fixtureBytes)||split.frozenBeforeAnyModel3Fit!==true)throw new Error('Split is not frozen against this fixture.');
const wasmBytes=await readFile(resolve(here,'../native/dist/carlab_engine_lab.wasm'));
const core=await loadEngineLab({wasm:wasmBytes});
if(core.version.modelVersion!==protocol.modelVersion)throw new Error(`Protocol requires ${protocol.modelVersion}, loaded ${core.version.modelVersion}.`);

// Fuel: C/H only; stoichiometry mirrors Rust FuelChemistry::stoich_afr (same constants).
const carbon=fixture.fuelAnalysis.carbonWeightFraction,hydrogenCarbon=((1-carbon)/carbon)*(12.011/1.008);
const AIR=[[0.0280134,0.78084],[0.0319988,0.209476],[0.039948,0.00934],[0.0440095,0.000314]];
const stoichAfr=(1+hydrogenCarbon/4)*(AIR.reduce((s,[m,x])=>s+m*x,0)/AIR[1][1])/(0.012011+hydrogenCarbon*0.001008);

const engine=core.normalizeConfig(protocol.engine);
const training=new Set(split.trainingRows),bands=new Map(split.rows.map(r=>[r.excelRow,r.band]));
const inspected=new Set(historical.selection.excelRows);
const points=fixture.points.map(p=>({...p,band:bands.get(p.excelRow),group:training.has(p.excelRow)?'training':'holdout'}));
const trainingPoints=points.filter(p=>p.group==='training');
const experiments=Object.fromEntries(protocol.experiments.map(e=>[e.id,e]));
const physicalOf=e=>Object.fromEntries(Object.entries(e.physical==='as E2a'?experiments['E2a-conditional-unfitted'].physical:e.physical).map(([k,v])=>[k,v==='fuel.hydrogenCarbonRatio'?hydrogenCarbon:v]));
const close=(a,b,tol=1e-10)=>finiteNumber(a)&&finiteNumber(b)&&Math.abs(a-b)<=tol*Math.max(1,Math.abs(a),Math.abs(b));
const measuredFor=p=>({torqueNm:p.brakeTorqueNm,fuelMassFlowGs:p.fuelMassFlowGs,airMassFlowGs:p.airMassFlowGs,powerKw:powerKwFromTorque(p.brakeTorqueNm,p.rpm),bsfcGkwh:p.bsfcGkwh});

function physicalRequest(experiment,point,params={}){
 const {intakeCamBaseOffsetDeg=0,exhaustCamBaseOffsetDeg=0,...physicalParams}=params;
 return {...protocol.basePhysical,ambientPressureBar:point.cellKpaAbsolute/100,intakeTemperatureK:point.intakeC+273.15,...physicalOf(experiment),
  ...(experiment.measuredControls?{sparkAdvanceDeg:point.sparkAdvanceDegBtdc,intakeCamRetardDeg:point.intakeCamPhaseDeg+intakeCamBaseOffsetDeg,
   exhaustCamRetardDeg:point.exhaustCamPhaseDeg+exhaustCamBaseOffsetDeg,airFuelRatio:point.exhaustLambda*stoichAfr}:{}),
  ...physicalParams};
}
function normalizationReasons(actual,requested,label='physical'){
 return Object.entries(requested).flatMap(([key,value])=>{
  if(typeof value==='number')return close(actual[key],value)?[]:[`normalized ${label}.${key}`];
  if(typeof value==='string'||typeof value==='boolean')return actual[key]===value?[]:[`normalized ${label}.${key}`];
  return value&&typeof value==='object'?normalizationReasons(actual[key]??{},value,`${label}.${key}`):[];
 });
}
function admission(estimate,boundary,physical){
 const n=protocol.numerics,reasons=[];
 for(const source of [estimate,estimate.cycle])for(const[key,value]of Object.entries(source))if(typeof value==='number'&&!finiteNumber(value))reasons.push(`nonfinite ${key}`);
 if(!close(estimate.manifoldPressureBar*1e5,boundary.intakePressurePa,1e-9)||!close(estimate.exhaustPressureBar*1e5,boundary.exhaustPressurePa,1e-9))reasons.push('boundary not reproduced');
 for(const key of ['periodicMassRelativeError','periodicEnergyRelativeError'])if(!(Math.abs(estimate.cycle[key])<=n.maxPeriodicRelativeError))reasons.push(`${key}>2%`);
 if(!(Math.abs(estimate.cycle.massBalanceResidualKg)<=n.maxMassLedgerResidualKg))reasons.push('massBalanceResidualKg exceeds numerical ledger gate');
 if(!(Math.abs(estimate.cycle.energyBalanceResidualJ)<=n.maxEnergyLedgerResidualJ))reasons.push('energyBalanceResidualJ exceeds numerical ledger gate');
 if(physical.airflowModel==='ve-map-fit'&&estimate.mapExtrapolated)reasons.push('generic VE map extrapolation');
 if(physical.indicatedEfficiencyMap)reasons.push('unexpected optional efficiency target');
 if(estimate.warnings.some(w=>w.startsWith('Cam-shifted valve event')))reasons.push('cam event clamped');
 return reasons;
}
let evaluations=0;
function evaluate(experiment,point,params={},exhaustOffsetKpa=0,detail=true){
 evaluations++;
 const row={experiment:experiment.id,excelRow:point.excelRow,rpm:point.rpm,band:point.band,group:point.group,originallyInspected:inspected.has(point.excelRow),measured:measuredFor(point),valid:false,reasons:[],predicted:null};
 try{
  const request=physicalRequest(experiment,point,params),physical=core.normalizePhysicalConfig(engine,request);
  row.reasons.push(...normalizationReasons(physical,request));
  const boundary={intakePressurePa:point.mapKpaAbsolute*1000,intakeTemperatureK:point.intakeC+273.15,exhaustPressurePa:(point.catalystInletKpaAbsolute+exhaustOffsetKpa)*1000,
   exhaustTemperatureK:(point.exhaustPort1C+point.exhaustPort2C+point.exhaustPort3C+point.exhaustPort4C)/4+273.15};
  const e=core.evaluateEngine(engine,physical,point.rpm,1,0,boundary);
  const fuel=e.fuelMassFlowKgs*1000,power=powerKwFromTorque(e.torqueNm,point.rpm);
  row.predicted={torqueNm:e.torqueNm,fuelMassFlowGs:fuel,airMassFlowGs:e.netInletAirMassFlowKgs*1000,powerKw:power,bsfcGkwh:bsfcGkwh(fuel,power)};
  row.reasons.push(...admission(e,boundary,physical));
  if(detail)row.diagnostics={retainedAirMassFlowGs:e.airMassFlowKgs*1000,indicatedTorqueNm:e.indicatedTorqueNm,pumpingTorqueNm:e.pumpingTorqueNm,frictionTorqueNm:e.frictionTorqueNm,
   mappedVE:e.mappedVolumetricEfficiency,actualVE:e.actualVolumetricEfficiency,airFuelRatio:physical.airFuelRatio,sparkAdvanceDeg:physical.sparkAdvanceDeg,
   ...Object.fromEntries(['socDeg','ca10Deg','ca50Deg','ca90Deg','valveEventsDeg','residualFraction','trappedFreshMassKg','intakeReverseMassKg','wallHeatLossJ','peakHeatTransferWm2K','peakPressurePa','periodicMassRelativeError','periodicEnergyRelativeError','massBalanceResidualKg','energyBalanceResidualJ'].map(k=>[k,e.cycle[k]])),
   warnings:e.warnings};
 }catch(error){row.reasons.push(String(error.message??error));}
 row.valid=row.reasons.length===0;
 return row;
}
const relative=field=>({minRelativeDenominator:protocol.relativeDenominator[field]??protocol.relativeDenominator.default});
const summarize=rows=>Object.fromEntries(protocol.metrics.map(f=>[f,scoreField(rows,f,relative(f)).metrics]));
function table(label,rows){
 const m=summarize(rows),pct=v=>v===null?'  n/a':v.toFixed(1).padStart(5),nm=v=>v===null?'  n/a':v.toFixed(1).padStart(6);
 console.log(`${label.padEnd(36)} n=${String(m.torqueNm.count).padStart(3)}/${String(m.torqueNm.total).padEnd(3)} torque MAPE ${pct(m.torqueNm.mapePercent)}% MAE ${nm(m.torqueNm.mae)} bias ${nm(m.torqueNm.bias)} Nm | fuel MAPE ${pct(m.fuelMassFlowGs.mapePercent)}% | air MAPE ${pct(m.airMassFlowGs.mapePercent)}% bias ${m.airMassFlowGs.bias?.toFixed(2)} g/s`);
 return m;
}

try{
 const started=Date.now();
 // E0 must reproduce the the recorded baseline lab-generic-ve predictions on the 12 inspected rows.
 const historicalRows=new Map(historical.rows.filter(r=>r.variant===protocol.historicalBaseline.variant).map(r=>[r.excelRow,r]));
 const reproduction=[...inspected].map(n=>{
  const now=evaluate(experiments['E0-legacy'],points.find(p=>p.excelRow===n),{},0,false),then=historicalRows.get(n).predicted;
  const rel=k=>Math.abs(now.predicted[k]-then[k])/Math.max(1e-12,Math.abs(then[k]));
  return {excelRow:n,torque:rel('torqueNm'),fuel:rel('fuelMassFlowGs'),air:rel('airMassFlowGs')};
 });
 const reproductionMax=Math.max(...reproduction.flatMap(r=>[r.torque,r.fuel,r.air]));
 console.log(`E0 reproduction of the recorded baseline on 12 rows: max relative difference ${reproductionMax.toExponential(2)}`);
 // Stoichiometry self-check: NASA burned-gas equivalence ratio must equal 1/lambda.
 const probe=trainingPoints[0],probeExperiment=experiments['E2a-conditional-unfitted'],probePhysical=core.normalizePhysicalConfig(engine,physicalRequest(probeExperiment,probe));
 const probeCycle=core.getCylinderCycle(engine,probePhysical,probe.rpm,1,{intakePressurePa:probe.mapKpaAbsolute*1000,intakeTemperatureK:probe.intakeC+273.15,exhaustPressurePa:probe.catalystInletKpaAbsolute*1000,exhaustTemperatureK:(probe.exhaustPort1C+probe.exhaustPort2C+probe.exhaustPort3C+probe.exhaustPort4C)/4+273.15},0);
 const stoichCheck={excelRow:probe.excelRow,lambda:probe.exhaustLambda,burnedGasEquivalenceRatio:probeCycle.burnedGasEquivalenceRatio,expected:1/probe.exhaustLambda};
 // EngineEstimate.exhaustTemperatureK is a computed gas temperature; the boundary echo is checked on the cycle config here.
 if(!close(probeCycle.config.exhaustTemperatureK,(probe.exhaustPort1C+probe.exhaustPort2C+probe.exhaustPort3C+probe.exhaustPort4C)/4+273.15)||!close(probeCycle.config.intakeTemperatureK,probe.intakeC+273.15))throw new Error('Temperature boundary not applied.');
 if(!close(stoichCheck.burnedGasEquivalenceRatio,stoichCheck.expected,1e-9))throw new Error(`Stoichiometry mismatch with Rust: ${JSON.stringify(stoichCheck)}`);
 console.log(`fuel H/C ${hydrogenCarbon.toFixed(4)}, AFR_st ${stoichAfr.toFixed(4)}; Rust phi check ${JSON.stringify(stoichCheck)}`);

 if(smoke){
  for(const id of ['E0-legacy','E1-physics-unfitted','E2a-conditional-unfitted']){
   const t=Date.now(),rows=points.filter(p=>inspected.has(p.excelRow)).map(p=>evaluate(experiments[id],p));
   table(`${id} [12 inspected]`,rows);
   for(const r of rows.filter(r=>!r.valid))console.log(`  row${r.excelRow} excluded: ${r.reasons.join('; ')}`);
   console.log(`  ${((Date.now()-t)/rows.length).toFixed(1)} ms/evaluation`);
  }
  process.exit(0);
 }

 // Declared two-stage fit on training rows only; every objective evaluation is logged.
 const fitLog=[],fitted={},E2b=experiments['E2b-conditional-fitted'];
 for(const stage of protocol.fit.stages){
  const ps=stage.parameters,decode=x=>Object.fromEntries(ps.map((p,i)=>[p.name,p.min+x[i]*(p.max-p.min)]));
  const objective=x=>{
   const params={...fitted,...decode(x)},rows=trainingPoints.map(p=>evaluate(E2b,p,params,0,false));
   const terms=rows.map(r=>stage.target==='airMassFlowGs'
    ?(r.valid&&r.predicted.airMassFlowGs>0?Math.log(r.predicted.airMassFlowGs/r.measured.airMassFlowGs)**2:1)
    :(r.valid?(r.predicted.torqueNm-r.measured.torqueNm)**2:2500));
   const value=terms.reduce((s,v)=>s+v,0)/terms.length;
   fitLog.push({stage:stage.id,params:decode(x),objective:value,admitted:rows.filter(r=>r.valid).length});
   return value;
  };
  const result=nelderMead(objective,ps.map(p=>(p.start-p.min)/(p.max-p.min)),{step:.1,maxEvaluations:stage.maxEvaluations,tolerance:1e-9});
  Object.assign(fitted,decode(result.x));
  console.log(`fit ${stage.id}: ${JSON.stringify(decode(result.x))} objective ${result.f.toPrecision(6)} after ${result.evaluations} evaluations`);
 }

 const results={};
 for(const e of protocol.experiments)results[e.id]=points.map(p=>evaluate(e,p,e.fit?fitted:{}));
 const summary={};
 for(const e of protocol.experiments){
  const rows=results[e.id];
  summary[e.id]={all:table(`${e.id} all`,rows),training:table(`${e.id} training`,rows.filter(r=>r.group==='training')),holdout:table(`${e.id} holdout`,rows.filter(r=>r.group==='holdout')),
   bands:Object.fromEntries([...new Set(points.map(p=>p.band))].map(b=>[b,summarize(rows.filter(r=>r.band===b))]))};
 }

 // Scaled Jacobian at the fitted point (training rows).
 const jac=protocol.diagnostics.jacobian,bounds={...Object.fromEntries(protocol.fit.stages.flatMap(s=>s.parameters.map(p=>[p.name,[p.min,p.max]]))),...jac.jacobianBounds};
 const center={...fitted,frictionBaseBar:protocol.basePhysical.frictionBaseBar,frictionSpeedBar:protocol.basePhysical.frictionSpeedBar,heatTransferMultiplier:1};
 const sigma={torqueNm:m=>Math.max(.5,.01*Math.abs(m)),fuelMassFlowGs:m=>.01*Math.abs(m),airMassFlowGs:m=>.01*Math.abs(m)};
 const jacobianRows=[];let jacobianExcludedPoints=0;
 for(const p of trainingPoints){
  const columns=jac.parameters.map(name=>{
   const [lo,hi]=bounds[name],h=.01*(hi-lo);
   const plus=evaluate(E2b,p,{...center,[name]:center[name]+h},0,false),minus=evaluate(E2b,p,{...center,[name]:center[name]-h},0,false);
   return plus.valid&&minus.valid?jac.observables.map(o=>(plus.predicted[o]-minus.predicted[o])/(2*h)*(hi-lo)/sigma[o](measuredFor(p)[o])):null;
  });
  if(columns.some(c=>c===null)){jacobianExcludedPoints++;continue;}
  jac.observables.forEach((o,i)=>jacobianRows.push(columns.map(c=>c[i])));
 }
 const singular=singularValues(jacobianRows),subset=names=>singularValues(jacobianRows.map(r=>names.map(n=>r[jac.parameters.indexOf(n)])));
 const rankOf=s=>({singularValues:s,numericalRank:s.filter(v=>v>=1e-6*s[0]).length,practicallyIdentifiable:s.filter(v=>v>=1).length,conditionNumber:s[0]/s[s.length-1]});
 const jacobian={parameters:jac.parameters,rowsUsed:jacobianRows.length,pointsExcluded:jacobianExcludedPoints,all:rankOf(singular),
  fitted:rankOf(subset(protocol.fit.stages.flatMap(s=>s.parameters.map(p=>p.name)))),
  combustionAndFriction:rankOf(subset(['sparkToSocDeg','burnDurationDeg','frictionBaseBar','frictionSpeedBar'])),
  torqueOnlyCombustionAndFriction:rankOf(singularValues(jacobianRows.filter((_,i)=>i%3===0).map(r=>['sparkToSocDeg','burnDurationDeg','frictionBaseBar','frictionSpeedBar'].map(n=>r[jac.parameters.indexOf(n)]))))};
 console.log(`Jacobian: ${JSON.stringify(jacobian.all)}`);

 // Exhaust-pressure sensitivity (diagnostic only).
 const sensitivity=Object.fromEntries(protocol.diagnostics.exhaustPressureSensitivity.offsetsKpa.map(dp=>{
  const rows=dp===0?results['E2b-conditional-fitted']:points.map(p=>evaluate(E2b,p,fitted,dp,false));
  return [`${dp}kPa`,{training:table(`E2b exhaust +${dp} kPa training`,rows.filter(r=>r.group==='training')),holdout:table(`E2b exhaust +${dp} kPa holdout`,rows.filter(r=>r.group==='holdout'))}];
 }));

 const sourceFiles=['config.rs','powertrain.rs','cylinder_cycle.rs','gas_properties.rs','maps.rs','lib.rs'];
 const modelSourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async name=>[name,sha(await readFile(resolve(here,'../native/src',name)))])));
 const report={schema:'carlab-engine-measurement-2',createdUtc:new Date().toISOString(),host:hostname(),node:process.version,sourceCommit:sourceCommit(),
  api:core.version,wasmSha256:sha(wasmBytes),protocolSha256:sha(protocolBytes),fixtureSha256:sha(fixtureBytes),splitSha256:sha(splitBytes),historicalProofSha256:sha(historicalBytes),
  adapterSha256:sha(await readFile(fileURLToPath(import.meta.url))),metricsSha256:sha(await readFile(resolve(here,'metrics.mjs'))),fitSha256:sha(await readFile(resolve(here,'fit.mjs'))),modelSourceHashes,
  fuel:{hydrogenCarbon,stoichAfr,stoichCheck},e0Reproduction:{maxRelativeDifference:reproductionMax,rows:reproduction},
  fitted,fitLog,summary,jacobian,exhaustPressureSensitivity:sensitivity,evaluations,runtimeSeconds:(Date.now()-started)/1000,
  rows:Object.values(results).flat(),
  interpretation:{status:'model3-conditional-heldout',heldOutBands:split.holdoutLimits,realEngineAccuracyPass:null,
   warning:'Holdout bands are complete separate speed sweeps from the same engine/session. E2 uses measured spark, cam phase and lambda as inputs, so it is a conditional experiment, not a predictive engine model. Power and BSFC are derived observables.'}};
 await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,1)+'\n');
 console.log(`wrote ${output} (${evaluations} evaluations, ${report.runtimeSeconds.toFixed(0)} s)`);
}finally{core.dispose();}
