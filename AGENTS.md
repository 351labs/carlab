# CarLab

CarLab is an independent Rust, WebAssembly, TypeScript and Three.js laboratory.
Keep mathematical model behavior separate from presentation and document the scope of calibration and scientific evidence.

- Run builds and tests through `lm-remote --host local` from this repository.
- Browser checks use `lm-remote --host local --gpu` and headless Chrome. Never open visible browser windows on this Mac.
- Report reference performance timings only from an authorized `lm-remote --bench` job on remix-mac2; functional tests are not benchmarks.
- Preserve third-party license notices and scientific sources. Never add commercial game assets or copied engine recordings without redistribution rights.
- Keep credentials out of Git and public assets. Cloudflare deployment uses the authenticated local CLI and `npm run deploy` after a verified build.

Useful checks: `npm run typecheck`, `npm run test:all`, `npm run build`, `node test-workshop.mjs`, and `node test-api-consumer.mjs`.
