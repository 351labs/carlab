# CarLab

CarLab is an interactive engine laboratory for exploring engine configuration, vehicle response and procedural sound. Its workshop includes GPU-rendered 3D components and three levels of explanation: Normal, Enthusiast and Scholar. The interface supports seven languages.

The mathematical engine and audio core is written in Rust and runs on the CPU, either natively or as WebAssembly. The browser presentation uses 3D graphics; GPU rendering is separate from the CPU simulation. The TypeScript/ESM package [`@carlab/engine`](api/README.md) exposes the Rust/WASM core to other applications.

CarLab is a research and exploration tool. Its default inputs are assumptions, and outputs are conditional on the model and inputs. Calibration to measurements does not by itself establish independent validation. CarLab is not a universally validated digital twin, a safety assessment or a component-life predictor. See [model and limits](docs/model.md) and the complete [research and source credits](credits.md).

## Develop

Install Node.js, Rust and the `wasm32-unknown-unknown` target. The Rust build uses the locked Cargo dependency cache offline; populate it with `cargo fetch --locked --manifest-path native/Cargo.toml` when necessary.

```sh
npm ci
lm-remote --host local --timeout 12 --pull native/dist --pull api/dist --pull dist --pull .cloudflare/output/v0 npm run build
npm run dev
```

The build compiles the WASM core, packages the API and builds the web application. `npm run build:native` builds the native executable. Run the project tests through the configured runner:

```sh
lm-remote --host local npm run test:all
```

Production is [carlab.351labs.xyz](https://carlab.351labs.xyz). The independent source repository is [351labs/carlab](https://github.com/351labs/carlab), private within the organization. See [deployment, verification and update instructions](docs/deployment/README.md).

## Notices

CarLab's original code and documentation are licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE), [credits.md](credits.md), [third-party notices](THIRD_PARTY_NOTICES.md) and the [sound attribution](public/references/ATTRIBUTION.md). Third-party code, coefficient data, measured data and reference audio retain their own terms. The build includes the Apache license, credits, Cantera notice and generated Rust dependency/toolchain inventory with the API and public application. The source repository remains private while the pre-publication review is in progress.
