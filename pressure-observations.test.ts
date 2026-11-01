import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePressureCsv,comparePressureTrace,requirePressureFitCoverage } from './pressure-observations.ts';

test('pressure CSV has explicit absolute units and angle origin',()=>{
 const csv='angle_deg,pressure_bar_abs\n'+Array.from({length:13},(_,i)=>`${i*30-180},${i+1}`).join('\n');
 const observation=parsePressureCsv(csv,'firing-tdc');assert.equal(observation.angleDeg[0],180);assert.equal(observation.angleDeg.at(-1),540);assert.equal(observation.pressurePa[3],400000);
 assert.throws(()=>parsePressureCsv(csv,'intake-tdc'));assert.throws(()=>parsePressureCsv(csv.replace('150,12','120,12'),'firing-tdc'));
 assert.throws(()=>parsePressureCsv('angle,p\n'+Array.from({length:12},(_,i)=>`${i},NaN`).join('\n')));
});
test('pressure comparison interpolates common angles without extrapolating or mixing bar and Pa',()=>{
 const observation={angleDeg:[0,90,180,270,360,450,540,630,720],pressurePa:[1,1.5,2,2.5,3,3.5,4,4.5,5].map(n=>n*1e5)};
 const exact=comparePressureTrace([0,180,360,540,720],[1e5,2e5,3e5,4e5,5e5],observation);assert.equal(exact.rmseBar,0);assert.equal(exact.samples,9);
 const shifted=comparePressureTrace([0,180,360,540,720],[2e5,3e5,4e5,5e5,6e5],observation,[180,540]);assert.equal(shifted.samples,5);assert.equal(shifted.rmseBar,1);assert.equal(shifted.maeBar,1);
 assert.throws(()=>comparePressureTrace([1,0],[1e5,2e5],observation));
 assert.throws(()=>comparePressureTrace([0,720],[1e5,2e5],{angleDeg:[360,180],pressurePa:[1e5,1e5]}));
});

test('burn fit requires observations across compression and burn rather than a clustered point count',()=>{
 const sample=(angles:number[])=>({angleDeg:angles,pressurePa:angles.map(()=>1e5)});
 assert.throws(()=>requirePressureFitCoverage(sample([0,...Array.from({length:25},(_,i)=>475+i),720])));
 assert.throws(()=>requirePressureFitCoverage(sample([240,...Array.from({length:24},(_,i)=>460+i),500])));
 const covered=sample(Array.from({length:145},(_,i)=>i*5));assert.equal(requirePressureFitCoverage(covered),covered);
});
