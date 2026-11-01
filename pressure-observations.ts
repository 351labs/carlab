export interface PressureObservation { angleDeg:number[]; pressurePa:number[] }
export interface PressureError { samples:number; rmseBar:number; maeBar:number; maxErrorBar:number }

/** Local instrument data only. Pressure is absolute; angle origin is explicit.
 * The external-audio analyzer never feeds this pressure-calibration path.
 */
export function parsePressureCsv(text:string,origin:'intake-tdc'|'firing-tdc'='intake-tdc'):PressureObservation {
 if(typeof text!=='string'||text.length>300000)throw new Error('CSV de pressão inválido ou maior que 300 kB.');
 const rows=text.replace(/^\uFEFF/,'').split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
 if(rows.length&&/[a-zA-Z]/.test(rows[0])&&!/^[-+\d.]/.test(rows[0]))rows.shift();
 if(rows.length<12||rows.length>2000)throw new Error('Use de 12 a 2.000 pontos: ângulo e pressão absoluta em bar.');
 const angleDeg:number[]=[],pressurePa:number[]=[];
 for(const row of rows){
  const fields=row.split(/[;,\s]+/).filter(Boolean);if(fields.length!==2)throw new Error('Cada linha precisa de duas colunas: ângulo, pressão absoluta em bar. Use ponto decimal.');
  const angle=Number(fields[0])+(origin==='firing-tdc'?360:0),pressure=Number(fields[1])*1e5;
  if(!Number.isFinite(angle)||angle<0||angle>720||!Number.isFinite(pressure)||pressure<=0||pressure>1e8)throw new Error('Ângulos precisam estar entre 0 e 720° na convenção escolhida; pressão entre 0 e 1.000 bar absolutos.');
  if(angleDeg.length&&angle<=angleDeg.at(-1)!)throw new Error('Os ângulos devem ser estritamente crescentes, sem duplicatas.');
  angleDeg.push(angle);pressurePa.push(pressure);
 }
 return {angleDeg,pressurePa};
}

export function comparePressureTrace(angles:ArrayLike<number>,pressures:ArrayLike<number>,observation:PressureObservation,window:[number,number]=[0,720]):PressureError {
 if(angles.length<2||pressures.length!==angles.length||observation.angleDeg.length!==observation.pressurePa.length)throw new Error('Traços de pressão incompatíveis.');
 for(let i=0;i<angles.length;i++)if(!Number.isFinite(angles[i])||!Number.isFinite(pressures[i])||(i>0&&angles[i]<=angles[i-1]))throw new Error('O modelo precisa de ângulos crescentes e pressão finita.');
 let square=0,absolute=0,maximum=0,samples=0,index=0;
 for(let i=0;i<observation.angleDeg.length;i++){
  const angle=observation.angleDeg[i],measured=observation.pressurePa[i];
  if(!Number.isFinite(angle)||!Number.isFinite(measured)||(i>0&&angle<=observation.angleDeg[i-1]))throw new Error('Observação precisa de ângulos crescentes e pressão finita.');
  if(angle<window[0]||angle>window[1]||angle<angles[0]||angle>angles[angles.length-1])continue;
  while(index<angles.length-2&&angles[index+1]<angle)index++;
  const t=(angle-angles[index])/(angles[index+1]-angles[index]),predicted=pressures[index]+(pressures[index+1]-pressures[index])*t,error=(predicted-measured)/1e5;
  square+=error*error;absolute+=Math.abs(error);maximum=Math.max(maximum,Math.abs(error));samples++;
 }
 if(!samples)throw new Error('Nenhum ponto de pressão dentro do intervalo de comparação.');
 return {samples,rmseBar:Math.sqrt(square/samples),maeBar:absolute/samples,maxErrorBar:maximum};
}

/** Burn fitting must observe the compression/burn window, not just count nearby samples. */
export function requirePressureFitCoverage(observation:PressureObservation|undefined):PressureObservation {
 if(!observation)throw new Error('Nenhuma pressão instrumentada carregada.');
 const covered=observation.angleDeg.filter(a=>a>=240&&a<=500);
 if(covered.length<24||covered[0]>250||covered.at(-1)!<490||covered.some((angle,i)=>i>0&&(angle<=covered[i-1]||angle-covered[i-1]>12)))throw new Error('Para ajustar a queima, cubra 240–500° com pelo menos 24 pontos, extremos a até 10° e sem lacunas maiores que 12°.');
 return observation;
}
