// Focused headless check of the experimental listening page; lm-remote only.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir,writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
const url=process.argv[2]??process.env.ENGINE_LAB_TIMBRE_URL??'http://127.0.0.1:4173/timbre/';
const executablePath=process.env.CHROME_PATH??['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'].find(existsSync);
const browser=await puppeteer.launch({executablePath,headless:true,acceptInsecureCerts:true,args:['--mute-audio','--autoplay-policy=no-user-gesture-required']});
const checks=[],errors=[],uploads=[];
const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);};
try{
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))uploads.push({method:r.method(),url:r.url()});});
 await page.setViewport({width:1400,height:1050});const response=await page.goto(url,{waitUntil:'networkidle0',timeout:25000});
 check('listening page is served in a secure context',response.status()===200&&await page.evaluate(()=>window.isSecureContext));
 check('three original voices and two operating cases are selectable',await page.evaluate(()=>document.querySelector('#preset').options.length===3&&document.querySelector('#case').options.length===2));
 check('three primary alternatives are separate from source-AC diagnostic',await page.evaluate(()=>document.querySelectorAll('#cards article').length===3&&document.querySelectorAll('#diagnostic-cards article').length===1));
 const paths=await page.$$eval('#cards audio',els=>els.map(e=>e.src));
 check('primary recordings have distinct files',new Set(paths).size===3);
 await page.$eval('#cards audio',a=>a.play());await page.waitForFunction(()=>document.querySelector('#cards audio').currentTime>.15,{timeout:10000});
 check('matched WAV decodes and actually plays',await page.$eval('#cards audio',a=>a.duration>3.99&&a.duration<4.01&&a.error===null));
 await page.$$eval('#cards audio',els=>els[1].play());
 check('starting an alternative pauses the previous recording',await page.$$eval('#cards audio',els=>els[0].paused&&!els[1].paused));
 await page.select('#preset','v12-classic');
 check('classic V12 has its own recordings',await page.$eval('#cards audio',a=>a.src.includes('v12-classic')));
 const loadedValue=await page.$$eval('#case option',els=>els.find(e=>e.value.includes('2500')).value);await page.select('#case',loadedValue);
 check('loaded comparison retains fixed 2500 RPM condition',await page.$eval('#condition',e=>e.textContent.includes('2.500')));
 const proof=process.env.ENGINE_LAB_PROOF??'docs/timbre/proof';await mkdir(proof,{recursive:true});await page.screenshot({path:`${proof}/listening-desktop.png`,fullPage:true});
 await page.setViewport({width:390,height:844});
 check('mobile page has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
 await page.screenshot({path:`${proof}/listening-mobile.png`,fullPage:true});
 check('page reports no script errors or uploads',errors.length===0&&uploads.length===0);
 const result={url,browser:await browser.version(),checks,errors,uploads,scope:'Headless listening UI/decoding checks; not a human timbre rating or real-engine fidelity validation.'};
 await writeFile(`${proof}/browser-check.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await browser.close();}
