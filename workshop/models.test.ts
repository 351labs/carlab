import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Mesh, type BufferGeometry, type Object3D } from 'three';
import { defaultConfig, normalizeConfig } from '../presets.ts';
import type { EngineTelemetry } from '../dsp.ts';
import type { PhysicalConfig, PowertrainState } from '../powertrain.ts';
import type { PartModel, WorkshopState } from './types.ts';
import { createEngineModel } from './engine-model.ts';
import { createTurboModel } from './turbo-model.ts';
import { createExhaustModel } from './exhaust-model.ts';
import { createInjectionModel } from './injection-model.ts';

function state(): WorkshopState {
  return {
    config: normalizeConfig(defaultConfig),
    physical: { boreStrokeRatio: 1.05, rodLengthStrokeRatio: 1.7 } as PhysicalConfig,
    telemetry: { turboRpm: 10000, boost: .3 } as EngineTelemetry,
    powertrain: { rpm: 2000 } as PowertrainState,
    physicalActive: false, running: true, crankAngleRad: .7, time: 0, exploded: 0, cutaway: false,
  };
}

function meshes(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse(object => { if (object instanceof Mesh) found.push(object); });
  return found;
}
function geometries(root: Object3D): Set<BufferGeometry> {
  return new Set(meshes(root).map(mesh => mesh.geometry));
}
// Compare actual vertex arrays and transforms rather than Three's generated UUIDs.
function snapshot(root: Object3D): unknown[] {
  root.updateMatrixWorld(true);
  return meshes(root).map(mesh => ({
    matrix: Array.from(mesh.matrixWorld.elements),
    positions: Array.from(mesh.geometry.getAttribute('position').array),
    indices: mesh.geometry.index ? Array.from(mesh.geometry.index.array) : null,
  }));
}
function finiteAndBounded(root: Object3D): void {
  root.updateMatrixWorld(true);
  const all = meshes(root);
  assert.ok(all.length > 0);
  for (const mesh of all) {
    assert.ok(mesh.matrixWorld.elements.every(Number.isFinite));
    assert.ok(Array.from(mesh.geometry.getAttribute('position').array).every(Number.isFinite));
  }
  const box = new Box3().setFromObject(root);
  assert.ok(!box.isEmpty());
  for (const value of [...box.min.toArray(), ...box.max.toArray()]) {
    assert.ok(Number.isFinite(value) && Math.abs(value) < 10, `invalid or unbounded coordinate ${value}`);
  }
}
function deepFreeze(value: unknown): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
}

const models: { name: string; make: () => PartModel; change: (s: WorkshopState) => void }[] = [
  { name: 'engine', make: createEngineModel, change: s => { s.config.displacement = 5; } },
  { name: 'turbo', make: createTurboModel, change: s => { s.config.turboSize = .9; } },
  { name: 'exhaust', make: createExhaustModel, change: s => { s.config.pipeDiameter = 110; } },
  { name: 'injection', make: createInjectionModel, change: s => { s.config.cylinders = 6; } },
];

for (const { name, make, change } of models) {
  test(`${name}: finite, deterministic geometry and immutable presentation inputs`, () => {
    const first = make(), second = make(), input = state();
    deepFreeze(input);
    try {
      first.update(input, 0); second.update(input, 0);
      finiteAndBounded(first.root);
      assert.deepEqual(snapshot(first.root), snapshot(second.root));
      const cut = { ...input, cutaway: true, exploded: .7 };
      first.update(cut, 0);
      finiteAndBounded(first.root);
    } finally { first.dispose(); second.dispose(); }
  });

  test(`${name}: telemetry reuses geometry; shape change and disposal release resources`, () => {
    const model = make(), input = state();
    try {
      model.update(input, 0);
      const before = geometries(model.root);
      const shape = snapshot(model.root);
      const disposed = new Set<BufferGeometry>();
      for (const geometry of before) geometry.addEventListener('dispose', () => disposed.add(geometry));
      model.update({ ...input, telemetry: { ...input.telemetry, turboRpm: 25000, boost: .8 } }, 0);
      assert.deepEqual(geometries(model.root), before);
      assert.equal(disposed.size, 0);
      const next = state(); change(next);
      model.update(next, 0);
      finiteAndBounded(model.root);
      assert.notDeepEqual(snapshot(model.root), shape);
      assert.equal(disposed.size, before.size);
      const after = geometries(model.root);
      const finalDisposed = new Set<BufferGeometry>();
      for (const geometry of after) geometry.addEventListener('dispose', () => finalDisposed.add(geometry));
      model.dispose();
      assert.equal(finalDisposed.size, after.size);
    } finally { model.dispose(); }
  });
}

test('engine: cylinder counts, layouts and irregular bank assignment remain finite and change the assembly', () => {
  for (const cylinders of [1, 3, 4, 6, 8, 10, 12]) {
    for (const layout of ['inline', 'v', 'boxer'] as const) {
      const input = state();
      input.config = normalizeConfig({ ...defaultConfig, cylinders, layout, bankAngle: layout === 'boxer' ? 180 : 60,
        cylinderBanks: Array.from({ length: cylinders }, (_, i) => i === 0 ? 1 : 0),
        firingOrder: undefined, firingAngles: undefined });
      const model = createEngineModel();
      try { model.update(input, 0); finiteAndBounded(model.root); }
      finally { model.dispose(); }
    }
  }
  const input = state();
  input.config = normalizeConfig({ ...defaultConfig, cylinders: 6, layout: 'v', cylinderBanks: [0, 0, 0, 0, 0, 1], firingOrder: undefined, firingAngles: undefined });
  const model = createEngineModel();
  try {
    model.update(input, 0);
    const before = snapshot(model.root);
    // Mutating the existing bank array must still be noticed.
    input.config.cylinderBanks[1] = 1;
    input.config.cylinderBanks[2] = 1;
    model.update(input, 0);
    assert.notDeepEqual(snapshot(model.root), before);
    finiteAndBounded(model.root);
  } finally { model.dispose(); }
});
