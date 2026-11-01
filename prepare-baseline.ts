/** Render comparison inputs from an explicitly supplied historical source fixture. */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const fixture=process.env.ENGINE_LAB_COMPARISON_BASELINE;
if(!fixture)throw new Error('Set ENGINE_LAB_COMPARISON_BASELINE to a directory containing the historical DSP, presets, offline, export and render sources. Provenance must be verified independently.');
const directory='output/baseline-v1',raw='output/comparison/raw/before';
await mkdir(directory,{recursive:true});
const sourceHashes:Record<string,string>={};
for(const name of ['dsp.ts','presets.ts','offline.ts','export.ts','render.ts']){
 const source=await readFile(join(resolve(fixture),name));
 sourceHashes[name]=createHash('sha256').update(source).digest('hex');
 await writeFile(join(directory,name),source);
}
const baseline={source:'user-supplied fixture',provenance:'not independently verified by this script',sourceHashes};
await writeFile(join(directory,'source.json'),JSON.stringify(baseline,null,2)+'\n');
for(const [id,preset,scenario] of [
 ['v12-steady','v12-highrev','steady'],['v12-idle','v12-highrev','idle'],
 ['v10-steady','v10-5','steady'],['v10-idle','v10-5','idle'],
]){
 const args=[join(directory,'render.ts'),'--preset',preset,'--scenario',scenario,'--duration','6','--out',join(raw,id)];
 if(scenario==='steady')args.push('--rpm','3000','--load','0.6','--throttle','0.6');
 execFileSync(process.execPath,args,{stdio:'inherit'});
}
console.log(JSON.stringify({baseline,beforeCaptures:4,raw},null,2));
