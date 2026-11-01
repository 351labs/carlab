import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir,hostname } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { preview } from 'vite';
import puppeteer from 'puppeteer-core';

// Run through lm-remote --gpu --lab after the coordinating static build. This
// checks compiled workers and actual interface actions; it is not a benchmark.
const proof=process.env.ENGINE_LAB_PROOF??'docs/proof/v4';
const outDir=process.env.ENGINE_LAB_DIST??'dist/client';
await mkdir(proof,{recursive:true});
const temporary=await mkdtemp(join(tmpdir(),'carlab-v4-browser-'));
const checks=[],errors=[],uploads=[];
let server,browser,page,failure;
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
async function downloaded(name){
 for(let attempt=0;attempt<100;attempt++){
  try{return JSON.parse(await readFile(join(temporary,name),'utf8'));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 throw new Error(`JSON download did not complete: ${name}`);
}
async function expand(selector){await page.$eval(selector,e=>{for(let p=e.parentElement;p;p=p.parentElement)if(p instanceof HTMLDetailsElement)p.open=true;});}
async function input(selector,value,event='change'){
 await expand(selector);
 await page.$eval(selector,(e,args)=>{e.value=String(args.value);e.dispatchEvent(new Event(args.event,{bubbles:true}));},{value,event});
}
async function screenshot(name,selector){await page.$eval(selector,e=>e.scrollIntoView({block:'start'}));await page.screenshot({path:join(proof,name)});}
try{
 server=await preview({configFile:'preview.config.ts',build:{outDir},preview:{host:'127.0.0.1',port:0,strictPort:false}});
 const port=server.httpServer.address().port;
 const executablePath=process.env.CHROME_PATH??['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'].find(existsSync);
 assert.ok(executablePath,'Chrome executable is available to the headless runner');
 browser=await puppeteer.launch({executablePath,headless:true,args:['--mute-audio','--disable-background-timer-throttling','--autoplay-policy=user-gesture-required']});
 page=await browser.newPage();await page.setViewport({width:1440,height:1050,deviceScaleFactor:1});
 const cdp=await page.createCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:temporary});
 page.on('pageerror',error=>errors.push(String(error)));
 page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 page.on('request',request=>{if(!['GET','HEAD'].includes(request.method()))uploads.push(request.url());});
 await page.goto(`http://127.0.0.1:${port}/${process.env.ENGINE_LAB_QUERY??'?mode=scholar&lang=pt'}`,{waitUntil:'networkidle0'});
 await page.waitForFunction(()=>window.__engineLab&&document.querySelector('#thermal-history')&&document.querySelector('#cycle-analyze'));
 if(process.env.ENGINE_LAB_EXPECT_BACKEND)check('main thread uses the requested computation backend',await page.evaluate(expected=>window.__engineLab.getBackend()===expected,process.env.ENGINE_LAB_EXPECT_BACKEND));
 check('compiled cycle and thermal panels mount without starting audio',await page.evaluate(()=>['cycle-panel','thermal-panel'].every(id=>document.getElementById(id)?.children.length>0)&&!window.__engineLab.isRunning()));
 check('material resistance starts unknown without a supplied card',await page.evaluate(()=>window.__engineLab.getPhysical().materialScreen.material===null&&document.querySelector('#material-card-status').textContent.includes('Nenhuma ficha')));

 await input('#cycle-rpm',3000);await input('#cycle-throttle',60);await page.click('#cycle-analyze');
 await page.waitForFunction(()=>!document.querySelector('#cycle-download').disabled&&document.querySelector('#cycle-status').textContent.includes('Ciclo concluído'),{timeout:60000});
 await page.click('#cycle-download');
 const cycleReport=await downloaded('carlab-cycle-analysis.json'),trace=cycleReport.cycle?.trace;
 check('compiled analysis worker produces a finite 720-degree pressure cycle',trace?.angleDeg?.[0]===0&&trace.angleDeg.at(-1)===720&&trace.pressurePa.length===trace.angleDeg.length&&trace.pressurePa.every(p=>Number.isFinite(p)&&p>0)&&Number.isFinite(cycleReport.cycle.energyBalanceResidualJ));
 const views=[];
 for(const view of ['pressure','pv','temperature','flow','heat']){
  await page.click(`[data-cycle-view="${view}"]`);
  check(`cycle ${view} view switches and draws`,await page.$eval(`[data-cycle-view="${view}"]`,e=>e.classList.contains('active')));
  views.push(await page.$eval('#cycle-plot',e=>e.toDataURL()));
 }
 check('cycle views render distinct data rather than one reused plot',new Set(views).size===views.length);
 await page.waitForFunction(()=>document.querySelector('#material-review').textContent.includes('Sem ficha de material fornecida'),{timeout:5000});
 await page.click('#thermal-export');
 const unknownReport=await downloaded('carlab-thermal-material-review.json');
 check('nominal loads are available while unsupported resistance and fatigue stay not evaluated',unknownReport.mechanicalResult?.status==='not-evaluated'&&unknownReport.mechanicalResult.fatigue.status==='not-evaluated'&&unknownReport.materialScreen.material===null&&unknownReport.mechanicalResult.trace.stressMPa.length===trace.angleDeg.length);

 const pressurePath=join(temporary,'synthetic-pressure.csv');
 // The observation is explicitly generated by this same model, not measured.
 await writeFile(pressurePath,'angle_deg,pressure_bar_abs\n'+trace.angleDeg.map((a,i)=>`${a},${trace.pressurePa[i]/1e5}`).join('\n'));
 await expand('#pressure-file');await (await page.$('#pressure-file')).uploadFile(pressurePath);
 await page.waitForFunction(()=>document.querySelector('#pressure-status').textContent.includes('synthetic-pressure.csv')&&!document.querySelector('#pressure-fit').disabled);
 check('local instrument CSV enters the pressure workflow with an explicit origin',await page.$eval('#pressure-status',e=>e.textContent.includes('pressão absoluta')));
 await input('#pressure-source','Synthetic self-model fixture / original condition');
 await page.evaluate(()=>{document.querySelector('#pressure-fit').click();document.querySelector('#pressure-source').value='Changed label while worker runs';});
 await page.waitForFunction(()=>!document.querySelector('#pressure-apply').disabled&&document.querySelector('#cycle-status').textContent.includes('Busca limitada concluída'),{timeout:60000});
 check('bounded burn fit completes with synthetic pressure without claiming independent validation',await page.$eval('#pressure-status',e=>e.textContent.includes('não houve validação independente')));
 await input('#physical-sparkAdvanceDeg',19);
 await page.click('#pressure-apply');
 check('a fit prepared for an older physical configuration cannot be applied',await page.$eval('#pressure-apply',e=>e.disabled)&&await page.evaluate(()=>!window.__engineLab.getPhysical().cycleCalibration));
 await input('#pressure-source','Synthetic self-model fixture / refit');await page.click('#pressure-fit');
 await page.waitForFunction(()=>!document.querySelector('#pressure-apply').disabled,{timeout:60000});await page.click('#pressure-apply');
 check('applied fit retains explicit local source hash, origin and original condition',await page.evaluate(()=>{const c=window.__engineLab.getPhysical().cycleCalibration;return c?.source==='Synthetic self-model fixture / refit'&&c.angleOrigin==='intake-tdc'&&/^[a-f0-9]{64}$/.test(c.referenceHash)&&c.rpm===3000&&c.throttle===.6&&c.method==='bounded-grid'&&Number.isFinite(c.rmseBar);}));
 const malformedPressure=join(temporary,'invalid-pressure.csv');await writeFile(malformedPressure,'angle_deg,pressure_bar_abs\n0,1\n0,2\n');
 await (await page.$('#pressure-file')).uploadFile(malformedPressure);
 await page.waitForFunction(()=>document.querySelector('#pressure-fit').disabled&&document.querySelector('#pressure-status').textContent.includes('12 a 2.000'));
 check('malformed pressure data clears the previous fit eligibility',await page.$eval('#pressure-apply',e=>e.disabled));

 const nominal=unknownReport.mechanicalResult,amplitude=nominal.stressAmplitudeMPa;
 check('cycle supplies a usable nonzero nominal loading envelope',Number.isFinite(amplitude)&&amplitude>0&&Number.isFinite(nominal.stressRatio));
 const material={schema:1,name:'Ficha <img src=x onerror="window.__materialXss=1">',provenance:{kind:'assumed',source:'Synthetic browser fixture <b>literal</b>; no real alloy data',conditions:'Nominal axial envelope; interface verification only'},allowableStressMPa:[{temperatureK:300,value:1},{temperatureK:500,value:1}],fatigueCurves:[{temperatureK:373.15,temperatureToleranceK:0,stressRatio:nominal.stressRatio,stressRatioTolerance:1e-8,conditions:'Synthetic S-N points for this browser check only',points:[{stressAmplitudeMPa:amplitude/2,cycles:1e6},{stressAmplitudeMPa:amplitude*2,cycles:1e4}]}]};
 await input('#material-json',JSON.stringify(material));await page.click('#material-apply');
 await page.waitForFunction(()=>window.__engineLab.getPhysical().materialScreen.material?.name.startsWith('Ficha <img'));
 check('material names and sources remain literal text without markup execution',await page.evaluate(()=>!window.__materialXss&&!document.querySelector('#material-review img')&&!document.querySelector('#material-card-status b')&&document.querySelector('#material-review strong').textContent.includes('<img')));
 await input('#material-durationSeconds',30);await input('#material-cyclesPerEngineCycle',2);
 await page.waitForFunction(()=>document.querySelector('#material-review').textContent.includes('Curva S–N compatível fornecida'));
 const validMaterial=await page.evaluate(()=>window.__engineLab.getPhysical().materialScreen.material);
 await input('#material-json','{"schema":1,"name":"Missing provenance"}');await page.click('#material-apply');
 check('invalid material import preserves the last valid evidence card',await page.evaluate(expected=>JSON.stringify(window.__engineLab.getPhysical().materialScreen.material)===JSON.stringify(expected),validMaterial));

 const materialPath=join(temporary,'supplied-material.json');await writeFile(materialPath,JSON.stringify({...material,name:'Ficha importada localmente'}));
 await (await page.$('#material-file')).uploadFile(materialPath);
 await page.waitForFunction(()=>window.__engineLab.getPhysical().materialScreen.material?.name==='Ficha importada localmente');
 check('a local material JSON applies through the file import boundary',await page.$eval('#material-card-status',e=>e.textContent.includes('Ficha importada localmente')));

 const veMap={schema:'carlab-calibration-map-1',kind:'ve',rpm:[600,8000],pressureBar:[.1,3],values:[[.7,.8],[.85,.95]],axisUnits:{rpm:'rpm',pressure:'bar-absolute'},valueUnit:'fraction',extrapolation:'clamp',provenance:{source:'assumed',label:'Bancada <b>literal</b>',version:'synthetic-browser-1',notes:'Original synthetic fixture; no measured calibration'}};
 await input('#physical-ve-map-json',JSON.stringify(veMap));await page.click('#physical-ve-map-apply');
 await page.waitForFunction(()=>window.__engineLab.getPhysical().veMap.provenance.version==='synthetic-browser-1');
 check('VE map editor preserves axes, values and declared provenance',await page.evaluate(expected=>{const map=window.__engineLab.getPhysical().veMap;return JSON.stringify(map.values)===JSON.stringify(expected.values)&&JSON.stringify(map.rpm)===JSON.stringify(expected.rpm)&&document.querySelector('#physical-ve-map-provenance').textContent.includes('<b>literal</b>')&&!document.querySelector('#physical-ve-map-provenance b');},veMap));
 await input('#physical-ve-map-json',JSON.stringify({...veMap,pressureBar:[1,1]}));await page.click('#physical-ve-map-apply');
 check('malformed VE grid cannot replace the last valid map',await page.evaluate(()=>window.__engineLab.getPhysical().veMap.provenance.version==='synthetic-browser-1'&&window.__engineLab.getPhysical().veMap.pressureBar[0]===.1));
 await input('#thermal-wallHeatCapacityJK',31000);await input('#thermal-source','Original browser assumptions; no calibration claim');
 await page.$eval('#library-name',e=>e.value='Hipóteses térmicas / materiais v4');await page.click('#library-save');
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('carlab-engine-lab-library-v1')).projects[0].revisions[0].physical);
 check('library snapshot persists nested map, thermal and material evidence',saved?.thermal?.wallHeatCapacityJK===31000&&saved.materialScreen?.durationSeconds===30&&saved.materialScreen.material?.name==='Ficha importada localmente'&&saved.veMap?.provenance.version==='synthetic-browser-1');
 await page.click('#material-clear');await input('#thermal-wallHeatCapacityJK',22000);await page.click('#physical-ve-map-generate');await page.click('#library-load');
 check('loading a library revision restores all three physical evidence domains',await page.evaluate(()=>{const p=window.__engineLab.getPhysical();return p.thermal.wallHeatCapacityJK===31000&&p.materialScreen.material?.name==='Ficha importada localmente'&&p.veMap.provenance.version==='synthetic-browser-1';}));

 await page.select('#physical-mode','free');await input('#physical-throttle',35,'input');await page.click('#physical-enable');await page.click('#power');
 await page.waitForFunction(()=>{const s=window.__engineLab.getPowertrainState();return window.__engineLab.isRunning()&&s.thermal?.elapsedSeconds>1&&Math.abs(s.thermal.cumulativeInputJ)>0;},{timeout:20000});
 await page.waitForFunction(()=>{const p=window.__engineLab.getTelemetry().physical;return p&&Number.isFinite(p.exhaustMassFlowKgs)&&p.intakePressureBar>0;},{timeout:5000});
 if(process.env.ENGINE_LAB_EXPECT_BACKEND)check('audio worklet uses the requested computation backend',await page.evaluate(expected=>window.__engineLab.getTelemetry().backend===expected,process.env.ENGINE_LAB_EXPECT_BACKEND));
 check('live audio worklet receives the shared physical gas and combustion state',await page.evaluate(()=>{const p=window.__engineLab.getTelemetry().physical,s=window.__engineLab.getPowertrainState().physical;return p&&Number.isFinite(p.exhaustTemperatureK)&&p.exhaustTemperatureK>0&&typeof p.fuelCut==='boolean'&&Number.isFinite(p.cycleEnergyScale)&&Math.abs(p.boostBar-s.boostBar)<.02;}));
 const thermal=await page.evaluate(()=>window.__engineLab.getPowertrainState().thermal);
 check('actual physical execution updates four thermal states with a conserved ledger',['wallTemperatureK','coolantTemperatureK','oilTemperatureK','exhaustWallTemperatureK'].every(k=>Number.isFinite(thermal[k])&&thermal[k]>0)&&Math.abs(thermal.energyResidualJ)<Math.max(.001,Math.abs(thermal.cumulativeInputJ)*1e-8)&&thermal.status==='unvalidated-lumped-model');
 check('gas and exhaust metal remain separate state quantities',Number.isFinite(thermal.exhaustGasTemperatureK)&&Math.abs(thermal.exhaustGasTemperatureK-thermal.exhaustWallTemperatureK)>1&&Number.isFinite(thermal.exhaustGasToWallHeatW));
 await page.waitForFunction(()=>document.querySelector('#thermal-energy-ledger').textContent.includes('resíduo'));
 await page.click('#power');
 await rm(join(temporary,'carlab-thermal-material-review.json'),{force:true});await page.click('#thermal-export');
 const suppliedReport=await downloaded('carlab-thermal-material-review.json');
 check('analysis export records hypotheses and conditional fatigue without a safe-life claim',suppliedReport.mechanicalInput.rpm===3000&&suppliedReport.mechanicalInput.angleDeg.length===trace.angleDeg.length&&suppliedReport.thermalConfig.wallHeatCapacityJK===31000&&suppliedReport.materialScreen.durationSeconds===30&&suppliedReport.mechanicalResult?.fatigue?.status==='evaluated'&&Math.abs(suppliedReport.mechanicalResult.fatigue.appliedEnvelopeCycles-1500)<1e-8&&suppliedReport.thermalState.elapsedSeconds>0&&suppliedReport.limits.includes('No FEM'));
 await page.click('[data-cycle-view="pressure"]');await page.click('#cycle-analyze');await page.waitForFunction(()=>document.querySelector('#cycle-status').textContent.includes('Ciclo concluído'),{timeout:60000});
 await screenshot('cycle-desktop.png','#cycle-panel');await screenshot('thermal-desktop.png','#thermal-panel');
 await page.setViewport({width:390,height:844,deviceScaleFactor:1});
 await page.$eval('#thermal-panel',e=>e.scrollIntoView());
 check('expanded thermal, material and map controls fit a mobile viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 await screenshot('thermal-mobile.png','#thermal-panel');
 check('local evidence imports send no upload requests',uploads.length===0);
 check('no compiled browser or audio-worklet errors',errors.length===0);
}catch(error){failure=error;await page?.screenshot({path:join(proof,'failure.png')}).catch(()=>{});}
finally{
 try{
  const result={host:hostname(),browser:browser?await browser.version().catch(()=>undefined):undefined,buildMode:'compiled-static',outDir,checks,errors,uploads,...(failure?{failure:String(failure)}:{}),scope:'Headless functional checks through lm-remote. Synthetic pressure/material/map fixtures verify workflows, not engine fidelity, real material safety or reference performance.'};
  await writeFile(join(proof,'browser-check.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
 }finally{
  try{await browser?.close();}
  finally{try{if(server)await new Promise(resolve=>server.httpServer.close(resolve));}finally{await rm(temporary,{recursive:true,force:true});}}
 }
}
if(failure)throw failure;
