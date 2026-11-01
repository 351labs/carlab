import type { ThermalConfig,ThermalState } from './thermal.ts';
import { getBackendIdentity,normalizeThermalConfig,normalizeMaterialScreenConfig,parseMaterialCard,screenMaterial } from './backend.ts';
import type { MaterialScreenConfig,MechanicalCycleInput,MaterialScreenResult } from './materials.ts';

export interface ThermalPanelOptions {
 getConfig():ThermalConfig;
 setConfig(config:ThermalConfig):void;
 getState():ThermalState|undefined;
 getMechanicalInput():MechanicalCycleInput|undefined;
 getMaterialScreen():MaterialScreenConfig;
 setMaterialScreen(config:MaterialScreenConfig):void;
 notify(message:string):void;
}
type Field={key:keyof ThermalConfig;label:string;unit:string;min:number;max:number;step:number};
const fields:Field[]=[
 {key:'ambientTemperatureK',label:'Temperatura ambiente',unit:'K',min:200,max:400,step:1},
 {key:'initialWallTemperatureK',label:'Temperatura inicial da parede',unit:'K',min:200,max:1800,step:1},
 {key:'initialCoolantTemperatureK',label:'Temperatura inicial do líquido',unit:'K',min:200,max:700,step:1},
 {key:'initialOilTemperatureK',label:'Temperatura inicial do óleo',unit:'K',min:200,max:900,step:1},
 {key:'initialExhaustWallTemperatureK',label:'Temperatura inicial da parede do escape',unit:'K',min:200,max:2000,step:1},
 {key:'coolantMassFlowKgs',label:'Vazão de líquido',unit:'kg/s',min:0,max:20,step:.01},
 {key:'oilMassFlowKgs',label:'Vazão de óleo',unit:'kg/s',min:0,max:20,step:.01},
 {key:'coolantInletTemperatureK',label:'Líquido na entrada da fronteira',unit:'K',min:200,max:700,step:1},
 {key:'oilInletTemperatureK',label:'Óleo na entrada da fronteira',unit:'K',min:200,max:900,step:1},
 {key:'wallHeatCapacityJK',label:'Capacidade térmica da parede',unit:'J/K',min:100,max:5e6,step:100},
 {key:'coolantHeatCapacityJK',label:'Capacidade térmica do líquido',unit:'J/K',min:100,max:5e6,step:100},
 {key:'oilHeatCapacityJK',label:'Capacidade térmica do óleo',unit:'J/K',min:100,max:5e6,step:100},
 {key:'exhaustWallHeatCapacityJK',label:'Capacidade térmica da parede do escape',unit:'J/K',min:100,max:5e6,step:100},
 {key:'wallToCoolantWK',label:'Condutância parede → líquido',unit:'W/K',min:0,max:20000,step:1},
 {key:'wallToOilWK',label:'Condutância parede → óleo',unit:'W/K',min:0,max:20000,step:1},
 {key:'wallToExhaustWK',label:'Condutância parede → escape',unit:'W/K',min:0,max:20000,step:1},
 {key:'exhaustToCoolantWK',label:'Condutância escape → líquido',unit:'W/K',min:0,max:20000,step:1},
 {key:'coolantToAmbientWK',label:'Condutância líquido → ambiente',unit:'W/K',min:0,max:20000,step:1},
 {key:'oilToAmbientWK',label:'Condutância óleo → ambiente',unit:'W/K',min:0,max:20000,step:1},
 {key:'exhaustToAmbientWK',label:'Condutância escape → ambiente',unit:'W/K',min:0,max:20000,step:1},
 {key:'coolantSpecificHeatJKgK',label:'Calor específico do líquido',unit:'J/(kg·K)',min:500,max:8000,step:10},
 {key:'oilSpecificHeatJKgK',label:'Calor específico do óleo',unit:'J/(kg·K)',min:500,max:8000,step:10},
 {key:'frictionToOilFraction',label:'Fração do calor de atrito no óleo',unit:'fração',min:0,max:1,step:.01},
 {key:'exhaustGasHeatCapacityJKgK',label:'Calor específico assumido do gás',unit:'J/(kg·K)',min:500,max:3000,step:10},
 {key:'exhaustHeatTransferEffectiveness',label:'Efetividade gás → parede do escape',unit:'fração',min:0,max:1,step:.01},
];
const materialFields=[
 ['netSectionMm2','Seção resistente nominal','mm²',1,100000,1],
 ['stressConcentration','Fator de concentração assumido','Kt',1,20,.1],
 ['componentTemperatureK','Temperatura do componente avaliado','K',150,2000,1],
 ['crankcasePressurePa','Pressão absoluta no cárter','Pa',1000,1e6,100],
 ['durationSeconds','Duração do caso de envelope','s',0,1e9,1],
 ['cyclesPerEngineCycle','Envelopes por ciclo de 720°','contagem assumida',.01,100,.1],
] as const;

/** Displays the actual model state; it never runs a separate decorative thermal
 * simulation. Material names and sources remain text, never inserted as markup.
 */
export function mountThermalPanel(container:HTMLElement,options:ThermalPanelOptions){
 const q=<T extends HTMLElement=HTMLElement>(id:string)=>container.querySelector<T>(`#${id}`)!;
 const numeric=(n:number)=>String(Number(n.toPrecision(8)));
 const field=(f:Field)=>`<label class="field">${f.label}<span class="field-unit">${f.unit}</span><input id="thermal-${f.key}" data-thermal="${f.key}" type="number" min="${f.min}" max="${f.max}" step="${f.step}"></label>`;
 container.innerHTML=`<div class="section-heading"><div><p class="eyebrow">Térmica / evidência de materiais</p><h2>Temperatura, carga e hipóteses</h2></div><span class="pill">Reservatórios térmicos · sem calibração</span></div><p class="panel-intro">Acompanhe a energia recebida pela parede, pelo líquido, pelo óleo e pela parede do escape. A temperatura do gás é outra grandeza. Os valores iniciais são hipóteses editáveis, sem banco de ligas ou vida útil implícitos.</p><div class="physical-metrics" id="thermal-metrics"></div><p id="thermal-energy-ledger" class="panel-note" role="status"></p><canvas id="thermal-history" aria-label="Histórico das temperaturas da parede, líquido, óleo e parede do escape" style="width:100%;height:220px;display:block"></canvas><p class="panel-note">Linhas: parede (verde), líquido (azul), óleo (marrom), parede do escape (laranja). Alterar temperaturas iniciais reinicia a rede térmica; alterar capacidades/condutâncias preserva as temperaturas e reinicia o balanço de referência.</p>
 <details><summary>Hipóteses térmicas e origem dos parâmetros</summary><div class="physical-fields"><label class="field">Origem declarada<select id="thermal-provenance"><option value="assumed">Assumida</option><option value="fitted">Ajustada</option><option value="measured">Medida</option></select></label><label class="field">Fonte / condições<input id="thermal-source" type="text" maxlength="2000"></label>${fields.map(field).join('')}</div><p class="panel-note">A origem descreve os parâmetros fornecidos, não certifica a rede. Calores de entrada vêm do modelo físico; a rejeição para fluidos/ambiente é contabilizada nas fronteiras. Não há campo térmico espacial ou temperaturas de cada ponto da peça.</p></details>
 <h3 style="margin-top:24px">Triagem nominal de um componente</h3><p class="panel-intro">Pressão e inércia são combinadas no mesmo ângulo do virabrequim para uma biela idealizada. Informe seção e temperatura do componente. A tensão é axial nominal; flambagem, flexão, contatos, parafusos e gradientes térmicos exigem outro modelo.</p><div class="physical-fields">${materialFields.map(([key,label,unit,min,max,step])=>`<label class="field">${label}<span class="field-unit">${unit}</span><input id="material-${key}" data-material="${key}" type="number" min="${min}" max="${max}" step="${step}"></label>`).join('')}<label class="field">Origem da temperatura do componente<input id="material-temperature-source" type="text" maxlength="1000"></label></div><div id="material-review" class="panel-note" role="status"></div>
 <details><summary>Ficha de material e curvas fornecidas</summary><p class="panel-note">Sem ficha, resistência e fadiga ficam não avaliadas. A ficha precisa de nome, proveniência, condições e tensão nominal de projeto por temperatura. S–N é opcional e precisa de domínio de temperatura, razão R e amplitude. Nada é extrapolado; não há correção de tensão média ou contagem rainflow.</p><label class="field">JSON da ficha<textarea id="material-json" rows="12" spellcheck="false"></textarea></label><div class="bench-actions"><button id="material-apply">Aplicar ficha</button><button id="material-import">Abrir JSON</button><button id="material-clear">Remover ficha</button><input id="material-file" type="file" accept="application/json,.json" hidden></div><p id="material-card-status" class="panel-note"></p></details><div class="bench-actions"><button id="thermal-export">Baixar análise e hipóteses</button></div>`;
 let disposed=false,lastConfig='',lastMaterial='',lastScreen='',fileEpoch=0,result:MaterialScreenResult|undefined;
 const history:{time:number;values:number[]}[]=[];
 const fmt=(n:number,digits=1)=>Number.isFinite(n)?n.toLocaleString('pt-BR',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
 function handle(action:()=>void){try{action();refresh();}catch(error){options.notify(error instanceof Error?error.message:String(error));}}
 function draw(){
  const canvas=q<HTMLCanvasElement>('thermal-history'),ctx=canvas.getContext('2d')!,width=Math.max(260,canvas.clientWidth),height=220,dpr=Math.min(devicePixelRatio,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#f3f6ec';ctx.fillRect(0,0,width,height);
  if(!history.length){ctx.fillStyle='#64715d';ctx.font='12px monospace';ctx.fillText('Ligue a condução física para acompanhar os estados.',12,35);return;}
  const min=Math.floor((Math.min(...history.flatMap(p=>p.values))-273.15)/10)*10-5,max=Math.max(min+20,Math.ceil((Math.max(...history.flatMap(p=>p.values))-273.15)/10)*10+5),left=48,right=width-12,top=20,bottom=187,start=history[0].time,end=Math.max(start+1,history.at(-1)!.time);
  ctx.font='10px monospace';for(let i=0;i<=4;i++){const y=bottom-i*(bottom-top)/4;ctx.strokeStyle='#dce4d2';ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillStyle='#66715f';ctx.fillText(`${Math.round(min+(max-min)*i/4)}°`,4,y+3);}
  for(const [index,color] of ['#557c3c','#3b7f9c','#82704e','#ba6f38'].entries()){ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();history.forEach((p,i)=>{const x=left+(p.time-start)/(end-start)*(right-left),y=bottom-(p.values[index]-273.15-min)/(max-min)*(bottom-top);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();}
  ctx.fillStyle='#66715f';ctx.fillText(`${fmt(start,0)} s`,left,207);ctx.fillText(`${fmt(end,0)} s`,Math.max(left,right-45),207);ctx.fillText('°C',7,12);
 }
 function sync(){
  const cfg=normalizeThermalConfig(options.getConfig()),cfgKey=JSON.stringify(cfg);
  if(cfgKey!==lastConfig){lastConfig=cfgKey;for(const f of fields)q<HTMLInputElement>(`thermal-${f.key}`).value=numeric(Number(cfg[f.key]));q<HTMLSelectElement>('thermal-provenance').value=cfg.provenance;q<HTMLInputElement>('thermal-source').value=cfg.source;}
  const screen=normalizeMaterialScreenConfig(options.getMaterialScreen()),screenKey=JSON.stringify(screen);
  if(screenKey!==lastScreen){lastScreen=screenKey;for(const [key] of materialFields)q<HTMLInputElement>(`material-${key}`).value=numeric(screen[key]);q<HTMLInputElement>('material-temperature-source').value=screen.componentTemperatureSource;}
  const material=JSON.stringify(screen.material);
  if(material!==lastMaterial){lastMaterial=material;q<HTMLTextAreaElement>('material-json').value=JSON.stringify(screen.material??{schema:1,name:'',provenance:{kind:'assumed',source:'',conditions:''},allowableStressMPa:[]},null,2);q('material-card-status').textContent=screen.material?`${screen.material.name} · origem ${screen.material.provenance.kind} · ${screen.material.provenance.source}`:'Nenhuma ficha aplicada. Complete os dados e a origem antes de aplicar.';}
  return screen;
 }
 function refresh(){
  if(disposed)return;const screen=sync(),state=options.getState();
  if(state){
   const values=[state.wallTemperatureK,state.coolantTemperatureK,state.oilTemperatureK,state.exhaustWallTemperatureK];
   q('thermal-metrics').innerHTML=[['PAREDE',values[0]],['LÍQUIDO',values[1]],['ÓLEO',values[2]],['PAREDE DO ESCAPE',values[3]]].map(([label,value])=>`<div><span>${label}</span><strong>${fmt(Number(value)-273.15)}</strong><small>°C</small></div>`).join('');
   q('thermal-energy-ledger').textContent=`${fmt(state.elapsedSeconds)} s · energia armazenada Δ ${fmt(state.deltaStoredEnergyJ/1000,2)} kJ · entrada ${fmt(state.cumulativeInputJ/1000,2)} kJ · rejeição líquida ${fmt(state.cumulativeRejectedJ/1000,2)} kJ · resíduo ${state.energyResidualJ.toExponential(2)} J. Gás de escape observado: ${fmt(state.exhaustGasTemperatureK-273.15)} °C; não é a temperatura do metal.`;
   if(history.length&&state.elapsedSeconds<history.at(-1)!.time)history.length=0;
   if(!history.length||state.elapsedSeconds-history.at(-1)!.time>=.5){history.push({time:state.elapsedSeconds,values});if(history.length>240)history.shift();}
   else if(state.elapsedSeconds===history.at(-1)!.time)history[history.length-1]={time:state.elapsedSeconds,values};
  }else{q('thermal-energy-ledger').textContent='Estado térmico ainda indisponível. Ative a condução física.';q('thermal-metrics').replaceChildren();}
  draw();const mechanical=options.getMechanicalInput();q('material-review').replaceChildren();result=undefined;
  if(!mechanical){q('material-review').textContent='Prepare um ciclo de pressão na bancada física para calcular cargas nominais. Sem ciclo ou ficha, resistência e fadiga não são avaliadas.';return;}
  try{
   result=screenMaterial(mechanical,screen);const name=document.createElement('strong');name.textContent=result.materialName??'Material não fornecido';q('material-review').append(name);
   const summary=document.createElement('p');summary.textContent=`Ciclo analisado a ${fmt(mechanical.rpm,0)} RPM · geometria ${fmt(mechanical.boreM*1000)} × ${fmt(mechanical.strokeM*1000)} mm. Tração nominal máxima ${fmt(result.peakTensileStressMPa)} MPa · compressão máxima ${fmt(result.peakCompressiveStressMPa)} MPa · amplitude ${fmt(result.stressAmplitudeMPa)} MPa · R ${result.stressRatio===null?'—':fmt(result.stressRatio,3)}. ${result.reason}`;q('material-review').append(summary);
   const fatigue=document.createElement('p');fatigue.textContent=result.fatigue.status==='evaluated'?`Curva S–N compatível fornecida: ${result.fatigue.cyclesAtAmplitude!.toExponential(3)} ciclos à amplitude · ${fmt(result.fatigue.appliedEnvelopeCycles,0)} envelopes assumidos · índice ${result.fatigue.damageFraction!.toExponential(3)}. ${result.fatigue.reason}`:`Fadiga não avaliada: ${result.fatigue.reason}`;q('material-review').append(fatigue);
   const limits=document.createElement('p');limits.textContent='Triagem axial nominal condicionada aos dados fornecidos; não calcula vida segura, potência segura, FEM ou efeitos de contato/flambagem. Temperatura do componente é uma entrada separada.';q('material-review').append(limits);
  }catch(error){q('material-review').textContent=`Triagem indisponível: ${error instanceof Error?error.message:String(error)}`;}
 }
 container.querySelectorAll<HTMLInputElement>('[data-thermal]').forEach(input=>input.addEventListener('change',()=>handle(()=>{const value=Number(input.value);if(!Number.isFinite(value))throw new Error('Use um parâmetro térmico finito.');options.setConfig(normalizeThermalConfig({...options.getConfig(),[input.dataset.thermal!]:value}));})));
 for(const id of ['thermal-provenance','thermal-source'])q(id).addEventListener('change',()=>handle(()=>options.setConfig(normalizeThermalConfig({...options.getConfig(),provenance:q<HTMLSelectElement>('thermal-provenance').value as ThermalConfig['provenance'],source:q<HTMLInputElement>('thermal-source').value}))));
 container.querySelectorAll<HTMLInputElement>('[data-material]').forEach(input=>input.addEventListener('change',()=>handle(()=>{const value=Number(input.value);if(!Number.isFinite(value))throw new Error('Use uma hipótese mecânica finita.');options.setMaterialScreen(normalizeMaterialScreenConfig({...options.getMaterialScreen(),[input.dataset.material!]:value}));})));
 q('material-temperature-source').addEventListener('change',()=>handle(()=>options.setMaterialScreen(normalizeMaterialScreenConfig({...options.getMaterialScreen(),componentTemperatureSource:q<HTMLInputElement>('material-temperature-source').value}))));
 const apply=(value:unknown)=>{const material=parseMaterialCard(value);options.setMaterialScreen(normalizeMaterialScreenConfig({...options.getMaterialScreen(),material}));options.notify('Ficha aplicada como evidência fornecida; a triagem continua nominal.');};
 q('material-apply').addEventListener('click',()=>handle(()=>apply(JSON.parse(q<HTMLTextAreaElement>('material-json').value))));
 q('material-clear').addEventListener('click',()=>handle(()=>options.setMaterialScreen(normalizeMaterialScreenConfig({...options.getMaterialScreen(),material:null}))));
 q('material-import').addEventListener('click',()=>q<HTMLInputElement>('material-file').click());
 q('material-file').addEventListener('change',async()=>{const file=q<HTMLInputElement>('material-file').files?.[0],epoch=++fileEpoch;if(!file)return;try{if(file.size>256000)throw new Error('A ficha deve ter até 256 kB.');const data=JSON.parse(await file.text());if(disposed||epoch!==fileEpoch)return;apply(data);refresh();}catch(error){if(!disposed&&epoch===fileEpoch)options.notify(error instanceof Error?error.message:String(error));}finally{if(!disposed)q<HTMLInputElement>('material-file').value='';}});
 q('thermal-export').addEventListener('click',()=>handle(()=>{const report={schema:'carlab-thermal-material-review-1',backend:getBackendIdentity(),createdAt:new Date().toISOString(),thermalModel:'lumped-network-1',mechanicalModel:'nominal-rod-1',thermalConfig:options.getConfig(),thermalState:options.getState(),materialScreen:options.getMaterialScreen(),mechanicalInput:options.getMechanicalInput(),mechanicalResult:result??null,limits:'Unvalidated lumped temperatures and evidence-conditioned nominal stress/envelope fatigue. No FEM, material-safe horsepower or validated component life.'};const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='carlab-thermal-material-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}));
 refresh();const interval=window.setInterval(refresh,250),resize=new ResizeObserver(draw);resize.observe(q('thermal-history'));
 return {refresh,dispose(){disposed=true;fileEpoch++;clearInterval(interval);resize.disconnect();}};
}
