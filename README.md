# CarLab

CarLab is an interactive engine laboratory for exploring engine configuration, vehicle response and procedural sound. Its workshop includes GPU-rendered 3D components and three levels of explanation: Normal, Enthusiast and Scholar. The interface supports seven languages.

The mathematical engine and audio core is written in Rust and runs on the CPU, either natively or as WebAssembly. The browser presentation uses 3D graphics; GPU rendering is separate from the CPU simulation. The TypeScript/ESM package [`@carlab/engine`](api/README.md) exposes the Rust/WASM core to other applications.

CarLab is a research and exploration tool. Its default inputs are assumptions, and outputs are conditional on the model and inputs. Calibration to measurements does not by itself establish independent validation. CarLab is not a universally validated digital twin, a safety assessment or a component-life predictor. See [model and limits](docs/model.md) and [research sources](docs/references.md).

## Develop

Install Node.js, Rust and the `wasm32-unknown-unknown` target. The Rust build uses the locked Cargo dependency cache offline; populate it with `cargo fetch --locked --manifest-path native/Cargo.toml` when necessary.

```sh
npm ci
npm run build
npm run dev
```

The build compiles the WASM core, packages the API and builds the web application. `npm run build:native` builds the native executable. Run the project tests through the configured runner:

```sh
lm-remote --host local npm run test:all
```

The intended deployment is [carlab.351labs.xyz](https://carlab.351labs.xyz), with a private GitHub repository at `351labs/carlab`. Deployment status and validation are recorded separately when available.

## Notices

See [third-party notices](THIRD_PARTY_NOTICES.md) and the [sound attribution](public/references/ATTRIBUTION.md). The build generates the Rust dependency and toolchain inventory and includes the full notices with the API and public application. These notices do not grant a licence to CarLab's own code.
