# Public repository preparation — 1 November 2026

The owner requested public visibility for `351labs/carlab` after the adversarial findings were corrected. Copyright ownership was explicitly confirmed in [ORIGIN.md](../licensing/ORIGIN.md); the license, complete credits, third-party exceptions and audio/data provenance are recorded in the repository. The [fix report](../review/fixes-2026-11-01.md) closes the prior release findings.

**Published:** https://github.com/351labs/carlab. GitHub confirmed public visibility after source `66e1c547d7a592e88f0e3c64b7de21df1c547474` was pushed. Anonymous repository, Apache license and credits requests returned HTTP 200. GitHub recognizes `Apache-2.0`; secret scanning and secret-scanning push protection are enabled. See the [provider confirmation](evidence/github-publication.json).

## Final dependency cleanup

The final npm check reported 16 dependency findings (14 high, 2 moderate) in development/build/test tooling. The runtime-only audit reported zero. These findings were not attributed to the browser's Three.js runtime or to the Rust model.

Three direct development dependencies were updated, keeping exact pins:

| Package | Previous | Updated |
|---|---|---|
| `@cloudflare/vite-plugin` | `2.0.0-beta.v.4` | `2.0.0-beta.v.8` |
| `cf` | `1.0.0-beta.21` | `1.0.0-beta.26` |
| `puppeteer-core` | `24.43.1` | `25.16.0` |

The regenerated lockfile retains optional platform packages so a fresh `npm ci` works independently of the maintainer's existing `node_modules`. The initial install-over-existing-tree lock omitted foreign-platform optional entries and was rejected by the reference runner's clean install; that lock was discarded. The final clean install succeeded locally and on remix-mac2. No direct runtime dependency or engine-model code changed.

Both the [complete npm audit](evidence/npm-audit.json) and [runtime-only npm audit](evidence/npm-audit-runtime.json) report **zero advisories** at this check. The upstream advisory records include [extract-zip path traversal](https://github.com/advisories/GHSA-jmr9-qjv8-65gv), [Undici TLS option handling](https://github.com/advisories/GHSA-2m5v-pch6-74hx) and [Zod resource consumption](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). Audit package counts include dependency effects, not independent vulnerabilities in CarLab source.

## Validation

The local runner was paused by memory pressure. The previously owner-authorized remix-mac2 fallback was used for functional checks, with headless Chrome and no benchmark timings:

- Environment / clean-install check: `carlab-1101-220453-63557`, Node 24.22.0, Rust/Cargo 1.99.0; required WASM target installed.
- Integrated job: **`carlab-1101-220554-64659`**. Typecheck, **165 TypeScript/JavaScript tests**, **130 Rust tests**, 12 legacy cases with zero mismatches, production build and real packed API consumer passed.
- **134 browser checks passed:** workshop 58, integrated listening/vehicle/library 22, cycle/materials 30, EFI 24; zero script errors or application uploads in every suite.
- The packed API retained zero npm runtime dependencies, correct SI/diesel behavior, the valid phasing result and rejection of all seven invalid phasing cases.

The [validation summary](evidence/validation.json) is derived from the captured command results. Node 24's default test reporter uses a different summary prefix from Node 22; the saved count is taken from its actual `tests 165`, `pass 165`, `fail 0` lines. Subsequent changes only document publication and supported Node versions. This is functional validation, not a performance benchmark, complete security certification or real-engine calibration.

The [high-confidence history check](evidence/history-scan.json) found no credential-pattern matches across 304 reachable blobs at source `7d28108`. Its scope is explicitly limited; Git author identity and historical provenance were preserved. No Actions runs or tracked workflow files were present at the visibility check.

## Publication scope

The GitHub source is public. Current README and deployment introductions no longer claim that it is private. Historical deployment/verification records preserve their original visibility context. The npm manifests remain `private: true` to prevent accidental registry publication; that is independent of GitHub visibility.

The running website remains the separately verified application source `032ce18`, Cloudflare version `fe1826b2-e846-4cee-9822-ce6443af899c`. Repository publication and development-tool updates do not require changing that deployed runtime. No new model-accuracy or cross-browser-support claim is introduced.
