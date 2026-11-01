/** Generate an attribution inventory from the locked Cargo graph and installed
 * source/toolchain notices. Metadata resolution is offline; nothing is fetched.
 * Run through the project's build runner when used as a distribution build step.
 */
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,resolve,relative,sep,join,isAbsolute} from 'node:path';
import {readFile,writeFile,readdir,stat,mkdir,copyFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const hash=data=>createHash('sha256').update(data).digest('hex');
function command(program,args){
 const result=spawnSync(program,args,{cwd:here,encoding:'utf8',maxBuffer:24*1024*1024});
 if(result.error)throw result.error;
 if(result.status!==0)throw new Error(`${program} ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
 return result.stdout.trim();
}
async function exists(path){try{return await stat(path);}catch(error){if(error.code==='ENOENT')return undefined;throw error;}}
function inside(root,path){const rel=relative(root,path);return rel===''||(!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel));}
function fence(text){let width=3;for(const match of text.matchAll(/`+/g))width=Math.max(width,match[0].length+1);const marks='`'.repeat(width);return `${marks}text\n${text}${text.endsWith('\n')?'':'\n'}${marks}\n`;}
function clean(value){return String(value??'').replace(/[\r\n]/g,' ').trim();}
async function noticeFiles(pkg){
 const root=dirname(pkg.manifest_path),files=new Set();
 if(pkg.license_file){const path=resolve(root,pkg.license_file);if(!inside(root,path))throw new Error(`Declared licence file is outside ${pkg.name}'s source directory.`);if(!(await exists(path))?.isFile())throw new Error(`Missing declared licence file for ${pkg.name} ${pkg.version}: ${pkg.license_file}`);files.add(path);}
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(entry.isFile()&&/^(?:LICEN[CS]E|COPYING|NOTICE|COPYRIGHT)(?:[._-].*)?$/i.test(entry.name))files.add(join(root,entry.name));
  if(entry.isDirectory()&&/^(?:licenses?|notices?)$/i.test(entry.name)){
   async function walk(dir){for(const child of await readdir(dir,{withFileTypes:true})){const path=join(dir,child.name);if(child.isDirectory())await walk(path);else if(child.isFile())files.add(path);}}
   await walk(join(root,entry.name));
  }
 }
 if(!files.size)throw new Error(`No supplied LICENSE/COPYING/NOTICE files found for ${pkg.name} ${pkg.version}; attribution cannot be silently fabricated.`);
 return [...files].sort().map(path=>({path,name:relative(root,path).split(sep).join('/')}));
}
function lockChecksums(lock){
 const out=new Map();
 for(const block of lock.split(/^\[\[package\]\]\s*$/m).slice(1)){
  const field=name=>block.match(new RegExp(`^${name} = "([^"]+)"$`,'m'))?.[1];
  const name=field('name'),version=field('version'),source=field('source'),checksum=field('checksum');
  if(name&&version&&source&&checksum)out.set(`${name}\0${version}\0${source}`,checksum);
 }
 return out;
}
async function rustNotices(){
 const version=command('rustc',['--version']),sysroot=command('rustc',['--print','sysroot']);
 const docs=join(sysroot,'share/doc/rust'),licenseDir=join(docs,'licenses');
 const candidates={MIT:[join(licenseDir,'MIT.txt')],Apache:[join(licenseDir,'Apache-2.0.txt')]};
 const staticDir=join(docs,'html/static.files');
 if((await exists(staticDir))?.isDirectory())for(const file of await readdir(staticDir)){
  if(/^LICENSE-MIT-.*\.txt$/.test(file))candidates.MIT.push(join(staticDir,file));
  if(/^LICENSE-APACHE-.*\.txt$/.test(file))candidates.Apache.push(join(staticDir,file));
 }
 const result={version,docs,texts:[],copyright:undefined,licenseDir:undefined};
 for(const [label,paths] of Object.entries(candidates)){
  let found;
  for(const path of paths)if((await exists(path))?.isFile()){found=path;break;}
  if(!found)throw new Error(`Installed Rust toolchain lacks its ${label} licence text. Supply/install the toolchain's notices before packaging; no text was inferred or fetched.`);
  result.texts.push({label,path:found,name:relative(sysroot,found).split(sep).join('/'),text:await readFile(found,'utf8')});
 }
 const copyright=join(docs,'COPYRIGHT-library.html');
 if((await exists(copyright))?.isFile())result.copyright=copyright;
 if((await exists(licenseDir))?.isDirectory())result.licenseDir=licenseDir;
 return result;
}
/** output is the durable inventory. stdlibAssetsDir copies the installed full
 * standard-library copyright inventory and referenced licences into a package.
 */
export async function generateThirdPartyNotices({output=join(here,'THIRD_PARTY_NOTICES.md'),stdlibAssetsDir}={}){
 const manifest=join(here,'Cargo.toml');
 const metadata=JSON.parse(command('cargo',['metadata','--offline','--locked','--format-version','1','--manifest-path',manifest]));
 const lock=await readFile(join(here,'Cargo.lock'),'utf8'),checksums=lockChecksums(lock);
 const resolved=new Set((metadata.resolve?.nodes??[]).map(node=>node.id));
 const packages=metadata.packages.filter(pkg=>typeof pkg.source==='string'&&pkg.source.startsWith('registry+')&&resolved.has(pkg.id)).sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
 if(!packages.length)throw new Error('The locked registry dependency graph is empty; refusing an incomplete notice inventory.');
 const sections=['# Third-party notices — CARLAB engine/audio core\n',
  'Generated offline from this crate’s locked Cargo dependency graph and the actual installed package/toolchain notice files. No licence text or licence conclusion is inferred from a package name. This inventory preserves upstream declarations and notices; it does not determine which portions were linked into a particular target.\n',
  `Cargo.lock SHA-256: \`${hash(lock)}\`. Registry packages: **${packages.length}**.\n`,
  'The graph includes build-time and proc-macro dependencies as well as runtime dependencies. Those categories are not a claim that all listed source code is present in the WASM binary. The original project code and reference media are outside this third-party Cargo inventory.\n',
  '| Package | Declared SPDX expression | Registry archive SHA-256 |\n|---|---|---|'];
 for(const pkg of packages){const checksum=checksums.get(`${pkg.name}\0${pkg.version}\0${pkg.source}`);if(!checksum)throw new Error(`No locked registry checksum for ${pkg.name} ${pkg.version}.`);sections.push(`| ${clean(pkg.name)} ${clean(pkg.version)} | ${clean(pkg.license)||'not declared'} | \`${checksum}\` |`);}
 for(const pkg of packages){
  const files=await noticeFiles(pkg);
  sections.push(`\n## ${clean(pkg.name)} ${clean(pkg.version)}\n`,`Declared licence expression: **${clean(pkg.license)||'not declared'}**. Source: \`${clean(pkg.source)}\`.\n`);
  if(pkg.repository)sections.push(`Upstream repository declared by package metadata: ${clean(pkg.repository)}.\n`);
  if(pkg.authors?.length)sections.push(`Authors declared by package metadata: ${pkg.authors.map(clean).join('; ')}.\n`);
  sections.push(`Cargo target kinds: ${[...new Set(pkg.targets.flatMap(target=>target.kind))].sort().join(', ')}. The following files are copied verbatim from that exact cached package version.\n`);
  for(const file of files){const text=await readFile(file.path,'utf8');sections.push(`### ${file.name}\n`,`SHA-256: \`${hash(text)}\`.\n`,fence(text));}
 }
 const rust=await rustNotices();
 sections.push('\n## Rust standard library and toolchain\n',`Toolchain queried: \`${clean(rust.version)}\`.\n`,
  'The Rust standard library’s installed copyright inventory states a general choice of Apache-2.0 or MIT, with exceptions recorded per file/dependency. Its contributors retain copyright. The Cargo table above does not enumerate the compiler-provided standard library. Do not interpret the general dual-licence statement as overriding any exception in the supplied inventory.\n');
 for(const file of rust.texts)sections.push(`### Installed Rust ${file.label} text\n`,`Source within the toolchain: \`${file.name}\`; SHA-256: \`${hash(file.text)}\`.\n`,fence(file.text));
 if(rust.copyright){
  const data=await readFile(rust.copyright);sections.push(`The installed full standard-library inventory, \`share/doc/rust/COPYRIGHT-library.html\`, has SHA-256 \`${hash(data)}\`. The built API package includes it at \`dist/rust-stdlib/COPYRIGHT-library.html\`, alongside the supplied licence texts it references. The toolchain inventory can include components for targets other than the one being distributed.\n`);
 }else sections.push('The installed toolchain did not supply COPYRIGHT-library.html; only its actual MIT/Apache texts above were available. No complete per-file standard-library inventory was fabricated.\n');
 if(stdlibAssetsDir){
  await mkdir(stdlibAssetsDir,{recursive:true});
  if(rust.copyright)await copyFile(rust.copyright,join(stdlibAssetsDir,'COPYRIGHT-library.html'));
  if(rust.licenseDir){await mkdir(join(stdlibAssetsDir,'licenses'),{recursive:true});for(const entry of await readdir(rust.licenseDir,{withFileTypes:true}))if(entry.isFile())await copyFile(join(rust.licenseDir,entry.name),join(stdlibAssetsDir,'licenses',entry.name));}
  else for(const file of rust.texts)await copyFile(file.path,join(stdlibAssetsDir,`${file.label}.txt`));
 }
 await mkdir(dirname(output),{recursive:true});await writeFile(output,sections.join('\n').trimEnd()+'\n');
 return {output,registryPackages:packages.length,rustVersion:rust.version,stdlibCopyright:!!rust.copyright};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2);let output,stdlibAssetsDir;
 while(args.length){const option=args.shift();if(option==='--output')output=args.shift();else if(option==='--stdlib-assets')stdlibAssetsDir=args.shift();else throw new Error(`Unknown option: ${option}`);}
 console.log(JSON.stringify(await generateThirdPartyNotices({...(output?{output}:{}),...(stdlibAssetsDir?{stdlibAssetsDir}:{})})));
}
