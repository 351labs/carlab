#!/usr/bin/env bash
# Run this build through lm-remote, from the CarLab repository.
# Native executable/targets are ignored; ship the reviewed WASM asset with the TypeScript API.
set -euo pipefail
cd "$(dirname "$0")"
engine_lab_build_kind=${1:-all}
case "$engine_lab_build_kind" in native|wasm|all) ;; *) echo 'Usage: build-native.sh [native|wasm|all]' >&2; exit 2;; esac
engine_lab_native_root="$PWD/native"
mkdir -p "$engine_lab_native_root/dist"
engine_lab_lock_flag=()
if test -f "$engine_lab_native_root/Cargo.lock"; then engine_lab_lock_flag=(--locked); fi
if test "$engine_lab_build_kind" = native || test "$engine_lab_build_kind" = all; then
 cargo build --offline "${engine_lab_lock_flag[@]}" --manifest-path "$engine_lab_native_root/Cargo.toml" --release --lib --bin carlab-engine
 cp "$engine_lab_native_root/target/release/carlab-engine" "$engine_lab_native_root/dist/carlab-engine"
fi
cp LICENSE NOTICE credits.md "$engine_lab_native_root/dist/"
mkdir -p "$engine_lab_native_root/dist/licenses"
cp licenses/cantera-BSD-3-Clause.txt "$engine_lab_native_root/dist/licenses/"
node native/third-party.mjs --output "$engine_lab_native_root/dist/THIRD_PARTY_NOTICES.md" --stdlib-assets "$engine_lab_native_root/dist/rust-stdlib"
if test "$engine_lab_build_kind" = wasm || test "$engine_lab_build_kind" = all; then
 cargo build --offline "${engine_lab_lock_flag[@]}" --manifest-path "$engine_lab_native_root/Cargo.toml" --release --target wasm32-unknown-unknown --lib
 cp "$engine_lab_native_root/target/wasm32-unknown-unknown/release/carlab_engine_lab.wasm" "$engine_lab_native_root/dist/carlab_engine_lab.wasm"
fi
