import { fileURLToPath } from 'node:url';
import { resolve,dirname } from 'node:path';
import { access,copyFile,mkdir,rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { generateThirdPartyNotices } from '../native/third-party.mjs';
const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'..'),wasm=resolve(here,'../native/dist/carlab_engine_lab.wasm');
try{await access(wasm);}catch{throw new Error('Build the native/WASM core first: bash build-native.sh (through lm-remote).');}
await rm(resolve(here,'dist'),{recursive:true,force:true});
const result=spawnSync(resolve(repo,'node_modules/.bin/tsc'),['-p',resolve(here,'tsconfig.json')],{cwd:repo,stdio:'inherit'});
if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);
await mkdir(resolve(here,'dist'),{recursive:true});await copyFile(wasm,resolve(here,'dist/carlab_engine_lab.wasm'));
// Always refresh from the locked graph/toolchain used by this build.
const notices=await generateThirdPartyNotices({stdlibAssetsDir:resolve(here,'dist/rust-stdlib')});
await copyFile(notices.output,resolve(here,'dist/THIRD_PARTY_NOTICES.md'));
console.log('Built @carlab/engine: portable ESM, declarations, WASM sidecar and upstream notices.');
