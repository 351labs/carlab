import { getBackendName,getBackendIdentity } from './backend.ts';
import type { EngineConfig } from './dsp.ts';
import type { ClipAnalysis, StereoClip } from './listening-bench.ts';

interface BenchItem { id:string; clip:StereoClip; analysis:ClipAnalysis; gainDb:number }
interface Options {
 getConfig():EngineConfig;
 getSnapshots():Partial<Record<'A'|'B',EngineConfig>>;
 stopLive():void;
 pauseFiles():void;
 volume():number;
 notify(message:string):void;
}

/** References stay in this browser. Worker analysis never uploads recordings. */
export function mountBench(container:HTMLElement, options:Options) {
 container.innerHTML=`<div class="section-heading"><div><p class="eyebrow">03 / Bancada de afinação</p><h2>Compare no mesmo trecho</h2></div><span class="pill">Arquivos locais · sem upload</span></div>
 <p class="panel-intro">Marque um trecho da sua gravação e compare com a voz atual ou os slots A/B. RPM e carga da referência são informações fornecidas por você; o laboratório não os deduz do áudio.</p>
 <div class="bench-fields"><label class="field">Referência WAV, MP3 ou outro formato do navegador<input id="bench-file" type="file" accept="audio/*"></label><label class="field">Início (s)<input id="bench-start" type="number" min="0" step="0.1" value="0"></label><label class="field">Fim (s)<input id="bench-end" type="number" min="0.4" step="0.1" value="6"></label><label class="field">RPM conhecido / alvo da síntese<input id="bench-rpm" type="number" min="400" max="18720" step="50" value="3000"></label><label class="field">Carga da síntese (%)<input id="bench-load" type="number" min="0" max="100" step="1" value="60"></label><label class="field">Normalização<select id="bench-match"><option value="lufs">Loudness · LUFS</option><option value="rms">Energia · RMS</option></select></label><label class="field">Trajetória da síntese<select id="bench-scenario"><option value="steady">RPM estável</option><option value="idle">Marcha lenta</option><option value="rev">Subida e descida de giro</option><option value="drive">Aceleração com trocas</option><option value="overrun">Aceleração e retenção</option></select></label></div>
 <p id="bench-source" class="panel-note">Sem referência: compare configurações sintetizadas em um trecho estável de seis segundos.</p>
 <div class="bench-actions"><button id="bench-build" class="dark">Preparar comparação</button><button id="bench-bank">Auditar transições do banco</button><button id="bench-cancel" disabled>Cancelar</button><button id="bench-stop" disabled>Parar audição</button><label class="check-label"><input id="bench-blind" type="checkbox" checked> Ocultar identidades</label><button id="bench-reveal" disabled>Revelar</button></div><p id="bench-status" role="status" class="panel-note">O volume de audição controla esta bancada. A normalização afeta somente as cópias de comparação.</p>
 <div id="bench-results" class="bench-results"></div><label class="field">Anotações da sessão<textarea id="bench-notes" rows="2" placeholder="Ex.: falta corpo em baixa; transição metálica; a referência foi gravada na cabine."></textarea></label><button id="bench-report" class="small" disabled>Baixar análise e anotações</button>`;
 const q=<T extends HTMLElement=HTMLElement>(id:string)=>container.querySelector<T>(`#${id}`)!;
 let decoded:AudioBuffer|undefined, referenceName='', worker:Worker|undefined, requestId=0;
 let items:BenchItem[]=[], order:number[]=[], revealed=false, busy=false, matching:unknown;
 let preparedSession:Record<string,unknown>={},ratings=new Map<number,number|null>();
 let player:AudioContext|undefined, source:AudioBufferSourceNode|undefined, output:GainNode|undefined, playGeneration=0;
 const number=(id:string,fallback:number,min:number,max:number)=>{const n=Number(q<HTMLInputElement>(id).value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;};
 const status=(message:string)=>{q('bench-status').textContent=message;};
 const setBusy=(value:boolean)=>{busy=value;q<HTMLButtonElement>('bench-build').disabled=value;q<HTMLButtonElement>('bench-bank').disabled=value;q<HTMLButtonElement>('bench-cancel').disabled=!value;};
 function stop(){playGeneration++;if(source){source.onended=null;try{source.stop();}catch{/* Already ended. */}source.disconnect();source=undefined;}q<HTMLButtonElement>('bench-stop').disabled=true;container.querySelectorAll('[data-bench-play]').forEach(b=>b.classList.remove('active'));void player?.suspend();}
 function cancel(){worker?.terminate();worker=undefined;requestId++;setBusy(false);status('Preparação cancelada.');}
 function clear(){stop();items=[];order=[];ratings.clear();q('bench-results').replaceChildren();q<HTMLButtonElement>('bench-report').disabled=true;q<HTMLButtonElement>('bench-reveal').disabled=true;}
 async function play(index:number){
  stop();const generation=playGeneration;options.stopLive();options.pauseFiles();
  try{
   player??=new AudioContext({sampleRate:48000});output??=player.createGain();output.gain.value=options.volume();output.disconnect();output.connect(player.destination);
   await player.resume();if(generation!==playGeneration)return;
   const clip=items[index].clip, buffer=player.createBuffer(2,clip.left.length,clip.sampleRate);
   buffer.copyToChannel(new Float32Array(clip.left),0);buffer.copyToChannel(new Float32Array(clip.right),1);
   source=player.createBufferSource();source.buffer=buffer;source.loop=true;source.connect(output);source.onended=()=>{q<HTMLButtonElement>('bench-stop').disabled=true;};source.start();
   q<HTMLButtonElement>('bench-stop').disabled=false;container.querySelector(`[data-bench-play="${index}"]`)?.classList.add('active');
  }catch(error){if(generation===playGeneration){stop();options.notify(`Não foi possível ouvir o trecho: ${String(error)}`);}}
 }
 function draw(canvas:HTMLCanvasElement,analysis:ClipAnalysis){
  const ctx=canvas.getContext('2d')!;canvas.width=760;canvas.height=130;ctx.fillStyle='#f1f3eb';ctx.fillRect(0,0,760,130);ctx.strokeStyle='#85936b';ctx.beginPath();
  const wave=analysis.waveform as {min:number[];max:number[]};
  for(let i=0;i<wave.min.length;i++){const x=i/Math.max(1,wave.min.length-1)*760;ctx.moveTo(x,38-wave.min[i]*30);ctx.lineTo(x,38-wave.max[i]*30);}ctx.stroke();
  ctx.strokeStyle='#354a27';ctx.beginPath();
  const spectrum=analysis.spectrum as {frequencyHz:number[];powerDb:number[]};
  for(let i=0;i<spectrum.frequencyHz.length;i++){const hz=spectrum.frequencyHz[i];if(hz<20||hz>20000)continue;const x=Math.log(hz/20)/Math.log(1000)*760,y=121-Math.max(0,Math.min(1,(spectrum.powerDb[i]+100)/100))*43;i?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.stroke();
  ctx.fillStyle='#58634f';ctx.font='10px monospace';ctx.fillText('Envelope / espectro 20 Hz — 20 kHz (log)',9,125);
 }
 const fixed=(value:number|null|undefined,digits=1)=>value!=null&&Number.isFinite(value)?value.toFixed(digits):'—';
 function render(){
  q('bench-results').replaceChildren();const hide=q<HTMLInputElement>('bench-blind').checked&&!revealed;
  for(const [position,index] of order.entries()){
   const item=items[index],card=document.createElement('article');card.className='bench-result';
   const title=document.createElement('h3');title.textContent=hide?`Amostra ${position+1}`:item.id;card.append(title);
   const button=document.createElement('button');button.textContent='Ouvir em loop';button.dataset.benchPlay=String(index);button.addEventListener('click',()=>void play(index));card.append(button);
   const canvas=document.createElement('canvas');canvas.setAttribute('aria-label','Envelope e espectro do trecho');card.append(canvas);draw(canvas,item.analysis);
   const info=document.createElement('p');info.className='panel-note';info.textContent=`${fixed(item.analysis.loudness.integratedLufs)} LUFS · ${fixed(item.analysis.rmsDbfs)} dBFS RMS · pico de amostra ${fixed(item.analysis.samplePeakDbfs)} dBFS · ajuste ${fixed(item.gainDb)} dB`;card.append(info);
   const bands=document.createElement('p');bands.className='panel-note';bands.textContent=item.analysis.bands.map(b=>`${b.label}: ${(b.fraction*100).toFixed(1)}%`).join(' · ');card.append(bands);
   const method=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Método e limites desta análise';method.append(summary);const warnings=document.createElement('p');warnings.className='panel-note';warnings.textContent=[...item.analysis.warnings,...item.analysis.loudness.warnings].join(' ');method.append(warnings);card.append(method);
   const label=document.createElement('label');label.className='field';label.textContent='Naturalidade percebida (1–10)';const rating=document.createElement('input');rating.type='number';rating.min='1';rating.max='10';rating.step='1';rating.dataset.benchRating=String(index);rating.value=ratings.get(index)!=null?String(ratings.get(index)):'';rating.addEventListener('input',()=>ratings.set(index,rating.value?Math.max(1,Math.min(10,Number(rating.value))):null));label.append(rating);card.append(label);q('bench-results').append(card);
  }
 }
 function attachWorker(id:number){
  worker!.onmessage=({data})=>{
   if(data.id!==requestId)return;
   if(data.type==='progress'){status(data.message??'Preparando…');return;}
   if(data.type==='error'){setBusy(false);status(data.message);worker?.terminate();worker=undefined;return;}
   if(data.type==='complete'){
    setBusy(false);items=data.clips;matching=data.matching;preparedSession.effectiveOptions=data.options;order=Array.from({length:items.length},(_,i)=>i);
    for(let i=order.length-1;i>0;i--){const bytes=crypto.getRandomValues(new Uint32Array(1));const j=bytes[0]%(i+1);[order[i],order[j]]=[order[j],order[i]];}
    revealed=items.length===1;render();q<HTMLButtonElement>('bench-reveal').disabled=items.length<2;q<HTMLButtonElement>('bench-report').disabled=false;
    status(data.kind==='bank-audition'?'Banco renderizado e reproduzido por interpolação de RPM × carga. Protótipo: ouça emendas e mudanças de timbre; esta audição ainda não é a integração em outra aplicação.':`Comparação pronta. ${data.options?.scenario==='steady'?`Alvo comum efetivo: ${Math.round(data.options.rpm)} RPM. `:''}A reprodução repete o trecho; cortes da gravação podem ser audíveis na emenda. Pico por amostra, sem true peak.`);
    worker?.terminate();worker=undefined;
   }
  };
  worker!.onerror=event=>{if(id!==requestId)return;setBusy(false);status(`Falha na bancada: ${event.message}`);worker?.terminate();worker=undefined;};
 }
 q('bench-file').addEventListener('change',async()=>{
  cancel();clear();decoded=undefined;referenceName='';const file=q<HTMLInputElement>('bench-file').files?.[0];if(!file){q('bench-source').textContent='Sem referência local.';return;}
  const generation=requestId;
  q('bench-source').textContent=`Preparando ${file.name} localmente…`;
  if(file.size>60*1024*1024){q('bench-source').textContent='Sem referência local.';status('Escolha um arquivo de até 60 MB.');return;}
  try{setBusy(true);status('Decodificando localmente…');const decoder=new OfflineAudioContext(2,1,48000);const audio=await decoder.decodeAudioData(await file.arrayBuffer());if(generation!==requestId)return;decoded=audio;referenceName=file.name;q<HTMLInputElement>('bench-end').value=String(Math.min(6,audio.duration).toFixed(2));q<HTMLInputElement>('bench-start').value='0';q('bench-source').textContent=`${file.name} · ${audio.duration.toFixed(2)} s · ${audio.sampleRate} Hz · ${audio.numberOfChannels} canal(is). Confira a posição do microfone e a condição de operação nas suas anotações.`;status('Referência pronta. Marque um trecho entre 0,4 e 12 segundos.');}
  catch(error){if(generation===requestId){decoded=undefined;q('bench-source').textContent='Sem referência local. Escolha outro arquivo ou compare as configurações sintetizadas.';status(`Formato não decodificado: ${String(error)}`);}}
  finally{if(generation===requestId)setBusy(false);}
 });
 q('bench-build').addEventListener('click',()=>{
  if(busy)return;clear();worker?.terminate();worker=new Worker(new URL('./bench-worker.ts',import.meta.url),{type:'module'});const id=++requestId;setBusy(true);status('Renderizando e medindo as amostras…');
  const config=options.getConfig(),snapshots=options.getSnapshots();
  const configs=[{id:'Voz atual',config},...(['A','B'] as const).filter(k=>snapshots[k]).map(k=>({id:`Configuração ${k}`,config:snapshots[k]!}))];
  let reference:StereoClip|undefined,duration=6;
  if(decoded){const start=number('bench-start',0,0,decoded.duration),end=number('bench-end',6,0,decoded.duration);duration=end-start;if(duration<.4||duration>12){setBusy(false);status('O trecho deve ter entre 0,4 e 12 segundos.');worker.terminate();return;}const a=Math.floor(start*decoded.sampleRate),b=Math.floor(end*decoded.sampleRate);reference={left:decoded.getChannelData(0).slice(a,b),right:decoded.getChannelData(Math.min(1,decoded.numberOfChannels-1)).slice(a,b),sampleRate:decoded.sampleRate};}
  const lockedOptions={scenario:q<HTMLSelectElement>('bench-scenario').value,duration,sampleRate:48000,rpm:number('bench-rpm',3000,400,18720),load:number('bench-load',60,0,100)/100,throttle:number('bench-load',60,0,100)/100};
  preparedSession={backend:getBackendIdentity(),reference:decoded?referenceName:null,referenceBounds:decoded?{startSeconds:number('bench-start',0,0,decoded.duration),endSeconds:number('bench-end',6,0,decoded.duration)}:null,referenceRpmConfirmed:false,options:lockedOptions,configs:structuredClone(configs)};
  attachWorker(id);
  worker.postMessage({backend:getBackendName(),type:'compare',id,configs,options:lockedOptions,reference,match:{mode:q<HTMLSelectElement>('bench-match').value,targetDb:-23,peakCeilingDbfs:-1},seed:crypto.getRandomValues(new Uint32Array(1))[0]});
 });
 q('bench-bank').addEventListener('click',()=>{if(busy)return;clear();worker?.terminate();worker=new Worker(new URL('./bench-worker.ts',import.meta.url),{type:'module'});const id=++requestId;setBusy(true);const config=options.getConfig();preparedSession={backend:getBackendIdentity(),kind:'bank-transition-audition',config:structuredClone(config),reference:null};attachWorker(id);status('Gerando os 48 pontos reais do banco para auditar suas transições…');worker.postMessage({backend:getBackendName(),type:'bank-audition',id,config,options:{duration:6}});});
 q('bench-cancel').addEventListener('click',cancel);q('bench-stop').addEventListener('click',stop);
 q('bench-reveal').addEventListener('click',()=>{stop();revealed=true;render();q<HTMLButtonElement>('bench-reveal').disabled=true;});
 q('bench-blind').addEventListener('change',()=>{stop();render();});
 q('bench-report').addEventListener('click',()=>{
  const report={schema:'carlab-listening-session-1',createdAt:new Date().toISOString(),...preparedSession,notes:q<HTMLTextAreaElement>('bench-notes').value,blindOrder:order,ratings:Array.from(ratings,([sample,rating])=>({sample,rating})),matching,clips:items.map(item=>({id:item.id,gainDb:item.gainDb,analysis:item.analysis})),limits:'Qualitative reference unless RPM/load/microphone are independently known; loudness is an implementation estimate; no true-peak measurement.'};
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='carlab-listening-session.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
 });
 return {stop,setVolume(value:number){if(output)output.gain.value=value;},dispose(){cancel();stop();void player?.close();},isPlaying:()=>!!source};
}
