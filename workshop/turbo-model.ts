import {
  BufferGeometry, CylinderGeometry, DoubleSide, Float32BufferAttribute, Group,
  Mesh, MeshStandardMaterial, TorusGeometry, Vector3,
} from 'three';
import type { PartModel, WorkshopState } from './types.ts';
import { cylinderBetween, disposeGroup, metal } from './model-utils.ts';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));

/** A growing circular scroll around the shaft, with an optional inspection opening. */
function scrollGeometry(radius: number, tube: number, cutaway: boolean): BufferGeometry {
  const positions: number[] = [], indices: number[] = [];
  const steps = 72, sides = 20;
  // The inspection version leaves a broad opening in the front of the casting.
  // Open the positive-X side, toward the default camera, to expose the wheel.
  const phiStart = cutaway ? Math.PI * .85 : 0;
  const phiEnd = cutaway ? Math.PI * 2.15 : Math.PI * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, a = t * Math.PI * 1.92;
    const r = radius * (.76 + .24 * t), section = tube * (.42 + .58 * t);
    for (let j = 0; j <= sides; j++) {
      const p = phiStart + (phiEnd - phiStart) * j / sides;
      const radial = r + section * Math.cos(p);
      positions.push(section * Math.sin(p), radial * Math.cos(a), radial * Math.sin(a));
      if (i < steps && j < sides) {
        const k = i * (sides + 1) + j;
        indices.push(k, k + sides + 1, k + 1, k + 1, k + sides + 1, k + sides + 2);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setIndex(indices); g.computeVertexNormals();
  return g;
}

function bladeGeometry(radius: number, width: number): BufferGeometry {
  const positions: number[] = [], indices: number[] = [];
  const radialSteps = 10, axialSteps = 3;
  for (let i = 0; i <= radialSteps; i++) {
    const t = i / radialSteps, r = radius * (.19 + .81 * t);
    for (let j = 0; j <= axialSteps; j++) {
      const u = j / axialSteps, angle = .82 * t + .3 * u;
      positions.push((u - .5) * width * (1 - .5 * t), r * Math.cos(angle), r * Math.sin(angle));
      if (i < radialSteps && j < axialSteps) {
        const k = i * (axialSteps + 1) + j;
        indices.push(k, k + axialSteps + 1, k + 1, k + 1, k + axialSteps + 1, k + axialSteps + 2);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setIndex(indices); g.computeVertexNormals();
  return g;
}

function axialCylinder(radius: number, length: number, material: MeshStandardMaterial, x: number, radius2 = radius): Mesh {
  const mesh = new Mesh(new CylinderGeometry(radius, radius2, length, 32), material);
  mesh.rotation.z = Math.PI / 2; mesh.position.x = x;
  return mesh;
}
function ring(radius: number, tube: number, material: MeshStandardMaterial, x: number): Mesh {
  const m = new Mesh(new TorusGeometry(radius, tube, 8, 48), material);
  m.rotation.y = Math.PI / 2; m.position.x = x;
  return m;
}

/** Presentation-only turbo: all motion is deliberately slowed and illustrative. */
export function createTurboModel(): PartModel {
  const root = new Group();
  let assembly = new Group(), compressor = new Group(), turbine = new Group();
  let compressorWheel = new Group(), turbineWheel = new Group();
  let solid: Group[] = [], sectioned: Group[] = [];
  let key = '', phase = 0;
  root.add(assembly);

  function rebuild(size: number, boost: number, intake: number): void {
    root.remove(assembly); disposeGroup(assembly);
    assembly = new Group(); root.add(assembly);
    compressor = new Group(); turbine = new Group();
    compressorWheel = new Group(); turbineWheel = new Group();
    solid = []; sectioned = [];
    const aluminum = metal(0xaab5b8, .38, .78), iron = metal(0x726b66, .66, .65);
    aluminum.side = DoubleSide; iron.side = DoubleSide;
    const dark = metal(0x303b40, .5, .72), bright = metal(0xd3dcda, .3, .85);
    const bronze = metal(0x9c8058, .43, .75);
    const blades = metal(0xc6d0cf, .32, .82); blades.side = DoubleSide;
    const r = .65 + size * .25, scrollTube = .22 + size * .075;
    const halfWidth = .56;
    assembly.add(compressor, turbine);
    assembly.add(axialCylinder(.25, .9, dark, 0), axialCylinder(.12, 2.0, bright, 0));
    assembly.add(ring(.27, .035, bronze, -.28), ring(.27, .035, bronze, .28));

    function housing(group: Group, mat: MeshStandardMaterial, sign: number): void {
      const full = new Group(), cut = new Group();
      full.add(new Mesh(scrollGeometry(r, scrollTube, false), mat));
      cut.add(new Mesh(scrollGeometry(r, scrollTube, true), mat));
      group.add(full, cut); solid.push(full); sectioned.push(cut);
      // Two adjacent spiral passages suggest a divided inlet to the turbine.
      const secondaryFull = new Mesh(scrollGeometry(r * .78, scrollTube * .55, false), mat);
      const secondaryCut = new Mesh(scrollGeometry(r * .78, scrollTube * .55, true), mat);
      secondaryFull.position.x = -sign * .12; secondaryCut.position.x = -sign * .12;
      full.add(secondaryFull); cut.add(secondaryCut);
      full.add(axialCylinder(r * .69, .12, mat, -sign * .16));
      group.add(ring(r * .68, .035, dark, -sign * .22));
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        const bolt = axialCylinder(.042, .12, bright, -sign * .25);
        bolt.position.y = Math.cos(a) * r * .64; bolt.position.z = Math.sin(a) * r * .64;
        group.add(bolt);
      }
      const outlet = cylinderBetween(new Vector3(0, r * .84, -.16), new Vector3(0, r + .55, -.16), scrollTube * .82, mat);
      group.add(outlet);
      const flange = cylinderBetween(new Vector3(0, r + .50, -.16), new Vector3(0, r + .61, -.16), scrollTube * 1.13, dark);
      group.add(flange);
    }
    housing(compressor, aluminum, -1); housing(turbine, iron, 1);
    compressor.position.x = -halfWidth; turbine.position.x = halfWidth;

    // Axial intake and turbine exit are open pipes, with a dark throat behind each rim.
    const inletLength = .25 + intake * .28;
    const inlet = new Group(), exit = new Group();
    inlet.add(axialCylinder(r * .36, inletLength, aluminum, -inletLength / 2 - .12));
    inlet.add(axialCylinder(r * .29, .012, dark, -inletLength - .125));
    inlet.add(ring(r * .32, .035, bright, -inletLength - .14));
    exit.add(axialCylinder(r * .40, .32, iron, .28));
    exit.add(axialCylinder(r * .32, .012, dark, .446));
    exit.add(ring(r * .36, .04, dark, .45));
    compressor.add(inlet); turbine.add(exit); solid.push(inlet, exit);

    function wheel(group: Group, x: number, wheelRadius: number): void {
      group.position.x = x;
      group.add(axialCylinder(wheelRadius * .18, .3, bronze, 0, wheelRadius * .10));
      const geometry = bladeGeometry(wheelRadius, .25);
      for (let i = 0; i < 11; i++) {
        const blade = new Mesh(geometry, blades); blade.rotation.x = i * Math.PI * 2 / 11; group.add(blade);
      }
      assembly.add(group);
    }
    wheel(compressorWheel, -halfWidth - .05, r * .64);
    wheel(turbineWheel, halfWidth + .05, r * .60);

    // Wastegate canister and articulated linkage on the turbine casting.
    const actuatorRadius = .16 + boost / 6 * .06;
    const can = axialCylinder(actuatorRadius, .25, dark, .24);
    can.position.set(.28, -.72, .53); turbine.add(can);
    const cap = axialCylinder(actuatorRadius * .84, .035, aluminum, .43);
    cap.position.set(.43, -.72, .53); turbine.add(cap);
    turbine.add(cylinderBetween(new Vector3(.42, -.72, .53), new Vector3(.62, -.43, .48), .035, bright));
    turbine.add(cylinderBetween(new Vector3(.62, -.43, .48), new Vector3(.54, -.29, .28), .055, bronze));
    // Static metadata is available to the hosting UI for a localized inactive label.
    root.userData.turboFitted = boost > 0;
    root.userData.presentation = 'illustrative';
  }

  return {
    root,
    update(state, dt) {
      const size = clamp(state.config.turboSize, 0, 1);
      const boost = clamp(state.config.boostBar, 0, 6);
      const intake = clamp(state.config.intakeLength, 0, 2);
      // Boost changes the fitted state and proportions, without inventing measured output.
      const nextKey = `${size}|${boost}|${intake}`;
      if (nextKey !== key) { rebuild(size, boost, intake); key = nextKey; }
      const separation = clamp(state.exploded, 0, 1) * .65;
      compressor.position.x = -.56 - separation; turbine.position.x = .56 + separation;
      compressorWheel.position.x = -.61 - separation; turbineWheel.position.x = .61 + separation;
      for (const group of solid) group.visible = !state.cutaway;
      for (const group of sectioned) group.visible = state.cutaway;
      compressorWheel.visible = state.cutaway; turbineWheel.visible = state.cutaway;
      if (state.running && boost > 0) {
        const rpm = clamp(state.telemetry.turboRpm, 0, 250000);
        const pressure = clamp(state.telemetry.boost, 0, 6);
        phase = (phase + clamp(dt, 0, .1) * (rpm / 250000 * 5 + pressure / 6)) % (Math.PI * 2);
      }
      compressorWheel.rotation.x = phase; turbineWheel.rotation.x = phase;
    },
    dispose() { disposeGroup(assembly); root.clear(); },
  };
}
