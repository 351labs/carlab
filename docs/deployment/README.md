# Production deployment

CarLab runs at **https://carlab.351labs.xyz/** as a dedicated Cloudflare Worker with static assets. The private source repository is **https://github.com/351labs/carlab**. The repository has its own history, pinned npm dependencies, locked Rust dependencies, build configuration, native executable, WebAssembly module and portable TypeScript API. There are no imports or package links to another application repository.

The mathematical model and synthesis execute on the visitor's CPU in Rust/WASM and the AudioWorklet. Three.js renders the component models on the GPU. Cloudflare serves the application and its assets; this deployment adds no remote simulation service or database.

## Verified release

- Application source: `985f45136e41d4851ea6168c12bc68fd58b895a5`.
- Cloudflare Worker: `carlab`.
- Cloudflare version: `52562b18-e420-41ab-9cd9-43f550f59e67`.
- Only custom domain: `carlab.351labs.xyz`; Workers.dev and preview URLs are disabled.
- The deployed JavaScript and WASM payload hashes match the locally verified release manifest.
- HTTPS certificate verification passed. HTML is revalidated; content-addressed assets use a year of immutable browser caching. A missing JavaScript asset returns HTTP 404, rather than an HTML fallback.

The [deployment record](proof/deployment.json) contains release hashes, jobs and scope. The [release manifest](proof/release-manifest.json) inventories the built files. The notice inventory, Three.js MIT text, Rust toolchain notices and audio credits are included in the public build.

## Validation

All checks ran through the local `lm-remote` runner:

- A fresh install from the standalone lockfile, native executable and WASM compilation, typecheck, web build and `npm run test:all` passed in `carlab-1101-124844-37925`.
- Ten focused data-import/provenance/metric checks passed in `carlab-1101-125220-46072`. Schema metadata changed during extraction; measured arrays, split membership and reference numerical cases remain frozen, as recorded in `validation/import-provenance.json`.
- The standalone packed TypeScript consumer passed with **zero npm runtime dependencies** in `carlab-1101-125403-48569`. That job also passed 127 compiled-browser checks across the workshop, comparisons/library, cycle/thermal/material workflows and EFI.
- Production verification exposed a navigation-lifetime bug: cleanup on `beforeunload` could release native handles while animation callbacks still ran. Source `60017c6` moves final cleanup to committed `pagehide`, cancels animation callbacks and preserves a suspended back/forward-cache page. A regression check verifies that a `beforeunload` event alone leaves the native model usable.
- After that correction, **52 local workshop checks** passed in `carlab-1101-130130-60801`, and **52 checks against the deployed HTTPS site** passed in `carlab-1101-130329-64337`, with no script errors or application uploads. These include actual Rust AudioWorklet combustion, physical WAV export, all five 3D assemblies, seven mobile locales, navigation and the WebGL-unavailable fallback.
- The final `985f451` change only separates HTML revalidation from immutable asset caching. Its release check passed in `carlab-1101-130422-66055`; the JavaScript and WASM bytes are identical to those exercised by the successful production browser run.

Cloudflare can inject its own security checks into served HTML. The production browser record accounts for their POST requests separately; the application does not upload audio, local evidence or calibration files.

## DNS observation

Cloudflare's authoritative DNS, `1.1.1.1` and `8.8.8.8` returned the new domain's proxied addresses after publication. The resolver used by this Mac retained an earlier NXDOMAIN response with a decreasing negative-cache TTL. Production browser verification therefore used a process-local hostname-to-public-edge mapping while retaining the real HTTPS hostname and ordinary certificate validation. No system DNS settings or trust stores were changed. A device with that earlier negative response may need to wait for its cache to expire.

## Update the release

From the repository root, commit the application source first. The source SHA is passed explicitly because the test runner creates its own snapshot commit.

```sh
carlab_source_commit=$(git rev-parse HEAD)
rm -rf .cloudflare/output/v0 dist/client
lm-remote --host local --timeout 12 \
  --pull native/dist --pull api/dist --pull dist --pull .cloudflare/output/v0 \
  "CARLAB_SOURCE_COMMIT=$carlab_source_commit npm run build"
lm-remote --host local --gpu --timeout 6 \
  --pull docs/workshop/proof node test-workshop.mjs
npm run deploy -- --dry-run
npm run deploy
```

The cleanup targets only generated release directories and prevents stale files surviving a runner pull. `scripts/check-release.mjs`, run inside a runner job after the build, verifies the exact Worker/domain, absence of bindings or credential-like asset files, notice files and matching static copies. To check the deployed application, use `CARLAB_TEST_URL=https://carlab.351labs.xyz/` with the browser harness through `lm-remote --host local --gpu`.

These are functional and distribution checks, not reference performance benchmarks or validation of real-engine fidelity. The default physical parameters remain assumptions unless calibrated and independently assessed.
