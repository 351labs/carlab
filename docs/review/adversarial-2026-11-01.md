# Adversarial pre-publication review — 1 November 2026

Publication privacy edit: the literal local machine hostname in finding I3 is redacted. Findings, evidence counts and the reviewer's original conclusions below are preserved; subsequent fixes are tracked separately.

Independent review of CarLab before the repository is made public. This review only reads the code. The reviewer changed nothing except this report and `docs/review/evidence-2026-11-01/`. Nothing was staged, committed, pushed, deployed or published.

## Scope and identity

| Item | Value |
|---|---|
| Repository | `351labs/carlab` (private), local worktree `main` |
| Baseline code reviewed | `a9c5c80da5fc4857902bccd2a6038926d4ff5fb6` |
| Licensing commits reviewed | `31ba8c748727ce7bb8e010535cefa20c1ed68657` (Apache-2.0, NOTICE, credits, notices, metadata) and `81693645b1729b617e536dc9508df17097c70fc5` (`docs/licensing/VERIFICATION.md`, `.gitattributes`). Another agent committed both during the review. |
| Final verified tree | `8169364` clean (lm-remote snapshot `50a71ab4`) |
| History scanned | every object reachable from all refs: 262 objects (216 blobs), all 7 commits. Rescanned after `8169364`. |
| Areas reviewed | Rust core and WASM ABI (`native/src`), TypeScript API (`api/`), browser application and lifecycle (`main.ts`, `*-ui.ts`, `worklet.ts`, `backend.ts`, `workshop/`), import parsers (`projects.ts`, `maps.ts`, `pressure-observations.ts`, ECU CSV, material cards), build and release scripts, `public/`, `docs/`, `validation/`, source history, dependency and licence notices, scientific provenance |

Labels used below: **Verified** means reproduced or observed in this review. **Code-read** means found by reading the code but not executed. **Inference** means research judgement or legal-risk reasoning. This report is not legal advice.

## Release recommendation

**Do not make the repository public yet.** No credentials, exploitable injection paths or runtime crash paths were found. The engineering quality of the boundary code is high. Two items must be closed first:

1. **B1** — the owner must confirm copyright ownership of the code and media. This needs no code change.
2. **B2** — the EPA dataset's own reuse statements, which contradict each other, must be corrected, and EPA's suggested citation must be added. This is a documentation and metadata change only.

Fix **M1** and **L1** before publication as well; both are small. The remaining items can follow publication.

Count of findings: 2 release gates, 1 medium, 6 low, 3 informational.

## Findings

### B1 — Release gate: copyright ownership and code lineage need owner confirmation (Inference, with verified evidence)

- **Evidence.**
  - `NOTICE:2` states "Copyright 2026 351labs and contributors."
  - All 7 commits, including the licensing commits, are authored and committed under an e-mail address at a different organisation's domain (`ollem.io`), not 351labs.
  - The application is a bulk import (`cdf5c10`) of work developed in a predecessor research workspace, "pega-engine-lab". All seven shipped `public/audio/*.wav` files are byte-identical to that workspace's comparison outputs. Its manifest records the generating models as `pega-engine-lab-1` and `pega-engine-lab-2`.
- **Risk.** An Apache-2.0 grant is effective only if the licensor holds the rights. If the work was created under an employment or contractor relationship with another organisation, or the predecessor code has other owners, the NOTICE and grant may be wrong.
- **Fix.**
  - The owner confirms that 351labs, or the named contributors, hold the rights to the predecessor code and media and to the work committed under the other domain.
  - If needed, adjust the NOTICE copyright line.
  - Optionally re-author future commits with a 351labs identity. History rewriting is the owner's decision and is not recommended merely for cosmetics.

### B2 — Release gate (medium): the EPA Mazda dataset contradicts itself about its reuse scope and lacks EPA's suggested citation (Verified)

The reviewer downloaded the EPA archive once and verified it: SHA-256 `01895c57…c8a2`, report `63159c55…0bf2`, workbook `19075910…402a`. All three match the fixtures.

- **What the source actually says.**
  - Report section "Discussion and Data Usage": *"In general, the engine operation and fuel consumption data produced in this testing are robust and can be used for any purpose."* The sentence sits in a paragraph about data quality, which is why the next sentence covers low-load uncertainty.
  - Package contents document: *"Use of any NCAT documents … should reference the suggested citation provided."*
  - The citation is: *2014 Mazda 2.0L SKYACTIV-G Engine Tier 2 Fuel – Test Data Package. Version 2018-02. Ann Arbor, MI: US EPA, National Vehicle and Fuel Emissions Laboratory, National Center for Advanced Technology, 2018.*
- **Contradictions in the repository.**
  - `validation/mazda-measured.json:1051` (`reuse.scope`): *"Only 12 measured spreadsheet rows … are retained; no complete map … Check individual attachment notices before bulk redistribution."* However, `validation/mazda-measured-all.json` ships the complete *Steady State* worksheet: 137 rows × 26 columns.
  - `validation/mazda-measured-all.json:15` and `validation/extract-mazda-steady.py:79` give their reuse basis as `MAZDA-INPUTS.md`, which is not in this repository. `validation/summarize-mazda.mjs:33` also links `ASSESSMENT.md` and `MAZDA-INPUTS.md`, both missing.
  - `credits.md:40` rests the data-use basis on "the extraction research", which is also not in the repository. `credits.md:38` calls the 137-row worksheet a "limited numeric extraction".
  - The citation is incomplete:
    - `credits.md:36` cites the package as "_2014 Mazda 2.0L SKYACTIV engine, Tier 2 fuel test data package_", not in EPA's suggested format (it omits "-G", NCAT and the version/place form).
    - The 137-row fixture's `source` block has no `suggestedCitation`. Only the 12-row fixture has one.
- **Risk.** Inference: legal redistribution risk looks low. This is US Government work, and the wording says "any purpose". The problem is that the published provenance record would be false or unverifiable on its own terms.
- **Fix.**
  - Quote EPA's exact sentence and its context in `credits.md`, and add the exact suggested citation.
  - Rewrite the 12-row fixture's `reuse.scope` (or add a top-level provenance note) to cover the 137-row fixture's existence and basis.
  - Replace `MAZDA-INPUTS.md` references with a pointer to `credits.md` §3, or vendor a sanitized copy of that document.
  - Changing fixture bytes requires updating `validation/import-provenance.json` hashes. Its test (`validation/import-provenance.test.mjs`) will flag any mismatch.

### M1 — Medium: `sparkToSocFromCa10Delay` has no input domain, so a `number` API returns `null` or silently wrong values (Verified)

- **Where.** `native/src/cylinder_cycle.rs:669-679`, dispatched at `native/src/lib.rs:268-273`, exposed at `api/index.ts:152`.
- **Reproducer.** Job `carlab-1101-135401-48878`:
  - `sparkToSocFromCa10Delay(20, 50, 0, 2)` returns `null`.
  - `(20, 50, -1e308, 2)` returns `null`.
  - `(20, 50, -1, 2)` returns `-7.06`.
  - `(20, -50, 6.9, 2)` returns `32.40`.
  - `(20, 50, 6.9, -1)` returns `20`.
  - The cycle kernel itself clamps the same parameters: Wiebe efficiency 1–12, shape 0.1–5, burn duration 8–120°. The conversion can therefore describe a combustion phasing that the kernel never runs.
- **Root cause, systemic.** `serde_json` serializes non-finite `f64` as JSON `null`. `lib.rs` `value()` (line 56) and `envelope()` have no finiteness guard on outputs. The API README says inputs reject non-finite numbers, but outputs can silently degrade. The 57,261-case fuzz found only this instance.
- **Fix.**
  - Validate the domain in `spark_to_soc_from_ca10_delay`: either use the kernel's ranges or reject out-of-range input with an error.
  - Return `Result`.
  - Optionally add an output guard that turns any non-finite number in a result into an explicit error instead of `null`.

### L1 — Low: the public WASM embeds the build machine's home directory and username (Verified)

- **Evidence.** The production WASM (SHA-256 `6bd40eda…79aa`) contains 20 panic-location strings of the form `/Users/<user>/.cargo/registry/src/…` and `/Users/<user>/.rustup/toolchains/…`. That hash is identical in the live `build.json`, the local `dist`, and rebuilds of `a9c5c80` and `8169364`. No CarLab source or runner-snapshot paths are embedded.
- **Fix.** Add `--remap-path-prefix` for `$HOME`, the Cargo registry and the rustup paths in `build-native.sh`, for example via `RUSTFLAGS` or `CARGO_ENCODED_RUSTFLAGS`, or use Cargo's `trim-paths` if the toolchain supports it. Expect a new WASM hash and redeploy.

### L2 — Low: the provenance of the shipped synthetic audio is not reproducible from the repository (Verified)

- **Evidence.**
  - The current TypeScript model (`offline.ts`, `carlab-engine-lab-5`) renders `v12-classic` "rev" differently from the shipped `public/audio/v12-classic-rev.wav`: 759,349 of 768,000 samples differ.
  - The "before" clips need an external historical-model fixture (`prepare-baseline.ts`, `ENGINE_LAB_COMPARISON_BASELINE`).
  - `compare-render.ts:11` writes its manifest to the untracked path `docs/analysis/comparison`.
  - The provenance does exist outside the repository: the predecessor manifest records all seven clips as synthetic model output, and the classic V12 as "not an imitation of a named manufacturer". It is byte-identical to what ships here.
- **Fix.** Commit a sanitized manifest next to `public/audio/`, listing per file the model ID, preset/config, scenario, gain and SHA-256. Mark the clips as historical renders not reproducible from the current model. This makes the `credits.md:154` statement verifiable from the repository.

### L3 — Low: stale or broken validation and research scripts, and dangling references (Verified)

- `validation/measure-mazda.mjs:24` throws "Protocol requires the reviewed model baseline." because it requires model `rust-2`, while the core is now `rust-3`.
- `validation/measure-mazda-model3.mjs:25` requires an external `ENGINE_LAB_MAZDA_BASELINE` even for `--smoke`. Its default output is `docs/research-improvements/proof/`, which is absent. So no Mazda model-3 comparison can be reproduced from this repository alone. No accuracy claim depends on it in the docs; the protocol says `heldOutAccuracyClaim: false`.
- `measure-comparison.sh`, `compare-render.ts`, `summarize-analysis.py` and `probe-*.mjs` write to `docs/analysis`, `docs/proof` and `docs/efi`, which do not exist. The default proof directories of `test-browser*.mjs` and `test-timbre-page.mjs` point to the same absent paths.
- `api/README.md:80` refers to "the parent engine-lab report", which is not in the repository.
- `validation/legacy-identity.mjs` is the evidence for the API README's "reproduces model-2 numbers exactly" claim. It passes (12 cases, 0 mismatches) but is not part of `npm test`.
- **Fix.** Delete or retarget the obsolete scripts, add `legacy-identity.mjs` to the test script, and replace the dangling references.

### L4 — Low: the release check accepts any 40-hex source commit (Verified)

- **Evidence.** `scripts/check-release.mjs` only matches `sourceCommit` against `/^[a-f0-9]{40}$/`. It compares against `CARLAB_SOURCE_COMMIT` only when that variable is set. Builds inside lm-remote record the runner's snapshot SHA:
  - The first job here produced `ee338636…`.
  - The final job produced `50a71ab4…`. That job computed `CARLAB_SOURCE_COMMIT` inside the runner, which is itself the documented pitfall.
  - The check passed in both cases.
- `docs/licensing/VERIFICATION.md` documents the correct procedure.
- **Fix.** For release builds, make `CARLAB_SOURCE_COMMIT` mandatory in `check-release.mjs`. Optionally assert that the commit exists in the repository (`git cat-file -e`) when run outside the runner.

### L5 — Low: the back/forward-cache claim is not covered by a repository test (behaviour verified correct)

- `docs/deployment/README.md:25` claims a suspended back/forward-cache page is preserved. `test-workshop.mjs` tests only `beforeunload`.
- The reviewer's probe (`evidence-2026-11-01/browser-bfcache.mjs`, job `carlab-1101-135938-61103`) confirmed the behaviour:
  - Navigating away and back restores the same document with `pageshow.persisted = true`.
  - Audio is stopped and the context suspended.
  - The native model stays usable.
  - Restart and preset changes work, with 0 page errors.
- **Fix.** Add the probe's assertions to `test-workshop.mjs`. Note that Puppeteer's `goBack({waitUntil:'networkidle0'})` hangs on bfcache restores, so wait on `domcontentloaded` with a page predicate instead.

### L6 — Low (hardening, code-read): no Content-Security-Policy or framing policy

- `public/_headers` sets `nosniff` and `Referrer-Policy` only.
- The application has no authentication or secrets, and the review found no injection sink, so impact is low.
- **Fix.** Add a CSP as defence in depth, for example `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'`. Verify with the browser suites first; the worklet and WASM may need adjustments.

### I1 — Info: "private" statements to update at publication

No `UNLICENSED` or "no licence grant" claim remains after `31ba8c7`. The following still describe the repository as private:

- `README.md:25` ("private within the organization")
- `README.md:29` ("remains private while the pre-publication review is in progress")
- `docs/deployment/README.md:3`

`docs/deployment/proof/deployment.json` (`"private": true`) is a historical record and can stay. `"private": true` in `package.json` and `api/package.json` only prevents npm publication, which is intentional.

### I2 — Info: production exposes a full control hook

- `main.ts:323` assigns `window.__engineLab`, which can start and stop playback, set configuration and read state.
- It is same-origin only and was used by the test harnesses, so there is no security impact.
- Consider gating it behind a query flag if it should not be a public surface.

### I3 — Info: identifying metadata in the repository

- Six proof JSON files record the machine hostname (`host: "<redacted-local-hostname>"`) under `docs/deployment/proof/` and `docs/workshop/proof/`.
- Commit metadata carries the author e-mail (see B1).
- The owner can choose to keep, redact or regenerate these.

## Verified without findings

- **Secrets and history.**
  - A pattern scan of every reachable blob covered AWS, GitHub and Slack tokens, private keys, Cloudflare tokens, JWTs, API keys, authorization headers, `account_id` and generic secret assignments. It found no credentials. The only other hits were benign: upstream author e-mail addresses inside the verbatim `licenses/vite-MIT.md`, and a DOI number in `credits.md:187` that matches a private-IP pattern.
  - `.env*`, `.cloudflare/` and build outputs are ignored.
  - `check-release.mjs` rejects `.env`, `.git`, `node_modules`, `src`, `.map` and key-file extensions in published assets. No sourcemaps are published.
- **Licence texts.**
  - `LICENSE` is byte-identical to apache.org `LICENSE-2.0.txt` (SHA-256 `cfc7749b…d30`).
  - `licenses/cantera-BSD-3-Clause.txt` is byte-identical to Cantera v3.1.0 `License.txt`.
  - `licenses/vite-MIT.md` is byte-identical to the installed Vite 8.3.5 `LICENSE.md`.
  - `api/package.json`, `package.json` and `native/Cargo.toml` declare `Apache-2.0`.
  - The packed API contains `LICENSE`, `NOTICE`, `credits.md` and the Cantera notice; `test-api-consumer.mjs` passed with byte checks.
- **NASA coefficient provenance.**
  - The reviewer fetched Cantera v3.1.0 `data/nasa_gas.yaml`. Its SHA-256 `4de6199d…4db` matches the code comment.
  - All N2, O2, CO2, H2O, CO and H2 coefficients (low and high ranges) and the single-range Ar fit are exactly equal to `native/src/gas_properties.rs`.
  - The attribution in `credits.md` §2, `THIRD_PARTY_NOTICES.md`, `NOTICE` and the generated inventory is accurate.
  - The baseline statement in `docs/references.md` ("not a NASA coefficient dataset") was misleading. `31ba8c7` has corrected it.
- **Shipped JavaScript bundle.**
  - The only third-party runtime code is Three.js (MIT notice shipped) and Vite's preload helper (`__vite__mapDeps`). No Rolldown runtime helpers were detected.
  - The WASM links serde, serde_json, itoa, ryu and memchr; their notices are in the generated inventory.
- **Audio attribution.**
  - `public/references/classic-v12-43483-preview-hq.mp3` matches the SHA-256 recorded in `ATTRIBUTION.md`.
  - Author, title, source URL, licence URL and change statement for CC BY 3.0 are present in `ATTRIBUTION.md`, the UI credit (`main.ts:72`) and `credits.md`.
  - `NOTICE` disclaims endorsement or affiliation for manufacturer names.
  - The reference recording is not used by the synthesis (code-read: `main.ts` plays it only through an `<audio>` element).
- **WASM and API boundary robustness.** Job `carlab-1101-135005-35319`, harness `evidence-2026-11-01/wasm-boundary-fuzz.mjs`:
  - 57,261 structured mutations across every dispatch operation seed, powertrain/ECU/engine leaves, synth configuration and physical audio state, plus raw ABI misuse: null or out-of-bounds pointers, unknown handles, zero frames, oversized allocation, 5,000-deep JSON nesting, handle exhaustion and recovery, double dispose and use-after-dispose.
  - Result: **0 WASM traps, 0 bricked instances, 0 requests over 1.5 s** (as a hang detector, not a benchmark), **0 non-finite or over-range audio blocks**.
  - 37,825 malformed requests were rejected with typed errors.
  - Handle limits (128), the 4 MB request cap, frame bounds and `dt`/`steps` bounds hold.
- **Hostile imports in the browser.** Job `carlab-1101-135749-57958`, harness `evidence-2026-11-01/browser-hostile-imports.mjs`:
  - An HTML/JS payload was sent through library names and notes (save and import), exhaust names, VE-map provenance, ECU CSV IDs, configuration enums and the pressure-source field. A material card with a payload was rejected by schema validation before display.
  - Result: 0 script executions, 0 injected elements, payload shown literally as text, 0 page errors, 0 dialogs.
  - After the hostile configuration import, only valid values remained in the live configuration (layout `inline`, perspective `exhaust`).
  - Rendering paths use `textContent` or `escape()`; `innerHTML` templates interpolate only constants, translated strings or normalised numbers.
- **Audio control stability.**
  - 12 rapid power toggles end in a consistent stopped and suspended state.
  - Preset churn plus extreme configuration (12 cylinders, 18,000 rpm redline, 2.5 bar boost) while running keeps audio running with finite telemetry.
  - `worklet.ts` has no internal try/catch, but `main.ts:180` handles `processorerror` by notifying and stopping. All DSP physical targets are clamped (`dsp.rs` `set_state`).
- **Scientific wording.** The README, `docs/model.md`, the API README and `credits.md` consistently disclaim validation, calibration transfer, digital-twin status, material safety and acoustic fidelity. The Mazda protocols set `heldOutAccuracyClaim: false` and freeze splits before fitting. No unhedged accuracy claim was found.
  - Minor gap: `docs/model.md` does not mention the model-3 options (NASA-7 mode, Woschni, valve geometry). They are documented in `api/README.md` and `credits.md`.

## Tests performed

All builds and tests ran through `lm-remote --host local`; browser jobs used `--gpu` with headless Chrome. No visible browser windows were opened. No benchmark or performance claims are made.

| Job | Tree | Result |
|---|---|---|
| `carlab-1101-134624-25460` | `a9c5c80` | typecheck pass. `npm run test:all` pass (exit 0). `npm run build` pass. `check-release` pass (45 files). Packed API consumer pass. |
| `carlab-1101-135202-42425` | `31ba8c7` (licensing in progress) | `npm test`: 160/160 pass. `analyze.test.py`: 5/5 pass. Captured the Mazda script errors (L3). |
| `carlab-1101-135005-35319` | `31ba8c7` | `legacy-identity.mjs`: 12 cases, 0 mismatches. WASM fuzz as above. |
| `carlab-1101-135401-48878` | `31ba8c7` | Null-result triage (M1). |
| `carlab-1101-135643-55125` | working tree | Regeneration of `v12-classic-rev.wav` does not match (L2). |
| `carlab-1101-135557-52847` (gpu) | `31ba8c7` | Build pass. `test-workshop` 52/52, `test-browser-v4` 30/30, `test-browser-efi` 24/24, `test-browser-v3` 22/22. 0 page errors and 0 uploads in every suite. |
| `carlab-1101-135749-57958` (gpu) | working tree | Hostile-import and audio-stability probe. |
| `carlab-1101-135938-61103` (gpu) | working tree | bfcache lifecycle probe (L5). |
| `carlab-1101-140051-64231` | `8169364` clean | typecheck pass. Node 160/160. Rust 128/128. Build pass. `check-release` pass (50 files). Packed API consumer pass. WASM `6bd40eda…` unchanged. |

External reads were limited to single GET requests:

- Cantera v3.1.0 `nasa_gas.yaml` and `License.txt`
- apache.org `LICENSE-2.0.txt`
- the EPA Mazda archive (5.9 MB, once)
- the live site's `/` and `/build.json`

No load testing or authenticated requests were made against the live site.

The prior research workspace was read only to resolve provenance, specifically for B2 and L2.

## Not checked

- No `npm audit` or `cargo audit`. Advisory databases were not queried; the Cargo graph is small and pinned.
- No Safari or Firefox runs. remix-mac2 was not used.
- No live re-verification of the Freesound page licence, the NASA NTRS record or EPA's site-wide disclaimer page. Hashes and archived wording were verified as listed above.
- Translations other than those exercised by `test-workshop` (seven mobile locales) were not reviewed for meaning.
- Not a legal opinion. The ownership (B1) and data-use (B2) conclusions need the owner's confirmation.
