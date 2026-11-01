import type { EngineConfig } from './dsp.ts';
import type { CalibrationMap } from './maps.ts';
import { createAssumedVeMap, normalizeCalibrationMap, parseCalibrationBundle } from './backend.ts';
import { Powertrain, evaluateEngine, normalizePhysicalConfig, potentialEnvelope, isReferenceEcuBlocked, type EngineEstimate, type PhysicalConfig, type PowertrainState } from './backend.ts';

type Field={key:keyof PhysicalConfig;label:string;min:number;max:number;step:number;unit:string};
const basic:Field[]=[
 {key:'boreStrokeRatio',label:'Diâmetro / curso',min:.5,max:2,step:.01,unit:':1'},
 {key:'volumetricEfficiency',label:'VE base para gerar mapa assumido',min:.3,max:1.25,step:.01,unit:'fração'},
 {key:'engineInertiaKgM2',label:'Inércia do conjunto rotativo',min:.03,max:2,step:.01,unit:'kg·m²'},
 {key:'vehicleMassKg',label:'Massa do veículo',min:400,max:3500,step:25,unit:'kg'},
 {key:'finalDrive',label:'Relação do diferencial',min:2,max:6,step:.05,unit:':1'},
 {key:'gradePercent',label:'Inclinação da via',min:-20,max:20,step:.5,unit:'%'},
];
const advanced:Field[]=[
 {key:'rodLengthStrokeRatio',label:'Comprimento da biela / curso',min:1.3,max:2.5,step:.01,unit:':1'},
 {key:'reciprocatingMassKg',label:'Massa alternativa por cilindro',min:.08,max:2,step:.01,unit:'kg'},
 {key:'ambientPressureBar',label:'Pressão ambiente absoluta',min:.5,max:1.2,step:.01,unit:'bar'},
 {key:'intakeTemperatureK',label:'Temperatura na admissão',min:240,max:450,step:1,unit:'K'},
 {key:'combustionEfficiency',label:'Fração de combustível que libera calor',min:.5,max:1,step:.01,unit:'fração'},
 {key:'gamma',label:'Razão de calores específicos γ',min:1.15,max:1.4,step:.01,unit:''},
 {key:'fuelLhvMJkg',label:'Poder calorífico inferior',min:20,max:50,step:.1,unit:'MJ/kg'},
 {key:'airFuelRatio',label:'Razão ar / combustível em massa',min:8,max:22,step:.1,unit:':1'},
 {key:'frictionBaseBar',label:'Atrito base · FMEP',min:0,max:3,step:.05,unit:'bar'},
 {key:'frictionSpeedBar',label:'Atrito por velocidade do pistão',min:0,max:.2,step:.005,unit:'bar/(m/s)'},
 {key:'tyreRadiusM',label:'Raio de rolamento do pneu',min:.2,max:.5,step:.005,unit:'m'},
 {key:'driveEfficiency',label:'Eficiência da transmissão',min:.65,max:1,step:.01,unit:'fração'},
 {key:'dragCdA',label:'Produto aerodinâmico Cd × área',min:.2,max:1.8,step:.01,unit:'m²'},
 {key:'rollingResistance',label:'Coeficiente de rolamento',min:0,max:.04,step:.001,unit:''},
 {key:'assumedPeakPressureBar',label:'Filtro assumido de pressão máxima simulada',min:30,max:350,step:5,unit:'bar absolutos'},
 {key:'assumedMeanPistonSpeedMs',label:'Filtro de velocidade média assumido',min:8,max:40,step:.5,unit:'m/s'},
];
const gasFields:Field[]=[
 {key:'intakeVolumeL',label:'Volume do coletor de admissão',min:.2,max:30,step:.1,unit:'L'},
 {key:'exhaustVolumeL',label:'Volume do coletor de escape',min:.2,max:30,step:.1,unit:'L'},
 {key:'throttleDiameterMm',label:'Diâmetro da borboleta',min:5,max:150,step:.5,unit:'mm'},
 {key:'throttleDischarge',label:'Coeficiente de descarga da borboleta',min:.1,max:1,step:.01,unit:'fração'},
 {key:'throttleLeakFraction',label:'Fração de área em marcha lenta',min:.001,max:.1,step:.001,unit:'fração'},
 {key:'exhaustRestrictionK',label:'Perdas localizadas no escape · K',min:0,max:100,step:.1,unit:''},
 {key:'exhaustFrictionFactor',label:'Fator de atrito Darcy do escape',min:.005,max:.12,step:.001,unit:''},
 {key:'compressorEfficiency',label:'Eficiência assumida do compressor',min:.35,max:.9,step:.01,unit:'fração'},
 {key:'turbineEfficiency',label:'Eficiência assumida da turbina',min:.3,max:.9,step:.01,unit:'fração'},
 {key:'turbineRestrictionK',label:'Perda localizada da turbina · K',min:0,max:100,step:.1,unit:''},
 {key:'intercoolerEffectiveness',label:'Efetividade do intercooler',min:0,max:.95,step:.01,unit:'fração'},
 {key:'turboInertiaKgM2',label:'Inércia do eixo do turbo',min:.000005,max:.001,step:.000005,unit:'kg·m²'},
];
const burnFields:Field[]=[
 {key:'sparkAdvanceDeg',label:'Avanço da ignição antes do PMS de combustão',min:-10,max:50,step:.5,unit:'°'},
 {key:'burnDurationDeg',label:'Duração da queima',min:15,max:120,step:1,unit:'° de virabrequim'},
 {key:'wiebeShape',label:'Forma da função de Wiebe',min:.5,max:5,step:.1,unit:''},
 {key:'wiebeEfficiency',label:'Coeficiente de completude de Wiebe',min:2,max:10,step:.1,unit:''},
 {key:'wallTemperatureK',label:'Temperatura de parede de referência do ciclo',min:230,max:1000,step:5,unit:'K'},
 {key:'heatTransferWm2K',label:'Troca térmica gás / parede do cilindro',min:0,max:3000,step:10,unit:'W/(m²·K)'},
 {key:'cycleVariability',label:'Variação determinística entre ciclos',min:0,max:1,step:.01,unit:'fração'},
 {key:'sparkToSocDeg',label:'Atraso faísca → início da combustão (SOC) · modelo 3',min:-20,max:60,step:.5,unit:'°'},
 {key:'heatTransferMultiplier',label:'Multiplicador de Woschni · somente com Woschni',min:0,max:5,step:.05,unit:''},
 {key:'fuelHydrogenCarbonRatio',label:'Razão H/C do combustível · somente NASA-7',min:.5,max:4,step:.01,unit:'mol/mol'},
];
const valveFields:Field[]=[
 {key:'intakeOpenDeg',label:'Abertura da admissão · ângulo no ciclo',min:650,max:719.9,step:.5,unit:'°'},
 {key:'intakeCloseDeg',label:'Fechamento da admissão · ângulo no ciclo',min:140,max:280,step:.5,unit:'°'},
 {key:'exhaustOpenDeg',label:'Abertura do escape · ângulo no ciclo',min:430,max:590,step:.5,unit:'°'},
 {key:'exhaustCloseDeg',label:'Fechamento do escape · ângulo no ciclo',min:0,max:70,step:.5,unit:'°'},
 {key:'intakeValveDiameterMm',label:'Diâmetro da válvula de admissão',min:6,max:90,step:.5,unit:'mm'},
 {key:'exhaustValveDiameterMm',label:'Diâmetro da válvula de escape',min:6,max:90,step:.5,unit:'mm'},
 {key:'intakeValveLiftMm',label:'Levantamento inicial de admissão para ajuste',min:.5,max:25,step:.1,unit:'mm'},
 {key:'exhaustValveLiftMm',label:'Levantamento da válvula de escape',min:.5,max:25,step:.1,unit:'mm'},
 {key:'intakeValveCount',label:'Válvulas de admissão por cilindro',min:1,max:4,step:1,unit:''},
 {key:'exhaustValveCount',label:'Válvulas de escape por cilindro',min:1,max:4,step:1,unit:''},
 {key:'valveDischargeCoefficient',label:'Coeficiente de descarga das válvulas',min:.1,max:1,step:.01,unit:'fração'},
 {key:'intakeCamRetardDeg',label:'Atraso do comando de admissão · desloca abertura e fechamento',min:-80,max:80,step:.5,unit:'° (+ = mais tarde)'},
 {key:'exhaustCamRetardDeg',label:'Atraso do comando de escape · desloca abertura e fechamento',min:-80,max:80,step:.5,unit:'° (+ = mais tarde)'},
];
/** Model-3 choices; legacy values reproduce model-2 physics exactly. */
const modelSelects=[
 {key:'propertyModel',label:'Propriedades do gás',options:[['air-standard','Ar padrão · γ de referência (legado)'],['nasa7-fixed-composition','NASA-7 · ar e produtos de composição fixa']]},
 {key:'heatTransferModel',label:'Troca térmica',options:[['constant','Coeficiente constante (legado)'],['woschni','Woschni 1967 · correlação de referência']]},
 {key:'airflowModel',label:'Vazão de ar',options:[['ve-map-fit','Ajuste do levantamento à meta do mapa VE (legado)'],['valve-geometry','Geometria das válvulas · sem ajuste à meta VE']]},
] as const;
const modelSelect=(s:typeof modelSelects[number])=>`<label class="field">${s.label}<select data-physical-select="${s.key}" id="physical-${s.key}">${s.options.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label>`;
const allFields=[...basic,...advanced,...gasFields,...burnFields,...valveFields];
const sourceLabels={assumed:'assumido',fitted:'ajustado',measured:'medido'} as const;

export function mountPowertrain(container:HTMLElement, initial:EngineConfig, onMode:(enabled:boolean)=>void){
 let engine=structuredClone(initial),physical=normalizePhysicalConfig(engine),model=new Powertrain(engine,physical),enabled=false,mode='vehicle',lastPaint=0,blipRemaining=0,shiftCutRemaining=0;
 let reference:EngineEstimate;
 const q=<T extends HTMLElement=HTMLElement>(id:string)=>container.querySelector<T>(`#${id}`)!;
 const numeric=(value:number)=>String(Number(value.toPrecision(8)));
 const field=(f:Field)=>`<label class="field">${f.label}<span class="field-unit">${f.unit}</span><input data-physical="${f.key}" id="physical-${f.key}" type="number" min="${f.min}" max="${f.max}" step="${f.step}" value="${numeric(Number(physical[f.key]))}"></label>`;
 container.innerHTML=`<div class="section-heading"><div><p class="eyebrow">04 / Motor, transmissão e veículo</p><h2>Resposta ao esforço</h2></div><span class="pill">Modelo reduzido · calibração declarada</span></div><p class="panel-intro">A rotação resulta do torque, da inércia e da resistência do veículo. O ciclo ar-padrão com queima finita, as válvulas e os coletores usam hipóteses editáveis. O mapa VE declara uma meta; o resultado calculado e seu resíduo aparecem abaixo. A sonoridade do escape não é uma medição de potência.</p>
 <div class="physical-driver"><label class="field">Bancada<select id="physical-mode"><option value="vehicle">Veículo com carga</option><option value="free">Motor em ponto morto</option></select></label><label class="field">Pedal (%)<input id="physical-throttle" type="range" min="0" max="100" value="25"><output id="physical-throttle-out">25 %</output></label><label class="field">Freio (%)<input id="physical-brake" type="range" min="0" max="100" value="0"><output id="physical-brake-out">0 %</output></label><label class="field">Marcha<select id="physical-gear"></select></label><button id="physical-enable" class="dark">Usar condução física</button><button id="physical-reset">Zerar velocidade</button></div>
 <p id="physical-mode-note" class="panel-note" role="status">Ligue o motor para ouvir. Ao ativar esta bancada, o pedal e a marcha acima passam a comandar RPM e carga.</p><div class="physical-metrics" id="physical-metrics" aria-live="off"></div><div class="physical-metrics" id="physical-gas-metrics" aria-live="off"></div><p id="physical-quantitative-status" class="panel-note"></p><p id="physical-filling" class="panel-note"></p><p id="physical-ecu-note" class="panel-note"></p>
 <div class="physical-fields">${basic.map(field).join('')}</div>
 <details class="physical-advanced" id="physical-map-panel"><summary>Mapa de enchimento e origem dos dados</summary><p>VE é a massa de ar fresco admitida dividida pela massa de referência ρ × cilindrada, usando pressão e temperatura na admissão. A grade usa RPM nas linhas e pressão absoluta em bar nas colunas. Fora do domínio, o valor da borda é mantido e sinalizado. A base acima só altera um mapa ao gerar uma nova hipótese.</p><p id="physical-ve-map-provenance" class="panel-note"></p><label class="field">Mapa VE em JSON<textarea id="physical-ve-map-json" rows="14" spellcheck="false" aria-describedby="physical-ve-map-status"></textarea></label><div class="physical-driver"><button id="physical-ve-map-apply">Aplicar JSON</button><button id="physical-ve-map-generate">Gerar mapa assumido</button><button id="physical-ve-map-import-button">Importar mapas JSON</button><button id="physical-ve-map-export">Exportar mapa VE</button><input id="physical-ve-map-import" type="file" accept="application/json,.json" hidden></div><p id="physical-ve-map-status" class="panel-note" role="status"></p><p class="panel-note">Importe um mapa VE ou pacote carlab-calibration-bundle-1 com VE e mapas opcionais de eficiência indicada e FMEP. Limite: 200 kB e 32 × 32 pontos por mapa. A origem assumida, ajustada ou medida é uma declaração do arquivo; não comprova validação independente. Gerar uma hipótese substitui apenas VE.</p></details><div class="potential-heading"><h3>Potencial sob as hipóteses atuais</h3><p id="physical-potential" class="panel-note"></p></div><canvas id="physical-curve" aria-label="Curvas simuladas de torque e potência em plena carga"></canvas><p id="physical-geometry" class="panel-note"></p>
 <p class="panel-note">Os filtros de pressão e velocidade do pistão são limites assumidos, sem certificação de durabilidade. Detonação, química detalhada, lubrificação e aderência não são resolvidas aqui. O painel térmico e de materiais faz sua própria triagem nas condições declaradas.</p>
 <details class="physical-advanced"><summary>Admissão, escape e turbo</summary><p>Pressões absolutas e inventários médios de massa e energia. Diâmetro e comprimento do tubo vêm da configuração do escape. K e o fator de atrito descrevem perda média de pressão, sem equivalência com atenuação acústica. O turbo usa um eixo dinâmico e eficiências assumidas, sem mapa real de compressor.</p><div class="physical-fields">${gasFields.map(field).join('')}</div></details>
 <details class="physical-advanced"><summary>Ignição, queima e troca térmica</summary><p>Ciclo de 720° com liberação de calor por Wiebe e troca com uma parede de referência. O PMS de combustão ocorre a 360°. O pico do gás não é a temperatura do pistão; a parede de referência do ciclo em cache não acompanha automaticamente a rede térmica. Opções do modelo 3 (somente Rust): propriedades NASA-7 de composição fixa (McBride, Gordon e Reno, NASA TM-4513), correlação de Woschni (1967) e atraso faísca→SOC; nos valores legados o resultado é idêntico ao modelo 2.</p><div class="physical-fields">${burnFields.map(field).join('')}${modelSelects.slice(0,2).map(modelSelect).join('')}<label class="field">Calor específico variável no ciclo<select id="physical-variableHeatCapacity"><option value="false">Constante · γ de referência</option><option value="true">Variável com temperatura · aproximação</option></select></label></div><p id="physical-thermo" class="panel-note"></p></details>
 <details class="physical-advanced"><summary>Comando e válvulas</summary><p>Ângulos absolutos no ciclo: 0° é o PMS entre escape e admissão; 180° o PMI de admissão; 360° o PMS de combustão. Para perseguir a meta VE, o modelo pode ajustar a área efetiva de admissão em até três tentativas limitadas. O levantamento inicial não é uma previsão de geometria calibrada. Os atrasos de comando deslocam abertura e fechamento juntos. Com vazão por geometria das válvulas, o levantamento não é ajustado à meta VE.</p><div class="physical-fields">${valveFields.map(field).join('')}${modelSelect(modelSelects[2])}</div></details>
 <details class="physical-advanced"><summary>Termodinâmica, perdas e filtros mecânicos</summary><p>Os filtros de pressão e velocidade do pistão são valores assumidos por você. Não certificam resistência de material, durabilidade ou ausência de detonação. Para um veículo específico, forneça mapas e medições com origem, condições e validação.</p><div class="physical-fields">${advanced.map(field).join('')}<label class="field">Relações das marchas (separadas por vírgula)<input id="physical-ratios" type="text" value="${physical.gearRatios.join(', ')}"></label></div></details>`;
 const fmt=(n:number,digits=1)=>n.toLocaleString('pt-BR',{maximumFractionDigits:digits,minimumFractionDigits:digits});
 function mapDescription(map:CalibrationMap){
  const p=map.provenance,v=p.validation;
  return `${sourceLabels[p.source]} · ${p.label} · versão ${p.version} · ${map.rpm.length} × ${map.pressureBar.length} pontos · ${fmt(map.rpm[0],0)}–${fmt(map.rpm.at(-1)!,0)} RPM / ${fmt(map.pressureBar[0],2)}–${fmt(map.pressureBar.at(-1)!,2)} bar absolutos${p.engineId?` · motor ${p.engineId}`:''}${p.calibratedAt?` · data ${p.calibratedAt}`:''}${p.notes?` · ${p.notes}`:''}${v?` · validação declarada: ${v.label}${v.date?` (${v.date})`:''}, ${v.independent?'independente declarada':'não independente'}`:' · sem validação declarada'}`;
 }
 function refreshMapEditor(){
  q<HTMLTextAreaElement>('physical-ve-map-json').value=JSON.stringify(physical.veMap,null,2);
  const descriptions=[`VE: ${mapDescription(physical.veMap)}`];
  if(physical.indicatedEfficiencyMap)descriptions.push(`Eficiência indicada: ${mapDescription(physical.indicatedEfficiencyMap)}`);
  if(physical.fmepMap)descriptions.push(`FMEP: ${mapDescription(physical.fmepMap)}`);
  q('physical-ve-map-provenance').textContent=descriptions.join(' | ');
  q('physical-ve-map-status').textContent='Mapa atual carregado no editor. Alterações no texto só entram no modelo ao aplicar.';
 }
 function paintFilling(e:EngineEstimate,online=false){
  const rpm=online?e.cycle.lookupRpm:e.rpm,pressure=online?e.cycle.lookupIntakePressureBar:e.manifoldPressureBar;
  q('physical-filling').textContent=`${online?'Ciclo retido da condução':'Referência estacionária em plena carga'} · ${fmt(rpm,0)} RPM / ${fmt(pressure,2)} bar absolutos: VE calculada ${fmt(e.actualVolumetricEfficiency*100)}% · meta do mapa ${fmt(e.mappedVolumetricEfficiency*100)}% · resíduo calculada − meta ${fmt(e.veTargetResidual*100,2)} pontos percentuais · origem ${sourceLabels[e.calibrationSource]}. ${e.mapExtrapolated?'FORA DO DOMÍNIO: ao menos um mapa foi limitado ao valor da borda.':'Consulta dentro dos domínios dos mapas ativos.'} ${Math.abs(e.veTargetResidual)>.03?'Meta de enchimento não atingida nas tentativas limitadas.':''}`;
 }
 function applyMapJson(raw:string){
  try{
   if(raw.length>200_000)throw new TypeError('Arquivo de mapas grande demais: limite de 200 kB.');
   const parsed:unknown=JSON.parse(raw);
   let patch:Pick<PhysicalConfig,'veMap'>&Partial<Pick<PhysicalConfig,'indicatedEfficiencyMap'|'fmepMap'>>;
   if(parsed&&typeof parsed==='object'&&'schema' in parsed&&parsed.schema==='carlab-calibration-bundle-1'){
    const maps=parseCalibrationBundle(parsed).maps;
    if(!maps.ve)throw new TypeError('O pacote precisa incluir o mapa VE.');
    patch={veMap:maps.ve,...(maps.indicatedEfficiency?{indicatedEfficiencyMap:maps.indicatedEfficiency}:{}),...(maps.fmep?{fmepMap:maps.fmep}:{})};
   }else patch={veMap:normalizeCalibrationMap(parsed,'ve')};
   const next=normalizePhysicalConfig(engine,{...physical,...patch});
   physical=next;model.setConfig(engine,physical);refreshMapEditor();draw();paint(model.getState());
   q('physical-ve-map-status').textContent='Mapas aplicados com a origem declarada no JSON. Os demais parâmetros físicos foram preservados.';
  }catch(error){q('physical-ve-map-status').textContent=`Mapa não aplicado: ${error instanceof Error?error.message:'dados inválidos'}. O último mapa válido foi preservado.`;}
 }
 function gearOptions(){const current=q<HTMLSelectElement>('physical-gear').value;q('physical-gear').replaceChildren();for(let i=1;i<=physical.gearRatios.length;i++){const option=document.createElement('option');option.value=String(i);option.textContent=`${i}ª · ${fmt(physical.gearRatios[i-1],2)}:1`;q('physical-gear').append(option);}if(Number(current)<=physical.gearRatios.length&&Number(current)>0)q<HTMLSelectElement>('physical-gear').value=current;}
 function draw(){
  if(isReferenceEcuBlocked(physical)){const text='EFI/modelo 3 requer Rust. A configuração foi preservada; curva e integração física ficam indisponíveis na referência TypeScript.';q('physical-potential').textContent=text;q('physical-geometry').textContent='Escolha o núcleo Rust ou desative EFI/opções do modelo 3 no projeto para executar a referência.';q('physical-thermo').textContent='Não foi substituído por um cálculo de AFR constante.';q('physical-filling').textContent='Sem avaliação EFI nesta referência.';const canvas=q<HTMLCanvasElement>('physical-curve');canvas.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);return;}
  const env=potentialEnvelope(engine,physical),peak=env.peakPower,pick=env.screenedPeakPower;
  q('physical-potential').textContent=`Pico simulado: ${fmt(peak.powerKw)} kW (${fmt(peak.powerHp)} hp) a ${fmt(peak.rpm,0)} RPM · torque máximo ${fmt(env.peakTorque.torqueNm)} N·m. ${pick?`Maior ponto dentro dos dois filtros assumidos: ${fmt(pick.powerKw)} kW a ${fmt(pick.rpm,0)} RPM.`:'Nenhum ponto atende simultaneamente aos dois filtros assumidos.'} No pico de potência: pressão máxima do ciclo ar-padrão com queima finita ${fmt(peak.idealPeakPressureBar)} bar absolutos e velocidade média do pistão ${fmt(peak.meanPistonSpeedMs)} m/s.${env.points.some(point=>point.mapExtrapolated)?' A curva contém consultas fora do domínio de um mapa; valores de borda foram mantidos.':''}`;
  const canvas=q<HTMLCanvasElement>('physical-curve'),ctx=canvas.getContext('2d')!,width=Math.max(280,canvas.clientWidth),ratio=Math.min(devicePixelRatio,2);canvas.width=Math.round(width*ratio);canvas.height=Math.round(245*ratio);ctx.setTransform(ratio,0,0,ratio,0,0);ctx.fillStyle='#f8faf2';ctx.fillRect(0,0,width,245);const left=42,right=width-37,top=45,bottom=195;
  const maxTorque=Math.max(1,env.peakTorque.torqueNm)*1.1,maxPower=Math.max(1,peak.powerKw)*1.1;
  ctx.font='11px monospace';ctx.fillStyle='#526449';ctx.fillText('Torque N·m ←',left,17);ctx.fillStyle='#93603d';ctx.fillText('→ Potência kW',width<500?left:right-120,width<500?33:17);
  for(let i=0;i<=4;i++){const y=bottom-(bottom-top)*i/4;ctx.strokeStyle='#dce2d2';ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillStyle='#526449';ctx.fillText((maxTorque*i/4).toFixed(0),4,y+4);ctx.fillStyle='#93603d';ctx.fillText((maxPower*i/4).toFixed(0),right+5,y+4);}
  for(const [key,max,color] of [['torqueNm',maxTorque,'#526f36'],['powerKw',maxPower,'#a77249']] as const){ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.beginPath();env.points.forEach((point,i)=>{const x=left+(point.rpm-engine.idleRpm)/(engine.redline-engine.idleRpm)*(right-left),y=bottom-Math.max(0,point[key])/max*(bottom-top);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();}
  ctx.fillStyle='#66705e';ctx.fillText(`${engine.idleRpm.toFixed(0)} RPM`,left,224);ctx.fillText(`${engine.redline.toFixed(0)} RPM`,right-85,224);
  const e=evaluateEngine(engine,physical,Math.min(3000,engine.redline*.7),1),g=e.geometry;reference=e;
  q('physical-geometry').textContent=`Geometria derivada de ${fmt(engine.displacement,2)} L / ${engine.cylinders} cilindros: diâmetro ${fmt(g.boreMm)} mm · curso ${fmt(g.strokeMm)} mm · biela ${fmt(g.rodLengthMm)} mm. Enchimento condicionado ao mapa VE declarado, à área efetiva das válvulas e aos contornos dos coletores. A perda média do tubo é calculada; suas ressonâncias ainda não preveem enchimento.`;
  q('physical-thermo').textContent=`Exemplo estacionário em plena carga a ${fmt(e.rpm,0)} RPM: referência Otto ar-padrão com γ constante ${fmt(e.ottoEfficiency*100)}% · eficiência ao freio simulada ${fmt(e.brakeEfficiency*100)}% · pressão no início da queima ${fmt(e.compressionPressureBar)} bar · pico do ciclo ar-padrão com queima finita ${fmt(e.idealPeakPressureBar)} bar absolutos / ${fmt(e.idealPeakGasTemperatureK,0)} K · CA50 ${fmt(e.cycle.ca50Deg)}° · perda gás / parede ${fmt(e.wallHeatLossW/1000)} kW. Força máxima de gás ${fmt(e.idealGasForceN/1000)} kN e força inercial no PMS ${fmt(e.inertiaForceTdcN/1000)} kN são componentes separados. Resíduo periódico de massa ${fmt(e.cycle.periodicMassRelativeError*100,2)}% / energia ${fmt(e.cycle.periodicEnergyRelativeError*100,2)}%.`;
  paintFilling(reference);
 }
 function paint(state:PowertrainState){
  const ecuConfig=(physical as PhysicalConfig & {ecu?:{enabled?:boolean;combustionMode?:string}}).ecu,ecuEnabled=!!ecuConfig?.enabled,diesel=ecuEnabled&&ecuConfig?.combustionMode==='directInjectionDiesel';for(const [key,disabled,reason]of [['sparkAdvanceDeg',ecuEnabled,'EFI usa o mapa de faísca ou SOI do modo ativo.'],['fuelLhvMJkg',ecuEnabled,'EFI usa propriedades do combustível configurado, não este PCI legado.'],['burnDurationDeg',diesel,'Diesel usa a duração de queima prescrita no painel EFI.']] as const){const input=q<HTMLInputElement>(`physical-${key}`);input.disabled=disabled;input.title=disabled?reason:'';const label=allFields.find(field=>field.key===key)?.label;if(label&&input.parentElement?.firstChild)input.parentElement.firstChild.textContent=disabled?`${label} · legado inativo`:label;}const pedal=q<HTMLInputElement>('physical-throttle');if(pedal.parentElement?.firstChild)pedal.parentElement.firstChild.textContent=diesel?'Pedal de combustível (%)':'Pedal (%)';const afr=q<HTMLInputElement>('physical-airFuelRatio');afr.disabled=ecuEnabled;afr.title=ecuEnabled?'Inativo com EFI: o controlador usa mapas de lambda e combustível entregue.':'AFR constante usado somente pelo caminho legado com EFI desativada.';q('physical-ecu-note').textContent=ecuEnabled?diesel?'Diesel DI: o pedal pede combustível; abertura de ar é independente no painel EFI. AFR, faísca, PCI e duração de queima legados estão inativos; valem quantidade/SOI, propriedades e atraso/queima prescritos de CI.':'EFI ativa: AFR, avanço de faísca e PCI constantes são legados inativos. Valem mapas e propriedades do combustível do controlador EFI.':'EFI desativada: o AFR constante da seção avançada permanece no caminho legado.';
  const qualification=state.quantitativelyValid?'SIMULADO':'QUALITATIVO';
  q('physical-metrics').innerHTML=[['VELOCIDADE',fmt(state.speedKmh),'km/h'],['ROTAÇÃO',fmt(state.rpm,0),'RPM'],[`TORQUE ${qualification}`,fmt(state.torqueNm),'N·m'],[`POTÊNCIA ${qualification==='SIMULADO'?'SIMULADA':'QUALITATIVA'}`,fmt(state.powerKw),'kW'],['CARGA ACÚSTICA',fmt(state.load*100,0),'%']].map(([name,value,unit])=>`<div><span>${name}</span><strong>${value}</strong><small>${unit}</small></div>`).join('');
  const gas=state.gasPath;
  q('physical-gas-metrics').innerHTML=[['PRESSÃO ADMISSÃO',fmt(gas.intake.pressurePa/1e5,3),'bar absolutos'],['TEMPERATURA ADMISSÃO',fmt(gas.intake.temperatureK,0),'K'],['PRESSÃO ESCAPE',fmt(gas.exhaust.pressurePa/1e5,3),'bar absolutos'],['TEMPERATURA GÁS ESCAPE',fmt(gas.exhaust.temperatureK,0),'K'],['VAZÃO AR CILINDROS',fmt(gas.cylinderAirMassFlowKgs*1000,2),'g/s']].map(([name,value,unit])=>`<div><span>${name}</span><strong>${value}</strong><small>${unit}</small></div>`).join('');
  q('physical-quantitative-status').textContent=`${state.quantitativelyValid?'Sem limite de inventário ou falta de convergência sinalizados neste passo.':'RESULTADO QUANTITATIVO LIMITADO: inventário de gás limitado ou ciclo ainda sem convergência periódica; torque e potência são apenas qualitativos.'} Resíduos dos coletores neste passo: massa ${gas.massBalanceResidualKg.toExponential(2)} kg / energia ${gas.energyBalanceResidualJ.toExponential(2)} J. O fechamento local dos coletores não demonstra balanço energético do motor completo. Ciclo online em cache: 500 RPM / 0,1 bar / 25 K na admissão / 100 K no escape, atualizado em até 20 Hz.${state.warnings.length?` Avisos do modelo: ${state.warnings.join(' ')}`:''}`;
  if(isReferenceEcuBlocked(physical))return;const operating=model.getOperatingEstimate();if(operating)paintFilling(operating,true);else if(reference)paintFilling(reference);
 }
 function configChanged(next:EngineConfig,resetDefaults=false){engine=structuredClone(next);physical=normalizePhysicalConfig(engine,resetDefaults?{}:physical);if(resetDefaults)model.setConfigAndReset(engine,physical);else model.setConfig(engine,physical);if(resetDefaults){blipRemaining=0;shiftCutRemaining=0;}for(const f of allFields)q<HTMLInputElement>(`physical-${f.key}`).value=numeric(Number(physical[f.key]));q<HTMLSelectElement>('physical-variableHeatCapacity').value=String(physical.variableHeatCapacity);for(const s of modelSelects)q<HTMLSelectElement>(`physical-${s.key}`).value=String(physical[s.key]);q<HTMLInputElement>('physical-ratios').value=physical.gearRatios.join(', ');gearOptions();refreshMapEditor();draw();paint(model.getState());}
 function setPhysical(value:unknown){physical=normalizePhysicalConfig(engine,value&&typeof value==='object'?value as Partial<PhysicalConfig>:{});configChanged(engine);}
 function setPhysicalAndReset(value:unknown){physical=normalizePhysicalConfig(engine,value&&typeof value==='object'?value as Partial<PhysicalConfig>:{});model.setConfigAndReset(engine,physical);blipRemaining=0;shiftCutRemaining=0;configChanged(engine);}
 function setEnabled(value:boolean){enabled=value;if(!value){blipRemaining=0;shiftCutRemaining=0;}q('physical-enable').textContent=value?'Voltar ao controle manual':'Usar condução física';q('physical-enable').classList.toggle('active',value);q('physical-mode-note').textContent=value?'Condução física ativa. Ligue o motor; use pedal, freio e marcha desta bancada. Espaço aplica pedal máximo; ↑ sobe uma marcha.':'Controle manual ou cenário acústico ativo. As curvas continuam disponíveis para consulta.';}
 container.querySelectorAll<HTMLInputElement>('[data-physical]').forEach(input=>input.addEventListener('change',()=>{const n=input.value.trim()?Number(input.value):NaN;if(!Number.isFinite(n)){input.value=String(physical[input.dataset.physical as keyof PhysicalConfig]);return;}physical=normalizePhysicalConfig(engine,{...physical,[input.dataset.physical!]:n});model.setConfig(engine,physical);input.value=String(physical[input.dataset.physical as keyof PhysicalConfig]);draw();paint(model.getState());if(input.dataset.physical==='volumetricEfficiency')q('physical-ve-map-status').textContent='Base VE alterada. O mapa atual foi preservado; use “Gerar mapa assumido” para substituí-lo.';}));
 for(const s of modelSelects)q(`physical-${s.key}`).addEventListener('change',()=>{physical=normalizePhysicalConfig(engine,{...physical,[s.key]:q<HTMLSelectElement>(`physical-${s.key}`).value});model.setConfig(engine,physical);draw();paint(model.getState());});
 q('physical-variableHeatCapacity').addEventListener('change',()=>{physical=normalizePhysicalConfig(engine,{...physical,variableHeatCapacity:q<HTMLSelectElement>('physical-variableHeatCapacity').value==='true'});model.setConfig(engine,physical);draw();paint(model.getState());});
 q('physical-ve-map-apply').addEventListener('click',()=>applyMapJson(q<HTMLTextAreaElement>('physical-ve-map-json').value));
 q('physical-ve-map-generate').addEventListener('click',()=>{physical=normalizePhysicalConfig(engine,{...physical,veMap:createAssumedVeMap(engine.idleRpm,engine.redline,physical.volumetricEfficiency)});model.setConfig(engine,physical);refreshMapEditor();draw();paint(model.getState());q('physical-ve-map-status').textContent='Novo mapa VE assumido gerado. Curva genérica original, sem dados medidos ou ajustados; os demais mapas foram preservados.';});
 q('physical-ve-map-import-button').addEventListener('click',()=>q<HTMLInputElement>('physical-ve-map-import').click());
 q('physical-ve-map-import').addEventListener('change',async()=>{
  const input=q<HTMLInputElement>('physical-ve-map-import'),file=input.files?.[0];if(!file)return;
  try{if(file.size>200_000)throw new TypeError('Arquivo de mapas grande demais: limite de 200 kB.');const raw=await file.text();q<HTMLTextAreaElement>('physical-ve-map-json').value=raw;applyMapJson(raw);}
  catch(error){q('physical-ve-map-status').textContent=`Importação não aplicada: ${error instanceof Error?error.message:'falha na leitura'}. O último mapa válido foi preservado.`;}
  finally{input.value='';}
 });
 q('physical-ve-map-export').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(physical.veMap,null,2)+'\n'],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='carlab-ve-map.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),0);q('physical-ve-map-status').textContent='Mapa VE atual exportado com domínio, unidades e origem declarada. Texto ainda não aplicado no editor não foi exportado.';});
 q('physical-ratios').addEventListener('change',()=>{const input=q<HTMLInputElement>('physical-ratios'),ratios=input.value.split(',').map(s=>Number(s.trim()));if(!ratios.length||ratios.length>8||ratios.some(n=>!Number.isFinite(n)||n<.3||n>6)){input.setCustomValidity('Use de 1 a 8 relações entre 0,3 e 6.');input.reportValidity();return;}input.setCustomValidity('');physical=normalizePhysicalConfig(engine,{...physical,gearRatios:ratios});model.setConfig(engine,physical);gearOptions();});
 q('physical-enable').addEventListener('click',()=>{setEnabled(!enabled);onMode(enabled);});
 q('physical-mode').addEventListener('change',()=>{mode=q<HTMLSelectElement>('physical-mode').value;model.reset();blipRemaining=0;shiftCutRemaining=0;q<HTMLSelectElement>('physical-gear').disabled=mode==='free';paint(model.getState());});
 q('physical-reset').addEventListener('click',()=>{model.reset();blipRemaining=0;shiftCutRemaining=0;paint(model.getState());});
 for(const key of ['throttle','brake'])q(`physical-${key}`).addEventListener('input',()=>{q(`physical-${key}-out`).textContent=`${q<HTMLInputElement>(`physical-${key}`).value} %`;});
 q<HTMLSelectElement>('physical-variableHeatCapacity').value=String(physical.variableHeatCapacity);for(const s of modelSelects)q<HTMLSelectElement>(`physical-${s.key}`).value=String(physical[s.key]);
 gearOptions();refreshMapEditor();draw();paint(model.getState());
 const resizeObserver=new ResizeObserver(draw);resizeObserver.observe(q('physical-curve'));
 return {configChanged,setPhysical,setPhysicalAndReset,getPhysical:()=>structuredClone(physical),setEnabled,isEnabled:()=>enabled,getState:()=>model.getState(),reset(){model.reset();blipRemaining=0;shiftCutRemaining=0;paint(model.getState());},
  step(dt:number,fullPedal=false){const demand=shiftCutRemaining>0?0:Math.max(fullPedal?1:Number(q<HTMLInputElement>('physical-throttle').value)/100,blipRemaining>0?.85:0);blipRemaining=Math.max(0,blipRemaining-dt);shiftCutRemaining=Math.max(0,shiftCutRemaining-dt);const state=model.step(dt,demand,Number(q<HTMLInputElement>('physical-brake').value)/100,mode==='free'?0:Number(q<HTMLSelectElement>('physical-gear').value));if(performance.now()-lastPaint>100){lastPaint=performance.now();paint(state);}return state;},
  blip(){blipRemaining=.2;},
  shift(){if(mode==='vehicle'){const selector=q<HTMLSelectElement>('physical-gear'),current=Number(selector.value);selector.value=String(Math.min(physical.gearRatios.length,current+1));if(Number(selector.value)!==current)shiftCutRemaining=.14;}},
  getDriveOptions:(fullPedal=false)=>({gear:mode==='free'?0:Number(q<HTMLSelectElement>('physical-gear').value),throttle:fullPedal?1:Number(q<HTMLInputElement>('physical-throttle').value)/100,brake:Number(q<HTMLInputElement>('physical-brake').value)/100}),dispose:()=>{resizeObserver.disconnect();model.dispose();}};
}
