// Freezes the model-3 Mazda split from source RPM only (no model output, no
// measured torque/air/fuel). `--check` verifies the committed file still follows it.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const fixtureBytes=await readFile(resolve(here,'mazda-measured-all.json'));
const fixture=JSON.parse(fixtureBytes),frozen12=JSON.parse(await readFile(resolve(here,'mazda-measured.json'))).selection.excelRows;
const NOMINAL=[1000,1250,1500,1750,2000,2500,3000,3500,4000,4500],TRAINING_BANDS=[1500,2000,3000,4500],TOLERANCE=30;
export function bandOf(rpm){
 const nominal=NOMINAL.find(n=>Math.abs(rpm-n)<=TOLERANCE);
 return nominal!==undefined?String(nominal):rpm<1000-TOLERANCE?'below-1000':'off-grid';
}
const rows=fixture.points.map(p=>({excelRow:p.excelRow,rpm:p.rpm,band:bandOf(p.rpm)}));
const training=rows.filter(r=>TRAINING_BANDS.map(String).includes(r.band));
const holdout=rows.filter(r=>!training.includes(r));
if(!frozen12.every(row=>training.some(r=>r.excelRow===row)))throw new Error('Every previously inspected point must be in the development/training set.');
const split={
 schema:'carlab-mazda-split-1',id:'mazda-e0-model3-split-1',
 fixture:'mazda-measured-all.json',fixtureSha256:createHash('sha256').update(fixtureBytes).digest('hex'),
 frozenBeforeAnyModel3Fit:true,
 rule:`Band = nominal speed in ${NOMINAL.join('/')} within +/-${TOLERANCE} rpm of measured Speed; otherwise 'below-1000' (<${1000-TOLERANCE} rpm) or 'off-grid'. Training/development = every row in the ${TRAINING_BANDS.join('/')} rpm bands, which contain all 12 previously inspected rows. Holdout = every other row. Selection uses measured RPM only.`,
 trainingBands:TRAINING_BANDS.map(String),
 developmentVisible:'The 12 original rows were inspected with model outputs (the recorded baseline); their four complete bands are therefore development/training data, never holdout.',
 disclosure:'All 137 raw source rows (inputs and measured outputs) were printed once to establish band structure and the cam-channel sign convention before this split was frozen. No model output had been computed for any holdout row.',
 holdoutLimits:'Holdout bands are complete separate sweeps from the same engine, cell and session package, not an independent engine or campaign. 1750/2500/3500/4000 rpm lie between training bands (interpolation in speed); below-1000/1000/1250 lie below them (extrapolation).',
 trainingRows:training.map(r=>r.excelRow),
 holdoutRows:holdout.map(r=>r.excelRow),
 rows,
};
const out=resolve(here,'mazda-split-model3.json'),text=JSON.stringify(split,null,1)+'\n';
if(process.argv.includes('--check')){
 if(await readFile(out,'utf8')!==text)throw new Error('mazda-split-model3.json differs from its declared rule/fixture.');
 console.log(`split verified: ${training.length} training, ${holdout.length} holdout`);
}else{await writeFile(out,text);console.log(`wrote split: ${training.length} training, ${holdout.length} holdout`);}
