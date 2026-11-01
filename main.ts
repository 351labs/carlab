import { defaultConfig,presets } from './presets.ts';
import { normalizeConfig,initializeBackend,requestedBackend,getBackendName,getBackendIdentity,getBackendModule,engineGeometry,normalizePhysicalConfig,isReferenceEcuBlocked,ecuRequest } from './backend.ts';
import type { EngineConfig, EngineTelemetry } from './dsp.ts';
import workletUrl from './worklet.ts?worker&url';
import { zipFiles } from './export.ts';
import { MODEL_VERSION, scenarioState } from './offline.ts';
import { mountBench } from './bench-ui.ts';
import { mountPowertrain } from './powertrain-ui.ts';
import { mountLibrary } from './library-ui.ts';
import { applyPhysicalExhaust } from './projects.ts';
import { mountCycleInspector } from './cycle-ui.ts';
import { mountThermalPanel } from './thermal-ui.ts';
import { mountEcuPanel } from './ecu-ui.ts';
import type { EcuConfig } from './api/types.ts';
import { mountWorkshopShell } from './workshop/shell.ts';
import { mountWorkshopViewport } from './workshop/viewport.ts';
import { getLocale, getI18nDiagnostics, mountI18n, subscribeLocale, t } from './i18n.ts';
import './workshop/workshop.css';

try { await initializeBackend(requestedBackend()); } catch(error) { const message=document.createElement('p');message.setAttribute('role','alert');message.textContent=`Não foi possível carregar o núcleo Rust: ${error instanceof Error?error.message:String(error)}. Recompile o laboratório ou escolha explicitamente ?backend=typescript para a referência.`;document.querySelector('#app')?.replaceChildren(message);throw error; }

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const clone = <T>(value:T):T => structuredClone(value);
const format = (n:number, digits=0) => n.toLocaleString(getLocale(),{minimumFractionDigits:digits,maximumFractionDigits:digits});
const names = ['Três em linha','Quatro em linha','V2 · pulso irregular','Boxer de quatro','V6 · equilíbrio','V8 · crossplane','V8 · flatplane','V10 · alto giro','V12 · gran turismo','V12 clássico · 5.0','Quatro compacto · 1.2'];
const descriptions = [
 'Pequeno, ritmado e pressurizado. Três cilindros com turbo compacto e pulsos separados por 240°.',
 'A base para começar. Quatro cilindros aspirados, admissão presente e pulsos de ignição a cada 180°.',
 'Duas combustões, muito caráter. Intervalos de 315° e 405° criam uma cadência assimétrica, com escape longo.',
 'Bancos opostos, caminhos acústicos diferentes. Quatro cilindros com coletor desigual e admissão encorpada.',
 'Seis cilindros em V de 60°. Pulsos uniformes, crossover moderado e uma entrega sonora progressiva.',
 'Oito cilindros, ritmo de cada banco irregular. Coletor longo e crossover deixam aparecer a pulsação grave.',
 'Oito cilindros, bancos alternados. Coletor curto, admissão aberta e limite alto para um timbre mais incisivo.',
 'Dez cilindros, 72° entre combustões. Alta rotação e escape pouco atenuado criam uma voz densa e aguda.',
 'Doze cilindros com pulsos muito próximos. Uma voz ampla de alto giro, com corpo grave e diferenças entre combustões.',
 'Esportivo clássico de cinco litros: giro mais baixo, coletores longos, corpo grave e pequenas variações mecânicas.',
 'Motor compacto de rua, com resposta progressiva e pouca cilindrada por cilindro. Uma base para vozes mais discretas.'
];
const requestedPreset = presets.findIndex(p => p.id === new URLSearchParams(location.search).get('preset'));
let selected = requestedPreset >= 0 ? requestedPreset : 1;
let config = clone(presets[selected]?.config ?? defaultConfig);
let tab = 'motor';
let running = false, starting = false, startGeneration = 0, context:AudioContext|undefined, node:AudioWorkletNode|undefined, master:GainNode|undefined, analyser:AnalyserNode|undefined;
let scenario = 'manual', scenarioTime = 0, lastTime = performance.now(), lastStateTime = 0, pressed = false, previousGear = -1;
let manualRpm = 2800, manualLoad = .48, manualThrottle = .48, driveRpm=config.idleRpm, volume=.15;
let telemetry:EngineTelemetry = {rpm:config.idleRpm,load:.2,throttle:.2,boost:0,turboRpm:0,firingHz:config.idleRpm*config.cylinders/120,peak:0,limiter:false,cycle:0,firingEvents:0,combustionEvents:0,bov:0};
let characterTelemetry={timingMeanDeg:0,timingRmsDeg:0,timingMaxDeg:0,weakCombustions:0,idleHuntRpm:0};
let scopeMode='wave', worker:Worker|undefined, exportId=0, toastTimer=0, suspendTimer=0;
let snapshots:Partial<Record<'A'|'B',EngineConfig>>={};
let bench:ReturnType<typeof mountBench>|undefined, physics:ReturnType<typeof mountPowertrain>|undefined;
let workshop:ReturnType<typeof mountWorkshopShell>|undefined, viewport:ReturnType<typeof mountWorkshopViewport>|undefined;
try { const saved=JSON.parse(localStorage.getItem('carlab-engine-lab-compare')??'{}'); for(const key of ['A','B'] as const) if(saved[key]) snapshots[key]=normalizeConfig(saved[key]); } catch { /* Optional local snapshots. */ }
const comparisonClips = [
 {id:'v12-steady',label:'V12 · 3.000 RPM',before:'/audio/v12-steady-before.wav',after:'/audio/v12-steady-after.wav'},
 {id:'v10-steady',label:'V10 · 3.000 RPM',before:'/audio/v10-steady-before.wav',after:'/audio/v10-steady-after.wav'},
 {id:'v12-idle',label:'V12 · marcha lenta',before:'/audio/v12-idle-before.wav',after:'/audio/v12-idle-after.wav'},
];
const classicDemoUrl = '/audio/v12-classic-rev.wav';
const iconPlay = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M2 0l10 6-10 6z"/></svg>';
const iconStop = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect width="10" height="10" x="1" y="1" rx="1" fill="currentColor"/></svg>';

$('#app').innerHTML = `
 <header class="topbar"><div class="brand">CarLab<span>ENGINE SOUND STUDIO</span></div><div class="topstatus"><span class="mono">${getBackendName()==='rust'?'RUST / WASM · CPU':'REFERÊNCIA TYPESCRIPT · CPU'}</span><span class="dot" id="status-dot"></span><span id="status">Áudio desligado</span></div></header>
 <div class="layout"><aside><p class="eyebrow">01 / Escolha uma voz</p><div class="preset-list">${presets.map((p,i)=>`<button class="preset ${i===selected?'active':''}" data-preset="${i}" data-preset-id="${p.id}"><span class="preset-name">${names[i]}</span><span class="preset-meta">${format(p.config.displacement,1)} L · ${p.config.boostBar?'TURBO':'ASPIRADO'} · ${format(p.config.redline)} RPM</span></button>`).join('')}</div><p class="aside-note">Cada voz nasce da ignição, da geometria e da mistura de camadas.<br><br>Use fones para ouvir a separação entre os bancos. Comece com o volume baixo.</p></aside>
 <main><div class="heading"><div><p class="eyebrow">Um instrumento para desenhar motores</p><h1 id="engine-name"></h1><p id="description" class="description"></p><div id="voice-tags" class="voice-tags" aria-label="Perfil descritivo da voz"></div></div><button id="power" class="primary sound-button">${iconPlay}Ligar motor</button></div><nav class="lab-nav" aria-label="Bancadas do laboratório"><a href="#parameters-panel">Desenhar a voz</a><a href="#bench-panel">Comparar referências</a><a href="#physics-panel">Simular esforço</a><a href="#ecu-panel">EFI e combustível</a><a href="#cycle-panel">Inspecionar ciclo</a><a href="#thermal-panel">Calor e materiais</a><a href="#library-panel">Biblioteca</a><a href="#production-panel">Produzir áudio</a></nav>
 <div class="dashboard"><section class="instrument" aria-label="Instrumentos do motor"><div class="instrument-head"><p class="eyebrow">Rotação / ciclo de quatro tempos</p><span class="live-label" id="live-label">PRONTO PARA OUVIR</span></div><canvas id="gauge" class="gauge" aria-label="Conta-giros"></canvas><div class="metrics"><div class="metric"><span>CARGA</span><strong id="metric-load">0</strong><small>%</small></div><div class="metric"><span>PRESSÃO DO TURBO</span><strong id="metric-boost">0,00</strong><small>bar</small></div><div class="metric"><span>IGNIÇÕES</span><strong id="metric-firing">0</strong><small>Hz</small></div></div></section>
 <section class="scope-panel"><div class="scope-title"><p class="eyebrow">Sinal de saída</p><div class="scope-buttons"><button class="active" data-scope="wave">ONDA</button><button data-scope="spectrum">ESPECTRO</button></div></div><canvas id="scope" class="scope" aria-label="Osciloscópio do sinal de áudio"></canvas><div class="cylinders" id="cylinders"></div><div class="firing-order" id="firing-order"></div></section></div>
 <section class="driver"><div class="section-heading"><p class="eyebrow">02 / Coloque o motor em movimento</p><div class="scenario-buttons">${[['manual','Manual'],['idle','Marcha lenta'],['rev','Aceleração'],['drive','Com trocas'],['overrun','Retenção']].map(([id,label])=>`<button data-scenario="${id}" class="${id==='manual'?'active':''}">${label}</button>`).join('')}</div></div><div class="driver-controls"><div class="control"><label for="rpm">Rotação manual<output id="rpm-out"></output></label><input id="rpm" type="range" min="600" max="10000" step="25" value="2800"></div><div class="control"><label for="load">Carga do motor<output id="load-out">48 %</output></label><input id="load" type="range" min="0" max="100" step="1" value="48"></div><div class="control"><label for="throttle-input">Abertura da borboleta<output id="throttle-out">48 %</output></label><input id="throttle-input" type="range" min="0" max="100" step="1" value="48"></div><button id="throttle" class="hold">Segure para acelerar <kbd>espaço</kbd></button></div><div class="driver-footer"><div class="volume"><label for="volume">Volume de audição</label><input id="volume" type="range" min="0" max="50" value="15"><span id="volume-out">15 %</span></div><div class="event-buttons"><button class="small" id="blip">Toque no acelerador</button><button class="small" id="shift">Trocar marcha <kbd>↑</kbd></button></div><span id="peak-label" class="mono">48 kHz · estéreo</span></div></section>
 <section class="parameters" id="parameters-panel"><div class="tabbar" role="tablist" aria-label="Configuração do motor">${[['motor','Motor e ignição'],['character','Caráter'],['escape','Escape'],['turbo','Admissão e turbo'],['mix','Mistura sonora']].map(([id,label])=>`<button role="tab" id="tab-${id}" data-tab="${id}" aria-selected="${id===tab}" class="${id===tab?'active':''}">${label}</button>`).join('')}</div><div id="parameters" class="parameter-content" role="tabpanel" aria-labelledby="tab-motor"></div></section>
 <div class="toolbar"><div class="compare"><span class="label">COMPARAR</span><button id="save-a" title="Guarda a configuração atual no navegador">Salvar A</button><button id="save-b">Salvar B</button><button id="recall-a">Ouvir A</button><button id="recall-b">Ouvir B</button></div><div class="exports"><button id="reset">Restaurar voz</button><button id="import">Importar JSON</button><button id="save-config">Salvar configuração ↗</button><input class="hidden" id="config-file" type="file" accept="application/json,.json"></div></div>
 <section class="lab-panel" id="bench-panel"></section><section class="lab-panel" id="physics-panel"></section><section class="lab-panel" id="ecu-panel"></section><section class="lab-panel" id="cycle-panel"></section><section class="lab-panel" id="thermal-panel"></section><section class="lab-panel library-panel" id="library-panel"></section>
 <details class="comparison"><summary>Arquivo de escuta: evolução v1 → v2 e V12 clássico</summary><p>Capturas históricas da v1 e v2, com o mesmo RPM e carga antes/depois e RMS estéreo igualado. Use a bancada de afinação para comparar a versão atual. Ouvir um arquivo pausa a síntese ao vivo. O volume de audição acima controla os players.</p><div class="comparison-grid">${comparisonClips.map(clip=>`<div class="comparison-row"><strong>${clip.label}</strong><label>Modelo v1<audio data-comparison id="${clip.id}-before" controls preload="none" src="${clip.before}"></audio></label><label>Modelo v2 · corpo e caráter<audio data-comparison id="${clip.id}-after" controls preload="none" src="${clip.after}"></audio></label></div>`).join('')}</div><div class="reference-row"><label>Nova voz original · V12 clássico<audio data-comparison id="classic-demo" controls preload="none" src="${classicDemoUrl}"></audio></label><label>Referência gravada · prévia MP3 licenciada<audio data-comparison id="reference-clip" controls preload="none" src="/references/classic-v12-43483-preview-hq.mp3"></audio></label></div><p class="reference-credit"><a href="https://freesound.org/people/enginemusic/sounds/43483/" target="_blank" rel="noopener">ferrari340america2.mp3</a> por enginemusic · <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noopener">CC BY 3.0</a>. Gravação identificada pelo autor como V12 clássico. A referência tem giro, carga, microfone e nível próprios; sua comparação com o sintetizador é qualitativa.</p></details>
 <section class="export-section" id="production-panel"><div><h2>Exporte seu som</h2><p>Exporte uma tomada de 12 segundos, suas quatro camadas separadas ou um banco com 48 pontos de RPM × carga. O renderizador usa o mesmo sintetizador e a perspectiva selecionada, em 48 kHz.</p></div><div class="actions"><select id="export-scenario" aria-label="Perfil de exportação"><option value="drive">Puxada com trocas</option><option value="rev">Subida e descida de giro</option><option value="idle">Marcha lenta</option><option value="overrun">Aceleração e retenção</option><option value="steady">RPM e carga atuais</option><option value="physical">Condução física · pedal e marcha atuais</option></select><button id="export-wav" class="dark">WAV</button><button id="export-stems">Camadas ZIP</button><button id="export-bank">Banco ZIP</button></div></section>
 <div class="progress" id="progress" role="status"><span id="progress-label">Renderizando…</span><progress id="render-progress" max="1" value="0"></progress><button class="small" id="cancel-export">Cancelar</button></div>
 <details><summary>O que este laboratório simula</summary><p>Combustões por cilindro em ciclos de 720°, intervalos e ordem de ignição, propagação e reflexões em tubos de admissão e escape, atenuação do abafador, ruído de fluxo, vibração mecânica, corte de giro, estalos de retenção e turbo com inércia e alívio. Cilindrada e compressão alteram a energia e a forma do pulso; a rotação define a cadência.</p><p>Os controles de caráter acrescentam diferenças entre cilindros, pequenas variações de chegada, oscilações leves na lenta e ressonâncias graves ligadas à geometria. É um modelo acústico procedural original. A geometria acústica orienta o timbre. Na condução física, um ciclo de pressão de 720° fornece trabalho e torque; reservatórios de admissão e escape, perdas de pressão e um eixo de turbo reduzido fornecem o estado compartilhado com o áudio. O modo manual mantém os controles artísticos. O cálculo ao vivo usa aproximações e consultas quantizadas; não é uma solução CFD ou uma previsão validada de um motor real. A variação entre ciclos é uma hipótese compartilhada de energia, fase e duração, sem recalcular uma curva de pressão para cada combustão. Fidelidade a um motor específico exige medições e calibração com gravações. Os bancos exportados têm emendas suavizadas; a auditoria das transições está disponível acima.</p><p>Atalhos: <kbd>espaço</kbd> acelera, <kbd>↑</kbd> troca marcha. A e B guardam configurações neste navegador. Volume de audição não altera os WAVs: os arquivos preservam o nível do sintetizador.</p></details>
 <footer class="footer"><span>CarLab · ENGINE SOUND STUDIO · ${getBackendName()==='rust'?'MODELO RUST 0.5':'REFERÊNCIA TYPESCRIPT 0.5'}<br>Síntese original · bancada física experimental · referências creditadas.</span><span id="footer-info">Web Audio · AudioWorklet · exportação local<br>Nenhum áudio sai deste navegador.</span></footer></main></div><div class="toast" id="toast" role="status"></div>`;

type Key = keyof EngineConfig;
type Slider = {key:Key;label:string;min:number;max:number;step:number;unit:string;digits?:number;scale?:number;hint?:string};
const groups:Record<string,Slider[]> = {
 motor:[{key:'displacement',label:'Cilindrada total',min:.1,max:12,step:.1,unit:'L',digits:1,hint:'Energia e corpo de cada combustão.'},{key:'compression',label:'Taxa de compressão',min:6,max:16,step:.1,unit:': 1',digits:1},{key:'redline',label:'Limite de rotação',min:2000,max:18000,step:100,unit:'RPM'},{key:'idleRpm',label:'Marcha lenta',min:400,max:2400,step:25,unit:'RPM'},{key:'cam',label:'Comando de válvulas',min:0,max:1,step:.01,unit:'%',hint:'Mais agressivo: pulsos curtos e marcha lenta mais áspera.'},{key:'irregularity',label:'Variação entre combustões',min:0,max:1,step:.01,unit:'%'},{key:'inertia',label:'Inércia de resposta',min:0,max:1,step:.01,unit:'%'},{key:'overrun',label:'Estalos na retenção',min:0,max:1,step:.01,unit:'%'}],
 character:[{key:'roughness',label:'Desigualdade entre cilindros',min:0,max:1,step:.01,unit:'/100',scale:100,hint:'Diferenças persistentes de força e duração dos pulsos; variação lenta na marcha lenta.'},{key:'timingJitter',label:'Variação de fase da combustão',min:0,max:1,step:.01,unit:'/100',scale:100,hint:'Pequenas diferenças de chegada dos pulsos, mantendo o ciclo e a cadência média.'},{key:'lowBody',label:'Corpo e ressonância grave',min:0,max:1,step:.01,unit:'/100',scale:100,hint:'Modos graves do coletor e vibração de baixa ordem. Não altera a nota de ignição.'},{key:'wear',label:'Combustões fracas na lenta',min:0,max:1,step:.01,unit:'/100',scale:100,hint:'Uma pequena fração de pulsos menos energéticos em baixa carga; sem buracos de silêncio artificiais.'}],
 escape:[{key:'headerLength',label:'Comprimento do coletor',min:.1,max:1.5,step:.01,unit:'m',digits:2,hint:'Altera o tempo de viagem e a primeira ressonância.'},{key:'exhaustLength',label:'Comprimento do escape',min:.3,max:4,step:.01,unit:'m',digits:2},{key:'pipeDiameter',label:'Diâmetro do tubo',min:25,max:120,step:1,unit:'mm'},{key:'muffler',label:'Atenuação do abafador',min:0,max:1,step:.01,unit:'%',hint:'Aberto à esquerda; mais silencioso à direita.'},{key:'damping',label:'Perdas nas paredes',min:0,max:1,step:.01,unit:'%'},{key:'crossover',label:'Ligação entre bancos',min:0,max:1,step:.01,unit:'%',hint:'Mistura os dois caminhos; mais perceptível em motores em V.'},{key:'temperature',label:'Temperatura dos gases',min:100,max:950,step:10,unit:'°C',hint:'Altera a velocidade de propagação do som.'}],
 turbo:[{key:'intakeLength',label:'Comprimento da admissão',min:.05,max:1.2,step:.01,unit:'m',digits:2},{key:'boostBar',label:'Pressão alvo do turbo',min:0,max:2.5,step:.05,unit:'bar',digits:2,hint:'Zero desliga a camada do turbo. Pressão real depende de carga e enchimento.'},{key:'turboSize',label:'Tamanho / inércia do turbo',min:0,max:1,step:.01,unit:'%',hint:'Grande: enche mais devagar e assobia em uma região diferente.'},{key:'bov',label:'Alívio ao fechar borboleta',min:0,max:1,step:.01,unit:'%'}],
 mix:[{key:'exhaustGain',label:'Escape',min:0,max:1,step:.01,unit:'%'},{key:'intakeGain',label:'Admissão',min:0,max:1,step:.01,unit:'%'},{key:'mechanicalGain',label:'Mecânica do bloco',min:0,max:1,step:.01,unit:'%'},{key:'turboGain',label:'Turbina e fluxo',min:0,max:1,step:.01,unit:'%'},{key:'stereoWidth',label:'Largura dos bancos',min:0,max:1,step:.01,unit:'%',hint:'Centro mono à esquerda; maior separação entre bancos à direita.'}]
};
groups.character.push({key:'combustionDetail',label:'Detalhe de descarga e válvulas',min:0,max:1,step:.01,unit:'/100',scale:100,hint:'A forma dos pulsos acompanha rotação e carga. Zero mantém a forma anterior.'});
function displayControl(item:Slider):string { const value=Number(config[item.key]); return `${format(value*(item.scale??(item.unit==='%'?100:1)),item.digits??0)} ${item.unit}`; }
function slider(item:Slider):string { return `<div class="control"><label for="param-${item.key}">${item.label}<output id="out-${item.key}">${displayControl(item)}</output></label><input data-key="${item.key}" id="param-${item.key}" type="range" min="${item.min}" max="${item.max}" step="${item.step}" value="${config[item.key]}">${item.hint?`<small>${item.hint}</small>`:''}</div>`; }
function renderParameters():void {
 let html='';
 if(tab==='mix')html+=`<div class="control"><label for="perspective">Perspectiva de audição</label><select id="perspective">${[['exhaust','Saída do escape'],['engine','Cofre do motor'],['cabin','Cabine'],['roadside','Exterior · distância fixa']].map(([id,label])=>`<option value="${id}" ${config.perspective===id?'selected':''}>${label}</option>`).join('')}</select><small>A perspectiva também é aplicada ao WAV e às camadas exportadas. Exterior estático, sem passagem ou Doppler.</small></div>`;
 if(tab==='character')html+=`<div class="character-intro"><p>Combine idade, precisão mecânica e corpo sonoro sem trocar a arquitetura. Os perfis são pontos de partida: cada característica continua editável. A escala de 0 a 100 indica intensidade; não é uma porcentagem medida de falhas.</p><div class="character-profiles">${[['bench','Bancada / preciso'],['modern','Rua moderna'],['classic','Clássico mecânico'],['raw','Preparado / áspero']].map(([id,label])=>`<button class="small" data-character="${id}">${label}</button>`).join('')}</div></div>`;
 if(tab==='escape')html+=`<div class="exhaust-profiles"><span class="label">RECEITAS DE ESCAPE</span>${[['street','Rua / abafado'],['sport','Esportivo'],['open','Tubo aberto'],['long','Longo / encorpado'],['dual','Duplo / crossover'],['side','Curto / lateral']].map(([id,label])=>`<button class="small" data-exhaust="${id}">${label}</button>`).join('')}</div>`;
 if(tab==='motor') html+=`<div class="control"><label for="cylinders-select">Número de cilindros<output>${config.cylinders}</output></label><select id="cylinders-select">${[2,3,4,5,6,8,10,12].map(n=>`<option value="${n}" ${n===config.cylinders?'selected':''}>${n} cilindros</option>`).join('')}</select></div><div class="control"><label for="layout-select">Arquitetura</label><select id="layout-select">${[['inline','Em linha'],['v','Em V'],['boxer','Boxer / opostos']].map(([id,name])=>`<option value="${id}" ${id===config.layout?'selected':''}>${name}</option>`).join('')}</select></div>${slider({key:'bankAngle',label:'Ângulo entre bancos',min:10,max:180,step:1,unit:'°',hint:'A fase do virabrequim é definida separadamente no editor de ignição.'})}`;
 html+=(groups[tab]??[]).map(slider).join('');
 if(tab==='motor') html+=`<div class="firing-editor"><div class="control"><label for="firing-angles">Ângulos de ignição · 720°</label><input id="firing-angles" value="${config.firingAngles.map(n=>+n.toFixed(2)).join(', ')}"><small>Um ângulo por cilindro, entre 0 e 719°. Ex.: V2 irregular: 0, 315.</small></div><div class="control"><label for="firing-order-edit">Ordem dos cilindros</label><input id="firing-order-edit" value="${config.firingOrder.join(', ')}"><small>Identificadores únicos de 1 a ${config.cylinders}. Edite e pressione Enter ou saia do campo.</small></div></div>`;
 $('#parameters').innerHTML=html;
 $('#parameters').setAttribute('aria-labelledby',`tab-${tab}`);
 if(tab==='mix')$('#perspective').addEventListener('change',()=>{config=normalizeConfig({...config,perspective:$<HTMLSelectElement>('#perspective').value as EngineConfig['perspective']});edited();});
 if(tab==='escape')$<HTMLInputElement>('#param-crossover').disabled=config.layout==='inline';
 document.querySelectorAll<HTMLInputElement>('[data-key]').forEach(input=>input.addEventListener('input',()=>{ const key=input.dataset.key as Key; config=normalizeConfig({...config,[key]:Number(input.value)}); const item=(groups[tab]??[]).find(item=>item.key===key)??{key,label:'',min:0,max:180,step:1,unit:'°'}; $(`#out-${key}`).textContent=displayControl(item); edited(); }));
 document.querySelectorAll<HTMLElement>('[data-exhaust]').forEach(button=>button.addEventListener('click',()=>{const recipes:Record<string,Partial<EngineConfig>>={street:{muffler:.78,damping:.58,exhaustLength:2.25,headerLength:.5,pipeDiameter:52,crossover:.3},sport:{muffler:.3,damping:.26,exhaustLength:1.7,headerLength:.55,pipeDiameter:68,crossover:.35},open:{muffler:.02,damping:.09,exhaustLength:.75,headerLength:.3,pipeDiameter:82,crossover:.08},long:{muffler:.22,damping:.32,exhaustLength:3.2,headerLength:1.1,pipeDiameter:65,crossover:.18},dual:{muffler:.28,damping:.3,exhaustLength:2.15,headerLength:.7,pipeDiameter:68,crossover:.68},side:{muffler:.14,damping:.18,exhaustLength:.5,headerLength:.4,pipeDiameter:65,crossover:.08}};config=normalizeConfig({...config,...recipes[button.dataset.exhaust!]});edited();const restrictions:Record<string,{exhaustVolumeL:number;exhaustRestrictionK:number;exhaustFrictionFactor:number}>={street:{exhaustVolumeL:4,exhaustRestrictionK:14,exhaustFrictionFactor:.035},sport:{exhaustVolumeL:3,exhaustRestrictionK:5,exhaustFrictionFactor:.025},open:{exhaustVolumeL:1.5,exhaustRestrictionK:1,exhaustFrictionFactor:.022},long:{exhaustVolumeL:6,exhaustRestrictionK:4,exhaustFrictionFactor:.03},dual:{exhaustVolumeL:5,exhaustRestrictionK:4,exhaustFrictionFactor:.025},side:{exhaustVolumeL:1.3,exhaustRestrictionK:2,exhaustFrictionFactor:.025}};if(physics)physics.setPhysical({...physics.getPhysical(),...restrictions[button.dataset.exhaust!]});renderParameters();toast('Receita aplicada com perdas físicas hipotéticas e atenuação acústica independentes.');}));
 document.querySelectorAll<HTMLElement>('[data-character]').forEach(button=>button.addEventListener('click',()=>{const profiles:Record<string,Partial<EngineConfig>>={bench:{roughness:0,timingJitter:0,lowBody:0,wear:0},modern:{roughness:.16,timingJitter:.12,lowBody:.4,wear:.01},classic:{roughness:.52,timingJitter:.38,lowBody:.7,wear:.1},raw:{roughness:.68,timingJitter:.32,lowBody:.62,wear:.04}};config=normalizeConfig({...config,...profiles[button.dataset.character!]});edited();renderParameters();toast('Perfil aplicado. Arquitetura e escape continuam independentes.');}));
 if(tab==='motor') {
  $<HTMLInputElement>('#param-bankAngle').disabled=config.layout==='inline';
  $('#cylinders-select').addEventListener('change',e=>{config=normalizeConfig({...config,cylinders:Number((e.target as HTMLSelectElement).value),firingAngles:[],firingOrder:[],cylinderBanks:[]});edited();renderParameters();});
  $('#layout-select').addEventListener('change',e=>{ const layout=(e.target as HTMLSelectElement).value as EngineConfig['layout'];config=normalizeConfig({...config,layout,bankAngle:layout==='boxer'?180:layout==='v'?60:0,cylinderBanks:[]});edited();renderParameters();});
  for(const id of ['firing-angles','firing-order-edit']) { const input=$<HTMLInputElement>(`#${id}`);input.addEventListener('change',applyFiring);input.addEventListener('keydown',e=>{if(e.key==='Enter')input.blur();}); }
 }
}
function applyFiring():void {
 const angles=$<HTMLInputElement>('#firing-angles').value.split(/[,;\s]+/).filter(Boolean).map(Number);
 const order=$<HTMLInputElement>('#firing-order-edit').value.split(/[,;\s]+/).filter(Boolean).map(Number);
 if(angles.length!==config.cylinders||angles.some(n=>!Number.isFinite(n)||n<0||n>=720)||new Set(angles).size!==config.cylinders||order.length!==config.cylinders||order.some(n=>!Number.isInteger(n)||n<1||n>config.cylinders)||new Set(order).size!==config.cylinders) {toast(`Use ${config.cylinders} ângulos distintos de 0 a 719° e uma ordem válida de cilindros.`);renderParameters();return;}
 config=normalizeConfig({...config,firingAngles:angles,firingOrder:order});edited();renderParameters();
}
function renderConfig(custom=false):void {
 $('#engine-name').textContent=custom?'Sua configuração':names[selected];
 $('#description').textContent=custom?`${config.cylinders} cilindros · ${config.layout==='inline'?'em linha':config.layout==='v'?`V de ${config.bankAngle}°`:'opostos'} · ${format(config.displacement,1)} L · ${config.boostBar?`${format(config.boostBar,2)} bar de pressão alvo`:'aspirado'}. Ajuste o motor e ouça como cada parte muda a voz.`:descriptions[selected];
 $('#cylinders').innerHTML=Array.from({length:config.cylinders},(_,i)=>`<span class="cylinder" data-cylinder="${i+1}" title="Cilindro ${i+1}, banco ${config.cylinderBanks[i]+1}">${i+1}</span>`).join('');
 $('#firing-order').textContent=`ORDEM ${config.firingOrder.join(' · ')} / 720°`;
 const rpm=$<HTMLInputElement>('#rpm');rpm.min=String(config.idleRpm);rpm.max=String(Math.round(config.redline*1.04));manualRpm=Math.min(Math.max(config.idleRpm,manualRpm),config.redline);rpm.value=String(manualRpm);manualRpm=Number(rpm.value);$('#rpm-out').textContent=`${format(manualRpm)} RPM`;
 document.querySelectorAll<HTMLElement>('[data-preset]').forEach((button,i)=>button.classList.toggle('active',i===selected&&!custom));
 renderVoiceTags();renderParameters();
}
function edited():void {node?.port.postMessage({type:'config',config});physics?.configChanged(config); renderConfigMetadata();}
function renderConfigMetadata():void {
 renderVoiceTags();
 $('#engine-name').textContent='Sua configuração';
 $('#description').textContent=`${config.cylinders} cilindros · ${config.layout==='inline'?'em linha':config.layout==='v'?`V de ${config.bankAngle}°`:'opostos'} · ${format(config.displacement,1)} L · ${config.boostBar?`${format(config.boostBar,2)} bar de pressão alvo`:'aspirado'} · limite em ${format(config.redline)} RPM.`;
 document.querySelectorAll('[data-preset]').forEach(button=>button.classList.remove('active'));
 $('#cylinders').innerHTML=Array.from({length:config.cylinders},(_,i)=>`<span class="cylinder" data-cylinder="${i+1}">${i+1}</span>`).join('');
 $('#firing-order').textContent=`ORDEM ${config.firingOrder.join(' · ')} / 720°`;
 const rpm=$<HTMLInputElement>('#rpm');rpm.min=String(config.idleRpm);rpm.max=String(Math.round(config.redline*1.04));manualRpm=Math.min(Math.max(config.idleRpm,manualRpm),Number(rpm.max));rpm.value=String(manualRpm);manualRpm=Number(rpm.value);$('#rpm-out').textContent=`${format(manualRpm)} RPM`;
 for(const item of groups[tab]??[]){const input=$<HTMLInputElement>(`#param-${item.key}`);if(input){input.value=String(config[item.key]);$(`#out-${item.key}`).textContent=displayControl(item);}}
}
function renderVoiceTags():void {
 const texture=(config.roughness+config.timingJitter+config.wear)/3;
 const labels=[config.displacement<1.6?'Compacto':config.displacement>=4?'Grande cilindrada':'Média cilindrada',texture<.08?'Precisão alta':texture<.28?'Textura de rua':'Textura mecânica',config.muffler>.6?'Escape abafado':config.muffler<.2?'Escape aberto':'Escape esportivo',config.inertia>.55?'Resposta progressiva':'Resposta rápida'];
 $('#voice-tags').innerHTML=labels.map(label=>`<span class="pill">${label}</span>`).join('');
}
function selectPreset(index:number):void { if(!presets[index])return;selected=index;config=clone(presets[index].config);driveRpm=config.idleRpm;scenarioTime=0;previousGear=-1;physics?.configChanged(config,true);node?.port.postMessage({type:'config',config});renderConfig(); }
document.querySelectorAll<HTMLElement>('[data-preset]').forEach(button=>button.addEventListener('click',()=>selectPreset(Number(button.dataset.preset))));
document.querySelectorAll<HTMLElement>('[data-tab]').forEach(button=>button.addEventListener('click',()=>{tab=button.dataset.tab!;document.querySelectorAll('[data-tab]').forEach(other=>{other.classList.toggle('active',other===button);other.setAttribute('aria-selected',String(other===button));});renderParameters();}));
document.querySelectorAll<HTMLElement>('[data-scope]').forEach(button=>button.addEventListener('click',()=>{scopeMode=button.dataset.scope!;document.querySelectorAll('[data-scope]').forEach(other=>other.classList.toggle('active',other===button));}));
function setScenario(next:string):void {if(next==='physical'&&physics&&isReferenceEcuBlocked(physics.getPhysical())){physics.setEnabled(false);toast('EFI/modelo 3 requer Rust; a condução física está indisponível nesta referência.');return;}scenario=next;scenarioTime=0;previousGear=-1;if(next!=='physical')physics?.setEnabled(false);document.querySelectorAll<HTMLElement>('[data-scenario]').forEach(button=>button.classList.toggle('active',button.dataset.scenario===scenario));}
document.querySelectorAll<HTMLElement>('[data-scenario]').forEach(button=>button.addEventListener('click',()=>setScenario(button.dataset.scenario!)));
$('#rpm').addEventListener('input',()=>{manualRpm=Number($<HTMLInputElement>('#rpm').value);$('#rpm-out').textContent=`${format(manualRpm)} RPM`;setScenario('manual');});
$('#load').addEventListener('input',()=>{manualLoad=Number($<HTMLInputElement>('#load').value)/100;$('#load-out').textContent=`${format(manualLoad*100)} %`;setScenario('manual');});
$('#throttle-input').addEventListener('input',()=>{manualThrottle=Number($<HTMLInputElement>('#throttle-input').value)/100;$('#throttle-out').textContent=`${format(manualThrottle*100)} %`;if(scenario==='physical'&&workshop?.getMode()==='normal'){const pedal=$<HTMLInputElement>('#physical-throttle');pedal.value=String(manualThrottle*100);pedal.dispatchEvent(new Event('input',{bubbles:true}));}else setScenario('manual');});
$('#volume').addEventListener('input',()=>{volume=Number($<HTMLInputElement>('#volume').value)/100;bench?.setVolume(volume);document.querySelectorAll<HTMLAudioElement>('audio[data-comparison]').forEach(audio=>{audio.volume=volume;});$('#volume-out').textContent=`${format(volume*100)} %`;if(context&&master)master.gain.setTargetAtTime(running?volume:0,context.currentTime,.025);});

const comparisonPlayers = [...document.querySelectorAll<HTMLAudioElement>('audio[data-comparison]')];
for(const player of comparisonPlayers){
 player.volume=volume;
 player.addEventListener('play',()=>{bench?.stop();if(running||starting)void stop();for(const other of comparisonPlayers)if(other!==player)other.pause();$('#status').textContent=player.id==='reference-clip'?'Referência gravada':'Comparação gravada';$('#status-dot').classList.add('on');});
 const resetPreviewStatus=()=>{if(!running&&comparisonPlayers.every(audio=>audio.paused)){$('#status').textContent='Motor desligado';$('#status-dot').classList.remove('on');}};
 player.addEventListener('pause',resetPreviewStatus);player.addEventListener('ended',resetPreviewStatus);
}

async function start():Promise<void> {
 if(scenario==='physical'&&physics&&isReferenceEcuBlocked(physics.getPhysical())){toast('EFI/modelo 3 requer Rust para executar a condução física.');return;}
 if(running||starting)return;
 bench?.stop();
 const generation=++startGeneration;
 clearTimeout(suspendTimer);
 comparisonPlayers.forEach(player=>player.pause());
 starting=true;$<HTMLButtonElement>('#power').disabled=true;
 try {
  if(!context) {
   context=new AudioContext({sampleRate:48000,latencyHint:'interactive'});
   await context.audioWorklet.addModule(workletUrl);
   if(generation!==startGeneration){await context.close();context=undefined;return;}
   node=new AudioWorkletNode(context,'carlab-engine',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2],processorOptions:{backend:getBackendName(),wasmModule:getBackendModule()}});
   master=context.createGain();master.gain.value=0;
   analyser=context.createAnalyser();analyser.fftSize=2048;analyser.smoothingTimeConstant=.75;
   node.connect(analyser);analyser.connect(master);master.connect(context.destination);
   node.port.onmessage=({data})=>{if(data.type==='telemetry'){telemetry=data;if(data.character)characterTelemetry=data.character;}};
   node.onprocessorerror=()=>{toast('O processador de áudio foi interrompido. Recarregue o laboratório.');void stop();};
   $('#footer-info').innerHTML=`${getBackendName()==='rust'?'Rust / WASM':'TypeScript referência'} · AudioWorklet · ${format(context.sampleRate/1000,0)} kHz<br>Nenhum áudio sai deste navegador.`;
  }
  await context.resume();
  if(generation!==startGeneration){master!.gain.setValueAtTime(0,context.currentTime);node!.port.postMessage({type:'trigger',kind:'stop'});await context.suspend();return;}
  running=true;scenarioTime=0;previousGear=-1;
  node!.port.postMessage({type:'config',config});node!.port.postMessage({type:'state',state:scenario==='physical'?physics!.getState():{rpm:scenario==='manual'?manualRpm:config.idleRpm,load:scenario==='manual'?manualLoad:.14,throttle:scenario==='manual'?manualThrottle:.06},actualRpm:scenario==='physical'});node!.port.postMessage({type:'trigger',kind:'start'});
  master!.gain.setTargetAtTime(volume,context.currentTime,.04);
  $('#power').innerHTML=`${iconStop}Desligar motor`;$('#power').classList.add('dark');$('#power').classList.remove('primary');$('#status').textContent='Motor ligado';$('#status-dot').classList.add('on');
 } catch(error) {if(generation===startGeneration){toast(`Não foi possível iniciar o áudio: ${error instanceof Error?error.message:String(error)}`);console.error(error);}running=false;node?.disconnect();await context?.close().catch(()=>{});context=undefined;node=undefined;master=undefined;analyser=undefined;}
 finally {starting=false;$<HTMLButtonElement>('#power').disabled=false;}
}
async function stop():Promise<void> {
 startGeneration++;
 running=false;pressed=false;$('#throttle').classList.remove('held');
 clearTimeout(suspendTimer);
 if(context&&master){master.gain.setTargetAtTime(0,context.currentTime,.035);node?.port.postMessage({type:'trigger',kind:'stop'});const saved=context;suspendTimer=window.setTimeout(()=>{if(!running)void saved.suspend();},250);}
 $('#power').innerHTML=`${iconPlay}Ligar motor`;$('#power').classList.add('primary');$('#power').classList.remove('dark');$('#status').textContent='Áudio desligado';$('#status-dot').classList.remove('on');
}
$('#power').addEventListener('click',()=>{if(running)void stop();else void start();});
function trigger(kind:'blip'|'shift'):void {if(kind==='blip'&&scenario==='physical'){physics?.blip();return;}node?.port.postMessage({type:'trigger',kind});if(kind==='shift'){if(scenario==='physical'){physics?.shift();return;}driveRpm=Math.max(config.idleRpm,driveRpm*.69);if(scenario==='manual'){manualRpm=Math.max(config.idleRpm,manualRpm*.69);$<HTMLInputElement>('#rpm').value=String(manualRpm);$('#rpm-out').textContent=`${format(manualRpm)} RPM`;}}}
$('#blip').addEventListener('click',()=>trigger('blip'));$('#shift').addEventListener('click',()=>trigger('shift'));
function hold(value:boolean):void {pressed=value;$('#throttle').classList.toggle('held',value);}
$('#throttle').addEventListener('pointerdown',e=>{e.preventDefault();$('#throttle').setPointerCapture(e.pointerId);hold(true);});
for(const event of ['pointerup','pointercancel','lostpointercapture'])$('#throttle').addEventListener(event,()=>hold(false));
window.addEventListener('blur',()=>{
 const wasPressed=pressed;hold(false);
 // Hidden tabs can pause requestAnimationFrame; release the pedal on the audio
 // thread immediately, rather than leaving its last full-throttle state active.
 if(wasPressed&&scenario==='physical')void stop();
 else if(wasPressed)node?.port.postMessage({type:'state',state:{rpm:manualRpm,load:manualLoad,throttle:manualThrottle},actualRpm:false});
});
window.addEventListener('keydown',e=>{if(e.code==='Escape'){bench?.stop();comparisonPlayers.forEach(player=>player.pause());if(running||starting)void stop();return;}if((e.target as HTMLElement).matches('input,select,textarea,button,audio'))return;if(e.code==='Space'){e.preventDefault();hold(true);}if(e.code==='ArrowUp'&&!e.repeat){e.preventDefault();trigger('shift');}});
window.addEventListener('keyup',e=>{if(e.code==='Space')hold(false);});

function updateComparison():void {for(const key of ['A','B'] as const){$<HTMLButtonElement>(`#recall-${key.toLowerCase()}`).disabled=!snapshots[key];$(`#save-${key.toLowerCase()}`).textContent=snapshots[key]?`Atualizar ${key}`:`Salvar ${key}`;}}
for(const key of ['A','B'] as const) {
 $(`#save-${key.toLowerCase()}`).addEventListener('click',()=>{snapshots[key]=clone(config);try{localStorage.setItem('carlab-engine-lab-compare',JSON.stringify(snapshots));}catch{/* Still available this session. */}updateComparison();toast(`Configuração ${key} salva. Ajuste outra voz e compare.`);});
 $(`#recall-${key.toLowerCase()}`).addEventListener('click',()=>{if(!snapshots[key])return;config=clone(snapshots[key]!);physics?.configChanged(config);node?.port.postMessage({type:'config',config});renderConfig(true);document.querySelectorAll('.compare button').forEach(button=>button.classList.remove('active'));$(`#recall-${key.toLowerCase()}`).classList.add('active');toast(`Configuração ${key} selecionada.`);});
}
$('#reset').addEventListener('click',()=>{selectPreset(selected);toast('Configuração original restaurada.');});
function toast(message:string):void {$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=window.setTimeout(()=>$('#toast').classList.remove('show'),5500);}
let lastDownload:{name:string;bytes:number}|undefined;
function download(data:Uint8Array|string,name:string,mime:string):void {const blob=new Blob([typeof data==='string'?data:new Uint8Array(data)],{type:mime});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);lastDownload={name,bytes:blob.size};}
function configDocument():object{return {format:'carlab-engine-config',version:2,model:MODEL_VERSION,config,physical:physics?.getPhysical()};}
$('#save-config').addEventListener('click',()=>download(JSON.stringify(configDocument(),null,2),'carlab-engine-config.json','application/json'));
$('#import').addEventListener('click',()=>$<HTMLInputElement>('#config-file').click());
$('#config-file').addEventListener('change',async()=>{const file=$<HTMLInputElement>('#config-file').files?.[0];if(!file)return;try{if(file.size>400000)throw new Error('Arquivo muito grande');const parsed=JSON.parse(await file.text());const input=parsed.config??parsed;if(!input||typeof input!=='object'||!Number.isFinite(input.cylinders))throw new Error('Configuração inválida');const nextConfig=normalizeConfig(input),nextPhysical=normalizePhysicalConfig(nextConfig,parsed.physical&&typeof parsed.physical==='object'?parsed.physical:{});config=nextConfig;physics!.configChanged(config,true);physics!.setPhysicalAndReset(nextPhysical);node?.port.postMessage({type:'config',config});renderConfig(true);toast('Configuração importada.');}catch(error){toast(`Falha ao importar: ${error instanceof Error?error.message:String(error)}`);}$<HTMLInputElement>('#config-file').value='';});
function finishExport():void {worker?.terminate();worker=undefined;$('#progress').classList.remove('visible');for(const id of ['export-wav','export-bank','export-stems'])$<HTMLButtonElement>(`#${id}`).disabled=false;}
function beginExport(type:'render'|'bank'|'stems'):void {
 if(worker)return;const id=++exportId;
 worker=new Worker(new URL('./render-worker.ts',import.meta.url),{type:'module'});
 $('#progress').classList.add('visible');$('#progress-label').textContent=type==='bank'?'Gerando 48 pontos…':type==='stems'?'Separando as quatro camadas…':'Renderizando 12 segundos…';$<HTMLProgressElement>('#render-progress').value=0;
 for(const id of ['export-wav','export-bank','export-stems'])$<HTMLButtonElement>(`#${id}`).disabled=true;
 worker.onmessage=({data})=>{
  if(data.id!==id)return;
  if(data.type==='progress'){$<HTMLProgressElement>('#render-progress').value=data.progress;return;}
  if(data.type==='complete'){
   try{const files=data.files as {name:string;data:Uint8Array}[];if(type==='render'){const wav=files.find(file=>file.name.endsWith('.wav'));if(!wav)throw new Error('WAV ausente');download(wav.data,wav.name,'audio/wav');}else download(zipFiles(files),type==='bank'?'carlab-engine-bank.zip':'carlab-engine-stems.zip','application/zip');toast(type==='bank'?'Banco pronto: WAVs, configuração e manifesto no ZIP.':type==='stems'?'Camadas prontas: escape, admissão, mecânica, turbo e mix completo.':'Tomada renderizada. O arquivo usa o nível integral do sintetizador.');}catch(error){toast(`Falha na exportação: ${String(error)}`);}finishExport();
  }
  if(data.type==='error'){toast(`Falha na renderização: ${data.error??data.message}`);finishExport();}
 };
 worker.onerror=(event)=>{toast(`Falha no renderizador: ${event.message}`);finishExport();};
 const exportScenario=workshop?.getMode()==='normal'?(scenario==='manual'?'steady':scenario):$<HTMLSelectElement>('#export-scenario').value;
 worker.postMessage({type,id,backend:getBackendName(),config:clone(config),physical:physics?.getPhysical(),options:{sampleRate:48000,duration:12,scenario:exportScenario,rpm:running?telemetry.rpm:manualRpm,load:running?telemetry.load:manualLoad,throttle:running?telemetry.throttle:manualThrottle,...(exportScenario==='physical'?physics?.getDriveOptions(pressed):{})}});
}
$('#export-wav').addEventListener('click',()=>beginExport('render'));$('#export-stems').addEventListener('click',()=>beginExport('stems'));$('#export-bank').addEventListener('click',()=>beginExport('bank'));$('#cancel-export').addEventListener('click',()=>{finishExport();toast('Exportação cancelada.');});

function driver(dt:number):void {
 if(scenario==='physical'&&physics&&isReferenceEcuBlocked(physics.getPhysical())){if(running)void stop();return;}
 scenarioTime+=dt;
 let rpm=manualRpm,load=manualLoad,throttle=manualThrottle;
 if(scenario==='physical'&&physics){const state=running?physics.step(dt,pressed):physics.getState();rpm=state.rpm;load=state.load;throttle=state.throttle;}
 else if(pressed){const response=1-Math.exp(-dt/(.22+config.inertia*.7));driveRpm+=(config.redline*1.025-driveRpm)*response;rpm=driveRpm;load=throttle=1;}
 else if(scenario!=='manual'){const t=scenarioTime%12;const state=scenarioState(config,scenario as 'idle'|'rev'|'drive'|'overrun',t,12);rpm=state.rpm;load=state.load;throttle=state.throttle;driveRpm=rpm;const gear=Math.floor(t/3);if(running&&scenario==='drive'&&gear!==previousGear&&previousGear>=0)node?.port.postMessage({type:'trigger',kind:'shift'});previousGear=gear;}
 else {driveRpm+=(manualRpm-driveRpm)*(1-Math.exp(-dt/.45));rpm=driveRpm;}
 if(running&&performance.now()-lastStateTime>30){lastStateTime=performance.now();node?.port.postMessage({type:'state',state:{rpm,load,throttle,...(scenario==='physical'?{physical:physics!.getState().physical}:{})},actualRpm:scenario==='physical'});}
}

function sizeCanvas(canvas:HTMLCanvasElement):{ctx:CanvasRenderingContext2D;width:number;height:number} {
 const width=canvas.clientWidth,height=canvas.clientHeight,dpr=Math.min(devicePixelRatio,2);if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}const ctx=canvas.getContext('2d')!;ctx.setTransform(dpr,0,0,dpr,0,0);return{ctx,width,height};
}
function drawGauge():void {
 const {ctx,width:w,height:h}=sizeCanvas($<HTMLCanvasElement>('#gauge'));ctx.clearRect(0,0,w,h);
 const rpm=running?telemetry.rpm:0,max=Math.ceil(config.redline/1000)*1000+1000,cx=w/2,cy=h*.86,r=Math.min(w*.39,h*.76);
 // A wide, shallow arc leaves the numeric reading at the centre.
 const a0=Math.PI*1.05,a1=Math.PI*1.95;
 ctx.lineCap='round';ctx.lineWidth=10;ctx.strokeStyle='#344247';ctx.beginPath();ctx.arc(cx,cy,r,a0,a1);ctx.stroke();
 ctx.strokeStyle=telemetry.limiter&&running?'#ff947b':'#d7fb5c';ctx.beginPath();ctx.arc(cx,cy,r,a0,a0+(a1-a0)*Math.min(rpm/max,1));ctx.stroke();
 for(let n=0;n<=max;n+=500){const a=a0+(a1-a0)*n/max,major=n%1000===0;ctx.strokeStyle=n>=config.redline?'#df8066':'#778c88';ctx.lineWidth=major?1.4:.7;ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*(r-13),cy+Math.sin(a)*(r-13));ctx.lineTo(cx+Math.cos(a)*(r-(major?23:18)),cy+Math.sin(a)*(r-(major?23:18)));ctx.stroke();if(major){ctx.fillStyle='#a6b8b0';ctx.font='9px ui-monospace,monospace';ctx.textAlign='center';ctx.fillText(String(n/1000),cx+Math.cos(a)*(r-36),cy+Math.sin(a)*(r-36)+3);}}
 ctx.fillStyle='#f0f6e9';ctx.textAlign='center';ctx.font=`400 ${Math.min(57,w*.12)}px ui-monospace,monospace`;ctx.fillText(format(rpm),cx,cy-20);ctx.font='9px ui-monospace,monospace';ctx.fillStyle='#92a69f';ctx.fillText(t('REVOLUTIONS / MIN'),cx,cy+1);ctx.font='9px ui-monospace,monospace';ctx.fillStyle='#b5c6b9';ctx.fillText(`${t('{count} CYLINDERS',{count:config.cylinders})}   ·   ${format(config.displacement,1)} L   ·   ${config.layout==='inline'?t('INLINE'):config.layout.toUpperCase()}`,cx,h-10);
 $('#metric-load').textContent=format(running?telemetry.load*100:0);$('#metric-boost').textContent=format(running?telemetry.boost:0,2);$('#metric-firing').textContent=format(running?telemetry.firingHz:0);
 $('#live-label').textContent=running?(telemetry.limiter?'CORTE DE GIRO':scenario==='physical'?'CONDUÇÃO FÍSICA':scenario==='manual'?'CONTROLE MANUAL':'CICLO AUTOMÁTICO'):'PRONTO PARA OUVIR';
 const peak=telemetry.peak>0?20*Math.log10(telemetry.peak):-96;$('#peak-label').textContent=running?`${format(peak,1)} dBFS · ${format(context?.sampleRate??48000)} Hz`:'48 kHz · estéreo';
 document.querySelectorAll<HTMLElement>('[data-cylinder]').forEach(element=>{const cylinder=Number(element.dataset.cylinder),event=config.firingOrder.indexOf(cylinder);const phase=((telemetry.cycle*720-config.firingAngles[event])+720)%720;element.classList.toggle('firing',running&&phase<Math.max(18,720/config.cylinders*.35));});
}
let waveData=new Float32Array(2048),spectrumData=new Uint8Array(1024);
function drawScope():void {
 const canvas=$<HTMLCanvasElement>('#scope');if(!canvas.clientWidth)return;const{ctx,width:w,height:h}=sizeCanvas(canvas);ctx.clearRect(0,0,w,h);ctx.strokeStyle='#e5e9df';ctx.lineWidth=1;for(let x=0;x<w;x+=w/8){ctx.beginPath();ctx.moveTo(x,10);ctx.lineTo(x,h-10);ctx.stroke();}for(let y=15;y<h;y+=(h-30)/4){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
 if(scopeMode==='wave'){if(analyser&&running)analyser.getFloatTimeDomainData(waveData);else waveData.fill(0);ctx.strokeStyle='#657e35';ctx.lineWidth=1.4;ctx.beginPath();for(let x=0;x<w;x++){const sample=waveData[Math.min(2047,Math.floor(x/w*700))];const y=h*.5-sample*h*.8;x?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.stroke();}
 else{if(analyser&&running)analyser.getByteFrequencyData(spectrumData);else spectrumData.fill(0);const n=48;for(let i=0;i<n;i++){const low=Math.floor(Math.pow(1024,i/n)),high=Math.max(low+1,Math.floor(Math.pow(1024,(i+1)/n)));let value=0;for(let j=low;j<high;j++)value=Math.max(value,spectrumData[j]??0);const bh=value/255*(h-26);ctx.fillStyle=i<n*.7?'#8da850':'#4f6b49';ctx.fillRect(i*w/n+1,h-12-bh,w/n-2,bh);}ctx.fillStyle='#7c8873';ctx.font='8px ui-monospace,monospace';ctx.fillText('20 Hz',7,h-1);ctx.fillText('20 kHz',w-42,h-1);}
}
let frame=0, visualAngle=0, visualSnapshotAt=0, animationRequest=0, closing=false;
let visualPhysical:ReturnType<typeof normalizePhysicalConfig>|undefined;
let visualPowertrain:ReturnType<NonNullable<typeof physics>['getState']>|undefined;
function animate(time:number):void {if(closing)return;const dt=Math.min(.1,(time-lastTime)/1000);lastTime=time;driver(dt);if(++frame%2===0){drawGauge();drawScope();if(viewport&&physics){if(!visualPhysical||time-visualSnapshotAt>250){visualSnapshotAt=time;visualPhysical=physics.getPhysical();visualPowertrain=physics.getState();workshop?.refresh();syncNormalDriving();}if(running)visualAngle=(visualAngle+Math.min(telemetry.rpm/60,.8)*Math.PI*2*dt*2)%(Math.PI*4);viewport.update({config,telemetry,physical:visualPhysical,powertrain:visualPowertrain!,physicalActive:scenario==='physical',running,crankAngleRad:visualAngle,time:time/1000,exploded:0,cutaway:false},dt*2);}}animationRequest=requestAnimationFrame(animate);}
physics=mountPowertrain($('#physics-panel'),config,enabled=>setScenario(enabled?'physical':'manual'));
const ecuPanel=mountEcuPanel($('#ecu-panel'),{getContext:()=>({engine:clone(config),physical:physics!.getPhysical()}),applyPhysical:(patch,reset=false)=>{const next={...physics!.getPhysical(),...patch};if(reset)physics!.setPhysicalAndReset(next);else physics!.setPhysical(next);},applyEngine:patch=>{config=normalizeConfig({...config,...patch});physics!.configChanged(config);node?.port.postMessage({type:'config',config});renderConfig(true);},getState:()=>physics!.getState(),reset:()=>physics!.reset(),notify:toast});
bench=mountBench($('#bench-panel'),{getConfig:()=>clone(config),getSnapshots:()=>clone(snapshots),stopLive:()=>{void stop();},pauseFiles:()=>comparisonPlayers.forEach(player=>player.pause()),volume:()=>volume,notify:toast});
const library=mountLibrary($('#library-panel'),{getProject:()=>({engine:clone(config),physical:{...physics!.getPhysical()}}),applyProject:project=>{const nextConfig=normalizeConfig(project.engine),nextPhysical=normalizePhysicalConfig(nextConfig,project.physical??{});config=nextConfig;physics!.configChanged(config,true);physics!.setPhysicalAndReset(nextPhysical);node?.port.postMessage({type:'config',config});renderConfig(true);},applyExhaust:(patch,physicalPatch)=>{config=normalizeConfig({...config,...patch});edited();if(physicalPatch)physics!.setPhysical(applyPhysicalExhaust(physics!.getPhysical(),physicalPatch));renderParameters();},notify:toast});
const cycleInspector=mountCycleInspector($('#cycle-panel'),{getContext:()=>({engine:clone(config),physical:physics!.getPhysical()}),applyPhysical:patch=>physics!.setPhysical({...physics!.getPhysical(),...patch}),notify:toast,onResult:()=>thermalPanel.refresh()});
const thermalPanel=mountThermalPanel($('#thermal-panel'),{getConfig:()=>physics!.getPhysical().thermal,setConfig:thermal=>physics!.setPhysical({...physics!.getPhysical(),thermal}),getState:()=>physics!.getState().thermal,getMaterialScreen:()=>physics!.getPhysical().materialScreen,setMaterialScreen:materialScreen=>physics!.setPhysical({...physics!.getPhysical(),materialScreen}),getMechanicalInput:()=>{const result=cycleInspector.getLatest();if(!result)return;const g=engineGeometry(result.engine,result.physical);return {angleDeg:result.cycle.trace.angleDeg,pressurePa:result.cycle.trace.pressurePa,boreM:g.boreMm/1000,strokeM:g.strokeMm/1000,rodLengthM:g.rodLengthMm/1000,reciprocatingMassKg:result.physical.reciprocatingMassKg,rpm:result.rpm};},notify:toast});
const workshopHost=document.createElement('section');workshopHost.id='workshop-panel';$('.dashboard').before(workshopHost);
const normalDriving=document.createElement('div');normalDriving.className='normal-physical-controls';normalDriving.id='normal-physical-controls';normalDriving.hidden=true;$('.driver-controls').after(normalDriving);
function renderNormalDriving():void {
 normalDriving.innerHTML=`<label class="field">${t('Drive mode')}<select id="normal-drive-mode"><option value="vehicle">${t('Vehicle')}</option><option value="free">${t('Free revving')}</option></select></label><label class="field">${t('Gear')}<select id="normal-drive-gear"><option value="0">${t('Neutral')}</option>${physics!.getPhysical().gearRatios.map((_,i)=>`<option value="${i+1}">${i+1}</option>`).join('')}</select></label><div class="control"><label for="normal-drive-brake">${t('Brake')}<output id="normal-drive-brake-out"></output></label><input id="normal-drive-brake" type="range" min="0" max="100" value="0"></div>`;
 syncNormalDriving();
}
function syncNormalDriving():void {
 normalDriving.hidden=workshop?.getMode()!=='normal'||scenario!=='physical';
 if(!normalDriving.children.length)return;
 const mode=$<HTMLSelectElement>('#physical-mode').value,gear=$<HTMLSelectElement>('#physical-gear').value,brake=$<HTMLInputElement>('#physical-brake').value;
 $<HTMLSelectElement>('#normal-drive-mode').value=mode;
 const gearSelect=$<HTMLSelectElement>('#normal-drive-gear'),count=physics!.getPhysical().gearRatios.length;
 if(gearSelect.options.length!==count+1)gearSelect.innerHTML=`<option value="0">${t('Neutral')}</option>${Array.from({length:count},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join('')}`;
 gearSelect.disabled=mode==='free';gearSelect.value=mode==='free'?'0':gear;
 $<HTMLInputElement>('#normal-drive-brake').value=brake;$('#normal-drive-brake-out').textContent=`${format(Number(brake))} %`;
 if(!normalDriving.hidden){const pedal=Number($<HTMLInputElement>('#physical-throttle').value);manualThrottle=pedal/100;$<HTMLInputElement>('#throttle-input').value=String(pedal);$('#throttle-out').textContent=`${format(pedal)} %`;}
}
normalDriving.addEventListener('input',event=>{if((event.target as HTMLElement).id==='normal-drive-brake'){const target=$<HTMLInputElement>('#physical-brake');target.value=$<HTMLInputElement>('#normal-drive-brake').value;target.dispatchEvent(new Event('input',{bubbles:true}));syncNormalDriving();}});
normalDriving.addEventListener('change',event=>{const id=(event.target as HTMLElement).id;if(id==='normal-drive-mode'||id==='normal-drive-gear'){const source=$<HTMLSelectElement>(id==='normal-drive-mode'?'#normal-drive-mode':'#normal-drive-gear'),target=$<HTMLSelectElement>(id==='normal-drive-mode'?'#physical-mode':'#physical-gear');target.value=source.value;target.dispatchEvent(new Event('change',{bubbles:true}));visualPhysical=undefined;syncNormalDriving();}});
renderNormalDriving();const disposeNormalDrivingLocale=subscribeLocale(renderNormalDriving);
function enableWorkshopDriving():void {if(isReferenceEcuBlocked(physics!.getPhysical())){toast(t('EFI requires the Rust backend.'));return;}physics!.setEnabled(true);setScenario('physical');}
workshop=mountWorkshopShell(workshopHost,{getConfig:()=>config,getPhysical:()=>physics!.getPhysical(),applyConfig:patch=>{config=normalizeConfig({...config,...patch});edited();renderParameters();visualPhysical=undefined;},applyPhysical:patch=>{physics!.setPhysical({...physics!.getPhysical(),...patch});visualPhysical=undefined;},selectPreset:index=>{selectPreset(index);visualPhysical=undefined;},onPart:part=>{void viewport?.selectPart(part);},onMode:syncNormalDriving,onFuel:fuel=>{try{const prior=physics!.getPhysical();const ecu=ecuRequest<EcuConfig>('normalizeEcuConfig',{engine:config,config:{...prior.ecu,enabled:true,combustionMode:fuel==='diesel'?'directInjectionDiesel':'portInjectionSpark',fuel:{...prior.ecu?.fuel,ethanolVolumeFraction:fuel==='ethanol'?1:fuel==='e85'?.85:0}}});physics!.setPhysicalAndReset({...prior,ecu});ecuPanel.refresh();visualPhysical=undefined;enableWorkshopDriving();}catch(error){toast(error instanceof Error?error.message:String(error));}}});
viewport=mountWorkshopViewport(workshop.canvasHost);
workshopHost.addEventListener('workshop-view',event=>viewport!.setView((event as CustomEvent).detail));
workshopHost.addEventListener('workshop-drive',enableWorkshopDriving);
void viewport.selectPart('engine');
const disposeI18n=mountI18n($('#app'));
renderConfig();updateComparison();animationRequest=requestAnimationFrame(animate);
window.addEventListener('pagehide',event=>{if(event.persisted){bench?.stop();comparisonPlayers.forEach(player=>player.pause());void stop();return;}if(closing)return;closing=true;cancelAnimationFrame(animationRequest);clearTimeout(suspendTimer);clearTimeout(toastTimer);disposeNormalDrivingLocale();disposeI18n();viewport?.dispose();workshop?.dispose();worker?.terminate();bench?.dispose();library.dispose();ecuPanel.dispose();cycleInspector.dispose();thermalPanel.dispose();physics?.dispose();void context?.close();});

// Read-only diagnostics and explicit controls for headless acceptance checks.
if (import.meta.env.DEV || new URLSearchParams(location.search).get('debug') === '1') Object.assign(window,{__engineLab:{backend:getBackendIdentity,getBackend:getBackendIdentity,getConfig:()=>clone(config),getTelemetry:()=>({...telemetry}),getCharacterTelemetry:()=>({...characterTelemetry}),isRunning:()=>running,getLastDownload:()=>lastDownload,selectPreset,start,stop,setScenario,setConfig:(input:Partial<EngineConfig>)=>{config=normalizeConfig({...config,...input});edited();renderParameters();},getPhysical:()=>physics!.getPhysical(),getPowertrainState:()=>physics!.getState(),latestCycle:()=>cycleInspector.getLatest(),getEcuCapture:()=>ecuPanel.getCaptured(),getEcuReport:()=>ecuPanel.getReport(),isBenchPlaying:()=>bench!.isPlaying(),audioState:()=>context?.state??'uninitialized',workshop:()=>viewport!.diagnostics(),getMode:()=>workshop!.getMode(),getLocale,getI18nDiagnostics}});
