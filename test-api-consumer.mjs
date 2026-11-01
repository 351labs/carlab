import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,readFile,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary=await mkdtemp(join(tmpdir(),'carlab-api-consumer-'));
const run=(command,args,cwd)=>{const result=spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(result.status,0,result.stderr||result.stdout);return result.stdout;};
try{
 const api=resolve('api'),packageJson=JSON.parse(await readFile(join(api,'package.json'),'utf8'));
 assert.equal(packageJson.dependencies,undefined,'web API has no npm runtime dependencies');
 run('npm',['pack','--ignore-scripts','--pack-destination',temporary],api);
 const archive=(await readdir(temporary)).find(name=>name.endsWith('.tgz'));assert.ok(archive);
 const consumer=join(temporary,'consumer'),moduleDir=join(consumer,'node_modules','@carlab','engine');await mkdir(moduleDir,{recursive:true});run('tar',['-xzf',join(temporary,archive),'--strip-components=1','-C',moduleDir],consumer);
 await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module'}));
 await writeFile(join(consumer,'consumer.ts'),`import {loadEngineLab,type EngineConfig,type PhysicalConfig} from '@carlab/engine';
export async function create(wasm:Uint8Array){
 const core=await loadEngineLab({wasm});
 const engine:Partial<EngineConfig>={cylinders:4,displacement:2};
 const physical:Partial<PhysicalConfig>={engineInertiaKgM2:.25};
 const model=core.createPowertrain(engine,physical);
 const state=model.stepMany({dt:1/240,steps:240,throttle:.6,gear:1});
 const synth=core.createSynth(engine,48000);synth.trigger('start');
 synth.setState({rpm:state.rpm,load:state.load,throttle:state.throttle,physical:state.physical},true);
 const left=new Float32Array(128),right=new Float32Array(128);synth.processStereo(left,right);
 const ecuConfig=core.normalizeEcuConfig(engine,{enabled:true});
 const controller=core.createEcuSession(engine,ecuConfig);controller.setConfigAndReset(ecuConfig);
 const dieselEngine={...engine,compression:16,redline:4500};
 const diesel=core.createPowertrain(dieselEngine,{ecu:core.normalizeEcuConfig(dieselEngine,{enabled:true,combustionMode:'directInjectionDiesel'})});
 const dieselState=diesel.stepMany({dt:1/240,steps:240,throttle:.4,gear:0});
 const result={rpm:state.rpm,backend:core.version.backend,frames:left.length,ecuResetTime:controller.getState().elapsedSeconds,dieselMode:dieselState.ecu?.combustionMode};core.dispose();return result;
}\n`);
 await writeFile(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'es2024',module:'NodeNext',moduleResolution:'NodeNext',lib:['es2024','DOM'],strict:true,skipLibCheck:false,outDir:'dist',types:[]},include:['consumer.ts']}));
 run(resolve('node_modules/.bin/tsc'),['-p',join(consumer,'tsconfig.json')],consumer);
 const {create}=await import(pathToFileURL(join(consumer,'dist','consumer.js')).href),wasm=new Uint8Array(await readFile(join(moduleDir,'dist','carlab_engine_lab.wasm'))),result=await create(wasm);
 assert.equal(result.backend,'rust');assert.ok(result.rpm>0);assert.equal(result.frames,128);
 assert.equal(result.ecuResetTime,0);assert.equal(result.dieselMode,'directInjectionDiesel');
 const entries=await readdir(join(moduleDir,'dist'));assert.ok(entries.includes('index.js')&&entries.includes('index.d.ts')&&entries.includes('types.d.ts'));
 console.log(JSON.stringify({check:'standalone packed TypeScript consumer',passed:true,npmRuntimeDependencies:0,...result}));
}finally{await rm(temporary,{recursive:true,force:true});}
