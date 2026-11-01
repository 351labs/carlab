import {
  BoxGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial,
  SphereGeometry, TorusGeometry, Vector3,
} from 'three';
import type { PartModel, WorkshopState } from './types.ts';
import { disposeGroup, metal, tubePath } from './model-utils.ts';

/** An educational assembly, not a geometric engine or spray simulation. */
export function createInjectionModel(): PartModel {
  const root = new Group();
  let key = '';
  let rail = new Group();
  let intake = new Group();
  let injectors: Group[] = [];
  let cones: Mesh[] = [];

  function build(count: number, diesel: boolean, cutaway: boolean): void {
    disposeGroup(root);
    rail = new Group(); intake = new Group(); injectors = []; cones = [];
    const alloy = metal(0xaab5ba, .29, .82);
    const dark = metal(0x303b42, .44, .65);
    const black = metal(0x20292d, .65, .15);
    const brass = metal(0xc5a66c, .35, .72);
    const seal = new MeshStandardMaterial({ color: 0x27393d, roughness: .84 });
    const length = 3.05;
    const spacing = count > 1 ? length / (count - 1) : 0;
    const xAt = (i: number) => count === 1 ? 0 : -length / 2 + i * spacing;
    const railBody = new Mesh(new CylinderGeometry(.115, .115, length + .56, 24), alloy);
    railBody.rotation.z = Math.PI / 2; railBody.position.y = .92; rail.add(railBody);
    for (const x of [-length / 2 - .3, length / 2 + .3]) {
      const cap = new Mesh(new CylinderGeometry(.14, .14, .09, 20), dark);
      cap.rotation.z = Math.PI / 2; cap.position.set(x, .92, 0); rail.add(cap);
    }
    // Pressure regulator and feed connection are schematic hardware.
    const regulator = new Mesh(new CylinderGeometry(.2, .2, .15, 24), dark);
    regulator.position.set(-length / 2 - .3, 1.12, 0); rail.add(regulator);
    const regulatorTop = new Mesh(new CylinderGeometry(.12, .16, .09, 24), alloy);
    regulatorTop.position.set(-length / 2 - .3, 1.24, 0); rail.add(regulatorTop);
    rail.add(tubePath([new Vector3(length / 2 + .32, .92, 0), new Vector3(1.85, .92, .15), new Vector3(1.93, .65, .28)], .045, dark, 20));
    root.add(rail);

    // Plenum, individual runners and a butterfly throttle establish the air path.
    const plenum = new Mesh(new CylinderGeometry(.25, .25, length + .35, 28), dark);
    plenum.rotation.z = Math.PI / 2; plenum.position.set(0, -.67, -.52); intake.add(plenum);
    const throttle = new Mesh(new CylinderGeometry(.29, .29, .28, 28), alloy);
    throttle.rotation.z = Math.PI / 2; throttle.position.set(-length / 2 - .3, -.67, -.52); intake.add(throttle);
    const plate = new Mesh(new CylinderGeometry(.23, .23, .018, 24), brass);
    plate.rotation.z = Math.PI / 2; plate.position.set(-length / 2 - .46, -.67, -.52); intake.add(plate);
    for (let i = 0; i < count; i++) {
      const x = xAt(i);
      intake.add(tubePath([new Vector3(x, -.62, -.52), new Vector3(x, -.72, -.29), new Vector3(x, -.86, .05)], .10, alloy, 18));
      const flange = new Mesh(new BoxGeometry(Math.min(.3, spacing || .3), .07, .28), dark);
      flange.position.set(x, -.88, .06); intake.add(flange);
      const injector = new Group(); injector.position.x = x;
      // In DI the pressure line is visibly separate; in PFI the rail feeds the injector directly.
      if (diesel) injector.add(tubePath([new Vector3(0, .92, 0), new Vector3(0, .78, .18), new Vector3(0, .64, .22)], .035, alloy, 16));
      const z = diesel ? .22 : 0;
      const shell = new Mesh(new CylinderGeometry(.115, .105, .48, 24, 1, false, 0, cutaway ? Math.PI : Math.PI * 2), dark);
      shell.position.set(0, .39, z); injector.add(shell);
      const collar = new Mesh(new CylinderGeometry(.135, .135, .08, 20, 1, false, 0, cutaway ? Math.PI : Math.PI * 2), brass);
      collar.position.set(0, .57, z); injector.add(collar);
      const nozzle = new Mesh(new CylinderGeometry(.075, .025, .25, 20, 1, false, 0, cutaway ? Math.PI : Math.PI * 2), alloy);
      nozzle.position.set(0, .025, z); injector.add(nozzle);
      const oRing = new Mesh(new TorusGeometry(.102, .018, 8, 20), seal);
      oRing.rotation.x = Math.PI / 2; oRing.position.set(0, .19, z); injector.add(oRing);
      if (cutaway) {
        const needle = new Mesh(new CylinderGeometry(.018, .008, .57, 12), brass);
        needle.position.set(0, .29, z); injector.add(needle);
        const valve = new Mesh(new SphereGeometry(.035, 12, 8), brass);
        valve.position.set(0, -.005, z); injector.add(valve);
      }
      const connector = new Mesh(new BoxGeometry(.16, .13, .15), black);
      connector.position.set(0, .51, z + .14); injector.add(connector);
      const coneMaterial = new MeshStandardMaterial({ color: diesel ? 0xf4c168 : 0x6dcde1, transparent: true, opacity: .38, depthWrite: false, roughness: 1 });
      const cone = new Mesh(new ConeGeometry(.15, .38, 18, 1, true), coneMaterial);
      cone.position.set(0, -.29, z); cone.visible = false; injector.add(cone); cones.push(cone);
      root.add(injector); injectors.push(injector);
    }
    root.add(intake);
    root.userData.assembly = diesel ? 'directInjectionDiesel' : 'portInjectionSpark';
    root.userData.geometry = 'schematic';
    root.userData.spray = 'illustrative-not-cfd';
  }

  return {
    root,
    update(state: WorkshopState): void {
      const count = Math.max(1, Math.min(48, Math.round(Number.isFinite(state.config.cylinders) ? state.config.cylinders : 1)));
      const enabled = state.physical.ecu?.enabled === true;
      const diesel = enabled && state.physical.ecu?.combustionMode === 'directInjectionDiesel';
      root.userData.enabled = enabled;
      root.userData.physicalActive = state.physicalActive;
      root.userData.configuration = enabled ? 'configured' : 'schematic';
      const nextKey = `${count}:${diesel}:${state.cutaway}`;
      if (nextKey !== key) { build(count, diesel, state.cutaway); key = nextKey; }
      const exploded = Math.max(0, Math.min(1, Number.isFinite(state.exploded) ? state.exploded : 0));
      rail.position.y = exploded * .55;
      intake.position.set(0, -exploded * .35, -exploded * .38);
      injectors.forEach((injector, i) => { injector.position.y = exploded * .22; injector.position.z = exploded * .18 * (i % 2 ? 1 : -1); });
      const ecu = state.physicalActive && state.physical.ecu?.enabled ? (state.powertrain.ecu ?? state.powertrain.ecuCoupling) : undefined;
      const duty = ecu && Number.isFinite(ecu.dutyFraction) ? Math.max(0, Math.min(1, ecu.dutyFraction)) : undefined;
      const rpm = state.powertrain.rpm;
      const pulse = ecu && Number.isFinite(ecu.pulseWidthMs) && Number.isFinite(rpm) && rpm > 0
        ? Math.max(0, Math.min(1, ecu.pulseWidthMs * rpm / 120000)) : undefined;
      const width = duty ?? pulse ?? .08;
      root.userData.animationSource = duty !== undefined ? 'ecu-duty' : pulse !== undefined ? 'ecu-pulse-width' : 'schematic';
      // Firing angles locate cylinders in the cycle; the injection timing remains illustrative, not measured SOI.
      const cycle = Math.PI * 4;
      const angle = Number.isFinite(state.crankAngleRad) ? state.crankAngleRad : 0;
      cones.forEach((cone, i) => {
        const event = state.config.firingOrder.indexOf(i + 1);
        const firingAngle = event >= 0 ? state.config.firingAngles[event] : undefined;
        const offset = firingAngle !== undefined && Number.isFinite(firingAngle) ? firingAngle / 720 : i / count;
        const phase = ((angle / cycle - offset) % 1 + 1) % 1;
        cone.visible = state.running && !ecu?.injectorCut && width > 0 && phase < width;
      });
    },
    dispose(): void { disposeGroup(root); key = ''; injectors = []; cones = []; },
  };
}
