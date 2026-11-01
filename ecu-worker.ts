/// <reference lib="webworker" />
import { initializeBackend,ecuRequest,getBackendIdentity } from './backend.ts';
interface Request {id:number;type:'fit'|'search';fields:Record<string,unknown>}
const scope=globalThis as unknown as DedicatedWorkerGlobalScope;
scope.onmessage=async({data}:MessageEvent<Request>)=>{
 try{
  await initializeBackend('rust');
  if(data.type!=='fit'&&data.type!=='search')throw new Error('Operação EFI desconhecida.');
  scope.postMessage({type:'progress',id:data.id,message:data.type==='fit'?'Ajustando correção de combustível; alvos e modelo de ar permanecem fixos…':'Avaliando candidatos no atuador e no ciclo; orçamento limitado…'});
  const result=ecuRequest(data.type==='fit'?'fitEcuFuelMap':'searchEcuOperatingPoint',data.fields);
  scope.postMessage({type:'complete',id:data.id,kind:data.type,result,backend:getBackendIdentity()});
 }catch(error){scope.postMessage({type:'error',id:data.id,message:error instanceof Error?error.message:String(error)});}
};
