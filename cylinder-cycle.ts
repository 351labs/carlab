/** Original air-standard, single-zone four-stroke model. Angles are crank degrees:
 * 0 intake TDC, 180 intake BDC, 360 firing TDC, 540 expansion BDC, 720 exhaust TDC.
 * Fuel is represented as external finite heat input; fuel mass and gas chemistry
 * are not added to this working-fluid mass. No measured engine data are embedded.
 */
export interface CylinderCycleConfig {
 boreM:number; strokeM:number; rodLengthM:number; compressionRatio:number; rpm:number;
 intakePressurePa:number; intakeTemperatureK:number; exhaustPressurePa:number; exhaustTemperatureK:number;
 intakeOpenDeg:number; intakeCloseDeg:number; exhaustOpenDeg:number; exhaustCloseDeg:number;
 intakeValveDiameterM:number; exhaustValveDiameterM:number; intakeValveLiftM:number; exhaustValveLiftM:number;
 intakeValveCount:number; exhaustValveCount:number; dischargeCoefficient:number;
 sparkAdvanceDeg:number; burnDurationDeg:number; wiebeShape:number; wiebeEfficiency:number;
 airFuelRatio:number; fuelLhvJkg:number; combustionEfficiency:number; fuelMassKg?:number; oxygenLimitAfr?:number; combustionStartDeg?:number; fuelDeliveryStartDeg?:number; fuelDeliveryDurationDeg?:number;
 wallTemperatureK:number; heatTransferWm2K:number; gamma:number; variableHeatCapacity:boolean;
 initialPressurePa:number; initialTemperatureK:number; stepDeg:number; settlingCycles:number;
}
export interface CylinderCycleTrace {
 angleDeg:number[]; pressurePa:number[]; temperatureK:number[]; volumeM3:number[]; massKg:number[];
 /** Cumulative heat released since this recorded cycle's start. */
 heatReleaseJ:number[]; heatReleaseRateJPerDeg:number[]; intakeFlowKgs:number[]; exhaustFlowKgs:number[];
}
export interface CylinderCycleResult {
 config:CylinderCycleConfig; trace:CylinderCycleTrace;
 /** Per cylinder, per 720 degrees. Net already includes the pumping loop. */
 netWorkJ:number; grossWorkJ:number; pumpingWorkJ:number; netIndicatedWorkJ:number; imepPa:number;
 peakPressurePa:number; peakTemperatureK:number; peakPressureAngleDeg:number; peakPressureRisePaPerDeg:number;
 ca10Deg:number; ca50Deg:number; ca90Deg:number;
 freshChargeMassKg:number; airMassKg:number; fuelMassKg:number; fuelEnergyJ:number; releasedHeatJ:number;
 residualFractionAtIvc:number; wallHeatLossJ:number;
 intakeMassInKg:number; intakeReverseMassKg:number; exhaustMassKg:number; exhaustReverseMassKg:number;
 exhaustTemperatureK:number; inletEnthalpyJ:number; outletEnthalpyJ:number;
 massBalanceResidualKg:number; energyBalanceResidualJ:number;
 periodicMassRelativeError:number; periodicEnergyRelativeError:number;
 initialMassKg:number; finalMassKg:number; initialInternalEnergyJ:number; finalInternalEnergyJ:number;
 oxygenLimitedFuelMassKg?:number; oxygenUnburnedFuelMassKg?:number;
 steps:number; warnings:string[]; /** The reference emits only air-standard; Rust NASA-7 runs report fixed-composition. */ status:'uncalibrated-air-standard'|'uncalibrated-fixed-composition';
}
export type CycleResult=CylinderCycleResult;

const R=287.05, DEG=Math.PI/180;
const clamp=(n:number,a:number,b:number)=>Math.max(a,Math.min(b,n));
const bound=(n:unknown,f:number,a:number,b:number)=>typeof n==='number'&&Number.isFinite(n)?clamp(n,a,b):f;
export function normalizeCylinderCycleConfig(input:Partial<CylinderCycleConfig>={}):CylinderCycleConfig {
 const s=input&&typeof input==='object'?input:{};
 const strokeM=bound(s.strokeM,.086,.02,.22), intakePressurePa=bound(s.intakePressurePa,101325,15000,500000);
 const exhaustPressurePa=bound(s.exhaustPressurePa,106000,30000,700000),exhaustTemperatureK=bound(s.exhaustTemperatureK,800,240,1800);
 const step=bound(s.stepDeg,2,.125,6),bins=Math.round(720/step);
 const result:CylinderCycleConfig={
  boreM:bound(s.boreM,.086,.025,.2),strokeM,rodLengthM:bound(s.rodLengthM,strokeM*1.7,strokeM*.6,strokeM*3),
  compressionRatio:bound(s.compressionRatio,10.5,5,18),rpm:bound(s.rpm,3000,300,18000),
  intakePressurePa,intakeTemperatureK:bound(s.intakeTemperatureK,315,230,600),exhaustPressurePa,exhaustTemperatureK,
  intakeOpenDeg:bound(s.intakeOpenDeg,710,650,719.9),intakeCloseDeg:bound(s.intakeCloseDeg,220,140,280),
  exhaustOpenDeg:bound(s.exhaustOpenDeg,500,430,590),exhaustCloseDeg:bound(s.exhaustCloseDeg,10,0,70),
  intakeValveDiameterM:bound(s.intakeValveDiameterM,.032,.006,.09),exhaustValveDiameterM:bound(s.exhaustValveDiameterM,.028,.006,.09),
  intakeValveLiftM:bound(s.intakeValveLiftM,.009,0,.025),exhaustValveLiftM:bound(s.exhaustValveLiftM,.008,0,.025),
  intakeValveCount:Math.round(bound(s.intakeValveCount,2,1,4)),exhaustValveCount:Math.round(bound(s.exhaustValveCount,2,1,4)),
  dischargeCoefficient:bound(s.dischargeCoefficient,.68,0,1),sparkAdvanceDeg:bound(s.sparkAdvanceDeg,18,-30,60),
  burnDurationDeg:bound(s.burnDurationDeg,50,8,120),wiebeShape:bound(s.wiebeShape,2,.1,5),wiebeEfficiency:bound(s.wiebeEfficiency,6.9,1,12),
  airFuelRatio:bound(s.airFuelRatio,14.7,8,25),fuelLhvJkg:bound(s.fuelLhvJkg,43e6,15e6,55e6),combustionEfficiency:bound(s.combustionEfficiency,.96,0,1),
  wallTemperatureK:bound(s.wallTemperatureK,450,230,1000),heatTransferWm2K:bound(s.heatTransferWm2K,180,0,3000),
  gamma:bound(s.gamma,1.33,1.15,1.4),variableHeatCapacity:s.variableHeatCapacity===true,
  initialPressurePa:bound(s.initialPressurePa,exhaustPressurePa,10000,700000),initialTemperatureK:bound(s.initialTemperatureK,exhaustTemperatureK,230,1800),
  stepDeg:720/bins,settlingCycles:Math.round(bound(s.settlingCycles,3,0,12)),
 };
 if(typeof s.fuelMassKg==='number'&&Number.isFinite(s.fuelMassKg))result.fuelMassKg=clamp(s.fuelMassKg,0,.0006);
 if(typeof s.oxygenLimitAfr==='number'&&Number.isFinite(s.oxygenLimitAfr))result.oxygenLimitAfr=clamp(s.oxygenLimitAfr,2,25);
 if(typeof s.combustionStartDeg==='number'&&Number.isFinite(s.combustionStartDeg))result.combustionStartDeg=clamp(s.combustionStartDeg,280,500);
 const hasStart=s.fuelDeliveryStartDeg!==undefined,hasDuration=s.fuelDeliveryDurationDeg!==undefined;
 if(hasStart!==hasDuration)throw new RangeError('Fuel delivery start and duration must be supplied together.');
 if(hasStart){if(!Number.isFinite(s.fuelDeliveryStartDeg)||!Number.isFinite(s.fuelDeliveryDurationDeg)||s.fuelDeliveryStartDeg!<0||s.fuelDeliveryDurationDeg!<=0||s.fuelDeliveryStartDeg!+s.fuelDeliveryDurationDeg!>720)throw new RangeError('Fuel delivery must be a finite positive event inside 0..720 degrees.');result.fuelDeliveryStartDeg=s.fuelDeliveryStartDeg!;result.fuelDeliveryDurationDeg=s.fuelDeliveryDurationDeg!;}

 return result;
}

export function cylinderVolume(config:Pick<CylinderCycleConfig,'boreM'|'strokeM'|'rodLengthM'|'compressionRatio'>,angleDeg:number):number {
 const area=Math.PI*config.boreM**2/4,a=config.strokeM/2,l=config.rodLengthM,t=angleDeg*DEG;
 const x=a*(1-Math.cos(t))+l-Math.sqrt(l*l-a*a*Math.sin(t)**2);
 return area*(config.strokeM/(config.compressionRatio-1)+x);
}
function volumeDerivative(c:CylinderCycleConfig,angle:number):number {
 const a=c.strokeM/2,t=angle*DEG,s=Math.sin(t),v=Math.cos(t),l=c.rodLengthM;
 return Math.PI*c.boreM**2/4*(a*s+a*a*s*v/Math.sqrt(l*l-a*a*s*s))*DEG;
}

/** Signed flow from reservoir A to B; negative values are reverse flow. */
export function compressibleOrificeFlow(pA:number,tA:number,pB:number,tB:number,areaM2:number,cd:number,gamma=1.33,gasR=R):number {
 if(![pA,tA,pB,tB,areaM2,cd,gamma,gasR].every(Number.isFinite)||pA<=0||pB<=0||tA<=0||tB<=0||gamma<=1||gasR<=0||areaM2<0||cd<0)throw new RangeError('Invalid compressible-flow boundary.');
 if(pA===pB||areaM2===0||cd===0)return 0;
 const forward=pA>pB,up=forward?pA:pB,down=forward?pB:pA,temp=forward?tA:tB,ratio=down/up;
 const critical=(2/(gamma+1))**(gamma/(gamma-1));
 const factor=ratio<=critical?Math.sqrt(gamma)*(2/(gamma+1))**((gamma+1)/(2*(gamma-1))):Math.sqrt(Math.max(0,2*gamma/(gamma-1)*(ratio**(2/gamma)-ratio**((gamma+1)/gamma))));
 return (forward?1:-1)*cd*areaM2*up/Math.sqrt(gasR*temp)*factor;
}

export function valveEffectiveArea(angleDeg:number,openDeg:number,closeDeg:number,diameterM:number,liftM:number,count=1):number {
 const duration=(closeDeg-openDeg+720)%720,phase=((angleDeg-openDeg)%720+720)%720;
 if(duration<=0||phase>=duration)return 0;
 const lift=liftM*Math.sin(Math.PI*phase/duration)**2;
 return count*Math.min(Math.PI*diameterM*lift,Math.PI*diameterM**2/4);
}

interface State { m:number; u:number; fresh:number }
interface Rates { dm:number; du:number; dfresh:number; din:number; dout:number; hin:number; hout:number; work:number; wall:number; temp:number; pressure:number }
export function solveCylinderCycle(input:Partial<CylinderCycleConfig>={}):CylinderCycleResult {
 const c=normalizeCylinderCycleConfig(input),cvReference=R/(c.gamma-1),slope=c.variableHeatCapacity?.12:0,b=cvReference-300*slope;
 // cv(T)=b+slope*T, u(0)=0. This bounded-domain air approximation is original,
 // not a chemical-equilibrium/NASA property table or a calibrated gas model.
 const specificU=(t:number)=>b*t+.5*slope*t*t;
 const temperature=(m:number,u:number)=>{const e=u/m;return slope===0?e/b:2*e/(b+Math.sqrt(b*b+2*slope*e));};
 const enthalpy=(t:number)=>specificU(t)+R*t;
 const gammaAt=(t:number)=>1+R/(b+slope*t);
 const swept=Math.PI*c.boreM**2/4*c.strokeM,dtPerDeg=1/(6*c.rpm),soc=c.combustionStartDeg??(360-c.sparkAdvanceDeg),burnEnd=soc+c.burnDurationDeg;
 const prescribedWiebe=(angle:number)=>{const x=clamp((angle-soc)/c.burnDurationDeg,0,1);return (1-Math.exp(-c.wiebeEfficiency*x**(c.wiebeShape+1)))/(1-Math.exp(-c.wiebeEfficiency));};
 const wiebe=(angle:number)=>c.fuelDeliveryStartDeg===undefined?prescribedWiebe(angle):Math.min(prescribedWiebe(angle),clamp((angle-c.fuelDeliveryStartDeg)/c.fuelDeliveryDurationDeg!,0,1));
 const burnAngle=(fraction:number)=>{if(c.fuelDeliveryStartDeg===undefined)return soc+c.burnDurationDeg*(-Math.log(1-fraction*(1-Math.exp(-c.wiebeEfficiency)))/c.wiebeEfficiency)**(1/(c.wiebeShape+1));let lo=Math.min(soc,c.fuelDeliveryStartDeg),hi=Math.max(burnEnd,c.fuelDeliveryStartDeg+c.fuelDeliveryDurationDeg!);for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(wiebe(mid)<fraction)lo=mid;else hi=mid;}return (lo+hi)/2;};
 const initialVolume=cylinderVolume(c,0);
 let state:State={m:c.initialPressurePa*initialVolume/(R*c.initialTemperatureK),u:0,fresh:0};state.u=state.m*specificU(c.initialTemperatureK);
 const trace:CylinderCycleTrace={angleDeg:[],pressurePa:[],temperatureK:[],volumeM3:[],massKg:[],heatReleaseJ:[],heatReleaseRateJPerDeg:[],intakeFlowKgs:[],exhaustFlowKgs:[]};
 let net=0,gross=0,pumping=0,heat=0,wall=0,inMass=0,inReverse=0,outMass=0,outReverse=0,hin=0,hout=0,outTemperature=0,steps=0;
 let fuel=0,oxygenEligibleFuel=0,freshCharge=0,residual=1,peakPressure=0,peakTemp=0,peakAngle=0,maxRise=0,initialM=0,initialU=0;
 const warnings:string[]=[];
 const rates=(angle:number,s:State,qPerDeg:number):Rates=>{
  const t=temperature(s.m,s.u),v=cylinderVolume(c,angle),p=s.m*R*t/v;
  const ai=valveEffectiveArea(angle,c.intakeOpenDeg,c.intakeCloseDeg,c.intakeValveDiameterM,c.intakeValveLiftM,c.intakeValveCount);
  const ae=valveEffectiveArea(angle,c.exhaustOpenDeg,c.exhaustCloseDeg,c.exhaustValveDiameterM,c.exhaustValveLiftM,c.exhaustValveCount);
  const gi=gammaAt(p<c.intakePressurePa?c.intakeTemperatureK:t),ge=gammaAt(p>c.exhaustPressurePa?t:c.exhaustTemperatureK);
  const din=compressibleOrificeFlow(c.intakePressurePa,c.intakeTemperatureK,p,t,ai,c.dischargeCoefficient,gi);
  const dout=compressibleOrificeFlow(p,t,c.exhaustPressurePa,c.exhaustTemperatureK,ae,c.dischargeCoefficient,ge);
  const incoming=(din>0?din*enthalpy(c.intakeTemperatureK):0)+(dout<0?-dout*enthalpy(c.exhaustTemperatureK):0);
  const outgoing=(din<0?-din*enthalpy(t):0)+(dout>0?dout*enthalpy(t):0);
  const frac=clamp(s.fresh/s.m,0,1),dfresh=(din>0?din:din*frac)-(dout>0?dout*frac:0);
  const area=2*Math.PI*c.boreM**2/4+Math.PI*c.boreM*(v/(Math.PI*c.boreM**2/4));
  const qw=c.heatTransferWm2K*area*(t-c.wallTemperatureK)*dtPerDeg,work=p*volumeDerivative(c,angle);
  return {dm:(din-dout)*dtPerDeg,du:qPerDeg-qw-work+(incoming-outgoing)*dtPerDeg,dfresh:dfresh*dtPerDeg,din,dout,hin:incoming*dtPerDeg,hout:outgoing*dtPerDeg,work,wall:qw,temp:t,pressure:p};
 };
 const valid=(s:State)=>s.m>1e-12&&s.u>0&&Number.isFinite(s.m+s.u+s.fresh)&&s.fresh>=-1e-12&&s.fresh<=s.m+1e-12&&temperature(s.m,s.u)>1&&temperature(s.m,s.u)<20000;
 function record(angle:number,qPerDeg:number){const r=rates(angle,state,qPerDeg);trace.angleDeg.push(angle);trace.pressurePa.push(r.pressure);trace.temperatureK.push(r.temp);trace.volumeM3.push(cylinderVolume(c,angle));trace.massKg.push(state.m);trace.heatReleaseJ.push(heat);trace.heatReleaseRateJPerDeg.push(qPerDeg);trace.intakeFlowKgs.push(r.din);trace.exhaustFlowKgs.push(r.dout);}
 const eventAngles=[c.intakeCloseDeg,soc,burnEnd,180,360,540,c.exhaustOpenDeg,720,...(c.fuelDeliveryStartDeg===undefined?[]:[c.fuelDeliveryStartDeg,c.fuelDeliveryStartDeg+c.fuelDeliveryDurationDeg!])].sort((a,b)=>a-b);
 for(let cycle=0;cycle<=c.settlingCycles;cycle++){
  const capturing=cycle===c.settlingCycles;
  if(capturing){initialM=state.m;initialU=state.u;net=gross=pumping=heat=wall=inMass=inReverse=outMass=outReverse=hin=hout=outTemperature=steps=0;record(0,0);peakPressure=trace.pressurePa[0];peakTemp=trace.temperatureK[0];peakAngle=0;}
  let angle=0,ivcCaptured=false,burnTagged=false;
  let cycleFuel=c.fuelMassKg??0,cycleHeatFuel=cycleFuel,cycleFresh=0,cycleResidual=1;
  const bins=Math.round(720/c.stepDeg);
  for(let sample=1;sample<=bins;sample++){
   const target=sample===bins?720:sample*c.stepDeg;
   while(angle<target-1e-9){
    if(!ivcCaptured&&angle>=c.intakeCloseDeg-1e-9){cycleFresh=state.fresh;cycleResidual=clamp(1-state.fresh/state.m,0,1);cycleFuel=c.fuelMassKg??cycleFresh/c.airFuelRatio;cycleHeatFuel=c.oxygenLimitAfr===undefined?cycleFuel:Math.min(cycleFuel,Math.max(0,cycleFresh)/c.oxygenLimitAfr);ivcCaptured=true;}
    // Mark the admitted working gas as combustion residual for the next charge.
    // This tracer conversion does not alter total gas mass or internal energy.
    if(!burnTagged&&angle>=soc-1e-9){state.fresh=0;burnTagged=true;}
    let h=Math.min(.25,c.stepDeg/4,target-angle);
    for(const event of eventAngles)if(event>angle+1e-9&&event<angle+h)h=event-angle;
    let accepted=false;
    for(let attempt=0;attempt<18;attempt++){
     const q=cycleHeatFuel*c.fuelLhvJkg*c.combustionEfficiency*(wiebe(angle+h)-wiebe(angle))/h;
     const first=rates(angle,state,q),mid:State={m:state.m+first.dm*h/2,u:state.u+first.du*h/2,fresh:state.fresh+first.dfresh*h/2};
     if(!valid(mid)||Math.abs(first.dm*h)>state.m*.08||Math.abs(first.du*h)>state.u*.25){h/=2;continue;}
     const r=rates(angle+h/2,mid,q),next:State={m:state.m+r.dm*h,u:state.u+r.du*h,fresh:state.fresh+r.dfresh*h};
     if(!valid(next)){h/=2;continue;}
     const oldP=state.m*R*temperature(state.m,state.u)/cylinderVolume(c,angle),newP=next.m*R*temperature(next.m,next.u)/cylinderVolume(c,angle+h);
     if(capturing){
      const w=r.work*h;net+=w;if(angle+h/2>=180&&angle+h/2<=540)gross+=w;else pumping+=w;
      heat+=q*h;wall+=r.wall*h;hin+=r.hin*h;hout+=r.hout*h;
      const dt=h*dtPerDeg;if(r.din>=0)inMass+=r.din*dt;else inReverse-=r.din*dt;
      if(r.dout>=0){outMass+=r.dout*dt;outTemperature+=r.dout*dt*r.temp;}else outReverse-=r.dout*dt;
      maxRise=Math.max(maxRise,(newP-oldP)/h);if(newP>peakPressure){peakPressure=newP;peakAngle=angle+h;}peakTemp=Math.max(peakTemp,temperature(next.m,next.u));steps++;
     }
     state=next;angle+=h;accepted=true;break;
    }
    if(!accepted)throw new RangeError(`Cylinder integration left its valid state domain near ${angle.toFixed(3)} crank degrees.`);
   }
   if(capturing){const q=cycleHeatFuel*c.fuelLhvJkg*c.combustionEfficiency*(wiebe(Math.min(720,target+.001))-wiebe(Math.max(0,target-.001)))/.002;record(target,q);}
  }
  if(capturing){fuel=cycleFuel;oxygenEligibleFuel=cycleHeatFuel;freshCharge=cycleFresh;residual=cycleResidual;}
 }
 const massResidual=state.m-initialM-(inMass+outReverse-inReverse-outMass),energyResidual=state.u-initialU-(heat-wall-net+hin-hout);
 const periodicMassRelativeError=Math.abs(state.m-initialM)/Math.max(initialM,1e-12),periodicEnergyRelativeError=Math.abs(state.u-initialU)/Math.max(initialU,1e-12);
 if(periodicMassRelativeError>.02||periodicEnergyRelativeError>.02)warnings.push('Cycle is not settled to within 2% mass/internal-energy closure; increase settling cycles or inspect boundary conditions.');
 if(burnEnd>=c.exhaustOpenDeg)warnings.push('Specified heat release overlaps exhaust opening; unburned-fuel discharge/chemistry is not resolved.');
 warnings.push('Uncalibrated air-standard single-zone model; fuel is represented by heat input and residual gas uses the same working-fluid properties.');
 if(c.variableHeatCapacity)warnings.push('Temperature-dependent heat capacity is an explicit linear air approximation, not chemical equilibrium or a validated gas-property table.');
 return {config:c,trace,netWorkJ:net,netIndicatedWorkJ:net,grossWorkJ:gross,pumpingWorkJ:pumping,imepPa:net/swept,
  peakPressurePa:Math.max(peakPressure,...trace.pressurePa),peakTemperatureK:Math.max(peakTemp,...trace.temperatureK),peakPressureAngleDeg:peakAngle,peakPressureRisePaPerDeg:maxRise,
  ca10Deg:burnAngle(.1),ca50Deg:burnAngle(.5),ca90Deg:burnAngle(.9),freshChargeMassKg:freshCharge,airMassKg:freshCharge,fuelMassKg:fuel,fuelEnergyJ:fuel*c.fuelLhvJkg,releasedHeatJ:heat,wallHeatLossJ:wall,residualFractionAtIvc:residual,
  intakeMassInKg:inMass,intakeReverseMassKg:inReverse,exhaustMassKg:outMass,exhaustReverseMassKg:outReverse,exhaustTemperatureK:outMass>0?outTemperature/outMass:c.exhaustTemperatureK,
  inletEnthalpyJ:hin,outletEnthalpyJ:hout,massBalanceResidualKg:massResidual,energyBalanceResidualJ:energyResidual,
  periodicMassRelativeError,periodicEnergyRelativeError,initialMassKg:initialM,finalMassKg:state.m,initialInternalEnergyJ:initialU,finalInternalEnergyJ:state.u,steps,warnings,status:'uncalibrated-air-standard',...(c.oxygenLimitAfr===undefined?{}:{oxygenLimitedFuelMassKg:oxygenEligibleFuel,oxygenUnburnedFuelMassKg:Math.max(0,fuel-oxygenEligibleFuel)})};
}
