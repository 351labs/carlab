import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
export default defineConfig({
  root: import.meta.dirname,
  plugins: [cloudflare()],
  server: { host: '127.0.0.1', port: 5433, strictPort: true, open: false },
  build: { target: 'es2022', sourcemap: false },
  worker: { format: 'es' },
});
