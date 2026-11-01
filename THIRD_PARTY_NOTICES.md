# Third-party notices

CarLab's original code and documentation are licensed under [Apache-2.0](LICENSE).
The dependencies and reference materials retain their own licenses and terms; the Apache grant does not relicense them. See [credits.md](credits.md) for the complete bibliography and incorporation boundaries.

- Three.js 0.186.1 is MIT licensed. Its notice is preserved in [licenses/three-MIT.txt](licenses/three-MIT.txt) and copied into the public build.
- Vite 8.3.5 supplies MIT-licensed build helpers; its supplied notice is preserved in [licenses/vite-MIT.md](licenses/vite-MIT.md) and copied into the public build.
- The seven NASA-7 species coefficient sets in `native/src/gas_properties.rs` are from Cantera v3.1.0 `data/nasa_gas.yaml`, which credits McBride, Gordon and Reno, NASA TM-4513 (1993). The complete [Cantera BSD-3-Clause notice](licenses/cantera-BSD-3-Clause.txt) is preserved in source, native/API and web distributions. The fixed-composition model and its coefficient adjustments are described in [credits.md](credits.md).
- Rust standard-library and locked Cargo dependency notices are generated from the installed toolchain and `native/Cargo.lock` by `native/third-party.mjs`. Builds include the complete inventory and supplied standard-library notices in the API package and public `licenses/` directory.
- The reference audio preview retains [its author, source and CC BY 3.0 attribution](public/references/ATTRIBUTION.md).
- Original synthetic comparison recordings are generated from this laboratory's procedural model.

The extracted numeric EPA Mazda test rows in `validation/` retain their source attribution and document-specific data-use scope, described in [credits.md](credits.md). They are not an Apache-licensed manufacturer calibration map.

Scientific publications cited in [credits.md](credits.md) are research sources; their source text and datasets do not acquire a new license through this repository. Build/development tools and their transitive dependencies are identified by the pinned npm/Cargo lockfiles and upstream notices, separately from code actually linked into the browser or WASM.
