/** Headless bake entry point. No browser, audio device, network or game server. */
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { presets, normalizeConfig } from './presets.ts';
import { renderClip, renderBank, renderStemSet, contentKeySource, MODEL_VERSION, type Scenario } from './offline.ts';
import { encodeWav, zipFiles } from './export.ts';

const {values}=parseArgs({options:{preset:{type:'string',default:'i4-na-2'},config:{type:'string'},scenario:{type:'string',default:'rev'},duration:{type:'string',default:'12'},rpm:{type:'string'},load:{type:'string'},throttle:{type:'string'},out:{type:'string',default:'output'},bank:{type:'boolean',default:false},stems:{type:'boolean',default:false},help:{type:'boolean',default:false}}});
if(values.help){console.log('node render.ts [--preset ID | --config FILE] [--scenario idle|rev|drive|steady|overrun] [--duration 12] [--rpm 4000 --load 0.8 --throttle 0.6] [--bank | --stems] [--out DIR]\nPresets: '+presets.map(p=>p.id).join(', '));process.exit(0);}
if(values.bank&&values.stems)throw new Error('Choose --bank or --stems.');
const preset=presets.find(p=>p.id===values.preset);
if(!preset)throw new Error('Unknown preset. Use --help to list original instruments.');
const imported=values.config?JSON.parse(await readFile(resolve(values.config),'utf8')):undefined;
const config=normalizeConfig(imported?(imported.config??imported):preset.config);
const scenario=values.scenario as Scenario;
if(!['idle','rev','drive','steady','overrun'].includes(scenario))throw new Error('Unknown scenario.');
const options={scenario,duration:Number(values.duration),sampleRate:48000,rpm:values.rpm?Number(values.rpm):undefined,load:values.load?Number(values.load):undefined,throttle:values.throttle?Number(values.throttle):undefined};
if(!Number.isFinite(options.duration)||options.duration<=0||options.duration>30)throw new Error('Duration must be >0 and <=30 seconds.');
if(options.rpm!==undefined&&!Number.isFinite(options.rpm))throw new Error('RPM must be finite.');
if(options.load!==undefined&&(!Number.isFinite(options.load)||options.load<0||options.load>1))throw new Error('Load must be between0 and1.');
if(options.throttle!==undefined&&(!Number.isFinite(options.throttle)||options.throttle<0||options.throttle>1))throw new Error('Throttle must be between0 and1.');
const key=createHash('sha256').update(contentKeySource(config,options,values.bank?'bank':values.stems?'stems':'clip')).digest('hex');
const out=resolve(values.out);await mkdir(out,{recursive:true});
if(values.bank){const bank=renderBank(config);await writeFile(join(out,`${key.slice(0,16)}-bank.zip`),zipFiles(bank.files));console.log(JSON.stringify({model:MODEL_VERSION,key,output:out,...bank.stats},null,2));}
else if(values.stems){const stems=renderStemSet(config,options);await writeFile(join(out,`${key.slice(0,16)}-stems.zip`),zipFiles(stems.files));console.log(JSON.stringify({model:MODEL_VERSION,key,output:out,...stems.stats},null,2));}
else{const clip=renderClip(config,options);const name=`${values.preset}-${scenario}.wav`;await writeFile(join(out,name),encodeWav(clip.left,clip.right,clip.sampleRate));await writeFile(join(out,`${values.preset}-${scenario}.json`),JSON.stringify({model:MODEL_VERSION,key,config,options,frames:clip.left.length,peak:clip.peak,rms:clip.rms},null,2));console.log(JSON.stringify({model:MODEL_VERSION,key,file:join(out,name),frames:clip.left.length,peak:clip.peak,rms:clip.rms},null,2));}
