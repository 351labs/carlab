import test from 'node:test';
import assert from 'node:assert/strict';
import {finiteNumber,compareValue,scoreField,powerKwFromTorque,bsfcGkwh} from './metrics.mjs';
const close=(actual,expected,tolerance=1e-12)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} ≠ ${expected}`);
const row=(predicted,measured,extra={})=>({predicted:{torqueNm:predicted},measured:{torqueNm:measured},...extra});
test('independent hand-calculated signed, absolute, RMS and percentage errors',()=>{
 const result=scoreField([row(12,10),row(18,20),row(30,25)],'torqueNm');
 assert.deepEqual(result.rows.map(r=>r.comparison.residual),[2,-2,5]);
 const m=result.metrics;assert.equal(m.count,3);assert.equal(m.invalidCount,0);assert.equal(m.coverage,1);
 close(m.bias,5/3);close(m.mae,3);close(m.rmse,Math.sqrt(11));close(m.mapePercent,50/3);
 assert.equal(m.maxAbsoluteError,5);assert.equal(m.maxRelativeError,.2);assert.equal(m.relativeCount,3);
});
test('null, strings and nonfinite values never become numeric zero',()=>{
 for(const value of [null,undefined,'0',NaN,Infinity,-Infinity]){
  assert.equal(finiteNumber(value),false);assert.equal(compareValue(value,1).valid,false);assert.equal(compareValue(1,value).valid,false);
 }
 assert.equal(finiteNumber(0),true);assert.equal(compareValue(0,0).residual,0);
 assert.equal(compareValue(Number.MAX_VALUE,-Number.MAX_VALUE).valid,false);
});
test('invalid rows and explicit finite admission failures stay in evidence but outside aggregates',()=>{
 const given=[row(12,10),row(null,1,{id:'missing'}),row(2,null),row(NaN,1),row(1,Infinity),row('2',2),row(200,1,{valid:false,reason:'Unsettled cycle'}),row(500,1,{admitted:false,reasons:['Normalization changed input','Outside declared regime']})];
 const result=scoreField(given,'torqueNm'),m=result.metrics;
 assert.equal(m.total,8);assert.equal(m.count,1);assert.equal(m.invalidCount,7);assert.equal(m.coverage,1/8);
 assert.equal(m.bias,2);assert.equal(m.rmse,2);assert.equal(m.maxAbsoluteError,2);
 assert.equal(result.rows.length,8);assert.equal(result.rows[1].id,'missing');assert.equal(result.rows[6].reason,'Unsettled cycle');
 assert.deepEqual(result.rows[7].reasons,given[7].reasons);assert.equal(result.rows[7].comparison.valid,false);assert.equal(given[0].comparison,undefined);
});
test('relative denominator uses measured magnitude and excludes near-zero conditions only from relative metrics',()=>{
 const result=scoreField([row(2,0),row(.75,.5),row(-3,-2)],'torqueNm',{minRelativeDenominator:1});
 assert.equal(result.metrics.count,3);assert.equal(result.metrics.relativeCount,1);assert.equal(result.metrics.relativeCoverage,1/3);
 assert.equal(result.rows[0].comparison.relativeError,null);assert.equal(result.rows[1].comparison.relativeError,null);assert.equal(result.rows[2].comparison.relativeError,-.5);
 assert.equal(result.metrics.mapePercent,50);assert.equal(result.metrics.maxRelativeError,.5);
 for(const threshold of [0,-1,null,NaN,Infinity])assert.throws(()=>compareValue(1,1,{minRelativeDenominator:threshold}),/positive/);
});
test('empty or wholly rejected conditions retain null error metrics',()=>{
 for(const rows of [[],[row(null,null)],[row(1,1,{valid:false})]]){
  const m=scoreField(rows,'torqueNm').metrics;assert.equal(m.count,0);
  for(const key of ['bias','mae','rmse','mapePercent','maxAbsoluteError','maxRelativeError'])assert.equal(m[key],null);
 }
 assert.equal(scoreField([],'torqueNm').metrics.coverage,0);
});
test('mechanical power and BSFC preserve units and reject unavailable or nonpositive consumption cases',()=>{
 close(powerKwFromTorque(100,3000),10*Math.PI);close(powerKwFromTorque(-100,3000),-10*Math.PI);
 assert.equal(powerKwFromTorque(100,0),0);assert.equal(powerKwFromTorque(null,3000),null);assert.equal(powerKwFromTorque(100,NaN),null);
 assert.equal(bsfcGkwh(1,10),360);assert.equal(bsfcGkwh(.5,20),90);
 for(const power of [0,-1,null,NaN,Infinity])assert.equal(bsfcGkwh(1,power),null);
 for(const fuel of [0,-1,null,NaN,Infinity])assert.equal(bsfcGkwh(fuel,10),null);
});
test('RMS remains finite for large same-sign finite residuals',()=>{
 const m=scoreField([row(1e200,0),row(1e200,0)],'torqueNm').metrics;assert.equal(m.rmse,1e200);assert.equal(m.mae,1e200);assert.equal(m.bias,1e200);
});
