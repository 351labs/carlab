/** Pure measurement scoring. Relative errors are fractions; MAPE alone is percent. */
export const finiteNumber=value=>typeof value==='number'&&Number.isFinite(value);
const finiteOrNull=value=>finiteNumber(value)?value:null;
export function powerKwFromTorque(torqueNm,rpm){
 return finiteNumber(torqueNm)&&finiteNumber(rpm)?finiteOrNull(torqueNm*rpm*(2*Math.PI/60)/1000):null;
}
/** Fuel is g/s; meaningful BSFC requires positive consumed fuel and brake power. */
export function bsfcGkwh(fuelGps,powerKw){
 return finiteNumber(fuelGps)&&finiteNumber(powerKw)&&fuelGps>0&&powerKw>0?finiteOrNull(fuelGps*3600/powerKw):null;
}
export function compareValue(predicted,measured,{minRelativeDenominator=1e-9}={}){
 if(!finiteNumber(minRelativeDenominator)||minRelativeDenominator<=0)throw new RangeError('minRelativeDenominator must be finite and positive.');
 const out={valid:false,residual:null,absoluteError:null,relativeError:null,absoluteRelativeError:null,reason:null,relativeReason:null};
 if(!finiteNumber(predicted)||!finiteNumber(measured)){out.reason='Predicted and measured values must be finite numbers; null is not zero.';return out;}
 const residual=predicted-measured;if(!finiteNumber(residual)){out.reason='Residual overflow.';return out;}
 out.valid=true;out.residual=residual;out.absoluteError=Math.abs(residual);
 if(Math.abs(measured)<minRelativeDenominator){out.relativeReason='Measured magnitude is below the relative-error threshold.';return out;}
 const relative=residual/Math.abs(measured);
 if(!finiteNumber(relative)){out.relativeReason='Relative-error overflow.';return out;}
 out.relativeError=relative;out.absoluteRelativeError=Math.abs(relative);return out;
}
/** Rows contain predicted[field]/measured[field]. Admission flags override finite
 * numerics. Rejected rows, their original reasons and numerical deltas remain in
 * rows; only admitted valid comparisons enter aggregates. Inputs are not mutated.
 */
export function scoreField(rows,field,options={}){
 if(!Array.isArray(rows)||typeof field!=='string'||!field)throw new TypeError('scoreField requires rows and a field name.');
 const scored=rows.map(row=>{
  const comparison=compareValue(row?.predicted?.[field],row?.measured?.[field],options);
  if(row?.valid===false||row?.admitted===false){comparison.valid=false;comparison.excluded=true;comparison.reason=row.reason??(Array.isArray(row.reasons)?row.reasons.join('; '):null)??'Row excluded by admission gate.';}
  return {...row,comparison};
 });
 const accepted=scored.filter(row=>row.comparison.valid),relative=accepted.filter(row=>finiteNumber(row.comparison.relativeError));
 const total=scored.length,count=accepted.length,relativeCount=relative.length;
 const maximum=accepted.reduce((max,row)=>Math.max(max,row.comparison.absoluteError),0);
 // Scale before summing/squaring so large finite residuals do not overflow RMS.
 const normalized=accepted.map(row=>maximum===0?0:row.comparison.residual/maximum);
 const mean=values=>values.length?values.reduce((sum,value)=>sum+value/values.length,0):null;
 const relativeMaximum=relative.reduce((max,row)=>Math.max(max,row.comparison.absoluteRelativeError),0);
 return {field,rows:scored,metrics:{total,count,invalidCount:total-count,relativeCount,
  coverage:total?count/total:0,relativeCoverage:total?relativeCount/total:0,
  bias:count?finiteOrNull(maximum*mean(normalized)):null,
  mae:count?finiteOrNull(maximum*mean(normalized.map(Math.abs))):null,
  rmse:count?finiteOrNull(maximum*Math.sqrt(mean(normalized.map(value=>value*value)))):null,
  mapePercent:relativeCount?finiteOrNull(mean(relative.map(row=>row.comparison.absoluteRelativeError))*100):null,
  maxAbsoluteError:count?maximum:null,maxRelativeError:relativeCount?relativeMaximum:null}};
}
