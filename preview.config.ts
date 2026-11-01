import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Vite does not apply Cloudflare's _headers automatically. Exercise the global
// production policy in every compiled-preview workflow, including worker tests.
const globalHeaders: Record<string, string> = {};
for (const line of readFileSync(resolve(import.meta.dirname, 'public/_headers'), 'utf8').split('\n').slice(1)) {
  if (!/^\s/.test(line)) break;
  const match = line.trim().match(/^([^:]+):\s*(.*)$/);
  if (match) globalHeaders[match[1]] = match[2];
}
export default defineConfig({
  plugins: [{ name: 'carlab-preview-security-headers', configurePreviewServer(server) {
    server.middlewares.use((_request, response, next) => {
      for (const [name, value] of Object.entries(globalHeaders)) response.setHeader(name, value);
      next();
    });
  } }],
  root: import.meta.dirname,
  build: { outDir: 'dist/client', emptyOutDir: false, target: 'es2022' },
  preview: { host: '127.0.0.1', port: 5433, strictPort: true, open: false },
});
