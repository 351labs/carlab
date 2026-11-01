/** Disposable acoustic listening experiment, not a production model change.
 * Execute through lm-remote; this script never edits the shipping DSP/presets.
 * Generated TS comes exclusively from this repository's current dsp.ts.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile,rename,realpath } from 'node:fs/promises';
import { dirname,resolve,relative,isAbsolute,sep } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { presets } from './presets.ts';
import { encodeWav } from './export.ts';

const labRoot=dirname(fileURLToPath(import.meta.url));
const repositoryRoot=labRoot;
const ignoredOutputRoot=resolve(labRoot,'output');
const sampleRate=48000,blockFrames=128,warmupFrames=72000,frames=192000;
const presetIds=['v8-crossplane','v12-classic','v12-highrev'];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const repoPath=path=>relative(repositoryRoot,path).split(sep).join('/');
const copy=value=>structuredClone(value);
const help=`Usage: node probe-timbre.mjs [--include-manual] [--source-ac] [--out PATH]\n\nRun through lm-remote. Default: 18 authoritative-physical takes, 3 original\npresets × warm idle/2500 RPM × baseline/deep-body/deep-body-single-tail.\nEach take is 4 seconds at 48 kHz after exactly 1.5 seconds of discarded warmup.\n--include-manual adds separately labelled artistic/manual diagnostic takes.\n--source-ac adds a separate baseline-geometry 18 Hz source-AC hypothesis.\n--out must stay inside output (default: timbre-prototypes).\nNo loudness normalization, final fades, physical solves or external media.\n`;
function argumentsForRun(){
 const args=process.argv.slice(2);let includeManual=false,sourceAc=false;
 let output=resolve(ignoredOutputRoot,'timbre-prototypes');
 for(let i=0;i<args.length;i++){
  if(args[i]==='--help'||args[i]==='-h'){process.stdout.write(help);return null;}
  if(args[i]==='--include-manual'){includeManual=true;continue;}
  if(args[i]==='--source-ac'){sourceAc=true;continue;}
  if(args[i]==='--out'){
   if(!args[i+1])throw new Error('--out requires a repository-relative or absolute path.');
   output=resolve(repositoryRoot,args[++i]);continue;
  }
  throw new Error(`Unknown argument ${args[i]}. Use --help.`);
 }
 const rel=relative(ignoredOutputRoot,output);
 if(!rel||rel.startsWith(`..${sep}`)||rel==='..'||isAbsolute(rel))throw new Error('--out must select a subdirectory of output.');
 return {includeManual,sourceAc,output};
}
function exactEdit(source,edit){
 const count=source.split(edit.before).length-1;
 assert.equal(count,1,`Source anchor must occur exactly once: ${edit.id}`);
 return source.replace(edit.before,edit.after);
}
function applyEdits(source,edits){return edits.reduce(exactEdit,source);}
const deepBodyEdits=[
 {id:'broaden-fundamental-mode',before:'const bodyQ = 2.6 + c.lowBody * (4.4 + (1 - c.damping) * 3.2);',after:'const bodyQ = 1.8 + c.lowBody * 2.2;'},
 {id:'broaden-main-mode-a',before:'this.bodyA.configure(chestHz, 2.1 + c.lowBody * 3.1, immediate);',after:'this.bodyA.configure(chestHz, 1.4 + c.lowBody * 1.8, immediate);'},
 {id:'broaden-main-mode-b',before:'this.bodyB.configure(chestHz * 1.08, 2 + c.lowBody * 2.8, immediate);',after:'this.bodyB.configure(chestHz * 1.08, 1.4 + c.lowBody * 1.8, immediate);'},
 {id:'fundamental-and-chest-weight-a',before:'const bodyA = this.bodyA.tick(bodyInputA) + this.bodyTailA.tick(bodyInputA) * 0.18;',after:'const bodyA = this.bodyA.tick(bodyInputA) * 0.75 + this.bodyTailA.tick(bodyInputA) * 0.65;'},
 {id:'fundamental-and-chest-weight-b',before:'const bodyB = this.bodyB.tick(bodyInputB) + this.bodyTailB.tick(bodyInputB) * 0.18;',after:'const bodyB = this.bodyB.tick(bodyInputB) * 0.75 + this.bodyTailB.tick(bodyInputB) * 0.65;'},
];
const singleTailEdit={
 id:'asymmetric-listening-transfer-before-mid-side',
 before:'const exhaustMid = (exhaustA + exhaustB) * (1 - p[BANK_PRESENCE]! * 0.22);',
 after:'// PROTOTYPE ONLY: a static listening transfer, not a firing/bank change.\n\t\t\texhaustA *= 1.5;\n\t\t\texhaustB *= 0.5;\n\t\t\tconst exhaustMid = (exhaustA + exhaustB) * (1 - p[BANK_PRESENCE]! * 0.22);',
};
const sourceAcEdits=[
 {id:'source-ac-state',before:'export class EngineDSP {',after:'export class EngineDSP {\n\tprivate prototypeSourceInA = 0;\n\tprivate prototypeSourceInB = 0;\n\tprivate prototypeSourceOutA = 0;\n\tprivate prototypeSourceOutB = 0;'},
 {id:'source-ac-pole',before:'const dt = 1 / sr;\n\t\tconst p = this.parameters;',after:'const dt = 1 / sr;\n\t\tconst prototypeSourceAcPole = Math.exp(-TAU * 18 / sr);\n\t\tconst p = this.parameters;'},
 {id:'source-ac-before-pipes',before:'\t\t\t// A passive pressure mix models the crossover junction.',after:'\t\t\t// PROTOTYPE ONLY: 18 Hz source DC blocker; unchanged firing and geometry.\n\t\t\tconst prototypeSourceA = bankA - this.prototypeSourceInA + prototypeSourceAcPole * this.prototypeSourceOutA;\n\t\t\tconst prototypeSourceB = bankB - this.prototypeSourceInB + prototypeSourceAcPole * this.prototypeSourceOutB;\n\t\t\tthis.prototypeSourceInA = bankA; this.prototypeSourceInB = bankB;\n\t\t\tthis.prototypeSourceOutA = prototypeSourceA; this.prototypeSourceOutB = prototypeSourceB;\n\t\t\tbankA = prototypeSourceA; bankB = prototypeSourceB;\n\t\t\t// A passive pressure mix models the crossover junction.'},
];
function variantsForRun(sourceAc){
 const variants=[
  {id:'baseline',label:'Current DSP · exact baseline',edits:[],diagnostic:false,interpretation:'Current acoustic transfer and existing preset parameters.'},
  {id:'deep-body',label:'Broader, deeper body',edits:deepBodyEdits,diagnostic:false,interpretation:'Artistic listening candidate: stronger pulse-driven fundamental, reduced chest weight and broader body modes. Not a measured collector response.'},
  {id:'deep-body-single-tail',label:'Deeper body · one outlet favoured',edits:[...deepBodyEdits,singleTailEdit],diagnostic:false,interpretation:'Same deeper-body candidate, plus static bank-A 1.5 / bank-B 0.5 listening weights before mid/side. This is a mic-like transfer, not different ignition, cylinders or pipe geometry.'},
 ];
 if(sourceAc)variants.push({id:'source-ac',label:'Source AC · diagnostic only',edits:sourceAcEdits,diagnostic:true,interpretation:'Unmeasured hypothesis: remove source DC with an 18 Hz high-pass before the unchanged baseline pipes/body. This is not combined with the deeper-body candidate and is not a shipping change.'});
 return variants;
}
function casesForPreset(config){
 // Explicit synthetic controls isolate timbre. These are neither an engine
 // measurement nor outputs from the pressure/thermal/ECU plant solvers.
 return [
  {id:'warm-idle',label:'Warm idle',rpm:config.idleRpm,load:0.18,throttle:0.08,
   physical:{boostBar:0,fuelCut:false,intakePressureBar:0.45,exhaustPressureBar:1.04,exhaustMassFlowKgs:0.014,exhaustTemperatureK:760,cycleEnergyScale:1,burnDurationScale:1,combustionPhaseDeg:0,residualFraction:0.08,cycleIndex:0}},
  {id:'2500-loaded',label:'2500 RPM · load 0.65',rpm:2500,load:0.65,throttle:0.65,
   physical:{boostBar:0,fuelCut:false,intakePressureBar:0.90,exhaustPressureBar:1.07,exhaustMassFlowKgs:0.065,exhaustTemperatureK:950,cycleEnergyScale:1,burnDurationScale:1,combustionPhaseDeg:0,residualFraction:0.05,cycleIndex:0}},
 ];
}
function processFrames(dsp,count,left,right,capture){
 const blockL=new Float32Array(blockFrames),blockR=new Float32Array(blockFrames);
 for(let frame=0;frame<count;frame+=blockFrames){
  const n=Math.min(blockFrames,count-frame);
  const l=n===blockFrames?blockL:blockL.subarray(0,n),r=n===blockFrames?blockR:blockR.subarray(0,n);
  dsp.process(l,r);
  if(capture){left.set(l,frame);right.set(r,frame);}
 }
}
function render(DSP,config,testCase,controlMode){
 const dsp=new DSP(sampleRate,copy(config));
 const physicalState=controlMode==='physical'?copy(testCase.physical):null;
 const state={rpm:testCase.rpm,load:testCase.load,throttle:testCase.throttle,physical:physicalState};
 dsp.setState(state,controlMode==='physical');dsp.trigger('start');
 processFrames(dsp,warmupFrames,null,null,false);
 const before=copy(dsp.getTelemetry()),characterBefore=copy(dsp.getCharacterTelemetry());
 const left=new Float32Array(frames),right=new Float32Array(frames);
 processFrames(dsp,frames,left,right,true);
 const telemetry=copy(dsp.getTelemetry()),characterAfter=copy(dsp.getCharacterTelemetry());
 let squareL=0,squareR=0,squareMono=0,sumL=0,sumR=0,peak=0;
 for(let i=0;i<frames;i++){
  const l=left[i],r=right[i];if(!Number.isFinite(l)||!Number.isFinite(r))throw new Error(`Nonfinite prototype sample at ${i}`);
  sumL+=l;sumR+=r;squareL+=l*l;squareR+=r*r;squareMono+=((l+r)*0.5)**2;peak=Math.max(peak,Math.abs(l),Math.abs(r));
 }
 assert.ok(peak>0&&peak<=1,'Prototype output must be non-silent and bounded before WAV quantization.');
 const counts={firingEvents:telemetry.firingEvents-before.firingEvents,combustionEvents:telemetry.combustionEvents-before.combustionEvents,warmupFiringEvents:before.firingEvents,warmupCombustionEvents:before.combustionEvents};
 const timing={warmupFrames,warmupSeconds:warmupFrames/sampleRate,analysisFrames:frames,analysisSeconds:frames/sampleRate,blockFrames,referenceEventHz:testCase.rpm*config.cylinders/120,referenceEvents:frames/sampleRate*testCase.rpm*config.cylinders/120,actualEventHz:counts.firingEvents/(frames/sampleRate),warmupTelemetry:before,characterBefore,characterAfter,pulse:copy(dsp.getPulseTelemetry())};
 return {left,right,telemetry,counts,timing,physicalState,metrics:{rms:Math.sqrt((squareL+squareR)/(frames*2)),peak,rmsL:Math.sqrt(squareL/frames),rmsR:Math.sqrt(squareR/frames),monoRms:Math.sqrt(squareMono/frames),meanL:sumL/frames,meanR:sumR/frames}};
}
function sampleBytes(array){return Buffer.from(array.buffer,array.byteOffset,array.byteLength);}
function clockIdentity(result){return {counts:result.counts,rpm:result.telemetry.rpm,load:result.telemetry.load,throttle:result.telemetry.throttle,firingHz:result.telemetry.firingHz,cycle:result.telemetry.cycle,limiter:result.telemetry.limiter,physical:result.telemetry.physical??null};}
async function run(options){
 const sourcePath=resolve(labRoot,'dsp.ts'),presetsPath=resolve(labRoot,'presets.ts');
 const originalSource=await readFile(sourcePath,'utf8'),presetSource=await readFile(presetsPath,'utf8');
 const originalHash=sha256(originalSource),presetsHash=sha256(presetSource);
 const presetsUri=pathToFileURL(presetsPath).href;
 const normalizerImport="import { normalizeConfig } from './presets.ts';";
 assert.equal(originalSource.split(normalizerImport).length-1,1,'The source must import exactly the original presets normalizer.');
 await mkdir(options.output,{recursive:true});
 const canonicalOutputRoot=await realpath(ignoredOutputRoot),canonicalOutput=await realpath(options.output);
 const canonicalRelative=relative(canonicalOutputRoot,canonicalOutput);
 assert.ok(canonicalRelative&&!isAbsolute(canonicalRelative)&&!canonicalRelative.startsWith(`..${sep}`)&&canonicalRelative!=='..','Output must remain inside the ignored lab output tree.');
 const moduleDirectory=resolve(options.output,'source'),rawDirectory=resolve(options.output,'raw');
 await mkdir(moduleDirectory,{recursive:true});await mkdir(rawDirectory,{recursive:true});
 const variants=variantsForRun(options.sourceAc),modules=new Map(),variantMetadata=[];
 for(const variant of variants){
  const canonical=applyEdits(originalSource,variant.edits);
  const generated=canonical.replace(normalizerImport,`import { normalizeConfig } from ${JSON.stringify(presetsUri)};`);
  const modulePath=resolve(moduleDirectory,`${variant.id}.ts`),diffPath=resolve(moduleDirectory,`${variant.id}.diff.json`);
  const diffDocument={schema:'carlab-source-prototype-edits-1',variant:variant.id,baseSourceSha256:originalHash,edits:variant.edits};
  await writeFile(modulePath,generated);await writeFile(diffPath,JSON.stringify(diffDocument,null,2)+'\n');
  const loaded=await import(pathToFileURL(modulePath).href+`?source=${sha256(generated)}`);
  assert.equal(typeof loaded.EngineDSP,'function',`Generated ${variant.id} module exposes EngineDSP.`);
  modules.set(variant.id,loaded.EngineDSP);
  variantMetadata.push({id:variant.id,label:variant.label,diagnostic:variant.diagnostic,interpretation:variant.interpretation,sourcePath:repoPath(modulePath),sourceSha256:sha256(generated),canonicalSourceSha256:sha256(canonical),diffPath:repoPath(diffPath),diffSha256:sha256(JSON.stringify(diffDocument)),changes:variant.edits.map(edit=>({id:edit.id,before:edit.before,after:edit.after}))});
 }
 assert.equal(variantMetadata[0].canonicalSourceSha256,originalHash,'Baseline has no acoustic source edit.');
 const OriginalDSP=(await import(pathToFileURL(sourcePath).href)).EngineDSP;
 const rows=[],baselineVerification=[],clockChecks=[];
 const modes=options.includeManual?['physical','manual']:['physical'];
 for(const presetId of presetIds){
  const preset=presets.find(item=>item.id===presetId);assert.ok(preset,`Existing preset is available: ${presetId}`);
  const config=copy(preset.config);
  for(const testCase of casesForPreset(config))for(const controlMode of modes){
   let baseline;
   for(const variant of variants){
    const rendered=render(modules.get(variant.id),config,testCase,controlMode);
    if(variant.id==='baseline'){
     baseline=clockIdentity(rendered);
     const original=render(OriginalDSP,config,testCase,controlMode);
     assert.ok(sampleBytes(original.left).equals(sampleBytes(rendered.left))&&sampleBytes(original.right).equals(sampleBytes(rendered.right)),`Generated baseline exactly matches current DSP samples: ${presetId}/${testCase.id}/${controlMode}`);
     assert.deepEqual(clockIdentity(original),baseline);
     baselineVerification.push({preset:presetId,case:testCase.id,controlMode,exactFloat32Samples:true,exactClock:true});
    }else{
     assert.deepEqual(clockIdentity(rendered),baseline,`Acoustic variant must preserve firing/combustion clock and supplied mean state: ${variant.id}`);
     clockChecks.push({preset:presetId,case:testCase.id,controlMode,variant:variant.id,exactClockAndMeanState:true});
    }
    const id=`${presetId}--${testCase.id}--${controlMode}--${variant.id}`;
    const rawFile=resolve(rawDirectory,`${id}.wav`),pcm=encodeWav(rendered.left,rendered.right,sampleRate);
    await writeFile(rawFile,pcm);
    rows.push({id,preset:presetId,presetLabel:preset.name,case:testCase.id,caseLabel:testCase.label,variant:variant.id,controlMode,rpm:testCase.rpm,load:testCase.load,throttle:testCase.throttle,sampleRate,rawPath:repoPath(rawFile),frames,channels:2,encoding:'PCM16LE-stereo-WAV',pcmSha256:sha256(pcm),telemetry:rendered.telemetry,config:copy(config),physicalState:rendered.physicalState,metrics:rendered.metrics,rawRms:rendered.metrics.rms,rawPeak:rendered.metrics.peak,counts:rendered.counts,timing:rendered.timing});
   }
  }
 }
 assert.equal(sha256(await readFile(sourcePath)),originalHash,'Production DSP source remained unchanged during rendering.');
 assert.equal(sha256(await readFile(presetsPath)),presetsHash,'Production presets remained unchanged during rendering.');
 const manifest={
  schema:'carlab-timbre-prototypes-1',pathBase:'repository',
  source:{path:repoPath(sourcePath),sha256:originalHash,presetsPath:repoPath(presetsPath),presetsSha256:presetsHash,normalizerImportUri:presetsUri,generatedImportNote:'Generated modules use the original absolute file URL. Their source hashes are checkout-path dependent; canonicalSourceSha256 and diffSha256 describe the portable source recipe.'},
  render:{sampleRate,channels:2,encoding:'PCM16LE-stereo-WAV',blockFrames,warmupFrames,warmupSeconds:warmupFrames/sampleRate,frames,seconds:frames/sampleRate,warmupIncludedInWav:false,edgeFade:false,levelNormalization:false,physicalSolverCalls:0,includesManualDiagnostic:options.includeManual,includesSourceAcDiagnostic:options.sourceAc},
  controls:{provenance:'assumed synthetic listening controls, not measured engine states',physical:'The same explicit boost/fuel-cut/MAP/exhaust pressure/mass flow/gas temperature/energy/duration/phase/residual/index is held across variants for each case. cycleIndex stays fixed as a control packet; it is not a replay or cycle-resolved plant solve.',manual:'Optional diagnostic only: actualRpm=false and physical=null; the current manual/artistic response and variation remain active.',variants:'Only source-derived acoustic modal weights/Q and optional listening-transfer/source-AC terms differ. All preset geometry, source gains, ignition, limiter, fuelCut and control packets remain unchanged.'},
  variants:variantMetadata,verification:{baselineVerification,clockChecks,productionSourceUnchanged:true,productionPresetsUnchanged:true},rows,
  limitations:['These are controlled artistic prototypes, not fitted or measured engine transfer functions.','Raw levels differ. Compare constant-gain level-matched copies before choosing a timbre.','Raw analysis WAVs have no edge fades; player click-free audition should apply its own short playback envelope.','No physical solver, commercial media, external code, reference download or shipping DSP edit is involved.'],
 };
 const manifestPath=resolve(options.output,'manifest.json'),temporary=resolve(options.output,'manifest.pending.json');
 await writeFile(temporary,JSON.stringify(manifest,null,2)+'\n');await rename(temporary,manifestPath);
 process.stdout.write(JSON.stringify({manifest:repoPath(manifestPath),rows:rows.length,variants:variantMetadata.map(v=>v.id),controlModes:modes,sampleRate,frames,warmupFrames,baselineFloat32Checks:baselineVerification.length,clockChecks:clockChecks.length,productionSourceUnchanged:true},null,2)+'\n');
}
const options=argumentsForRun();if(options)await run(options);
