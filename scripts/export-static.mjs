import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, '.cloudflare/output/v0/workers/default/assets');
const target = resolve(root, 'dist/client');
await readFile(resolve(source, 'index.html'));
await rm(target, { recursive: true, force: true });
await mkdir(resolve(root, 'dist'), { recursive: true });
await cp(source, target, { recursive: true });
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      files.push({ path: relative(target, path).split('\\').join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
await walk(target); files.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(resolve(root, 'dist/release.json'), JSON.stringify({ application: 'CarLab', worker: 'carlab', domain: 'carlab.351labs.xyz', files }, null, 2) + '\n');
console.log(`Prepared ${files.length} standalone static files.`);
