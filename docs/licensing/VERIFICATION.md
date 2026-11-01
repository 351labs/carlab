# Apache-2.0 and attribution preparation

Date: 1 November 2026. Source change: `31ba8c748727ce7bb8e010535cefa20c1ed68657`.

This preparation adds the exact official Apache-2.0 text, NOTICE, root/API/Cargo metadata, the complete `credits.md` register, corrected NASA data attribution, and separate third-party notices. Original third-party texts retain their own terms. The full Vite notice is copied verbatim, including upstream whitespace; `.gitattributes` excludes only that file from whitespace diagnostics.

## Primary-source checks

- `LICENSE` was retrieved from <https://www.apache.org/licenses/LICENSE-2.0.txt>, 11,358 bytes, SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`.
- `licenses/cantera-BSD-3-Clause.txt` matches Cantera v3.1.0 `License.txt`, 1,796 bytes, SHA-256 `469fa95f76e0c652b4f204c2e5d3ffd184dbbb85b2a7fbc75355bee3a16e48e2`.
- Cantera v3.1.0 `data/nasa_gas.yaml` was retrieved for provenance comparison, 276,140 bytes, SHA-256 `4de6199d65d2d3db782e30573720c723130953707336add59713b02d8667e4db`. The seven species coefficient sets match the source values. Ar's single source fit is duplicated across the code's two ranges; mixture weighting/enthalpy adjustments are documented separately in `credits.md`.
- NASA's TM-4513 record identifies McBride, Gordon and Reno (1993), with public government-work use. This does not replace the retained Cantera notice.
- `credits.md` consolidates 164 distinct external URLs, including the eighteen focused-research IDs S01–S18, multilingual studies, EFI/community sources, measured-data provenance and recorded/synthetic audio distinctions. Citation presence is not a claim of implementation, verified reuse rights or transferred experimental accuracy.

## Local runner validation

All application builds and tests below ran through `lm-remote --host local`; no benchmark timings are claimed.

Job **`carlab-1101-135139-40186`**, exit 0:

- `npm run typecheck`: passed, application and portable API.
- `npm run test:all`: **160 Node/TypeScript tests and 128 Rust tests passed**, zero failures.
- `npm run build`: passed; unchanged application JS and WASM content compared with the prior release.
- `node scripts/check-release.mjs`: passed, 50 static files, isolated worker/domain configuration and copied notice files.
- `node test-api-consumer.mjs`: passed, packed-package TypeScript compilation and actual WASM execution, including SI/diesel, with zero npm runtime dependencies. The test also compares packed Apache LICENSE, NOTICE, credits and Cantera notice byte-for-byte against source and checks the full Cantera text occurs in the generated inventory.

Final static-artifact job **`carlab-1101-135356-48584`**, exit 0, explicitly bound the generated `build.json` to the real source commit above, then rebuilt the static app and verified all hashes/notices. Two intermediate artifact versions used runner-only or incorrect provenance IDs and were discarded; their successful byte-integrity checks were not treated as proof of source identity. The final artifact source is `31ba8c748727ce7bb8e010535cefa20c1ed68657`.

- WASM SHA-256: `6bd40eda5dc7a32be88efea66fdc1d0c1e7dccb4ff923aff62998ec9e16779aa`.
- Application entry: `assets/index-BMqY_a0k.js`, SHA-256 `128ae0fae63e224e6330535e91baa61da2855aaffd1af9b383e49e39ad8b4f61`.
- Full generated release inventory: `dist/release.json` (ignored build artifact).
- Final preparation produced no new runtime behavior; changes concern attribution, metadata and distribution checks.

`lm-remote` creates a snapshot commit. For a release, capture the real repository revision **before entering the runner** and pass it explicitly, for example:

```sh
carlab_license_source_commit=$(git rev-parse HEAD)
lm-remote --host local --timeout 12 \
  --pull native/dist --pull api/dist --pull dist --pull .cloudflare/output/v0 \
  "CARLAB_SOURCE_COMMIT=$carlab_license_source_commit npm run build && CARLAB_SOURCE_COMMIT=$carlab_license_source_commit node scripts/check-release.mjs && node test-api-consumer.mjs"
```

## Independent review handoff

An Orca Claude agent received the adversarial review, scoped to the application, Rust/WASM/API boundaries, imports, scientific claims, licensing/data scope, history and release artifacts. Its requested report is `docs/review/adversarial-2026-11-01.md`. The reviewer owns that report and sanitized review evidence only; it has no authority to publish, deploy or modify the implementation.

This document records preparation and local validation. It does not assert the independent review is finished or that the repository is ready for public visibility. In particular, research-only sources retain access/rights caveats and the EPA numeric extraction has document-specific data-use language rather than a blanket Apache data license. These changes have not been deployed as part of this preparation.
