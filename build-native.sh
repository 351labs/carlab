#!/usr/bin/env bash
# Run this build through lm-remote, from the CarLab repository.
# Native executable/targets are ignored; ship the reviewed WASM asset with the TypeScript API.
set -euo pipefail
cd "$(dirname "$0")"
# Keep Cargo's own rustflags selection intact, including target configuration.
# A compiler wrapper adds remaps to every crate, including dependencies.
engine_lab_sep=$'\x1f'
engine_lab_flags=()
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
engine_lab_build_kind=${1:-all}
case "$engine_lab_build_kind" in native|wasm|all) ;; *) echo 'Usage: build-native.sh [native|wasm|all]' >&2; exit 2;; esac
engine_lab_native_root="$PWD/native"
# Stable Cargo does not expose its merged configuration. Do not silently
# override a configured build.rustc-wrapper: when configuration exists, require
# an explicit environment selection (RUSTC_WRAPPER='' deliberately disables it).
if [[ ! ${RUSTC_WRAPPER+x} && ! ${CARGO_BUILD_RUSTC_WRAPPER+x} ]]; then
  for engine_lab_config_dir in "$PWD" "$(pwd -P)"; do
    while :; do
      if [[ -f "$engine_lab_config_dir/.cargo/config" || -f "$engine_lab_config_dir/.cargo/config.toml" ]]; then
        echo 'Cargo configuration found; set RUSTC_WRAPPER explicitly to its intended wrapper, or to an empty value to disable it.' >&2
        exit 1
      fi
      [[ $engine_lab_config_dir = / ]] && break
      engine_lab_config_dir=${engine_lab_config_dir%/*}
      [[ -n $engine_lab_config_dir ]] || engine_lab_config_dir=/
    done
  done
  engine_lab_cargo_home=${CARGO_HOME:-$HOME/.cargo}
  if [[ -f "$engine_lab_cargo_home/config" || -f "$engine_lab_cargo_home/config.toml" ]]; then
    echo 'Cargo configuration found; set RUSTC_WRAPPER explicitly to its intended wrapper, or to an empty value to disable it.' >&2
    exit 1
  fi
fi
engine_lab_target_base=$(cargo metadata --offline --no-deps --format-version 1 --manifest-path "$engine_lab_native_root/Cargo.toml" | node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => process.stdout.write(JSON.parse(s).target_directory))')
export CARLAB_REMAP_FLAGS="$(IFS="$engine_lab_sep"; printf '%s' "${engine_lab_flags[*]}")"
export CARLAB_INNER_RUSTC_WRAPPER="${RUSTC_WRAPPER-${CARGO_BUILD_RUSTC_WRAPPER:-}}"
# The wrapper's extra arguments are invisible to Cargo's fingerprints. Keep a
# separate cache keyed by the remaps and inner wrapper, so an old unremapped
# build or a different runner's paths can never satisfy this build.
engine_lab_key=$(node -e 'const c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(process.env.CARLAB_REMAP_FLAGS).update("\0").update(process.env.CARLAB_INNER_RUSTC_WRAPPER).digest("hex"))')
export CARGO_TARGET_DIR="$engine_lab_target_base/carlab-remapped/$engine_lab_key"
engine_lab_wrapper_dir=$(mktemp -d "${TMPDIR:-/tmp}/carlab-rustc.XXXXXXXX")
trap 'rm -rf "$engine_lab_wrapper_dir"' EXIT
cat > "$engine_lab_wrapper_dir/rustc-wrapper.rs" <<'WRAPPER'
use std::{env, os::unix::process::CommandExt, process::{Command, exit}};

fn main() {
    let mut args = env::args_os().skip(1);
    let compiler = args.next().unwrap_or_else(|| exit(2));
    let inner = env::var_os("CARLAB_INNER_RUSTC_WRAPPER").unwrap_or_default();
    let mut command = if inner.is_empty() {
        Command::new(compiler)
    } else {
        let mut command = Command::new(inner);
        command.arg(compiler);
        command
    };
    command.args(args);
    if let Ok(remaps) = env::var("CARLAB_REMAP_FLAGS") {
        command.args(remaps.split('\u{1f}'));
    } else { exit(2); }
    // A native wrapper preserves Cargo's dynamic-library environment on macOS.
    let _ = command.exec();
    eprintln!("Unable to start the configured Rust compiler wrapper.");
    exit(1);
}
WRAPPER
"${RUSTC:-rustc}" --edition=2021 "$engine_lab_wrapper_dir/rustc-wrapper.rs" -o "$engine_lab_wrapper_dir/rustc-wrapper"
export RUSTC_WRAPPER="$engine_lab_wrapper_dir/rustc-wrapper"
mkdir -p "$engine_lab_native_root/dist"
engine_lab_lock_flag=()
if test -f "$engine_lab_native_root/Cargo.lock"; then engine_lab_lock_flag=(--locked); fi
if test "$engine_lab_build_kind" = native || test "$engine_lab_build_kind" = all; then
 cargo build --offline "${engine_lab_lock_flag[@]}" --manifest-path "$engine_lab_native_root/Cargo.toml" --release --lib --bin carlab-engine
 cp "$CARGO_TARGET_DIR/release/carlab-engine" "$engine_lab_native_root/dist/carlab-engine"
fi
cp LICENSE NOTICE credits.md "$engine_lab_native_root/dist/"
mkdir -p "$engine_lab_native_root/dist/licenses"
cp licenses/cantera-BSD-3-Clause.txt "$engine_lab_native_root/dist/licenses/"
node native/third-party.mjs --output "$engine_lab_native_root/dist/THIRD_PARTY_NOTICES.md" --stdlib-assets "$engine_lab_native_root/dist/rust-stdlib"
if test "$engine_lab_build_kind" = wasm || test "$engine_lab_build_kind" = all; then
 cargo build --offline "${engine_lab_lock_flag[@]}" --manifest-path "$engine_lab_native_root/Cargo.toml" --release --target wasm32-unknown-unknown --lib
 cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/carlab_engine_lab.wasm" "$engine_lab_native_root/dist/carlab_engine_lab.wasm"
fi
