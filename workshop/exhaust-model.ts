import {
  BoxGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, SphereGeometry,
  TorusGeometry, Vector3,
} from 'three';
import type { EngineConfig } from '../dsp.ts';
import type { PartModel, WorkshopState } from './types.ts';
import { cylinderBetween, disposeGroup, metal, tubePath } from './model-utils.ts';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** A deliberately compact schematic: dimensions convey the controls, not CAD geometry or CFD. */
export function createExhaustModel(): PartModel {
  const root = new Group();
  let assembly = new Group();
  root.add(assembly);
  let key = '';
  let downstream: Group[] = [];
  let cutGroups: Group[] = [];
  let closedGroups: Group[] = [];
  let markers: { mesh: Mesh; z: number; start: number; end: number; phase: number }[] = [];

  function rebuild(config: EngineConfig): void {
    disposeGroup(assembly);
    root.remove(assembly);
    assembly = new Group();
    root.add(assembly);
    downstream = []; cutGroups = []; closedGroups = []; markers = [];

    const steel = metal(0x9caab0, .31, .82);
    steel.side = DoubleSide; // The cut shell must also be visible from inside.
    const headerMetal = metal(0xb5a89b, .36, .78);
    const dark = metal(0x465359, .48, .72);
    const rim = metal(0xd3d9d7, .25, .88);
    const baffle = metal(0x76858a, .5, .7);
    const glow = new MeshStandardMaterial({ color: 0xe39748, emissive: 0x9b430e, emissiveIntensity: .55, roughness: .5 });
    const count = clamp(Math.round(config.cylinders), 1, 12);
    const dual = config.layout !== 'inline';
    const bankLists: number[][] = dual ? [[], []] : [[]];
    for (let i = 0; i < count; i++) bankLists[dual && config.cylinderBanks[i] === 1 ? 1 : 0]!.push(i);
    const activeBanks = bankLists.map((list, bank) => ({ list, bank })).filter(({ list }) => list.length > 0);
    const pipeRadius = .055 + (clamp(config.pipeDiameter, 20, 140) - 20) / 120 * .055;
    const headerEnd = -.30 + (clamp(config.headerLength, .1, 2) - .1) / 1.9 * .48;
    const tailEnd = 1.55 + (clamp(config.exhaustLength, .15, 4) - .15) / 3.85 * .28;
    const chamberLength = .48 + clamp(config.muffler, 0, 1) * .38;
    const chamberRadius = pipeRadius + .105 + clamp(config.muffler, 0, 1) * .10;
    const chamberCenter = .93;
    const inlet = chamberCenter - chamberLength / 2;
    const outlet = chamberCenter + chamberLength / 2;

    // Cylinder and torus axes are rotated to follow the exhaust's X axis.
    function axial(group: Group, x: number, z: number, length: number, radius: number, material: MeshStandardMaterial, arc = Math.PI * 2): Mesh {
      const mesh = new Mesh(new CylinderGeometry(radius, radius, length, 32, 1, arc < Math.PI * 2, 0, arc), material);
      mesh.rotation.z = -Math.PI / 2;
      mesh.position.set(x, 0, z);
      group.add(mesh);
      return mesh;
    }
    function ring(group: Group, x: number, z: number, radius: number, material: MeshStandardMaterial, thickness = .018): void {
      const mesh = new Mesh(new TorusGeometry(radius, thickness, 8, 32), material);
      mesh.rotation.y = Math.PI / 2;
      mesh.position.set(x, 0, z);
      group.add(mesh);
    }

    for (const { list, bank } of activeBanks) {
      const z = dual ? (bank === 0 ? -.48 : .48) : 0;
      const headers = new Group();
      assembly.add(headers);
      const spacing = Math.min(.29, 1.3 / Math.max(1, list.length - 1));
      list.forEach((_cylinder, index) => {
        const startX = -1.65 + index * spacing;
        const startZ = z + (dual ? (bank === 0 ? -.21 : .21) : -.19);
        const startY = config.layout === 'boxer' ? .17 : .38;
        const start = new Vector3(startX, startY, startZ);
        const end = new Vector3(headerEnd, 0, z);
        const radius = pipeRadius * .58;
        headers.add(tubePath([
          start,
          new Vector3(startX + .07, startY - .17, startZ),
          new Vector3(startX + .18, .06 + index * .012, z),
          end,
        ], radius, headerMetal, 36));
        const flange = new Mesh(new BoxGeometry(.15, .055, .14), dark);
        flange.position.copy(start);
        headers.add(flange);
        const port = new Mesh(new CylinderGeometry(radius * 1.22, radius * 1.22, .035, 16), rim);
        port.position.copy(start); headers.add(port);
      });
      axial(headers, headerEnd + .06, z, .20, pipeRadius * 1.28, steel);
      ring(headers, headerEnd + .17, z, pipeRadius * 1.25, rim);

      const tail = new Group();
      assembly.add(tail); downstream.push(tail);
      axial(tail, (headerEnd + .17 + inlet) / 2, z, inlet - headerEnd - .17, pipeRadius, steel);
      ring(tail, inlet - .04, z, pipeRadius * 1.08, dark);
      axial(tail, (outlet + tailEnd) / 2, z, tailEnd - outlet, pipeRadius, steel);
      ring(tail, outlet + .04, z, pipeRadius * 1.08, dark);
      // Open, dark tailpipe mouth and polished lip.
      axial(tail, tailEnd - .07, z, .18, pipeRadius * 1.28, rim);
      const mouth = new Mesh(new CylinderGeometry(pipeRadius * 1.02, pipeRadius * 1.02, .006, 24), dark);
      mouth.rotation.z = -Math.PI / 2; mouth.position.set(tailEnd + .022, 0, z); tail.add(mouth);
      ring(tail, tailEnd + .025, z, pipeRadius * 1.15, rim, .012);

      const closed = new Group();
      const cut = new Group();
      tail.add(closed, cut); closedGroups.push(closed); cutGroups.push(cut);
      axial(closed, chamberCenter, z, chamberLength, chamberRadius, steel);
      ring(closed, inlet + .035, z, chamberRadius * .98, rim, .012);
      ring(closed, outlet - .035, z, chamberRadius * .98, rim, .012);
      // Half shell opens toward the viewer; disks and the inner perforated path
      // are illustrative sectional details, not an acoustic muffler specification.
      axial(cut, chamberCenter, z, chamberLength, chamberRadius, steel, Math.PI);
      for (let i = 0; i < 3; i++) {
        const x = inlet + chamberLength * (i + 1) / 4;
        axial(cut, x, z, .025, chamberRadius * .93, baffle);
        ring(cut, x + .015, z, pipeRadius * 1.07, dark, .009);
      }
      axial(cut, chamberCenter, z, chamberLength, pipeRadius * .74, dark);
      for (let i = 0; i < 3; i++) {
        const marker = new Mesh(new SphereGeometry(.035, 12, 8), glow);
        tail.add(marker);
        markers.push({ mesh: marker, z, start: headerEnd + .2, end: tailEnd, phase: i / 3 });
      }
    }
    if (dual && activeBanks.length === 2 && config.crossover > .001) {
      const bridge = new Group();
      assembly.add(bridge); downstream.push(bridge);
      const x = Math.min(inlet - .12, headerEnd + .30);
      const radius = pipeRadius * (.35 + clamp(config.crossover, 0, 1) * .5);
      bridge.add(cylinderBetween(new Vector3(x, 0, -.48), new Vector3(x, 0, .48), radius, steel));
      ring(bridge, x, -.48, pipeRadius * 1.05, dark, .012);
      ring(bridge, x, .48, pipeRadius * 1.05, dark, .012);
    }
  }

  return {
    root,
    update(state: WorkshopState): void {
      const c = state.config;
      const nextKey = [c.cylinders, c.layout, c.cylinderBanks.join(','), c.headerLength, c.exhaustLength, c.pipeDiameter, c.muffler, c.crossover].join('|');
      if (nextKey !== key) { rebuild(c); key = nextKey; }
      const exploded = clamp(state.exploded, 0, 1);
      for (const group of downstream) group.position.x = exploded * .24;
      for (const group of closedGroups) group.visible = !state.cutaway;
      for (const group of cutGroups) group.visible = state.cutaway;
      for (const marker of markers) {
        marker.mesh.visible = state.running && state.cutaway;
        const phase = ((state.crankAngleRad / (Math.PI * 4) + marker.phase) % 1 + 1) % 1;
        marker.mesh.position.set(marker.start + (marker.end - marker.start) * phase, .11, marker.z);
      }
    },
    dispose(): void { disposeGroup(assembly); root.remove(assembly); },
  };
}
