#!/usr/bin/env bash
# Run this build through lm-remote, from the CarLab repository.
# Native executable/targets are ignored; ship the reviewed WASM asset with the TypeScript API.
set -euo pipefail
cd "$(dirname "$0")"
# Cargo prefers encoded flags over RUSTFLAGS. Preserve whichever form Cargo
# would have used, then append path remaps as single arguments (spaces safe).
engine_lab_sep=$'\x1f'
engine_lab_flags=()
if [[ ${CARGO_ENCODED_RUSTFLAGS+x} ]]; then
  if [[ -n $CARGO_ENCODED_RUSTFLAGS ]]; then
    IFS="$engine_lab_sep" read -r -a engine_lab_flags <<< "$CARGO_ENCODED_RUSTFLAGS"
  fi
elif [[ -n ${RUSTFLAGS:-} ]]; then
  # Cargo splits RUSTFLAGS on whitespace, rather than parsing shell quotes.
  while IFS= read -r engine_lab_line; do
    read -r -a engine_lab_words <<< "$engine_lab_line"
    engine_lab_flags+=("${engine_lab_words[@]}")
  done <<< "$RUSTFLAGS"
fi
engine_lab_remap() {
  local source=$1 target=$2 physical
  [[ $source = /* ]] || source="$PWD/$source"
  [[ -n $source && $source = /* && $source != / && $source != *'='* && $source != *"$engine_lab_sep"* && $source != *$'\n'* ]] || {
    echo 'Cannot safely remap an invalid build path.' >&2; exit 1;
  }
  engine_lab_flags+=("--remap-path-prefix=$source=$target")
  if [[ -d $source ]]; then
    physical=$(cd "$source" && pwd -P)
    [[ $physical != "$source" ]] && engine_lab_flags+=("--remap-path-prefix=$physical=$target")
  fi
  return 0
}
# More specific paths come last, so Cargo, rustup and project sources retain
# distinct virtual prefixes even when they live beneath the home directory.
engine_lab_remap "$HOME" /carlab-home
engine_lab_remap "${TMPDIR:-/tmp}" /carlab-tmp
engine_lab_remap "${CARGO_HOME:-$HOME/.cargo}" /carlab-cargo
engine_lab_remap "${RUSTUP_HOME:-$HOME/.rustup}" /carlab-rustup
engine_lab_remap "$PWD" /carlab-src
engine_lab_remap "$(pwd -P)" /carlab-src
printf -v CARGO_ENCODED_RUSTFLAGS '%s' "$(IFS="$engine_lab_sep"; printf '%s' "${engine_lab_flags[*]}")"
export CARGO_ENCODED_RUSTFLAGS
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
