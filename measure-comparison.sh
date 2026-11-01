#!/usr/bin/env bash
# Rebuild, measure and level-match the exact v1/v2 listening comparison.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p output/analysis/synthetic
node prepare-baseline.ts
node compare-render.ts
for key in v12-steady v12-idle v10-steady v10-idle; do
 voice=v12-highrev
 case "$key" in v10-*) voice=v10-5;; esac
 mode=steady
 case "$key" in *-idle) mode=idle;; esac
 python3 analyze.py "output/comparison/raw/before/$key/$voice-$mode.wav" \
  --output-prefix "output/analysis/synthetic/$key-before" --start 0.5 --duration 5 --label "$key v1"
 python3 analyze.py "output/comparison/raw/after/$key.wav" \
  --output-prefix "output/analysis/synthetic/$key-after" --start 0.5 --duration 5 --label "$key v2"
done
python3 analyze.py output/analysis/comparison/v12-classic-idle.wav \
 --output-prefix output/analysis/synthetic/v12-classic-idle --start 0.5 --duration 5 --label 'Original classic V12 v2'
python3 summarize-analysis.py
