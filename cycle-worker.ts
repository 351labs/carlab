/// <reference lib="webworker" />
import { getCylinderCycle,normalizePhysicalConfig,evaluateEngine,type PhysicalConfig } from './backend.ts';
import { normalizeConfig,initializeBackend,type BackendName } from './backend.ts';
import type { EngineConfig } from './dsp.ts';
import { comparePressureTrace,requirePressureFitCoverage,type PressureObservation } from './pressure-observations.ts';

type Request={backend?:BackendName;id:number;type:'analyze'|'fit';engine:EngineConfig;physical:PhysicalConfig;rpm:number;throttle:number;observation?:PressureObservation};
const scope=globalThis as unknown as DedicatedWorkerGlobalScope;
scope.onmessage=async({data}:MessageEvent<Request>)=>{
 try{
  await initializeBackend(data.backend??'rust');
  const engine=normalizeConfig(data.engine),physical=normalizePhysicalConfig(engine,data.physical);
  const rpm=Math.max(engine.idleRpm,Math.min(engine.redline*.995,Number(data.rpm))),throttle=Math.max(0,Math.min(1,Number(data.throttle)));
  if(!Number.isFinite(rpm)||!Number.isFinite(throttle))throw new Error('RPM/carga do ciclo inválidos.');
  if(data.type==='fit'){
   if(physical.ecu?.enabled)throw new Error('O ajuste escalar de avanço está indisponível com EFI ativa: a injeção usa seus próprios mapas. Use a busca da bancada EFI.');
   const observation=requirePressureFitCoverage(data.observation);
   const candidates:PhysicalConfig[]=[];
   for(const advance of [-6,0,6])for(const duration of [-10,0,10])candidates.push(normalizePhysicalConfig(engine,{...physical,sparkAdvanceDeg:physical.sparkAdvanceDeg+advance,burnDurationDeg:physical.burnDurationDeg+duration}));
   const unique=[...new Map(candidates.map(p=>[`${p.sparkAdvanceDeg}/${p.burnDurationDeg}`,p])).values()];
   let best:{sparkAdvanceDeg:number;burnDurationDeg:number;rmseBar:number;maeBar:number;samples:number}|undefined;
   for(let i=0;i<unique.length;i++){
    scope.postMessage({type:'progress',id:data.id,message:`Avaliando hipótese ${i+1}/${unique.length}…`});
    const candidate=unique[i],cycle=getCylinderCycle(engine,candidate,rpm,throttle),error=comparePressureTrace(cycle.trace.angleDeg,cycle.trace.pressurePa,observation,[240,500]);
    if(!best||error.rmseBar<best.rmseBar)best={sparkAdvanceDeg:candidate.sparkAdvanceDeg,burnDurationDeg:candidate.burnDurationDeg,...error};
   }
   scope.postMessage({type:'complete',id:data.id,kind:'fit',best,candidates:unique.length,rpm,throttle,bounds:{sparkAdvanceDeg:[Math.min(...unique.map(p=>p.sparkAdvanceDeg)),Math.max(...unique.map(p=>p.sparkAdvanceDeg))],burnDurationDeg:[Math.min(...unique.map(p=>p.burnDurationDeg)),Math.max(...unique.map(p=>p.burnDurationDeg))]}});return;
  }
  scope.postMessage({type:'progress',id:data.id,message:'Integrando admissão, compressão, queima, expansão e escape…'});
  const cycle=getCylinderCycle(engine,physical,rpm,throttle),estimate=evaluateEngine(engine,physical,rpm,throttle);
  const error=data.observation?comparePressureTrace(cycle.trace.angleDeg,cycle.trace.pressurePa,data.observation):undefined;
  scope.postMessage({type:'complete',id:data.id,kind:'analyze',cycle,estimate,error,rpm,throttle});
 }catch(error){scope.postMessage({type:'error',id:data.id,message:error instanceof Error?error.message:String(error)});}
};
