import { defineConfig } from 'vite';
export default defineConfig({
  root: import.meta.dirname,
  build: { outDir: 'dist/client', emptyOutDir: false, target: 'es2022' },
  preview: { host: '127.0.0.1', port: 5433, strictPort: true, open: false },
});
