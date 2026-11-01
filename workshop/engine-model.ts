import {
  BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, TorusGeometry,
  type BufferGeometry,
} from 'three';
import type { PartModel, WorkshopState } from './types.ts';

/** A visual teaching model. Dimensions and crank phases are illustrative. */
export function createEngineModel(): PartModel {
  const root = new Group();
  root.userData.partId = 'engine';
  const assembly = new Group();
  root.add(assembly);
  const alloy = new MeshStandardMaterial({ color: 0x9ba7a9, metalness: .78, roughness: .3 });
  const dark = new MeshStandardMaterial({ color: 0x303d43, metalness: .74, roughness: .34 });
  const polished = new MeshStandardMaterial({ color: 0xd6dcdb, metalness: .9, roughness: .2 });
  const bronze = new MeshStandardMaterial({ color: 0xb68b50, metalness: .78, roughness: .3 });
  const shell = new MeshStandardMaterial({ color: 0x89979a, metalness: .72, roughness: .38, transparent: true });
  const materials = [alloy, dark, polished, bronze, shell];
  const geometries = new Set<BufferGeometry>();
  const pistons: { piston: Group; rod: Mesh; pin: Mesh; web: Mesh; cylinderId: number; crankRadius: number; rodLength: number }[] = [];
  const covers: { group: Group; y: number }[] = [];
  let crank = new Group();
  let base = new Group();
  let lastCylinders = -1, lastAngle = NaN, lastDisplacement = NaN, lastRatio = NaN;
  let lastLayout = '';
  let lastRodRatio = NaN;
  const lastBanks: number[] = [];
  let animatedAngle = 0;

  function mesh(parent: Group, geometry: BufferGeometry, material: MeshStandardMaterial, x: number, y: number, z: number): Mesh {
    geometries.add(geometry);
    const result = new Mesh(geometry, material);
    result.position.set(x, y, z);
    parent.add(result);
    return result;
  }
  function box(parent: Group, w: number, h: number, d: number, material: MeshStandardMaterial, x = 0, y = 0, z = 0): Mesh {
    return mesh(parent, new BoxGeometry(w, h, d), material, x, y, z);
  }
  function cylinder(parent: Group, r: number, h: number, material: MeshStandardMaterial, x = 0, y = 0, z = 0, segments = 24): Mesh {
    return mesh(parent, new CylinderGeometry(r, r, h, segments), material, x, y, z);
  }
  function clearGeometry(): void {
    geometries.forEach(geometry => geometry.dispose());
    geometries.clear();
    assembly.clear();
    pistons.length = 0;
    covers.length = 0;
  }
  function build(state: WorkshopState): void {
    clearGeometry();
    const n = Math.max(1, Math.min(12, Math.round(state.config.cylinders)));
    const banks = state.config.layout === 'inline' ? 1 : 2;
    const bankIds: number[][] = Array.from({ length: banks }, () => []);
    for (let id = 0; id < n; id++) {
      const bank = banks === 1 ? 0 : state.config.cylinderBanks[id] === 1 ? 1 : 0;
      bankIds[bank]!.push(id);
    }
    const rows = Math.max(...bankIds.map(ids => ids.length), 1);
    const spacing = Math.min(.72, 3.15 / Math.max(1, rows));
    const ratio = Math.max(.5, Math.min(2, state.physical.boreStrokeRatio || 1));
    const volume = Math.max(.1, Math.min(12, state.config.displacement));
    // Cube-root scaling follows relative cylinder volume; dimensions are normalized for display.
    const size = Math.max(.65, Math.min(1.18, Math.cbrt(volume / n / .5)));
    const radius = Math.min(spacing * .43, .29 * size * Math.cbrt(ratio));
    const stroke = Math.min(.53, Math.max(.22, radius * 1.5 / ratio));
    const barrelHeight = Math.max(.68, stroke + .48);
    const length = Math.max(.62, rows * spacing + .22);
    const bankAngle = state.config.layout === 'boxer' ? Math.PI : Math.max(10, Math.min(180, state.config.bankAngle)) * Math.PI / 180;

    base = new Group();
    assembly.add(base);
    box(base, banks === 1 ? .72 : .9, .48, length, dark, 0, -.18);
    box(base, banks === 1 ? .79 : .98, .09, length + .12, alloy, 0, -.44);
    box(base, banks === 1 ? .68 : .87, .08, length + .04, polished, 0, .06);
    for (let i = 0; i < rows + 1; i++) {
      const z = -length / 2 + .11 + i * spacing;
      for (const x of [-.3, .3]) cylinder(base, .035, .055, bronze, x, -.49, z, 6);
    }
    crank = new Group();
    assembly.add(crank);
    const shaft = cylinder(crank, .085, length + .36, polished);
    shaft.rotation.x = Math.PI / 2;
    const flywheel = cylinder(crank, Math.min(.48, .28 + radius * .5), .12, dark, 0, 0, length / 2 + .17, 40);
    flywheel.rotation.x = Math.PI / 2;
    const rim = cylinder(crank, Math.min(.4, .23 + radius * .5), .13, alloy, 0, 0, length / 2 + .18, 40);
    rim.rotation.x = Math.PI / 2;
    const hub = cylinder(crank, .105, .16, bronze, 0, 0, length / 2 + .19);
    hub.rotation.x = Math.PI / 2;
    for (let bank = 0; bank < banks; bank++) {
      const count = bankIds[bank]!.length;
      if (!count) continue;
      const group = new Group();
      group.rotation.z = banks === 1 ? 0 : (bank === 0 ? -1 : 1) * bankAngle / 2;
      assembly.add(group);
      // Cast walls join the bores into a single block; the inspection material
      // fades these walls with the barrels to reveal the moving mechanism.
      const wallHeight = barrelHeight * .76;
      const wallY = wallHeight / 2 + .06;
      for (const side of [-1, 1]) {
        box(group, .11, wallHeight, length, shell, side * radius * 1.04, wallY);
        box(group, .15, .07, length + .05, alloy, side * radius * 1.04, .075);
        for (let row = 0; row < count; row++) {
          const z = (row - (rows - 1) / 2) * spacing;
          box(group, .15, wallHeight * .73, .055, shell, side * radius * 1.08, wallY, z + spacing * .4);
          // Raised port flange and fasteners suggest the attachment of manifolds.
          box(group, .075, .18, Math.min(spacing * .63, .34), dark,
            side * (radius * 1.1 + .075), barrelHeight * .67, z);
          for (const dz of [-1, 1]) {
            const bolt = cylinder(group, .025, .045, bronze,
              side * (radius * 1.1 + .12), barrelHeight * .67, z + dz * Math.min(spacing * .23, .12), 6);
            bolt.rotation.z = Math.PI / 2;
          }
        }
      }
      for (const end of [-1, 1]) {
        box(group, radius * 2.1, wallHeight, .10, shell, 0, wallY, end * (length / 2 - .05));
      }
      const cover = new Group();
      cover.position.y = barrelHeight + .24;
      group.add(cover);
      covers.push({ group: cover, y: cover.position.y });
      box(cover, radius * 2.15, .21, length, dark);
      box(cover, radius * 1.84, .07, length - .06, alloy, 0, .14);
      box(cover, radius * .8, .025, length - .15, polished, 0, .19);
      for (let row = 0; row < count; row++) {
        const z = (row - (rows - 1) / 2) * spacing;
        // The barrel is transparent in cutaway so the moving parts remain legible.
        cylinder(group, radius * 1.1, barrelHeight, shell, 0, barrelHeight / 2 + .04, z, 32);
        const lip = mesh(group, new TorusGeometry(radius * 1.05, .025, 8, 32), polished, 0, barrelHeight + .04, z);
        lip.rotation.x = Math.PI / 2;
        const head = cylinder(group, radius * 1.05, .12, alloy, 0, barrelHeight + .1, z, 32);
        head.position.y += .01;
        for (const x of [-radius * .73, radius * .73]) {
          cylinder(cover, .035, .045, bronze, x, .15, z, 6);
        }
        const piston = new Group();
        group.add(piston);
        cylinder(piston, radius * .84, radius * .68, polished, 0, 0, z, 32);
        for (const y of [-radius * .12, radius * .08, radius * .24]) {
          const ring = mesh(piston, new TorusGeometry(radius * .845, .012, 6, 32), dark, 0, y, z);
          ring.rotation.x = Math.PI / 2;
        }
        const rod = cylinder(group, Math.max(.035, radius * .15), 1, alloy, 0, 0, z, 12);
        const rodRatio = Math.max(1.3, Math.min(2.5, state.physical.rodLengthStrokeRatio || 1.7));
        const crankRadius = Math.min(stroke * .31, barrelHeight * .76 / (2 * rodRatio + 1));
        const rodLength = crankRadius * 2 * rodRatio;
        // Each visual crank link is in the same bank coordinate system as its rod.
        // This keeps the teaching mechanism connected even for uneven firing phases.
        const pin = cylinder(group, Math.max(.04, radius * .18), .12, bronze, 0, 0, z, 16);
        pin.rotation.x = Math.PI / 2;
        const web = box(group, Math.max(.065, radius * .3), crankRadius, .065, dark, 0, 0, z);
        pistons.push({ piston, rod, pin, web, cylinderId: bankIds[bank]![row]! + 1, crankRadius, rodLength });
      }
      // Cam caps and rails give the covers a readable mechanical silhouette.
      for (const x of [-radius * .55, radius * .55]) {
        const rail = cylinder(cover, .035, length * .83, bronze, x, .2, 0, 12);
        rail.rotation.x = Math.PI / 2;
      }
    }
  }
  return {
    root,
    update(state) {
      const c = state.config;
      let banksChanged = lastBanks.length !== c.cylinderBanks.length;
      for (let i = 0; !banksChanged && i < c.cylinderBanks.length; i++) {
        if (lastBanks[i] !== c.cylinderBanks[i]) banksChanged = true;
      }
      if (lastCylinders !== c.cylinders || lastLayout !== c.layout || lastAngle !== c.bankAngle ||
          lastDisplacement !== c.displacement || lastRatio !== state.physical.boreStrokeRatio ||
          lastRodRatio !== state.physical.rodLengthStrokeRatio || banksChanged) {
        lastCylinders = c.cylinders; lastLayout = c.layout; lastAngle = c.bankAngle;
        lastDisplacement = c.displacement; lastRatio = state.physical.boreStrokeRatio;
        lastRodRatio = state.physical.rodLengthStrokeRatio;
        lastBanks.length = 0;
        for (const bank of c.cylinderBanks) lastBanks.push(bank);
        build(state);
      }
      const exploded = Math.max(0, Math.min(1, state.exploded));
      shell.opacity = state.cutaway ? .18 : 1;
      shell.depthWrite = !state.cutaway;
      base.visible = !state.cutaway;
      if (state.running) animatedAngle = state.crankAngleRad;
      crank.rotation.z = animatedAngle;
      for (const cover of covers) cover.group.position.y = cover.y + exploded * .65 + (state.cutaway ? .2 : 0);
      for (const item of pistons) {
        const eventIndex = c.firingOrder.indexOf(item.cylinderId);
        const firingAngle = eventIndex >= 0 ? c.firingAngles[eventIndex] : undefined;
        const phase = animatedAngle - (Number.isFinite(firingAngle) ? firingAngle! * Math.PI / 180 : 0);
        const pinX = Math.sin(phase) * item.crankRadius;
        const pinY = Math.cos(phase) * item.crankRadius;
        const rodRise = Math.sqrt(Math.max(0, item.rodLength * item.rodLength - pinX * pinX));
        item.piston.position.y = pinY + rodRise;
        item.pin.position.x = pinX;
        item.pin.position.y = pinY;
        item.web.position.x = pinX / 2;
        item.web.position.y = pinY / 2;
        item.web.rotation.z = -phase;
        item.rod.position.x = pinX / 2;
        item.rod.position.y = pinY + rodRise / 2;
        item.rod.scale.y = item.rodLength;
        item.rod.rotation.z = Math.atan2(pinX, rodRise);
      }
    },
    dispose() {
      clearGeometry();
      materials.forEach(material => material.dispose());
      root.clear();
    },
  };
}
