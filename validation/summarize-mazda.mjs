// Pure reduction of recorded evidence; run through lm-remote, no model execution.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root='docs/validation-real-engines';
const resultPath=process.argv[2];
if(!resultPath)throw new Error('Provide the path to a current, independently produced measurement JSON report.');
const rawReport=await readFile(resolve(resultPath));
const report=JSON.parse(rawReport.toString('utf8'));
const expectedFixtureHash=createHash('sha256').update(await readFile(new URL('./mazda-measured.json',import.meta.url))).digest('hex');
if(report.schema!=='carlab-engine-measurement-1'||report.fixtureSha256!==expectedFixtureHash||!Array.isArray(report.rows)||report.rows.length!==36||!report.summary||!report.protocol?.variants)throw new Error('Expected a current 36-row measurement report bound to the imported fixture.');
const fmt=(v,n=2)=>typeof v==='number'&&Number.isFinite(v)?v.toFixed(n):'not evaluated';
const lab=report.rows.filter(r=>r.variant==='lab-generic-ve');
const fixed=report.rows.filter(r=>r.variant==='fixed-valve');
const settled=report.rows.filter(r=>r.variant==='fixed-valve-settled');
const max=values=>Math.max(...values.map(Math.abs));
const settlingTorqueDelta=max(fixed.map((r,i)=>r.predicted.torqueNm-settled[i].predicted.torqueNm));
const settlingFuelDelta=max(fixed.map((r,i)=>r.predicted.fuelMassFlowGs-settled[i].predicted.fuelMassFlowGs));
const genericTorqueDelta=max(lab.map((r,i)=>r.predicted.torqueNm-fixed[i].predicted.torqueNm));
const veMiss=lab.filter(r=>Math.abs(r.diagnostics.calibration.veResidual)>.03).length;
const maxPeriodicMass=max(report.rows.map(r=>r.diagnostics.periodicMassRelativeError));
const maxPeriodicEnergy=max(report.rows.map(r=>r.diagnostics.periodicEnergyRelativeError));
const maxMassLedger=max(report.rows.map(r=>r.diagnostics.massBalanceResidualKg));
const maxEnergyLedger=max(report.rows.map(r=>r.diagnostics.energyBalanceResidualJ));
const fields=[['torqueNm','Brake-shaft torque','Nm'],['fuelMassFlowGs','Measured fuel flow','g/s'],['airMassFlowGs','Net inlet airflow proxy','g/s'],['bsfcGkwh','Specific fuel consumption (derived)','g/kWh']];
const totals=fields.map(([field,name,unit])=>{const m=report.summary['lab-generic-ve'][field];return`| ${name} | ${fmt(m.bias)} ${unit} | ${fmt(m.mae)} ${unit} | ${fmt(m.rmse)} ${unit} | ${fmt(m.mapePercent)}% | ${m.count}/${m.total} |`;}).join('\n');
const rows=lab.map(r=>`| ${r.excelRow} | ${fmt(r.rpm,0)} | ${fmt(r.mapKpaAbsolute,1)} | ${fmt(r.measured.torqueNm,1)} | ${fmt(r.predicted.torqueNm,1)} | ${fmt((r.predicted.torqueNm/r.measured.torqueNm-1)*100,1)}% | ${fmt(r.measured.fuelMassFlowGs,3)} | ${fmt(r.predicted.fuelMassFlowGs,3)} |`).join('\n');
const variants=report.protocol.variants.map(v=>{const t=report.summary[v].torqueNm,f=report.summary[v].fuelMassFlowGs;return`| ${v} | ${fmt(t.mapePercent)}% | ${fmt(f.mapePercent)}% | ${t.count}/${t.total} |`;}).join('\n');
const text=`# First measured-engine comparison: Mazda 2.0 E0

**This supplied report describes the generic model under its recorded conditions.** On 12 predetermined warm steady points, the lab's bounded generic-VE path has **${fmt(report.summary['lab-generic-ve'].torqueNm.mapePercent)}% torque MAPE**, **${fmt(report.summary['lab-generic-ve'].fuelMassFlowGs.mapePercent)}% fuel-flow MAPE** and **${fmt(report.summary['lab-generic-ve'].airMassFlowGs.mapePercent)}% net-inlet-airflow MAPE**. This is an initial conditional discrepancy measurement, not a global fidelity percentage, a calibrated twin, or an engine-tuning recommendation.

See [data credits](../../credits.md#3-incorporated-measured-data-and-geometry-context) and the [source fixture](../../validation/mazda-measured.json) for the source, geometry, sensors, measured/calculated fields and missing inputs. The report records the admission gates. The EPA source contains 137 steady points; this campaign scores a **fixed 12-point subset**, not the entire map.

## What was frozen before the run

The [protocol](../../validation/mazda-protocol.json) and [source fixture](../../validation/mazda-measured.json) were selected before any model outputs. Selection spans approximately 1,500/2,000/3,000/4,500 rpm, lighter loads and measured maxima in three bands. No measured torque, fuel flow, air flow or BSFC enters an input or fitting target. Source spark/cam/lambda channels remain observations; they are not substituted for Wiebe phase or absolute valve events. There is no real-data parameter fitting and no train/holdout calibration claim.

Inputs include OEM 1,998 cc / I4 / 83.5 × 91.2 mm geometry, tested 13:1 compression, OEM 6,800 rpm redline and actual E0 fuel LHV 42.887 MJ/kg. Each point supplies measured RPM, absolute manifold pressure, intake temperature and cell pressure. The exhaust reservoir uses catalyst-inlet pressure and mean measured four-port temperature as **explicit sensor-location proxies**: unknown upstream header pressure loss/pulsation and cylinder differences remain unresolved.

Other inputs stay generic: rod ratio 1.7; AFR 14.7; effective heat-release phase 18° BTDC and duration 50°; gamma 1.33; combustion efficiency 0.96; wall 450 K / heat transfer 180 W/(m² K); valve events/areas/discharge; and the original friction formula. Full normalized configurations and per-point cycle settings are retained in [the supplied JSON evidence](proof/mazda-input.json). The measured accessory drive powered only the water pump; generic FMEP does not identify that exact boundary.

ECU is disabled. This evaluates the current reduced SI thermodynamic plant at measured boundaries, not the production DI injector/ECU. Optional indicated-efficiency/FMEP maps and pressure calibration are absent. The adapter derives shaft torque from net cylinder work minus friction using the native source equations; pumping is already included once in net work. No wheel/crank factor or atmospheric torque correction is invented. For the inlet-air comparison it uses signed net inlet flow, while separately retaining IVC trapped-fresh-air flow; neither proxy identifies every real manifold/storage/blow-through effect.

## Results: current lab path

Bias is predicted minus measured. MAPE is mean absolute percentage error, not an accuracy score. Low measured loads amplify percentage errors; absolute errors and coverage are therefore shown alongside it. BSFC and power are derived from torque/speed/fuel and do not supply additional independent sensors.

| Observable | Bias | MAE | RMSE | MAPE | Admitted |
|---|---:|---:|---:|---:|---:|
${totals}

Inspect the point table and the source report for individual discrepancies. Signed bias should be read alongside absolute error.

| Source row | RPM | MAP kPa abs | Torque measured Nm | Torque predicted Nm | Torque signed error | Fuel measured g/s | Fuel predicted g/s |
|---:|---:|---:|---:|---:|---:|---:|---:|
${rows}

## Numerical diagnostics and the alternative paths

| Variant | Torque MAPE | Fuel-flow MAPE | Admitted |
|---|---:|---:|---:|
${variants}

- **lab-generic-ve:** the actual current bounded three-trial inverse-area path, targeting only its original assumed VE map. **${veMiss}/12 points failed to reach that generic VE target** within the existing 0.03 residual warning threshold. Warnings remain in the artifact. These are actual solves, not a successful VE calibration or fitted measured engine.
- **fixed-valve:** calls the same raw Rust cylinder kernel with normalized generic valve geometry, bypassing inverse area fitting. Both this path and the current lab path use 3 settling cycles.
- **fixed-valve-settled:** the same fixed physical inputs, with 12 settling cycles for every selected point. Maximum torque change versus 3 cycles is **${settlingTorqueDelta.toExponential(3)} Nm**; maximum fuel change is **${settlingFuelDelta.toExponential(3)} g/s**. Insufficient settling does not explain the large discrepancies observed here; this is not a universal timestep/convergence proof.

The maximum current-lab versus fixed-valve torque change is ${fmt(genericTorqueDelta,4)} Nm. Neither changing the internal generic-VE path nor increasing settling removed the physical disagreement. This does not identify a unique physical cause.

${report.rows.filter(r=>r.valid).length}/${report.rows.length} point/variant rows pass the recorded finite/normalization/periodicity/ledger/map-domain admission checks. Maximum periodic mass drift: ${maxPeriodicMass.toExponential(3)}; energy drift: ${maxPeriodicEnergy.toExponential(3)} (both fractions, gate 0.02). Maximum absolute mass-ledger residual: ${maxMassLedger.toExponential(3)} kg; energy-ledger residual: ${maxEnergyLedger.toExponential(3)} J. Gates are internal numerical-consistency checks, not real-engine accuracy thresholds. Excluded rows remain visible in the source report. Live gas inventories, held-cycle/diesel-pressure coupling and delayed PI readiness are **not evaluated** by these static calls.

## Interpretation and next experiment

This generic configuration is not ready to represent this engine as a quantitative digital twin. A numerically consistent solve can still be physically inaccurate. The observed air and fuel errors, unachieved generic VE targets, missing actual VVT/base valve events, prescribed burn phase, generic thermal/friction inputs, exhaust sensor proxies and DI/PFI mismatch are competing explanations and limitations. The experiment does not isolate their individual contributions.

The next campaign should obtain/identify valve timing and effective breathing, then constrain combustion/heat loss/friction with independent observations. Preserve this unfitted baseline; declare a limited calibration parameter set and training regions before fitting, freeze them and evaluate complete withheld RPM/load bands. Do not fit measured torque/fuel at a point and score that same point as validation. Verify a second engine separately after freezing transferable assumptions. No ECU map, model default, preset, geometry domain or synthetic sound was changed to improve these scores.

This campaign does not validate predictive spark/knock, EFI or DI transients, emissions, durability or acoustic fidelity. Source torque uncertainty 0.0808 Nm, fuel 0.00640 g/s and speed 1.183 rpm are combined standard sensor uncertainties, not automatic 95% bounds on all derived/model outputs; the source additionally cautions about low-load relative uncertainty. The large reported discrepancies are not converted into a universal pass/fail tolerance.

## Reproduction and evidence

This document summarizes the explicitly supplied report. It does not assert when, where, or whether an independent run took place. The input report retains its own source, hashes and model identity.

Artifacts: [supplied JSON](proof/mazda-input.json), [point CSV](proof/mazda-points.csv), [summary CSV](proof/mazda-summary.csv). The source fixture remains source-only and separately hashed; the complete EPA archive is not bundled.
`;
await mkdir(`${root}/proof`,{recursive:true});
await writeFile(`${root}/MAZDA-MEASUREMENT.md`,text);
await writeFile(`${root}/proof/mazda-input.json`,rawReport);
const header=['variant','excelRow','rpm','mapKpaAbsolute','admitted','torqueMeasuredNm','torquePredictedNm','fuelMeasuredGs','fuelPredictedGs','airMeasuredGs','netAirPredictedGs','retainedAirPredictedGs','bsfcMeasuredGkwh','bsfcPredictedGkwh'];
const pointRows=report.rows.map(r=>[r.variant,r.excelRow,r.rpm,r.mapKpaAbsolute,r.valid,r.measured.torqueNm,r.predicted?.torqueNm??'',r.measured.fuelMassFlowGs,r.predicted?.fuelMassFlowGs??'',r.measured.airMassFlowGs,r.predicted?.airMassFlowGs??'',r.predicted?.retainedAirMassFlowGs??'',r.measured.bsfcGkwh,r.predicted?.bsfcGkwh??'']);
await writeFile(`${root}/proof/mazda-points.csv`,[header,...pointRows].map(r=>r.join(',')).join('\n')+'\n');
const summaryHeader=['variant','field','total','count','coverage','bias','mae','rmse','mapePercent','maxAbsoluteError','maxRelativeError'];
const summaryRows=Object.entries(report.summary).flatMap(([variant,fields])=>Object.entries(fields).map(([field,m])=>[variant,field,...summaryHeader.slice(2).map(k=>m[k]??'')]));
await writeFile(`${root}/proof/mazda-summary.csv`,[summaryHeader,...summaryRows].map(r=>r.join(',')).join('\n')+'\n');
console.log(JSON.stringify({report:resolve(`${root}/MAZDA-MEASUREMENT.md`),settlingTorqueDelta,settlingFuelDelta,genericTorqueDelta,veMiss,maxPeriodicMass,maxPeriodicEnergy,maxMassLedger,maxEnergyLedger}));
