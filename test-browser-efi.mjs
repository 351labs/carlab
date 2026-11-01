import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile,mkdtemp,rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir,hostname } from 'node:os';
import { join } from 'node:path';
import { preview } from 'vite';
import puppeteer from 'puppeteer-core';

// Functional acceptance of the compiled UI/worker/worklet, through lm-remote.
// All observations are synthetic fixtures, not independent engine validation.
const proof=process.env.ENGINE_LAB_PROOF??'output/review-fixes/efi';
const outDir=process.env.ENGINE_LAB_DIST??'dist/client';
await mkdir(proof,{recursive:true});
const temporary=await mkdtemp(join(tmpdir(),'carlab-efi-browser-'));
const checks=[],errors=[],uploads=[];
let server,browser,page,failure;
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
async function expand(selector){await page.$eval(selector,e=>{for(let p=e.parentElement;p;p=p.parentElement)if(p instanceof HTMLDetailsElement)p.open=true;});}
async function input(selector,value,event='change'){await expand(selector);await page.$eval(selector,(e,{value,event})=>{if(e.type==='checkbox')e.checked=Boolean(value);else e.value=String(value);e.dispatchEvent(new Event(event,{bubbles:true}));},{value,event});}
async function click(selector){await expand(selector);await page.click(selector);}
async function downloaded(name){for(let i=0;i<100;i++){try{return JSON.parse(await readFile(join(temporary,name),'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}await new Promise(r=>setTimeout(r,100));}throw new Error(`Missing download ${name}`);}
async function applyEcu(config){await input('#ecu-json',JSON.stringify(config));await click('#ecu-config-apply');}
async function waitEcu(predicate,...args){await page.waitForFunction(predicate,{timeout:20000},...args);}
try{
 server=await preview({configFile:'preview.config.ts',build:{outDir},preview:{host:'127.0.0.1',port:0,strictPort:false}});
 const port=server.httpServer.address().port;
 const executablePath=process.env.CHROME_PATH??['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'].find(existsSync);
 assert.ok(executablePath,'headless Chrome is available');
 browser=await puppeteer.launch({executablePath,headless:true,args:['--mute-audio','--disable-background-timer-throttling','--autoplay-policy=user-gesture-required']});
 page=await browser.newPage();await page.setViewport({width:1440,height:1050,deviceScaleFactor:1});
 await (await page.createCDPSession()).send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:temporary});
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 page.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))uploads.push(r.url());});
 const target = new URL(`http://127.0.0.1:${port}/${process.env.ENGINE_LAB_QUERY??'?mode=scholar&lang=pt'}`); target.searchParams.set('debug','1');
 await page.goto(target.href,{waitUntil:'networkidle0'});
 await page.waitForFunction(()=>window.__engineLab&&document.querySelector('#ecu-enable'));
 check('EFI mounts with Rust and is opt-in',await page.evaluate(()=>window.__engineLab.getBackend()==='rust-wasm-v3'&&!window.__engineLab.getPhysical().ecu.enabled&&!window.__engineLab.isRunning()));
 for(const[id,value]of [['propertyModel','nasa7-fixed-composition'],['heatTransferModel','woschni'],['airflowModel','valve-geometry']]){await expand(`#physical-${id}`);await page.select(`#physical-${id}`,value);}
 await input('#physical-sparkToSocDeg',8);await input('#physical-intakeCamRetardDeg',20);
 check('model-3 controls reach the native configuration and the Rust curve',await page.evaluate(()=>{const p=window.__engineLab.getPhysical();return p.propertyModel==='nasa7-fixed-composition'&&p.heatTransferModel==='woschni'&&p.airflowModel==='valve-geometry'&&p.sparkToSocDeg===8&&p.intakeCamRetardDeg===20&&!/requer Rust/.test(document.querySelector('#physical-potential').textContent);}));
 for(const[id,value]of [['propertyModel','air-standard'],['heatTransferModel','constant'],['airflowModel','ve-map-fit']])await page.select(`#physical-${id}`,value);
 await input('#physical-sparkToSocDeg',0);await input('#physical-intakeCamRetardDeg',0);
 await input('#ecu-enable',true);
 await waitEcu(()=>window.__engineLab.getPhysical().ecu.enabled);
 await input('#ecu-ethanol',50);
 await waitEcu(()=>window.__engineLab.getPhysical().ecu.fuel.ethanolVolumeFraction===.5);
 check('blend volume fraction reaches the actual native configuration',await page.evaluate(()=>window.__engineLab.getPhysical().ecu.fuel.ethanolVolumeFraction===.5));

 await page.select('#ecu-map-kind','fuelCorrection');
 const map=await page.$eval('#ecu-map-json',e=>JSON.parse(e.value));
 const literal='Synthetic <img src=x onerror="window.__ecuXss=1">';map.provenance.label=literal;
 await input('#ecu-map-json',JSON.stringify(map));await click('#ecu-map-apply');
 check('map provenance is displayed as literal text',await page.evaluate(label=>document.querySelector('#ecu-map-provenance').textContent.includes(label)&&!window.__ecuXss&&!document.querySelector('#ecu-map-provenance img'),literal));
 await input('#ecu-map-json',JSON.stringify({...map,pressureBar:[1,1]}));await click('#ecu-map-apply');
 check('malformed map cannot replace the accepted grid',await page.evaluate(()=>document.querySelector('#ecu-map-status').textContent.includes('não aplicado')&&window.__engineLab.getPhysical().ecu.fuelCorrectionMap.pressureBar[0]!==1));

 const csvPath=join(temporary,'synthetic-lambda.csv');
 await writeFile(csvPath,'\uFEFFid,capture_session_id,rpm,map_bar_abs,observed_lambda,target_lambda,applied_fuel_multiplier,steady,valid,split\ntrain-1,synthetic-train,2500,0.7,1.10,1,1,true,true,train\ntrain-2,synthetic-train,3000,0.8,1.08,1,1,true,true,train\nheld-1,synthetic-held,3500,0.9,1.09,1,1,true,true,validation\n');
 const inputHash=createHash('sha256').update(await readFile(csvPath)).digest('hex');
 await expand('#ecu-observation-file');await (await page.$('#ecu-observation-file')).uploadFile(csvPath);
 await page.waitForFunction(()=>document.querySelector('#ecu-observation-status').textContent.includes('synthetic-lambda.csv'));
 await input('#ecu-observation-source','Synthetic browser fixture; no engine measurement');await input('#ecu-observation-declared',true);
 await click('#ecu-fit-file');
 await page.waitForFunction(()=>!document.querySelector('#ecu-fit-apply').disabled,{timeout:60000});
 const fitted=await page.evaluate(()=>window.__engineLab.getEcuReport());
 check('worker fits observed lambda with full source/request and reports held-out limits',fitted?.kind==='fit'&&fitted.source?.fingerprint?.length===64&&fitted.source.inputFileSha256===inputHash&&fitted.request?.observations?.length===3&&fitted.result?.independentValidation===false);
 await input('#ecu-battery',13.1);await input('#ecu-search-budget',4);await click('#ecu-search');
 await page.waitForFunction(()=>window.__engineLab.getEcuReport()?.kind==='search'&&document.querySelector('#ecu-cancel').disabled,{timeout:60000});
 await click('#ecu-fit-apply');
 check('starting a search cannot make a stale fit applicable to changed actuator context',await page.$eval('#ecu-fit-apply',e=>e.disabled)&&await page.evaluate(()=>window.__engineLab.getPhysical().ecu.fuelCorrectionMap.values.every(r=>r.every(v=>v===1))));
 await click('#ecu-fit-file');await page.waitForFunction(()=>!document.querySelector('#ecu-fit-apply').disabled,{timeout:60000});await click('#ecu-fit-apply');
 check('reviewed fuel-correction proposal applies without rewriting target or VE',await page.evaluate(()=>{const c=window.__engineLab.getPhysical().ecu;return c.fuelCorrectionMap.values.some(r=>r.some(v=>v>1))&&c.lambdaTargetMap.values.every(r=>r.every(v=>v===1))&&c.veEstimateMap.values.every(r=>r.every(v=>v===.88));}));

 const malformed=join(temporary,'bad-lambda.csv');await writeFile(malformed,'rpm,map_bar_abs,observed_lambda\n3000,1,nope\n');await (await page.$('#ecu-observation-file')).uploadFile(malformed);
 await page.waitForFunction(()=>document.querySelector('#ecu-observation-status').textContent.includes('finitos'));
 check('invalid CSV clears previous fit eligibility',await page.$eval('#ecu-fit-apply',e=>e.disabled));

 await input('#ecu-search-budget',9);await click('#ecu-search');
 await page.waitForFunction(()=>window.__engineLab.getEcuReport()?.kind==='search'&&document.querySelector('#ecu-cancel').disabled,{timeout:60000});
 const search=await page.evaluate(()=>window.__engineLab.getEcuReport());
 check('bounded search exports actual candidates and respects its evaluation budget',search?.result?.candidates?.length>0&&search.result.candidates.length<=9&&search.request.physical.ecu.enabled&&search.result.candidates.every(c=>c.valid===false||Number.isFinite(c.torqueNm)));
 await input('#ecu-search-require-knock',true);await click('#ecu-search');
 await page.waitForFunction(()=>/unsupported|not available|not supported|evidence/i.test(document.querySelector('#ecu-search-status').textContent),{timeout:60000});
 check('required unsupported evidence fails instead of inventing a safe tune',await page.$eval('#ecu-search-status',e=>/knock/i.test(e.textContent)));
 await input('#ecu-search-require-knock',false);

 await page.select('#physical-mode','free');await input('#physical-throttle',35,'input');await click('#physical-enable');await click('#power');
 await waitEcu(()=>{const s=window.__engineLab.getPowertrainState();return window.__engineLab.isRunning()&&s.ecu?.elapsedSeconds>1&&s.ecu.deliveredFuelMassFlowKgs>0;});
 const live=await page.evaluate(()=>({state:window.__engineLab.getPowertrainState(),audio:window.__engineLab.getTelemetry()}));
 check('live Rust controller delivers fuel to the pressure model and audio worklet',live.state.ecu.requestedFuelMassFlowKgs>0&&live.state.ecu.injectedFuelMassFlowKgs>0&&Math.abs(live.state.ecu.fuelMassResidualKg)<1e-9&&live.audio.backend==='rust-wasm-v3'&&Number.isFinite(live.audio.physical?.cycleEnergyScale));
 await click('#ecu-capture');await new Promise(r=>setTimeout(r,800));await input('#ecu-battery',13.2);
 await page.waitForFunction(()=>document.querySelector('#ecu-capture-status').textContent.includes('configuração alterada'));
 check('capture stops rather than mixing observations from changed configurations',await page.$eval('#ecu-capture-status',e=>e.textContent.includes('configuração alterada')));
 await click('#power');
 await page.evaluate(()=>document.querySelector('#toast')?.classList.remove('show'));await page.$eval('#ecu-panel',e=>e.scrollIntoView());await page.screenshot({path:join(proof,'efi-si-desktop.png')});

 const beforeMode=await page.evaluate(()=>window.__engineLab.getConfig());
 await page.select('#ecu-combustion-mode','directInjectionDiesel');
 await waitEcu(()=>window.__engineLab.getPhysical().ecu.combustionMode==='directInjectionDiesel');
 check('explicit combustion-mode reset preserves geometry and clears PFI inventory',await page.evaluate(previous=>{const c=window.__engineLab.getConfig(),s=window.__engineLab.getPowertrainState();return JSON.stringify(c)===JSON.stringify(previous)&&s.ecu.wallFilmMassKg===0&&s.ecu.elapsedSeconds===0;},beforeMode));
 check('diesel exposes its own maps, hides inactive SI controls and blocks the SI inverse workflow',await page.evaluate(()=>document.querySelector('#ecu-ethanol').disabled&&document.querySelector('#ecu-ethanol').offsetParent===null&&document.querySelector('#ecu-feedback').disabled&&document.querySelector('#ecu-fit-file').disabled&&Array.from(document.querySelector('#ecu-map-kind').options).some(o=>o.value==='dieselInjectionAdvance')&&!Array.from(document.querySelector('#ecu-map-kind').options).some(o=>o.value==='sparkAdvance')));
 await click('#ecu-diesel-demo');
 await waitEcu(()=>window.__engineLab.getConfig().compression===16&&window.__engineLab.getConfig().redline===4500);
 check('only the explicit original diesel example changes compression and speed domain',await page.evaluate(()=>{const c=window.__engineLab.getConfig();return c.cylinders===4&&c.displacement===2&&c.compression===16&&c.redline===4500;}));
 await input('#physical-throttle',40,'input');await click('#power');
 await waitEcu(()=>{const s=window.__engineLab.getPowertrainState();return window.__engineLab.isRunning()&&s.ecu?.elapsedSeconds>.5&&s.ecu.deliveredFuelMassFlowKgs>0;});
 const dieselLive=await page.evaluate(()=>window.__engineLab.getPowertrainState());
 check('coupled diesel drives the live model with quantity, cylinder pressure head and prescribed phasing',dieselLive.ecu.combustionMode==='directInjectionDiesel'&&dieselLive.ecu.feedbackTrim===1&&dieselLive.ecu.wallFilmMassKg===0&&dieselLive.ecu.deliveredFuelMgPerCylinderCycle>0&&dieselLive.ecu.deltaPressurePa>0&&Number.isFinite(dieselLive.ecu.injectionAdvanceDeg)&&Number.isFinite(dieselLive.ecu.startOfCombustionDeg));
 await click('#power');
 await input('#ecu-search-rpm',2500);await input('#ecu-search-budget',9);await input('#ecu-search-diesel-quantity-min',5);await input('#ecu-search-diesel-quantity-max',25);await input('#ecu-search-injection-advance-min',3);await input('#ecu-search-injection-advance-max',18);await click('#ecu-search');
 await page.waitForFunction(()=>window.__engineLab.getEcuReport()?.result?.mode==='directInjectionDiesel'&&document.querySelector('#ecu-cancel').disabled,{timeout:60000});
 const ciSearch=await page.evaluate(()=>window.__engineLab.getEcuReport());
 check('diesel search evaluates quantity and SOI through its own actuator path',ciSearch.result.candidates.length>0&&ciSearch.result.candidates.length<=9&&ciSearch.result.candidates.some(c=>c.valid&&Number.isFinite(c.actualQuantityMg))&&ciSearch.result.candidates.every(c=>c.lambdaTarget===null&&c.sparkAdvanceDeg===null&&Number.isFinite(c.dieselQuantityMg)&&Number.isFinite(c.injectionAdvanceDeg))&&!Object.hasOwn(ciSearch.request.options,'lambdaBounds'));
 await click('#ecu-report-export');const exported=await downloaded('carlab-efi-review.json');
 check('diesel report retains the exact mode, request and all evaluated candidates',exported.context.physical.ecu.combustionMode==='directInjectionDiesel'&&exported.result.candidates.length===ciSearch.result.candidates.length&&exported.request.options.dieselQuantityMinMg===5);
 await input('#cycle-rpm',2500);await input('#cycle-throttle',50);await click('#cycle-analyze');
 await page.waitForFunction(()=>document.querySelector('#cycle-status').textContent.includes('Ciclo concluído'),{timeout:60000});
 const ciCycle=await page.evaluate(()=>window.__engineLab.latestCycle().cycle);
 check('compiled diesel cylinder cannot release heat before fuel arrival',ciCycle.config.fuelDeliveryDurationDeg>0&&ciCycle.trace.angleDeg.every((a,i)=>{const fraction=Math.max(0,Math.min(1,(a-ciCycle.config.fuelDeliveryStartDeg)/ciCycle.config.fuelDeliveryDurationDeg));return ciCycle.trace.heatReleaseJ[i]<=ciCycle.fuelEnergyJ*ciCycle.config.combustionEfficiency*fraction+1e-5;}));
 await page.evaluate(()=>document.querySelector('#toast')?.classList.remove('show'));await page.$eval('#ecu-panel',e=>e.scrollIntoView());await page.screenshot({path:join(proof,'efi-diesel-desktop.png')});
 await input('#library-name','EFI browser fixture');await click('#library-save');
 check('project revision retains complete ECU calibration',await page.evaluate(()=>JSON.parse(localStorage.getItem('carlab-engine-lab-library-v1')).projects[0].revisions[0].physical.ecu.enabled));
 await page.setViewport({width:390,height:844,deviceScaleFactor:1});await page.$eval('#ecu-panel',e=>e.scrollIntoView());
 check('EFI controls fit a mobile viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 await page.screenshot({path:join(proof,'efi-mobile.png')});
 check('local CSV and calibration workflows perform no uploads',uploads.length===0);
 check('compiled interface, workers and worklet have no errors',errors.length===0);
}catch(error){failure=error;await page?.screenshot({path:join(proof,'failure.png')}).catch(()=>{});}
finally{
 try{const result={host:hostname(),browser:browser?await browser.version().catch(()=>undefined):undefined,buildMode:'compiled-static',outDir,checks,errors,uploads,...(failure?{failure:String(failure)}:{}),scope:'Headless functional acceptance through lm-remote. Synthetic observations test workflow, not measured engine fidelity, safe calibration or performance.'};await writeFile(join(proof,'browser-check.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));}
 finally{try{await browser?.close();}finally{try{if(server)await new Promise(r=>server.httpServer.close(r));}finally{await rm(temporary,{recursive:true,force:true});}}}
}
if(failure)throw failure;
