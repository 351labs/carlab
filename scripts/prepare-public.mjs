import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const publicDir = resolve(root, 'public');
await mkdir(resolve(publicDir, 'licenses'), { recursive: true });
await copyFile(resolve(root, 'node_modules/three/LICENSE'), resolve(publicDir, 'licenses/three-MIT.txt'));
await copyFile(resolve(root, 'licenses/vite-MIT.md'), resolve(publicDir, 'licenses/vite-MIT.md'));
await copyFile(resolve(root, 'licenses/cantera-BSD-3-Clause.txt'), resolve(publicDir, 'licenses/cantera-BSD-3-Clause.txt'));
for (const file of ['LICENSE', 'NOTICE', 'credits.md']) await copyFile(resolve(root, file), resolve(publicDir, file));
await copyFile(resolve(root, 'api/dist/THIRD_PARTY_NOTICES.md'), resolve(publicDir, 'licenses/rust-and-dependencies.md'));
await cp(resolve(root, 'api/dist/rust-stdlib'), resolve(publicDir, 'licenses/rust-stdlib'), { recursive: true });
const wasm = await readFile(resolve(root, 'native/dist/carlab_engine_lab.wasm'));
const sourceCommit = process.env.CARLAB_SOURCE_COMMIT ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const build = { application: 'CarLab', sourceCommit, wasmSha256: createHash('sha256').update(wasm).digest('hex') };
await writeFile(resolve(publicDir, 'build.json'), JSON.stringify(build, null, 2) + '\n');
await writeFile(resolve(publicDir, 'THIRD_PARTY_NOTICES.md'), '# CarLab licenses and third-party notices\n\nCarLab original code and documentation: [Apache-2.0](LICENSE), [NOTICE](NOTICE).\n\n- [Complete research and source credits](credits.md)\n- [Three.js MIT license](licenses/three-MIT.txt)\n- [Vite build helper notices](licenses/vite-MIT.md)\n- [Cantera BSD-3-Clause coefficient notice](licenses/cantera-BSD-3-Clause.txt)\n- [Rust toolchain and locked dependency notices](licenses/rust-and-dependencies.md)\n- [Reference audio attribution, CC BY 3.0](references/ATTRIBUTION.md)\n\nThird-party code, coefficient data, measured data and reference audio retain their own terms.\n');
