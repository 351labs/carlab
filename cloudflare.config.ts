import { defineConfig } from 'cf/config';
export default defineConfig({
  worker: {
    name: 'carlab',
    compatibilityDate: '2026-11-01',
    workersDev: false,
    previewUrls: false,
    domains: ['carlab.351labs.xyz'],
    assets: { notFoundHandling: 'none' },
    observability: { enabled: true, traces: { enabled: true } },
  },
});
