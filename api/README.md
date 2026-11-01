# @carlab/engine

An importable TypeScript/ESM API for the original Rust engine and procedural-audio core. The same Rust code builds as a native executable and as WebAssembly. The API executes the Rust/WASM module on the CPU of the importing process/browser; it does not call a remote service or use GPU compute.

The package has no npm runtime dependencies. Its built distribution includes `THIRD_PARTY_NOTICES.md` for the exact locked Cargo packages, their supplied licence texts, and the installed Rust standard-library copyright inventory/licence assets. The build generates this inventory offline; a proc-macro/build dependency in the inventory is not a claim that its code is linked into WASM. Its emitted JavaScript has no imports of the reference TypeScript model, DOM globals or Vite helpers. Public declarations are self-contained in the package. The application supplies the WASM asset, its serving/cache policy and any audio-device integration.

Original CarLab code and documentation are **Apache-2.0**. The packed distribution includes `dist/LICENSE`, `dist/NOTICE` and `dist/credits.md`. The seven NASA species coefficient sets are separately attributed to NASA TM-4513 via Cantera 3.1.0, with its full BSD-3-Clause notice in `dist/licenses/cantera-BSD-3-Clause.txt` and the generated third-party inventory. Reference recordings and measured EPA fixtures are not included in this API package.

## Build and install

From the CarLab repository, build through the project runner: On a fresh Cargo cache, first run `lm-remote --host local cargo fetch --locked --manifest-path native/Cargo.toml`; subsequent builds use the locked cache offline.

```sh
lm-remote --host local \
  --pull native/dist \
  --pull api/dist \
  'bash build-native.sh && node api/build.mjs'
```

The owner may authorize another runner when local resources are unavailable. `api/dist/` contains `index.js`, `index.d.ts`, standalone DTO declarations and `carlab_engine_lab.wasm`. Build artifacts are ignored by Git; rebuilding is necessary before installing the local package. The package is private and is not published by this workflow.

A web project can install the built local directory:

```sh
npm install /absolute/path/to/carlab/api
```

For a copy that does not depend on the source directory, pack the built package and install the resulting `.tgz`. Run package construction/consumer checks through `lm-remote` under this repository's rules.

## Web application

Copy the built WASM sidecar to the application's static assets and pass its URL. Any bundler capable of packaging ESM can import the JavaScript entry point.

```ts
import { loadEngineLab } from '@carlab/engine';

const core = await loadEngineLab({ wasm: '/assets/carlab_engine_lab.wasm' });
const engine = core.normalizeConfig({ cylinders: 4, displacement: 2, compression: 10.5 });
const physical = core.normalizePhysicalConfig(engine);
const point = core.evaluateEngine(engine, physical, 3000, 0.6);
const cycle = core.getCylinderCycle(engine, physical, 3000, 0.6);
console.log(point.torqueNm, cycle.trace.pressurePa);

const powertrain = core.createPowertrain(engine, physical);
const state = powertrain.step(1 / 60, 0.6, 0, 1);
const synth = core.createSynth(engine, 48000);
synth.setState({ rpm: state.rpm, load: state.load, throttle: state.throttle, physical: state.physical }, true);
synth.trigger('start');
const left = new Float32Array(128), right = new Float32Array(128);
synth.processStereo(left, right);
// Supply blocks to your application's AudioWorklet or another audio sink.

synth.dispose();
powertrain.dispose();
core.dispose();
```

A Vite application may instead resolve the package sidecar with its `?url` convention:

```ts
import wasmUrl from '@carlab/engine/engine.wasm?url';
const core = await loadEngineLab({ wasm: wasmUrl });
```

`loadEngineLab` also accepts a `Uint8Array`, `ArrayBuffer` or already compiled `WebAssembly.Module`. A custom `fetcher` can handle an authenticated/static-asset route. WASM has no imported runtime functions. Failed fetches, incompatible API versions and model-domain errors throw explicit errors.

## Node

```ts
import { readFile } from 'node:fs/promises';
import { loadEngineLab } from '@carlab/engine';
const bytes = await readFile(new URL(import.meta.resolve('@carlab/engine/engine.wasm')));
const core = await loadEngineLab({ wasm: bytes });
const model = core.createPowertrain({ cylinders: 12, displacement: 5 });
const state = model.stepMany({ dt: 1 / 240, steps: 2400, throttle: 0.65, gear: 0 });
console.log(state.rpm, state.thermal.wallTemperatureK);
core.dispose();
```

`stepMany` integrates inside Rust and returns the final state with one control-boundary call. It accepts 0–100,000 steps and a positive step up to 0.25 s. Individual `step` accepts zero as a state-preserving no-op. These are caller-selected numerical conditions, not wall-clock scheduling guarantees. Build the independent native CLI with `npm run build:native` through `lm-remote --host local`; `native/dist/carlab-engine --help` describes its input/output operations. Model assumptions and reproducibility limits are documented in [the model guide](../docs/model.md).

## Workers and AudioWorklet

Initialize asynchronously on a normal thread, then send `core.module` through structured cloning to each worker. `instantiateEngineLab(module)` synchronously creates an independent instance and native handle registry; no fetching is performed in the audio callback or worklet constructor. Do not share native handle numbers between instances. The API has an internal UTF-8 fallback for worklet environments without `TextEncoder`/`TextDecoder`.

Controls/analysis cross a versioned JSON boundary. Audio crosses as reused planar Float32 buffers with no per-sample JSON. `processStereo(left, right)` and `processInterleaved(output)` copy into caller-owned buffers, reacquiring native views after calls that may grow WASM memory. Each block supports 1–16,384 stereo frames. Outputs must not overlap or alias the WASM heap. Keep these output buffers and the synth handle alive across callbacks.

Destroy unused handles explicitly. Disposing a core destroys its remaining handles; it does not close an application's AudioContext or alter system audio settings. A compiled module can be reused to create another instance after disposal.

## Model and units

Public DTOs retain the v4 field names and units: SI for cylinder/flow/thermal state, bar absolute where named by the map/config API, gauge bar for boost, and degrees of crank rotation over 720°. `solveCylinderCycle` accepts raw cylinder inputs; `getCylinderCycle` derives and fits the cycle from engine/physical inputs. Gas-boundary overrides are explicit. The API also exposes calibration-map operations, pressure-derived material screening and configuration normalization.

The Rust port does not establish real-engine calibration, material-safe power, a globally closed engine/turbo energy budget or acoustic fidelity. Supply and validate appropriate measurements separately. A declared `measured` provenance remains the caller's declaration. JSON inputs reject nonfinite numbers; control requests are limited to 4,000,000 UTF-8 bytes. Physical state patches retain the previous target when omitted, and `physical: null` clears shared physical input.

## Opt-in EFI controller (package 0.6)

EFI adds version-1 operations to the Rust backend. It is disabled in default physical configurations. Existing configurations retain the legacy path until `ecu.enabled` is explicitly set. The TypeScript reference can preserve a supplied ECU JSON configuration but cannot execute it; a reference-backend UI must refuse enabled EFI rather than silently run its constant-AFR model.

In SI mode, the four maps are separate from plant breathing: `lambdaTargetMap`, `fuelCorrectionMap`, `sparkAdvanceMap` and `veEstimateMap`. They use `carlab-ecu-map-1`, RPM rows and absolute-MAP bar columns. A supplied map is a complete, strictly validated surface with provenance. Patching a controller setting does not tune the plant VE map.

```ts
const ecu = core.normalizeEcuConfig(engine, {
  enabled: true,
  fuel: { ethanolVolumeFraction: 0.3 },
  feedback: { enabled: true },
});
const physicalWithEfi = core.normalizePhysicalConfig(engine, { ...physical, ecu });
const vehicle = core.createPowertrain(engine, physicalWithEfi);
const stateWithEfi = vehicle.stepMany({ dt: 1 / 240, steps: 240, throttle: 0.6, gear: 1 });
console.log(stateWithEfi.ecu?.requestedFuelMassFlowKgs);
console.log(stateWithEfi.ecu?.deliveredFuelMassFlowKgs);
vehicle.dispose();
```

`createPowertrain` owns and couples its own controller state when EFI is enabled. For an isolated controller experiment, `createEcuSession(engine, ecu)` returns `setConfig`, `reset`, `getState`, `step`, `stepMany` and `dispose`. Input patches inherit the session's engine cylinder/displacement context and declared controller-input defaults. Supply actual conditions explicitly for a reproducible experiment. `step` accepts a zero-time state query; positive simulated time is required for batches. Changing config preserves the controller's film/history according to the Rust model; call `reset` explicitly for a new history.

`evaluateEcuSteady` is a warm open-loop actuator/film-equilibrium evaluation. It does not claim a delayed PI loop has converged. `fuelBlendProperties` accepts the full `ecu.fuel` subconfiguration; `injectorDelivery` accepts `ecu.injector` and explicit `InjectorInput`. Rail pressure and manifold pressure are absolute Pa; differential pressure is their difference. Voltage/pressure dead time, duty saturation, requested/injected/delivered fuel and film mass are distinct outputs. Lambda is a delayed/filtered mass-ratio proxy, not an oxygen-chemistry sensor model. Nullable lambda means unavailable, not zero. `learningGates` and `canLearn` describe separate rolling-stability evidence for fitting/learning; a failed learning gate does not automatically freeze an otherwise valid PI feedback update.

`fitEcuFuelMap(engine, config, observations, options)` adjusts only the fuel-correction map from explicitly declared steady observations. Target-lambda and controller air/VE maps stay fixed. Source kind, label and fingerprint are mandatory; supplied `measured` provenance is not independently verified. Samples carry explicit validity/steady declarations, cut/saturation/transient gates and optional training/validation split. Retain rejected rows, coverage and held-out errors from the result. Supply capture-session identifiers when declaring a split: the result records shared conditions/cells/sessions, missing session evidence and its independent-split status. Empty validation sets remain not evaluated with nullable metrics; a declared disjoint split is not independent real-engine validation. Fitting a simulated observation does not validate a real engine.

`searchEcuOperatingPoint(engine, physical, rpm, throttle, options)` explores a bounded simulator grid/refinement using the actuator/cylinder path. It reports concrete candidates, torque/fuel tradeoffs, constraints, boundary optima and context identity. Failed candidates have nullable metrics and an error; they do not acquire fabricated zero performance. Knock, emissions and material-life evidence are unsupported constraints, not hidden passes. A selected candidate is a simulator result under assumptions, not a safe engine tune.

Saving `EcuConfig` preserves calibration and assumptions; it does not save the live film, sensor-delay or integral-trim trajectory. The dynamic `EcuState` and cycle/estimate coupling summaries describe those separate conditions. Fuel-blend end-member properties are editable assumptions, and the two film-component inventories retain their prior mixture when the feed ethanol fraction changes.

## Direct-injection diesel mode

Package 0.6 also supports the explicit `directInjectionDiesel` combustion mode. `portInjectionSpark` remains the default. Diesel uses its own `DieselConfig`: a single declared fuel component, a separate high-pressure injector, quantity in **mg per cylinder per 720°**, minimum-lambda and injection-advance maps. The SI gasoline/ethanol maps and port-film model are not silently transferred to it.

```ts
const diesel = core.normalizeEcuConfig(engine, {
  enabled: true,
  combustionMode: 'directInjectionDiesel',
  diesel: { ignitionDelayDeg: 8, burnDurationDeg: 45, airThrottleFraction: 1 },
});
// Original synthetic test assumptions, not a real engine calibration.
const ciPoint = core.evaluateEcuSteady(engine, diesel, {
  rpm: 2000, throttle: 0.5, mapPressurePa: 100000,
  injectionDownstreamPressurePa: 4000000,
  actualAirMassFlowKgs: 0.035,
});
console.log(ciPoint.requestedFuelMgPerCylinderCycle, ciPoint.startOfCombustionDeg);
```

A declared CI `requestedFuelQuantityOverrideMg` can replace the map command in an experiment; it is still subject to the controller/actuator limits. The cylinder-side injector downstream pressure is an explicit boundary. CI controller calls reject a missing `injectionDownstreamPressurePa`; manifold pressure is not substituted. The generic injector helper accepts `downstreamPressurePa` and otherwise uses the SI manifold-pressure fallback. `DieselEcuInput` and `DieselInjectorInput` make the required CI boundary explicit for typed callers.

Ignition delay and burn duration are prescribed assumptions. The pressure-cycle kernel accepts an absolute `combustionStartDeg`; paired `fuelDeliveryStartDeg`/`fuelDeliveryDurationDeg` can constrain cumulative heat release by a uniform single-main injection schedule. This is not a spray, cetane/autoignition, pilot/post-injection or emissions solver. State quantities, pulse duration, effective injection duration, SOI, prescribed SOC and air/fuel limits are reported separately. A limit based on an assumed minimum lambda is not a measured smoke/emissions limit.

Changing fuel settings within a mode preserves the model's appropriate state. To change combustion modes, use `NativeEcuSession.setConfigAndReset` or `NativePowertrain.setConfigAndReset`; these named operations explicitly discard the old dynamic history. Plain configuration updates must not relabel stored SI fuel as diesel. Both combustion modes require the Rust backend when enabled.

Search accepts `dieselQuantityMinMg`, `dieselQuantityMaxMg`, `injectionAdvanceMinDeg`, `injectionAdvanceMaxDeg`, `dieselQuantitySteps` and `injectionAdvanceSteps` for CI. Result `mode`, `axisLabels` and resolved `axisBounds` identify the axes. Candidate SI lambda/spark fields are null in CI; CI quantity/injection fields are null in SI. Inactive option axes are omitted so exported options can be replayed in the same mode. Wrong-mode axes are rejected. The first fuel-map fitting workflow remains SI-only and explicitly rejects CI input.

## Model-3 plant options (package 0.7)

Package 0.7 runs Rust model `carlab-engine-lab-rust-3`. Every new `PhysicalConfig` option defaults to the model-2 value and then reproduces model-2 numbers exactly (`validation/legacy-identity.mjs`).

| Option | Values / unit | Effect |
|---|---|---|
| `propertyModel` | `air-standard` (default), `nasa7-fixed-composition` | NASA-7 polynomials (McBride, Gordon & Reno 1993) for fixed-composition air and CH_yO_z products, coherent u/h/cp/R; rich mixtures lose CO/H2 chemical energy (water-gas shift, K frozen at 1700 K). |
| `fuelHydrogenCarbonRatio`, `fuelOxygenCarbonRatio` | mol/mol (1.85, 0) | Fuel composition for the NASA-7 products and stoichiometry. |
| `heatTransferModel` | `constant` (default), `woschni` | Woschni 1967 coefficient (bore, pressure, temperature, characteristic gas velocity with combustion term). |
| `heatTransferMultiplier` | dimensionless (1) | Woschni only. |
| `sparkToSocDeg` | ° crank (0) | SOC = firing TDC − spark advance + offset. SI only; diesel SOC is unchanged. `sparkToSocFromCa10Delay(delay, duration, a, m)` converts a measured spark→CA10 delay. It rejects non-finite or negative delay, duration outside 8–120°, efficiency outside 1–12, shape outside 0.1–5, and resulting offsets outside the kernel’s −20–60° range. |
| `intakeCamRetardDeg`, `exhaustCamRetardDeg` | ° crank, + = later (0) | Shift opening and closing together; clamping to the kernel range is reported as a warning. |
| `airflowModel` | `ve-map-fit` (default), `valve-geometry` | `valve-geometry` solves the valves once and does not fit lift to the VE map target. `calibration.trials` logs every VE trial; `missClassification` explains a missed target. |

`evaluateEngine(engine, physical, rpm, throttle, boostFraction, override)` accepts the same fixed intake/exhaust boundary as `getCylinderCycle`, for evaluation at measured manifold conditions. Estimates add `netInletAirMassFlowKgs` (forward minus reverse intake flow) and cycle diagnostics (SOC, CA10/CA90, valve events, trapped fresh mass, wall heat loss, peak heat-transfer coefficient).

These are physics options, not a calibration of any engine. The TypeScript reference preserves them but refuses to run legacy physics in their place.
