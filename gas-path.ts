/** Original lumped ideal-gas air path. The cylinder solver supplies cycle-scale
 * detail; these reservoirs retain mean intake/exhaust mass and energy. All
 * pressure is absolute Pa, temperature K, length m, mass kg and energy J.
 */
export interface GasPathConfig {
	ambientPressurePa: number;
	ambientTemperatureK: number;
	intakeVolumeM3: number;
	exhaustVolumeM3: number;
	throttleDiameterM: number;
	throttleDischarge: number;
	throttleLeakFraction: number;
	exhaustDiameterM: number;
	exhaustLengthM: number;
	exhaustMinorK: number;
	exhaustFrictionFactor: number;
	gamma: number;
	gasConstant: number;
}

export interface ReservoirState {
	massKg: number;
	internalEnergyJ: number;
	pressurePa: number;
	temperatureK: number;
	volumeM3: number;
}

export interface ReservoirInflow { massFlowKgs: number; temperatureK: number }
export interface ReservoirBalance {
	massInKg: number;
	massOutKg: number;
	energyInJ: number;
	energyOutJ: number;
	heatJ: number;
	limitedOutflowKg: number;
	limitedCoolingJ: number;
	massResidualKg: number;
	energyResidualJ: number;
}

const clamp = (value:number, low:number, high:number):number => Math.min(high, Math.max(low,value));
const finite = (value:unknown, fallback:number, low:number, high:number):number =>
	typeof value==='number' && Number.isFinite(value) ? clamp(value,low,high) : fallback;

export function normalizeGasPathConfig(input:Partial<GasPathConfig> = {}):GasPathConfig {
	const source=input && typeof input==='object'?input:{};
	return {
		ambientPressurePa:finite(source.ambientPressurePa,101325,30000,200000),
		ambientTemperatureK:finite(source.ambientTemperatureK,293.15,200,500),
		intakeVolumeM3:finite(source.intakeVolumeM3,.003,.0002,.2),
		exhaustVolumeM3:finite(source.exhaustVolumeM3,.003,.0002,.2),
		throttleDiameterM:finite(source.throttleDiameterM,.05,.005,.2),
		throttleDischarge:finite(source.throttleDischarge,.72,.1,1),
		throttleLeakFraction:finite(source.throttleLeakFraction,.01,0,.2),
		exhaustDiameterM:finite(source.exhaustDiameterM,.06,.01,.2),
		exhaustLengthM:finite(source.exhaustLengthM,1.7,0,10),
		exhaustMinorK:finite(source.exhaustMinorK,2,0,100),
		exhaustFrictionFactor:finite(source.exhaustFrictionFactor,.025,0,.15),
		gamma:finite(source.gamma,1.35,1.1,1.67),
		gasConstant:finite(source.gasConstant,287.05,200,500),
	};
}

function positive(value:number,name:string):number {
	if(!Number.isFinite(value)||value<=0)throw new RangeError(`${name} must be finite and positive`);
	return value;
}

/** Quasi-steady isentropic orifice law. Positive means A→B. Reversal selects
 * the other reservoir's pressure AND temperature. Cd and area are explicit
 * assumptions; this function is not a throttle plate/valve CFD calculation.
 */
export function compressibleOrificeFlow(pressureAPa:number,temperatureAK:number,
	pressureBPa:number,temperatureBK:number,areaM2:number,discharge:number,gamma=1.35,gasConstant=287.05):number {
	positive(pressureAPa,'pressure A');positive(pressureBPa,'pressure B');
	positive(temperatureAK,'temperature A');positive(temperatureBK,'temperature B');
	if(!Number.isFinite(areaM2)||areaM2<0||!Number.isFinite(discharge)||discharge<0||discharge>1
		||!Number.isFinite(gamma)||gamma<=1||!Number.isFinite(gasConstant)||gasConstant<=0)throw new RangeError('Invalid orifice parameters');
	if(areaM2===0||discharge===0||pressureAPa===pressureBPa)return 0;
	const sign=pressureAPa>pressureBPa?1:-1;
	const up=sign>0?pressureAPa:pressureBPa,down=sign>0?pressureBPa:pressureAPa;
	const temperature=sign>0?temperatureAK:temperatureBK;
	const ratio=down/up,critical=(2/(gamma+1))**(gamma/(gamma-1));
	const factor=ratio<=critical
		?Math.sqrt(gamma)*(2/(gamma+1))**((gamma+1)/(2*(gamma-1)))
		:Math.sqrt(Math.max(0,2*gamma/(gamma-1)*(ratio**(2/gamma)-ratio**((gamma+1)/gamma))));
	return sign*discharge*areaM2*up/Math.sqrt(gasConstant*temperature)*factor;
}

/** Darcy-Weisbach plus supplied minor losses and an explicit exit loss of1.
 * This is mean pressure loss, not acoustic attenuation/transmission loss.
 * Signed result follows the signed mass flow; quasi-steady density is supplied.
 */
export function exhaustPressureLoss(massFlowKgs:number,densityKgm3:number,diameterM:number,lengthM:number,
	minorK:number,frictionFactor=.025):number {
	positive(densityKgm3,'density');positive(diameterM,'diameter');
	if(!Number.isFinite(massFlowKgs)||!Number.isFinite(lengthM)||lengthM<0||!Number.isFinite(minorK)||minorK<0
		||!Number.isFinite(frictionFactor)||frictionFactor<0)throw new RangeError('Invalid pressure-loss parameters');
	const area=Math.PI*diameterM**2/4,k=1+minorK+frictionFactor*lengthM/diameterM;
	return k*massFlowKgs*Math.abs(massFlowKgs)/(2*densityKgm3*area**2);
}

/** A fixed-volume calorically-perfect gas inventory. Advance uses enthalpy for
 * mass crossing the boundary. The explicit outflow/cooling caps are numerical
 * domain guards, returned in the balance instead of hidden mass/energy clamps.
 */
export class IdealGasReservoir {
	private mass:number;
	private energy:number;
	readonly volumeM3:number;
	readonly gamma:number;
	readonly gasConstant:number;
	readonly cv:number;
	readonly cp:number;
	constructor(volumeM3:number,pressurePa:number,temperatureK:number,gamma=1.35,gasConstant=287.05){
		this.volumeM3=positive(volumeM3,'volume');positive(pressurePa,'pressure');positive(temperatureK,'temperature');
		if(!Number.isFinite(gamma)||gamma<1.1||gamma>1.67)throw new RangeError('Reservoir gamma must be within the supported1.1–1.67 domain');
		this.gamma=gamma;this.gasConstant=positive(gasConstant,'gas constant');this.cv=gasConstant/(gamma-1);this.cp=this.cv+gasConstant;
		this.mass=pressurePa*volumeM3/(gasConstant*temperatureK);this.energy=this.mass*this.cv*temperatureK;
		if(!Number.isFinite(this.mass)||!Number.isFinite(this.energy)||this.mass<=0||this.energy<=0)throw new RangeError('Gas inventory is outside the finite positive numeric domain');
	}
	getState():ReservoirState {
		const temperatureK=this.energy/(this.mass*this.cv);
		return {massKg:this.mass,internalEnergyJ:this.energy,temperatureK,pressurePa:this.mass*this.gasConstant*temperatureK/this.volumeM3,volumeM3:this.volumeM3};
	}
	advance(dt:number,inflows:readonly ReservoirInflow[],outflowKgs:number,heatW=0):ReservoirBalance {
		if(!Number.isFinite(dt)||dt<0||!Number.isFinite(outflowKgs)||outflowKgs<0||!Number.isFinite(heatW))throw new RangeError('Invalid reservoir flow/step');
		const beforeMass=this.mass,beforeEnergy=this.energy,temperature=this.getState().temperatureK;
		let massInKg=0,energyInJ=0;
		for(const flow of inflows){
			if(!Number.isFinite(flow.massFlowKgs)||flow.massFlowKgs<0)throw new RangeError('Invalid inflow');
			positive(flow.temperatureK,'inlet temperature');
			const dm=flow.massFlowKgs*dt;massInKg+=dm;energyInJ+=dm*this.cp*flow.temperatureK;
		}
		const requestedOut=outflowKgs*dt;
		// At most20% of the previous inventory exits in one explicit update. This
		// also bounds enthalpy removal below stored internal energy forγ<1.67.
		const massOutKg=Math.min(requestedOut,this.mass*.2);
		const energyOutJ=massOutKg*this.cp*temperature;
		const beforeHeat=this.energy+energyInJ-energyOutJ;
		const requestedHeat=heatW*dt,heatJ=Math.max(requestedHeat,-beforeHeat*.95);
		this.mass+=massInKg-massOutKg;this.energy=beforeHeat+heatJ;
		if(!Number.isFinite(this.mass)||!Number.isFinite(this.energy)||this.mass<=0||this.energy<=0)throw new Error('Gas reservoir left its positive finite domain');
		return {massInKg,massOutKg,energyInJ,energyOutJ,heatJ,limitedOutflowKg:requestedOut-massOutKg,
			limitedCoolingJ:heatJ-requestedHeat,massResidualKg:this.mass-beforeMass-(massInKg-massOutKg),
			energyResidualJ:this.energy-beforeEnergy-(energyInJ-energyOutJ+heatJ)};
	}
}

export interface GasPathInput {
	rpm:number;
	throttle:number;
	engineDisplacementM3:number;
	volumetricEfficiency:number;
	fuelMassFlowKgs?:number;
	exhaustTemperatureK?:number;
	/** Supplied by the ONE turbo state in the physical model, not another lag. */
	compressorPressurePa?:number;
	compressorTemperatureK?:number;
	/** Optional mean demand from the cylinder cycle; otherwise speed-density. */
	cylinderAirMassFlowKgs?:number;
	intakeHeatW?:number;
	exhaustHeatW?:number;
}

export interface GasPathState {
	intake:ReservoirState;
	exhaust:ReservoirState;
	throttleMassFlowKgs:number;
	cylinderAirMassFlowKgs:number;
	cylinderExhaustMassFlowKgs:number;
	fuelMassFlowKgs:number;
	outletMassFlowKgs:number;
	exhaustPressureLossPa:number;
	massBalanceResidualKg:number;
	energyBalanceResidualJ:number;
	/** Signed heat actually applied after cooling limits over this step. */
	intakeHeatJ:number;
	exhaustHeatJ:number;
	limitedOutflowKg:number;
	limitedCoolingJ:number;
	warnings:string[];
}

export class GasPath {
	private config:GasPathConfig;
	private intake:IdealGasReservoir;
	private exhaust:IdealGasReservoir;
	private last:GasPathState;
	constructor(config:Partial<GasPathConfig>={}){
		this.config=normalizeGasPathConfig(config);
		const c=this.config;
		this.intake=new IdealGasReservoir(c.intakeVolumeM3,c.ambientPressurePa,c.ambientTemperatureK,c.gamma,c.gasConstant);
		this.exhaust=new IdealGasReservoir(c.exhaustVolumeM3,c.ambientPressurePa,550,c.gamma,c.gasConstant);
		this.last=this.emptyState();
	}
	private emptyState():GasPathState {
		return {intake:this.intake.getState(),exhaust:this.exhaust.getState(),throttleMassFlowKgs:0,cylinderAirMassFlowKgs:0,
			cylinderExhaustMassFlowKgs:0,fuelMassFlowKgs:0,outletMassFlowKgs:0,exhaustPressureLossPa:0,
			massBalanceResidualKg:0,energyBalanceResidualJ:0,intakeHeatJ:0,exhaustHeatJ:0,limitedOutflowKg:0,limitedCoolingJ:0,warnings:[]};
	}
	configure(input:Partial<GasPathConfig>):void {
		const old=this.config,next=normalizeGasPathConfig({...old,...input});this.config=next;
		if(old.intakeVolumeM3!==next.intakeVolumeM3||old.exhaustVolumeM3!==next.exhaustVolumeM3||old.gamma!==next.gamma||old.gasConstant!==next.gasConstant){
			const intake=this.intake.getState(),exhaust=this.exhaust.getState();
			// A changed model definition starts a new inventory with the priorP/T;
			// it is a configuration reset, not part of a conserved dynamic step.
			this.reset({intakePressurePa:intake.pressurePa,intakeTemperatureK:intake.temperatureK,
				exhaustPressurePa:exhaust.pressurePa,exhaustTemperatureK:exhaust.temperatureK});
			this.last.warnings.push('Gas inventory reset after volume/gas-property configuration changed.');
		}
	}
	reset(state:{intakePressurePa?:number;intakeTemperatureK?:number;exhaustPressurePa?:number;exhaustTemperatureK?:number}={}):GasPathState {
		const c=this.config;
		this.intake=new IdealGasReservoir(c.intakeVolumeM3,finite(state.intakePressurePa,c.ambientPressurePa,1000,2e6),finite(state.intakeTemperatureK,c.ambientTemperatureK,100,3000),c.gamma,c.gasConstant);
		this.exhaust=new IdealGasReservoir(c.exhaustVolumeM3,finite(state.exhaustPressurePa,c.ambientPressurePa,1000,2e6),finite(state.exhaustTemperatureK,550,100,3000),c.gamma,c.gasConstant);
		this.last=this.emptyState();return this.getState();
	}
	getState():GasPathState{return {...this.last,intake:{...this.last.intake},exhaust:{...this.last.exhaust},warnings:[...this.last.warnings]};}
	step(inputDt:number,input:GasPathInput):GasPathState {
		const dt=finite(inputDt,0,0,.25);if(dt===0)return this.getState();
		const c=this.config,steps=Math.ceil(dt/.0005),h=dt/steps;
		const throttle=finite(input.throttle,0,0,1),rpm=finite(input.rpm,0,0,22000),displacement=finite(input.engineDisplacementM3,.002,.00001,.03),ve=finite(input.volumetricEfficiency,.9,0,2);
		const supplyPressure=finite(input.compressorPressurePa,c.ambientPressurePa,1000,2e6),supplyTemp=finite(input.compressorTemperatureK,c.ambientTemperatureK,100,2000);
		const exhaustTemp=finite(input.exhaustTemperatureK,800,150,3000),fuelDemand=finite(input.fuelMassFlowKgs,0,0,.5);
		const throttleArea=Math.PI*c.throttleDiameterM**2/4*(c.throttleLeakFraction+(1-c.throttleLeakFraction)*throttle**2);
		const exitArea=Math.PI*c.exhaustDiameterM**2/4,exitK=1+c.exhaustMinorK+c.exhaustFrictionFactor*c.exhaustLengthM/c.exhaustDiameterM;
		let throttleMass=0,cylinderAir=0,cylinderExhaust=0,fuelMass=0,outletMass=0,massResidual=0,energyResidual=0,intakeHeat=0,exhaustHeat=0,limitedOutflow=0,limitedCooling=0;
		for(let index=0;index<steps;index++){
			const a=this.intake.getState(),e=this.exhaust.getState();
			const throttleFlow=compressibleOrificeFlow(supplyPressure,supplyTemp,a.pressurePa,a.temperatureK,throttleArea,c.throttleDischarge,c.gamma,c.gasConstant);
			const requestedAir=input.cylinderAirMassFlowKgs!==undefined?finite(input.cylinderAirMassFlowKgs,0,0,5):a.massKg/c.intakeVolumeM3*ve*displacement*rpm/120;
			const intakeOut=requestedAir+Math.max(0,-throttleFlow);
			const ib=this.intake.advance(h,throttleFlow>0?[{massFlowKgs:throttleFlow,temperatureK:supplyTemp}]:[],intakeOut,finite(input.intakeHeatW,0,-1e6,1e6));
			const outRatio=intakeOut>0?ib.massOutKg/(intakeOut*h):1;
			const actualAir=requestedAir*outRatio,actualThrottle=throttleFlow>=0?throttleFlow:throttleFlow*outRatio;
			const actualFuel=fuelDemand*(requestedAir>0?outRatio:0),exhaustIn=actualAir+actualFuel;
			const outletFlow=compressibleOrificeFlow(e.pressurePa,e.temperatureK,c.ambientPressurePa,c.ambientTemperatureK,exitArea,1/Math.sqrt(exitK),c.gamma,c.gasConstant);
			const inflows:ReservoirInflow[]=[{massFlowKgs:exhaustIn,temperatureK:exhaustTemp}];
			if(outletFlow<0)inflows.push({massFlowKgs:-outletFlow,temperatureK:c.ambientTemperatureK});
			const eb=this.exhaust.advance(h,inflows,Math.max(0,outletFlow),finite(input.exhaustHeatW,0,-1e6,1e6));
			const actualOutlet=outletFlow<=0?outletFlow:eb.massOutKg/h;
			throttleMass+=actualThrottle*h;cylinderAir+=actualAir*h;cylinderExhaust+=exhaustIn*h;fuelMass+=actualFuel*h;outletMass+=actualOutlet*h;
			massResidual+=ib.massResidualKg+eb.massResidualKg;energyResidual+=ib.energyResidualJ+eb.energyResidualJ;
			intakeHeat+=ib.heatJ;exhaustHeat+=eb.heatJ;
			limitedOutflow+=ib.limitedOutflowKg+eb.limitedOutflowKg;limitedCooling+=ib.limitedCoolingJ+eb.limitedCoolingJ;
		}
		const intake=this.intake.getState(),exhaust=this.exhaust.getState(),outletMassFlowKgs=outletMass/dt;
		const warnings:string[]=[];
		if(limitedOutflow>1e-12)warnings.push('Explicit gas outflow limited by available inventory; refine step or review volumes/flows.');
		if(limitedCooling>1e-8)warnings.push('Cooling limited to retain positive gas energy; thermal inputs outside the explicit-step domain.');
		this.last={intake,exhaust,throttleMassFlowKgs:throttleMass/dt,cylinderAirMassFlowKgs:cylinderAir/dt,
			cylinderExhaustMassFlowKgs:cylinderExhaust/dt,fuelMassFlowKgs:fuelMass/dt,outletMassFlowKgs,
			exhaustPressureLossPa:exhaustPressureLoss(outletMassFlowKgs,exhaust.massKg/c.exhaustVolumeM3,c.exhaustDiameterM,c.exhaustLengthM,c.exhaustMinorK,c.exhaustFrictionFactor),
			massBalanceResidualKg:massResidual,energyBalanceResidualJ:energyResidual,intakeHeatJ:intakeHeat,exhaustHeatJ:exhaustHeat,limitedOutflowKg:limitedOutflow,limitedCoolingJ:limitedCooling,warnings};
		return this.getState();
	}
}
