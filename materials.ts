/** Original nominal rod-load screening. No alloy database, FEM geometry or
 * experimentally calibrated life model is supplied by this module.
 */
export interface MaterialProvenance {
 kind:'assumed'|'fitted'|'measured';
 source:string;
 conditions:string;
}
export interface AllowableStressPoint { temperatureK:number; value:number }
export interface FatiguePoint { stressAmplitudeMPa:number; cycles:number }
export interface FatigueCurve {
 temperatureK:number;
 /** Explicit applicability band supplied with the card, not inferred. */
 temperatureToleranceK:number;
 stressRatio:number;
 stressRatioTolerance:number;
 conditions:string;
 points:FatiguePoint[];
}
export interface MaterialCard {
 schema:1;
 name:string;
 provenance:MaterialProvenance;
 /** Owner-specified nominal uniaxial design limits. Not automatically yield,
  * ultimate strength, a fatigue limit, or a component-safe stress.
  */
 allowableStressMPa:AllowableStressPoint[];
 fatigueCurves?:FatigueCurve[];
}
export interface MaterialScreenConfig {
 netSectionMm2:number;
 stressConcentration:number;
 componentTemperatureK:number;
 componentTemperatureSource:string;
 crankcasePressurePa:number;
 durationSeconds:number;
 /** Explicit constant-amplitude envelope-count assumption; no rainflow model. */
 cyclesPerEngineCycle:number;
 material:MaterialCard|null;
}
export interface MechanicalCycleInput {
 angleDeg:ArrayLike<number>;
 pressurePa:ArrayLike<number>;
 boreM:number;
 strokeM:number;
 rodLengthM:number;
 reciprocatingMassKg:number;
 rpm:number;
}
export interface MaterialScreenResult {
 status:'not-evaluated'|'within-card'|'exceeds-card';
 reason:string;
 materialName:string|null;
 provenance:MaterialProvenance|null;
 allowableStressMPa:number|null;
 peakTensileStressMPa:number;
 peakCompressiveStressMPa:number;
 maximumAbsoluteStressMPa:number;
 stressAmplitudeMPa:number;
 meanStressMPa:number;
 stressRatio:number|null;
 peakTensileAngleDeg:number|null;
 peakCompressiveAngleDeg:number|null;
 trace:{angleDeg:number[];gasForceN:number[];inertiaForceN:number[];rodCompressionForceN:number[];stressMPa:number[]};
 fatigue:{
  status:'not-evaluated'|'evaluated';
  reason:string;
  curveTemperatureK:number|null;
  cyclesAtAmplitude:number|null;
  appliedEnvelopeCycles:number;
  damageFraction:number|null;
 };
 assumptions:string[];
}

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
 && (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const clamp=(value:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,value));
const bounded=(value:unknown,fallback:number,lo:number,hi:number)=>typeof value==='number'&&Number.isFinite(value)?clamp(value,lo,hi):fallback;
function text(value:unknown,label:string,max=2000):string {
 if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${label}: texto obrigatório e limitado a ${max} caracteres.`);
 return value.trim();
}
function positive(value:unknown,label:string):number {
 if(typeof value!=='number'||!Number.isFinite(value)||value<=0)throw new Error(`${label}: valor finito positivo obrigatório.`);
 return value;
}
function nonnegative(value:unknown,label:string):number {
 if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error(`${label}: valor finito não negativo obrigatório.`);
 return value;
}
function finite(value:unknown,label:string):number {
 if(typeof value!=='number'||!Number.isFinite(value))throw new Error(`${label}: número finito obrigatório.`);
 return value;
}

/** Strict import boundary. Every returned object/array is independent of input. */
export function parseMaterialCard(value:unknown):MaterialCard {
 if(!record(value)||value.schema!==1)throw new Error('Ficha de material inválida: use schema 1.');
 if(!record(value.provenance))throw new Error('A ficha precisa de proveniência.');
 const p=value.provenance;
 if(p.kind!=='assumed'&&p.kind!=='fitted'&&p.kind!=='measured')throw new Error('Proveniência deve ser assumed, fitted ou measured.');
 if(!Array.isArray(value.allowableStressMPa)||value.allowableStressMPa.length<1||value.allowableStressMPa.length>128)throw new Error('Forneça de 1 a 128 limites de tensão por temperatura.');
 const allowableStressMPa=Array.from(value.allowableStressMPa,(point:unknown)=>{
  if(!record(point))throw new Error('Ponto de tensão admissível inválido.');
  return {temperatureK:positive(point.temperatureK,'Temperatura'),value:positive(point.value,'Tensão nominal admissível')};
 }).sort((a,b)=>a.temperatureK-b.temperatureK);
 if(new Set(allowableStressMPa.map(point=>point.temperatureK)).size!==allowableStressMPa.length)throw new Error('Temperaturas duplicadas na ficha.');
 const card:MaterialCard={schema:1,name:text(value.name,'Nome',120),provenance:{kind:p.kind,source:text(p.source,'Fonte',1000),conditions:text(p.conditions,'Condições')},allowableStressMPa};
 if(value.fatigueCurves!==undefined){
  if(!Array.isArray(value.fatigueCurves)||value.fatigueCurves.length>32)throw new Error('Use no máximo 32 curvas de fadiga.');
  card.fatigueCurves=Array.from(value.fatigueCurves,(curve:unknown)=>{
   if(!record(curve)||!Array.isArray(curve.points)||curve.points.length<2||curve.points.length>128)throw new Error('Curva S–N precisa de 2 a 128 pontos.');
   const points=Array.from(curve.points,(point:unknown)=>{
    if(!record(point))throw new Error('Ponto S–N inválido.');
    return {stressAmplitudeMPa:positive(point.stressAmplitudeMPa,'Amplitude de tensão'),cycles:positive(point.cycles,'Ciclos')};
   }).sort((a,b)=>a.stressAmplitudeMPa-b.stressAmplitudeMPa);
   if(points.some((point,i)=>i>0&&(point.stressAmplitudeMPa<=points[i-1].stressAmplitudeMPa||point.cycles>=points[i-1].cycles)))throw new Error('S–N deve ter amplitude crescente e número de ciclos decrescente.');
   return {temperatureK:positive(curve.temperatureK,'Temperatura S–N'),temperatureToleranceK:nonnegative(curve.temperatureToleranceK??0,'Domínio de temperatura S–N'),stressRatio:finite(curve.stressRatio,'Razão R S–N'),stressRatioTolerance:nonnegative(curve.stressRatioTolerance??0,'Domínio de R S–N'),conditions:text(curve.conditions,'Condições S–N'),points};
  });
 }
 return card;
}

/** Geometry/count/temperature defaults are labelled assumptions. There is no
 * default material card and therefore no default strength/life result.
 */
export function normalizeMaterialScreenConfig(value:unknown={}):MaterialScreenConfig {
 const source=record(value)?value:{};
 return {
  netSectionMm2:bounded(source.netSectionMm2,400,1,100_000),
  stressConcentration:bounded(source.stressConcentration,1,1,20),
  componentTemperatureK:bounded(source.componentTemperatureK,373.15,150,2000),
  componentTemperatureSource:typeof source.componentTemperatureSource==='string'&&source.componentTemperatureSource.trim()?source.componentTemperatureSource.trim().slice(0,1000):'Temperatura do componente assumida pelo usuário; não é a temperatura do gás.',
  crankcasePressurePa:bounded(source.crankcasePressurePa,101325,1000,1e6),
  durationSeconds:bounded(source.durationSeconds,60,0,1e9),
  cyclesPerEngineCycle:bounded(source.cyclesPerEngineCycle,1,.01,100),
  material:source.material==null?null:parseMaterialCard(source.material),
 };
}

function interpolateAllowable(points:AllowableStressPoint[],temperatureK:number):number|null {
 if(temperatureK<points[0].temperatureK||temperatureK>points.at(-1)!.temperatureK)return null;
 for(let i=0;i<points.length;i++){
  if(temperatureK===points[i].temperatureK)return points[i].value;
  if(i>0&&temperatureK<points[i].temperatureK){const a=points[i-1],b=points[i],t=(temperatureK-a.temperatureK)/(b.temperatureK-a.temperatureK);return a.value+(b.value-a.value)*t;}
 }
 return null;
}
function interpolateFatigue(points:FatiguePoint[],amplitude:number):number|null {
 if(amplitude<points[0].stressAmplitudeMPa||amplitude>points.at(-1)!.stressAmplitudeMPa)return null;
 for(let i=0;i<points.length;i++){
  if(amplitude===points[i].stressAmplitudeMPa)return points[i].cycles;
  if(i>0&&amplitude<points[i].stressAmplitudeMPa){const a=points[i-1],b=points[i],t=Math.log(amplitude/a.stressAmplitudeMPa)/Math.log(b.stressAmplitudeMPa/a.stressAmplitudeMPa);return Math.exp(Math.log(a.cycles)+(Math.log(b.cycles)-Math.log(a.cycles))*t);}
 }
 return null;
}

/** Constant-speed slider-crank inertia and gas force are evaluated at each same
 * crank angle. Stress is nominal axial force / owner section, scaled by owner Kt.
 * Bending, buckling, bolts, bearing contacts, thermal gradients and angular
 * acceleration are absent. This is an evidence-conditioned screen, not FEM.
 */
export function screenMaterial(cycle:MechanicalCycleInput,input:unknown={}):MaterialScreenResult {
 const config=normalizeMaterialScreenConfig(input),count=cycle.angleDeg.length;
 if(count<3||count>20_000||cycle.pressurePa.length!==count)throw new Error('Traço mecânico precisa de ângulos e pressões de mesmo tamanho.');
 const bore=positive(cycle.boreM,'Diâmetro'),stroke=positive(cycle.strokeM,'Curso'),rod=positive(cycle.rodLengthM,'Biela');
 const mass=nonnegative(cycle.reciprocatingMassKg,'Massa alternativa'),rpm=nonnegative(cycle.rpm,'RPM'),r=stroke/2;
 if(rod<=r)throw new Error('Comprimento da biela deve superar o raio da manivela.');
 if(Math.abs(cycle.angleDeg[0])>1e-6||Math.abs(cycle.angleDeg[count-1]-720)>1e-6)throw new Error('O traço deve cobrir 0 a 720 graus.');
 const area=Math.PI*bore*bore/4,omega=rpm*2*Math.PI/60;
 const trace:MaterialScreenResult['trace']={angleDeg:[],gasForceN:[],inertiaForceN:[],rodCompressionForceN:[],stressMPa:[]};
 let maximum=-Infinity,minimum=Infinity,maximumAngle=0,minimumAngle=0;
 for(let i=0;i<count;i++){
  const angle=finite(cycle.angleDeg[i],'Ângulo'),pressure=nonnegative(cycle.pressurePa[i],'Pressão absoluta');
  if(i>0&&angle<=cycle.angleDeg[i-1])throw new Error('Ângulos devem ser estritamente crescentes.');
  const theta=angle*Math.PI/180,s=Math.sin(theta),c=Math.cos(theta),root=Math.sqrt(rod*rod-r*r*s*s);
  const accelerationPerOmegaSquared=r*c+r*r*Math.cos(2*theta)/root+r**4*s*s*c*c/(root**3);
  const gas=(pressure-config.crankcasePressurePa)*area,inertia=mass*omega*omega*accelerationPerOmegaSquared;
  const cosRodAngle=root/rod,force=(gas-inertia)/cosRodAngle;
  const stress=-force*config.stressConcentration/config.netSectionMm2;
  if(!Number.isFinite(stress))throw new Error('Estado mecânico não finito.');
  trace.angleDeg.push(angle);trace.gasForceN.push(gas);trace.inertiaForceN.push(inertia);trace.rodCompressionForceN.push(force);trace.stressMPa.push(stress);
  if(stress>maximum){maximum=stress;maximumAngle=angle;}if(stress<minimum){minimum=stress;minimumAngle=angle;}
 }
 const amplitude=(maximum-minimum)/2,mean=(maximum+minimum)/2,ratio=Math.abs(maximum)>1e-12?minimum/maximum:null;
 const absolute=Math.max(Math.abs(maximum),Math.abs(minimum)),card=config.material;
 const allowable=card?interpolateAllowable(card.allowableStressMPa,config.componentTemperatureK):null;
 const fatigue:MaterialScreenResult['fatigue']={status:'not-evaluated',reason:card?'Sem curva S–N compatível com temperatura, razão R e amplitude.':'Sem ficha de material fornecida.',curveTemperatureK:null,cyclesAtAmplitude:null,appliedEnvelopeCycles:rpm/120*config.durationSeconds*config.cyclesPerEngineCycle,damageFraction:null};
 if(card&&amplitude>0&&ratio!==null){
  const curves=(card.fatigueCurves??[]).filter(curve=>Math.abs(config.componentTemperatureK-curve.temperatureK)<=curve.temperatureToleranceK+1e-8&&Math.abs(ratio-curve.stressRatio)<=curve.stressRatioTolerance+1e-8)
   .sort((a,b)=>Math.abs(config.componentTemperatureK-a.temperatureK)-Math.abs(config.componentTemperatureK-b.temperatureK));
  for(const curve of curves){const cycles=interpolateFatigue(curve.points,amplitude);if(cycles!==null){fatigue.status='evaluated';fatigue.reason='Triagem de envelope com curva fornecida; não é vida validada do componente.';fatigue.curveTemperatureK=curve.temperatureK;fatigue.cyclesAtAmplitude=cycles;fatigue.damageFraction=fatigue.appliedEnvelopeCycles/cycles;break;}}
 }
 const status=allowable===null?'not-evaluated':absolute<=allowable?'within-card':'exceeds-card';
 return {
  status,reason:!card?'Sem ficha de material fornecida.':allowable===null?'Temperatura do componente fora dos limites fornecidos.':status==='within-card'?'Tensão nominal dentro do limite fornecido; sem certificação do componente.':'Tensão nominal excede o limite fornecido.',
  materialName:card?.name??null,provenance:card?{...card.provenance}:null,allowableStressMPa:allowable,
  peakTensileStressMPa:Math.max(0,maximum),peakCompressiveStressMPa:Math.max(0,-minimum),maximumAbsoluteStressMPa:absolute,stressAmplitudeMPa:amplitude,meanStressMPa:mean,stressRatio:ratio,peakTensileAngleDeg:maximum>0?maximumAngle:null,peakCompressiveAngleDeg:minimum<0?minimumAngle:null,trace,fatigue,
  assumptions:[
   'Modelo axial nominal da biela; não calcula tensão local por elementos finitos, flambagem ou vida segura.',
   'Pressão e inércia combinadas no mesmo ângulo, com velocidade angular constante em cada ciclo.',
   'Extremos limitados à amostragem angular do traço recebido.',
   'Seção resistente e fator de concentração são hipóteses fornecidas pelo usuário.',
   config.componentTemperatureSource,
   `Contagem de fadiga assume ${config.cyclesPerEngineCycle} envelope(s) por ciclo de 720°; não há contagem rainflow nem histórico multiaxial.`,
   'Não há correção de tensão média: a curva S–N deve corresponder ao R e ao domínio térmico fornecidos.',
   'Limite de tensão simétrico de projeto fornecido na ficha; não é automaticamente resistência ao escoamento ou limite de fadiga.',
  ],
 };
}
