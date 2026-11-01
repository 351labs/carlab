// Adversarial structured-mutation probe of the CarLab WASM control boundary.
// Run from the CarLab repository root after `bash build-native.sh wasm && node api/build.mjs`.
// Functional robustness only; timings are coarse hang detectors, not benchmarks.
import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = process.argv[2] ?? 'fuzz-report.json';
const api = await import(pathToFileURL(resolve('api/dist/index.js')).href);
const bytes = await readFile(resolve('api/dist/carlab_engine_lab.wasm'));
const module = await WebAssembly.compile(bytes);
let core = api.instantiateEngineLab(module);
const fresh = () => { core = api.instantiateEngineLab(module); };

const EXTREMES = [null, true, 'x<img src=x onerror=alert(1)>', -1, 0, 1e308, -1e308, 5e-324, 1e-300, 4294967297, -0.5, [], {}, [1e308, -1e308]];
const traps = [], slow = [], nullLeaks = [], bricked = [], nonfiniteAudio = [], otherErrors = new Map();
let cases = 0, accepted = 0, rejected = 0;
const progress = resolve(out + '.progress');

function leaves(value, path = []) {
  if (Array.isArray(value)) return value.length ? value.flatMap((v, i) => (i < 4 || i === value.length - 1) ? leaves(v, [...path, i]) : []) : [path];
  if (value && typeof value === 'object') { const ks = Object.keys(value); return ks.length ? ks.flatMap(k => leaves(value[k], [...path, k])) : [path]; }
  return [path];
}
function setAt(root, path, v) { const copy = structuredClone(root); if (!path.length) return v; let o = copy; for (const k of path.slice(0, -1)) o = o[k]; o[path.at(-1)] = v; return copy; }
function countNulls(v) { if (v === null) return 1; if (Array.isArray(v)) return v.reduce((s, x) => s + countNulls(x), 0); if (v && typeof v === 'object') return Object.values(v).reduce((s, x) => s + countNulls(x), 0); return 0; }
function healthy() { try { core.request('version'); return true; } catch { return false; } }

function attempt(label, fn, baselineNulls) {
  cases++;
  writeFileSync(progress, label);
  const t0 = performance.now();
  try {
    const result = fn();
    accepted++;
    const ms = performance.now() - t0;
    if (ms > 1500) slow.push({ label, ms: Math.round(ms) });
    if (baselineNulls !== undefined && result !== undefined) { const n = countNulls(result); if (n > baselineNulls) nullLeaks.push({ label, extraNulls: n - baselineNulls }); }
    return result;
  } catch (error) {
    const ms = performance.now() - t0;
    if (ms > 1500) slow.push({ label, ms: Math.round(ms), rejected: true });
    if (error instanceof WebAssembly.RuntimeError) {
      const stillHealthy = healthy();
      traps.push({ label, message: String(error.message), instanceUsableAfterTrap: stillHealthy });
      if (!stillHealthy) bricked.push(label);
      fresh();
    } else if (error?.name === 'EngineLabError' || error instanceof RangeError || error instanceof TypeError) {
      rejected++;
    } else { otherErrors.set(String(error?.name), (otherErrors.get(String(error?.name)) ?? 0) + 1); }
    return undefined;
  }
}

// Seeds derived from the API's own normalized defaults.
const engine = core.normalizeConfig({});
const physical = core.normalizePhysicalConfig(engine, {});
const physicalModel3 = core.normalizePhysicalConfig(engine, { propertyModel: 'nasa7-fixed-composition', heatTransferModel: 'woschni', airflowModel: 'valve-geometry' });
const ecuSi = core.normalizeEcuConfig(engine, { enabled: true });
const ecuDi = core.normalizeEcuConfig({ ...engine, compression: 16, redline: 4500 }, { enabled: true, combustionMode: 'directInjectionDiesel' });
const cycleCfg = core.cycleConfigFor(engine, physical, 3000, 0.6);
const veMap = core.createAssumedVeMap(850, 7200, 0.9, 'shaped');
const thermal = core.normalizeThermalConfig({});
const screen = core.normalizeMaterialScreenConfig({});

const seeds = [
  ['normalizeConfig', { config: engine }],
  ['normalizePhysical', { engine, physical }],
  ['normalizePhysical', { engine, physical: { ...physicalModel3 } }],
  ['geometry', { engine, physical }],
  ['cycle', { config: cycleCfg }],
  ['cycleConfig', { engine, physical, rpm: 3000, throttle: 0.6, override: { intakePressurePa: 90000, exhaustTemperatureK: 900 }, boostFraction: 1 }],
  ['evaluate', { engine, physical: physicalModel3, rpm: 3000, throttle: 0.6, boostFraction: 1 }],
  ['potential', { engine, physical, samples: 16 }],
  ['normalizeThermal', { config: thermal }],
  ['normalizeMaterialScreen', { config: screen }],
  ['normalizeMap', { map: veMap, kind: 've' }],
  ['sampleMap', { map: veMap, rpm: 3000, pressureBar: 1 }],
  ['assumedVeMap', { idleRpm: 850, redlineRpm: 7200, baseVe: 0.9 }],
  ['normalizeEcuConfig', { engine, config: ecuSi }],
  ['normalizeEcuConfig', { engine: { ...engine, compression: 16, redline: 4500 }, config: ecuDi }],
  ['evaluateEcuSteady', { engine, config: ecuSi, input: { rpm: 2500, throttle: 0.4, mapPressurePa: 70000, actualAirMassFlowKgs: 0.02 } }],
  ['fuelBlendProperties', { config: ecuSi.fuel }],
  ['normalizeEcuMap', { map: ecuSi.lambdaTargetMap ?? Object.values(ecuSi).find(v => v?.schema === 'carlab-ecu-map-1'), kind: (ecuSi.lambdaTargetMap ?? Object.values(ecuSi).find(v => v?.schema === 'carlab-ecu-map-1'))?.kind }],
  ['sparkToSocFromCa10Delay', { sparkToCa10Deg: 20, burnDurationDeg: 50, wiebeEfficiency: 6.9, wiebeShape: 2 }],
];

for (const [op, base] of seeds) {
  const baseResult = attempt(`seed ${op}`, () => core.request(op, base));
  const baseNulls = baseResult === undefined ? undefined : countNulls(baseResult);
  for (const path of leaves(base)) for (const v of EXTREMES) attempt(`${op} ${path.join('.')}=${JSON.stringify(v).slice(0, 40)}`, () => core.request(op, setAt(base, path, v)), baseNulls);
}

// Stateful paths: mutate physical/ECU leaves, then integrate and render audio.
function powertrainCase(label, eng, phys) {
  attempt(label, () => {
    const p = core.createPowertrain(eng, phys);
    try {
      const s = p.stepMany({ dt: 1 / 240, steps: 120, throttle: 0.9, gear: 2 });
      const s2 = p.stepMany({ dt: 0.25, steps: 8, throttle: 0, brake: 1, gear: 0 });
      if (!Number.isFinite(s.rpm) || !Number.isFinite(s2.rpm)) nullLeaks.push({ label, rpm: [s.rpm, s2.rpm] });
      return s2;
    } finally { p.dispose(); }
  });
}
for (const path of leaves(physical)) for (const v of [-1, 0, 1e308, -1e308, null, []]) powertrainCase(`powertrain physical.${path.join('.')}=${JSON.stringify(v)}`, engine, setAt(physical, path, v));
for (const path of leaves(ecuSi)) for (const v of [-1, 0, 1e308, null]) powertrainCase(`powertrain ecu.${path.join('.')}=${JSON.stringify(v)}`, engine, { ...physical, ecu: setAt(ecuSi, path, v) });
for (const path of leaves(engine)) for (const v of [-1, 0, 1e308, null, 'v']) powertrainCase(`powertrain engine.${path.join('.')}=${JSON.stringify(v)}`, setAt(engine, path, v), physical);

// Audio: extreme config and physical targets must not end in a permanently failing synth.
const audioState = { rpm: 3000, load: 0.6, throttle: 0.6, physical: { boostBar: 0.5, fuelCut: false, intakePressureBar: 1.5, exhaustPressureBar: 1.2, exhaustMassFlowKgs: 0.1, exhaustTemperatureK: 1000, cycleEnergyScale: 1, burnDurationScale: 1, combustionPhaseDeg: 0, residualFraction: 0.05, cycleIndex: 1 } };
function audioCase(label, eng, state) {
  attempt(label, () => {
    const s = core.createSynth(eng, 48000);
    try {
      s.trigger('start'); s.setState(state, true);
      const l = new Float32Array(1024), r = new Float32Array(1024);
      for (let i = 0; i < 24; i++) { s.processStereo(l, r); if (i === 8) s.trigger('blip'); if (i === 16) s.trigger('shift'); }
      if (l.some(x => !Number.isFinite(x) || Math.abs(x) > 4) || r.some(x => !Number.isFinite(x) || Math.abs(x) > 4)) nonfiniteAudio.push({ label, peak: Math.max(...l.map(Math.abs)) });
    } catch (error) { if (String(error?.message).includes('nonfinite')) nonfiniteAudio.push({ label, error: String(error.message) }); throw error; } finally { s.dispose(); }
  });
}
for (const path of leaves(engine)) for (const v of [-1, 0, 1e308, -1e308, 5e-324]) audioCase(`audio engine.${path.join('.')}=${JSON.stringify(v)}`, setAt(engine, path, v), audioState);
for (const path of leaves(audioState)) for (const v of [-1e308, 1e308, 0, 5e-324, null]) audioCase(`audio state.${path.join('.')}=${JSON.stringify(v)}`, engine, setAt(audioState, path, v));
for (const sr of [8000, 192000]) for (const rpm of [0, 400, 30000]) audioCase(`audio sr=${sr} rpm=${rpm}`, { ...engine, cylinders: 12, redline: 18000 }, { ...audioState, rpm });

// Raw ABI misuse from an embedding caller.
const e = core.exports;
const raw = (label, fn) => attempt(`raw ${label}`, fn);
raw('request ptr=0', () => { const p = e.engine_lab_request(0, 10); return p; });
raw('request out-of-bounds', () => e.engine_lab_request(e.memory.buffer.byteLength - 4, 100));
raw('dsp unknown handle', () => e.engine_lab_dsp_process(999999, 128));
raw('dsp zero frames', () => e.engine_lab_dsp_process(1, 0));
raw('alloc huge', () => { const p = e.engine_lab_alloc(4_000_001); if (p !== 0) throw new Error('accepted huge alloc'); });
raw('deep nesting', () => core.request('normalizeConfig', { config: JSON.parse('['.repeat(5000) + ']'.repeat(5000)) }));
raw('handle exhaustion+recovery', () => { const hs = []; try { for (let i = 0; i < 200; i++) hs.push(core.createSynth(engine)); } catch {} const n = hs.length; hs.forEach(h => h.dispose()); core.createSynth(engine).dispose(); return n; });
raw('double dispose and use-after-dispose', () => { const s = core.createSynth(engine); s.dispose(); s.dispose(); try { s.processStereo(new Float32Array(8), new Float32Array(8)); } catch (x) { if (!(x?.name === 'EngineLabError')) throw x; } });

const report = { cases, accepted, rejected, traps, bricked, slow: slow.sort((a, b) => b.ms - a.ms).slice(0, 40), nullLeaks: nullLeaks.slice(0, 60), nullLeakCount: nullLeaks.length, nonfiniteAudio, otherErrors: Object.fromEntries(otherErrors) };
await writeFile(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ cases, accepted, rejected, traps: traps.length, bricked: bricked.length, slow: slow.length, nullLeaks: nullLeaks.length, nonfiniteAudio: nonfiniteAudio.length, otherErrors: report.otherErrors }));
