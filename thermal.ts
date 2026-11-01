/** Original lumped thermal network. Constant capacities/conductances are explicit
 * hypotheses; no engine or material calibration is implied by these defaults.
 * Exhaust-wall temperature is distinct from the observed gas boundary temperature.
 */
export interface ThermalConfig {
 provenance:'assumed'|'fitted'|'measured';
 source:string;
 ambientTemperatureK:number;
 initialWallTemperatureK:number;
 initialCoolantTemperatureK:number;
 initialOilTemperatureK:number;
 initialExhaustWallTemperatureK:number;
 wallHeatCapacityJK:number;
 coolantHeatCapacityJK:number;
 oilHeatCapacityJK:number;
 exhaustWallHeatCapacityJK:number;
 wallToCoolantWK:number;
 wallToOilWK:number;
 wallToExhaustWK:number;
 exhaustToCoolantWK:number;
 coolantToAmbientWK:number;
 oilToAmbientWK:number;
 exhaustToAmbientWK:number;
 coolantMassFlowKgs:number;
 coolantSpecificHeatJKgK:number;
 coolantInletTemperatureK:number;
 oilMassFlowKgs:number;
 oilSpecificHeatJKgK:number;
 oilInletTemperatureK:number;
 frictionToOilFraction:number;
 exhaustGasHeatCapacityJKgK:number;
 exhaustHeatTransferEffectiveness:number;
}

export interface ThermalLoads {
 /** Signed heat delivered from cylinder gas to metal; wall rejection is positive. */
 gasHeatW?:number;
 /** Dissipated mechanical power, nonnegative. */
 frictionHeatW?:number;
 /** Already-deposited heat into exhaust wall, not the gas enthalpy flow. */
 exhaustHeatW?:number;
 /** Actual signed gas→wall exchange already applied with opposite sign to the
  * gas-path energy ledger. Use this instead of the optional gas-boundary flow.
  */
 coupledExhaustGasHeatW?:number;
 /** An external gas boundary; a coupled gas-path model must lose the same heat. */
 exhaustGasTemperatureK?:number;
 exhaustMassFlowKgs?:number;
}

export interface ThermalState {
 wallTemperatureK:number;
 coolantTemperatureK:number;
 oilTemperatureK:number;
 exhaustWallTemperatureK:number;
 /** Observed boundary gas temperature; never substituted for component metal. */
 exhaustGasTemperatureK:number;
 elapsedSeconds:number;
 storedEnergyJ:number;
 deltaStoredEnergyJ:number;
 cumulativeInputJ:number;
 cumulativeRejectedJ:number;
 ambientRejectedJ:number;
 fluidRejectedJ:number;
 energyResidualJ:number;
 exhaustGasToWallHeatW:number;
 status:'unvalidated-lumped-model';
}

const clamp=(v:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,v));
const bounded=(value:unknown,fallback:number,lo:number,hi:number)=>typeof value==='number'&&Number.isFinite(value)?clamp(value,lo,hi):fallback;
export function normalizeThermalConfig(input:Partial<ThermalConfig>={}):ThermalConfig {
 const s=input&&typeof input==='object'?input:{};
 return {
  provenance:s.provenance==='fitted'||s.provenance==='measured'?s.provenance:'assumed',
  source:typeof s.source==='string'&&s.source.trim()?s.source.trim().slice(0,2000):'Hipóteses de demonstração; modelo sem calibração.',
  ambientTemperatureK:bounded(s.ambientTemperatureK,293.15,200,400),
  initialWallTemperatureK:bounded(s.initialWallTemperatureK,353.15,200,1800),
  initialCoolantTemperatureK:bounded(s.initialCoolantTemperatureK,343.15,200,700),
  initialOilTemperatureK:bounded(s.initialOilTemperatureK,343.15,200,900),
  initialExhaustWallTemperatureK:bounded(s.initialExhaustWallTemperatureK,473.15,200,2000),
  wallHeatCapacityJK:bounded(s.wallHeatCapacityJK,25000,100,5e6),
  coolantHeatCapacityJK:bounded(s.coolantHeatCapacityJK,18000,100,5e6),
  oilHeatCapacityJK:bounded(s.oilHeatCapacityJK,9000,100,5e6),
  exhaustWallHeatCapacityJK:bounded(s.exhaustWallHeatCapacityJK,4500,100,5e6),
  wallToCoolantWK:bounded(s.wallToCoolantWK,180,0,20000),
  wallToOilWK:bounded(s.wallToOilWK,35,0,20000),
  wallToExhaustWK:bounded(s.wallToExhaustWK,8,0,20000),
  exhaustToCoolantWK:bounded(s.exhaustToCoolantWK,5,0,20000),
  coolantToAmbientWK:bounded(s.coolantToAmbientWK,35,0,20000),
  oilToAmbientWK:bounded(s.oilToAmbientWK,18,0,20000),
  exhaustToAmbientWK:bounded(s.exhaustToAmbientWK,16,0,20000),
  coolantMassFlowKgs:bounded(s.coolantMassFlowKgs,.25,0,20),
  coolantSpecificHeatJKgK:bounded(s.coolantSpecificHeatJKgK,4180,500,8000),
  coolantInletTemperatureK:bounded(s.coolantInletTemperatureK,333.15,200,700),
  oilMassFlowKgs:bounded(s.oilMassFlowKgs,.15,0,20),
  oilSpecificHeatJKgK:bounded(s.oilSpecificHeatJKgK,2000,500,8000),
  oilInletTemperatureK:bounded(s.oilInletTemperatureK,343.15,200,900),
  frictionToOilFraction:bounded(s.frictionToOilFraction,.7,0,1),
  exhaustGasHeatCapacityJKgK:bounded(s.exhaustGasHeatCapacityJKgK,1100,500,3000),
  exhaustHeatTransferEffectiveness:bounded(s.exhaustHeatTransferEffectiveness,.18,0,1),
 };
}

/** Pairwise exact exchange conserves energy and cannot overshoot the two input
 * temperatures. Splitting introduces time-discretization error, not energy loss.
 * Inlet/ambient reservoirs are external boundaries recorded separately.
 */
export class ThermalNetwork {
 private config:ThermalConfig;
 private readonly temperature=new Float64Array(4);
 private readonly capacity=new Float64Array(4);
 private referenceEnergy=0;
 private inputJ=0;
 private ambientJ=0;
 private fluidJ=0;
 private elapsed=0;
 private gasTemperature=293.15;
 private gasToWallW=0;
 constructor(config:Partial<ThermalConfig>={}){this.config=normalizeThermalConfig(config);this.updateCapacities();this.reset();}
 private updateCapacities(){const c=this.config;this.capacity.set([c.wallHeatCapacityJK,c.coolantHeatCapacityJK,c.oilHeatCapacityJK,c.exhaustWallHeatCapacityJK]);}
 private energy(){let sum=0;for(let i=0;i<4;i++)sum+=this.temperature[i]*this.capacity[i];return sum;}
 private rebase(){this.referenceEnergy=this.energy();this.inputJ=0;this.ambientJ=0;this.fluidJ=0;this.elapsed=0;this.gasToWallW=0;}
 setConfig(config:Partial<ThermalConfig>):void {
  const next=normalizeThermalConfig({...this.config,...config}),previous=this.config;
  if(JSON.stringify(next)===JSON.stringify(previous))return;
  const reset=next.initialWallTemperatureK!==previous.initialWallTemperatureK||next.initialCoolantTemperatureK!==previous.initialCoolantTemperatureK||next.initialOilTemperatureK!==previous.initialOilTemperatureK||next.initialExhaustWallTemperatureK!==previous.initialExhaustWallTemperatureK;
  const physicalChange=(Object.keys(next) as (keyof ThermalConfig)[]).some(key=>key!=='source'&&key!=='provenance'&&next[key]!==previous[key]);
  this.config=next;this.updateCapacities();if(reset)this.reset();else if(physicalChange)this.rebase();
 }
 reset():ThermalState {
  const c=this.config;this.temperature.set([c.initialWallTemperatureK,c.initialCoolantTemperatureK,c.initialOilTemperatureK,c.initialExhaustWallTemperatureK]);this.gasTemperature=c.ambientTemperatureK;this.rebase();return this.getState();
 }
 getState():ThermalState {
  const storedEnergyJ=this.energy(),cumulativeRejectedJ=this.ambientJ+this.fluidJ;
  return {wallTemperatureK:this.temperature[0],coolantTemperatureK:this.temperature[1],oilTemperatureK:this.temperature[2],exhaustWallTemperatureK:this.temperature[3],exhaustGasTemperatureK:this.gasTemperature,elapsedSeconds:this.elapsed,storedEnergyJ,deltaStoredEnergyJ:storedEnergyJ-this.referenceEnergy,cumulativeInputJ:this.inputJ,cumulativeRejectedJ,ambientRejectedJ:this.ambientJ,fluidRejectedJ:this.fluidJ,energyResidualJ:storedEnergyJ-this.referenceEnergy-this.inputJ+cumulativeRejectedJ,exhaustGasToWallHeatW:this.gasToWallW,status:'unvalidated-lumped-model'};
 }
 private exchange(a:number,b:number,g:number,h:number){
  if(g===0)return;const ca=this.capacity[a],cb=this.capacity[b];const q=(this.temperature[a]-this.temperature[b])/(1/ca+1/cb)*(-Math.expm1(-g*(1/ca+1/cb)*h));this.temperature[a]-=q/ca;this.temperature[b]+=q/cb;
 }
 private boundary(node:number,t:number,g:number,h:number):number {
  if(g===0)return 0;const q=this.capacity[node]*(this.temperature[node]-t)*(-Math.expm1(-g*h/this.capacity[node]));this.temperature[node]-=q/this.capacity[node];return q;
 }
 step(dt:number,loads:ThermalLoads={}):ThermalState {
  if(!Number.isFinite(dt)||dt<=0)return this.getState();
  if(dt>60)throw new RangeError('Use passos térmicos de até 60 segundos.');
  const load=(key:keyof ThermalLoads,fallback=0)=>{const value=loads[key]??fallback;if(!Number.isFinite(value))throw new RangeError(`Carga térmica inválida: ${key}`);return value;};
  const gasHeatW=load('gasHeatW'),frictionHeatW=load('frictionHeatW'),exhaustHeatW=load('exhaustHeatW'),coupledExhaustGasHeatW=load('coupledExhaustGasHeatW'),massFlow=load('exhaustMassFlowKgs');
  const gasTemperature=load('exhaustGasTemperatureK',this.gasTemperature);
  if(frictionHeatW<0||massFlow<0||gasTemperature<=0)throw new RangeError('Atrito/vazão devem ser não negativos e temperatura absoluta positiva.');
  const c=this.config,steps=Math.ceil(dt/.05),h=dt/steps;
  const t0=this.temperature[0],t1=this.temperature[1],t2=this.temperature[2],t3=this.temperature[3],oldInput=this.inputJ,oldAmbient=this.ambientJ,oldFluid=this.fluidJ;
  let gasToWallJ=coupledExhaustGasHeatW*dt;
  try{
   for(let step=0;step<steps;step++){
    this.temperature[0]+=gasHeatW*h/this.capacity[0];this.temperature[1]+=frictionHeatW*(1-c.frictionToOilFraction)*h/this.capacity[1];this.temperature[2]+=frictionHeatW*c.frictionToOilFraction*h/this.capacity[2];this.temperature[3]+=(exhaustHeatW+coupledExhaustGasHeatW)*h/this.capacity[3];
    this.inputJ+=(gasHeatW+frictionHeatW+exhaustHeatW+coupledExhaustGasHeatW)*h;
    // The removed energy has the opposite sign of heat entering the wall.
    const gasBoundaryQ=this.boundary(3,gasTemperature,massFlow*c.exhaustGasHeatCapacityJKgK*c.exhaustHeatTransferEffectiveness,h);
    gasToWallJ-=gasBoundaryQ;this.inputJ-=gasBoundaryQ;
    this.exchange(0,1,c.wallToCoolantWK,h);this.exchange(0,2,c.wallToOilWK,h);this.exchange(0,3,c.wallToExhaustWK,h);this.exchange(3,1,c.exhaustToCoolantWK,h);
    this.fluidJ+=this.boundary(1,c.coolantInletTemperatureK,c.coolantMassFlowKgs*c.coolantSpecificHeatJKgK,h)+this.boundary(2,c.oilInletTemperatureK,c.oilMassFlowKgs*c.oilSpecificHeatJKgK,h);
    this.ambientJ+=this.boundary(1,c.ambientTemperatureK,c.coolantToAmbientWK,h)+this.boundary(2,c.ambientTemperatureK,c.oilToAmbientWK,h)+this.boundary(3,c.ambientTemperatureK,c.exhaustToAmbientWK,h);
    if(!this.temperature.every(value=>Number.isFinite(value)&&value>0))throw new RangeError('Estado térmico não físico: verifique cargas e capacidades.');
   }
  }catch(error){this.temperature.set([t0,t1,t2,t3]);this.inputJ=oldInput;this.ambientJ=oldAmbient;this.fluidJ=oldFluid;throw error;}
  this.elapsed+=dt;this.gasTemperature=gasTemperature;this.gasToWallW=gasToWallJ/dt;return this.getState();
 }
}
