import {
  ACESFilmicToneMapping, AmbientLight, Box3, DirectionalLight, GridHelper,
  Group, HemisphereLight, Mesh, MeshStandardMaterial, PerspectiveCamera,
  PlaneGeometry, PMREMGenerator, Scene, Sphere, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { t, subscribeLocale } from '../i18n.ts';
import type { PartId, PartModel, WorkshopState } from './types.ts';

const loaders: Record<PartId, () => Promise<PartModel>> = {
  engine: async () => (await import('./engine-model.ts')).createEngineModel(),
  turbo: async () => (await import('./turbo-model.ts')).createTurboModel(),
  exhaust: async () => (await import('./exhaust-model.ts')).createExhaustModel(),
  injection: async () => (await import('./injection-model.ts')).createInjectionModel(),
  instruments: async () => (await import('./instruments-model.ts')).createInstrumentsModel(),
};

/** GPU presentation only. The Rust model and AudioWorklet remain authoritative. */
export function mountWorkshopViewport(host: HTMLElement) {
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  canvas.dataset.modelCanvas = '';
  const status = document.createElement('p');
  status.className = 'workshop-render-status';
  status.setAttribute('role', 'status');
  const cameraTools = document.createElement('div');
  cameraTools.className = 'workshop-camera-tools';
  cameraTools.setAttribute('role', 'group');
  const buttons = [
    ['left', 'Rotate left', '↶'], ['right', 'Rotate right', '↷'],
    ['in', 'Zoom in', '+'], ['out', 'Zoom out', '−'],
  ] as const;
  for (const [action, label, symbol] of buttons) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.cameraAction = action;
    button.dataset.cameraLabel = label; button.textContent = symbol;
    cameraTools.append(button);
  }
  host.append(canvas, status, cameraTools);
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    canvas.hidden = true; cameraTools.hidden = true;
    const refresh = () => { status.textContent = t('3D is unavailable on this device. All audio and model controls still work.'); };
    refresh(); const unsubscribe = subscribeLocale(refresh);
    return {
      selectPart: async (_part: PartId) => {}, update: (_state: WorkshopState, _dt: number) => {},
      setView: (_view: { exploded?: number; cutaway?: boolean; reset?: boolean }) => {},
      diagnostics: () => ({ available: false, part: 'engine', error: 'webgl-unavailable', meshes: 0 }),
      dispose: () => { unsubscribe(); host.replaceChildren(); },
    };
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  const scene = new Scene();
  const camera = new PerspectiveCamera(36, 1, .05, 100);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.enablePan = false;
  controls.minDistance = 1.5; controls.maxDistance = 18;
  controls.maxPolarAngle = Math.PI * .92;
  const wrapper = new Group(); scene.add(wrapper);
  const environmentScene = new RoomEnvironment();
  const pmrem = new PMREMGenerator(renderer);
  const environment = pmrem.fromScene(environmentScene, .04);
  scene.environment = environment.texture;
  environmentScene.dispose(); pmrem.dispose();
  scene.add(new HemisphereLight(0xc9e7e7, 0x333a34, 2.2), new AmbientLight(0xffffff, .35));
  const key = new DirectionalLight(0xffefda, 4.5); key.position.set(3, 6, 4); scene.add(key);
  const rim = new DirectionalLight(0x9bc9d4, 3); rim.position.set(-4, 2, -3); scene.add(rim);
  const floor = new Mesh(new PlaneGeometry(60, 60), new MeshStandardMaterial({ color: 0x18282c, roughness: .9, metalness: .15 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1.3; scene.add(floor);
  const grid = new GridHelper(14, 28, 0x364f53, 0x263b40); grid.position.y = -1.295; scene.add(grid);
  floor.visible = false;
  for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) {
    material.transparent = true; material.opacity = .35; material.depthWrite = false;
  }
  let current: PartModel | undefined, part: PartId = 'engine', epoch = 0, disposed = false, contextLost = false;
  let firstFit = true, shapeKey = '', error = '', loading = true;
  let exploded = 0, cutaway = false, radius = 2;
  const center = new Vector3(), direction = new Vector3(), box = new Box3(), sphere = new Sphere();
  const message = () => {
    canvas.setAttribute('aria-label', t('Interactive 3D component. Drag to rotate; use the buttons to zoom.'));
    cameraTools.setAttribute('aria-label', t('3D camera'));
    cameraTools.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      button.title = t(button.dataset.cameraLabel!); button.setAttribute('aria-label', button.title);
    });
    status.textContent = contextLost ? t('3D context lost. Reload to restore the view.') : error ? t('The 3D component could not be loaded. Audio controls remain available.') : loading ? t('Preparing the 3D component…') : '';
  };
  const unsubscribe = subscribeLocale(message); message();

  function fit(reset = false) {
    if (!current) return;
    wrapper.position.set(0, 0, 0); wrapper.updateMatrixWorld(true);
    box.setFromObject(current.root); box.getBoundingSphere(sphere);
    if (!Number.isFinite(sphere.radius) || sphere.radius === 0) return;
    const previousRadius = radius;
    center.copy(sphere.center); radius = Math.max(.7, sphere.radius);
    wrapper.position.copy(center).multiplyScalar(-1);
    floor.position.y = box.min.y - center.y - .14; grid.position.y = floor.position.y + .005;
    if (reset) {
      direction.set(part === 'instruments' ? .08 : 1.1, part === 'instruments' ? .15 : .72, 1.6).normalize();
      const right = new Vector3(0, 1, 0).cross(direction).normalize();
      const up = new Vector3().crossVectors(direction, right).normalize();
      const corner = new Vector3();
      let halfWidth = 0, halfHeight = 0, halfDepth = 0;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        corner.set(x, y, z).sub(center);
        halfWidth = Math.max(halfWidth, Math.abs(corner.dot(right)));
        halfHeight = Math.max(halfHeight, Math.abs(corner.dot(up)));
        halfDepth = Math.max(halfDepth, Math.abs(corner.dot(direction)));
      }
      const tangent = Math.tan(camera.fov * Math.PI / 360);
      const distance = (Math.max(halfHeight / tangent, halfWidth / (tangent * camera.aspect)) + halfDepth) * 1.14;
      camera.position.copy(direction).multiplyScalar(distance);
      controls.target.set(0, 0, 0);
      controls.minDistance = radius * .65; controls.maxDistance = radius * 8;
      camera.near = Math.max(.01, radius / 100); camera.far = Math.max(100, radius * 20); camera.updateProjectionMatrix();
      controls.update();
    } else if (radius > previousRadius * 1.05) {
      direction.copy(camera.position).sub(controls.target).multiplyScalar(radius / previousRadius);
      camera.position.copy(controls.target).add(direction);
      controls.maxDistance = radius * 8; controls.update();
    }
  }
  function resize() {
    if (disposed) return;
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix();
    if (current) fit(true);
  }
  const observer = new ResizeObserver(resize); observer.observe(host); resize();
  const rotate = (amount: number) => {
    direction.copy(camera.position).sub(controls.target).applyAxisAngle(new Vector3(0, 1, 0), amount);
    camera.position.copy(controls.target).add(direction); controls.update();
  };
  const cameraAction = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-camera-action]');
    if (!button) return;
    if (button.dataset.cameraAction === 'left') rotate(-.3);
    else if (button.dataset.cameraAction === 'right') rotate(.3);
    else {
      direction.copy(camera.position).sub(controls.target);
      const distance = Math.max(controls.minDistance, Math.min(controls.maxDistance, direction.length() * (button.dataset.cameraAction === 'in' ? .8 : 1.25)));
      camera.position.copy(controls.target).add(direction.setLength(distance)); controls.update();
    }
  };
  cameraTools.addEventListener('click', cameraAction);
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); rotate(event.key === 'ArrowLeft' ? -.3 : .3); }
  };
  canvas.addEventListener('keydown', keyboard);
  const lost = (event: Event) => { event.preventDefault(); contextLost = true; message(); };
  canvas.addEventListener('webglcontextlost', lost);
  return {
    async selectPart(next: PartId) {
      const generation = ++epoch; part = next; loading = true; error = ''; message();
      try {
        const model = await loaders[next]();
        if (disposed || generation !== epoch) { model.dispose(); return; }
        if (current) { wrapper.remove(current.root); current.dispose(); }
        current = model; wrapper.add(model.root);
        firstFit = true; shapeKey = ''; loading = false;
      } catch (cause) {
        if (generation === epoch) { error = cause instanceof Error ? cause.message : String(cause); loading = false; }
      }
      message();
    },
    update(state: WorkshopState, dt: number) {
      if (disposed || contextLost || !current || !host.isConnected || host.clientWidth === 0) return;
      const visual = { ...state, exploded, cutaway };
      current.update(visual, dt);
      const nextShape = [part, JSON.stringify(state.config), state.physical.boreStrokeRatio, state.physical.rodLengthStrokeRatio, state.physical.ecu?.enabled, state.physical.ecu?.combustionMode, exploded, cutaway].join('|');
      if (firstFit || nextShape !== shapeKey) { fit(firstFit); shapeKey = nextShape; firstFit = false; }
      controls.update();
      if (document.visibilityState !== 'hidden') renderer.render(scene, camera);
    },
    setView(view: { exploded?: number; cutaway?: boolean; reset?: boolean }) {
      if (typeof view.exploded === 'number') exploded = Math.max(0, Math.min(1, view.exploded));
      if (typeof view.cutaway === 'boolean') cutaway = view.cutaway;
      if (view.reset) { firstFit = true; controls.reset(); }
    },
    diagnostics() {
      let meshes = 0; current?.root.traverse(object => { if (object instanceof Mesh) meshes++; });
      return { available: true, part, loading, error, meshes, cutaway, exploded, triangles: renderer.info.render.triangles, calls: renderer.info.render.calls, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, metadata: current?.root.userData };
    },
    dispose() {
      disposed = true; epoch++; observer.disconnect(); unsubscribe(); controls.dispose(); current?.dispose();
      canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('keydown', keyboard);
      cameraTools.removeEventListener('click', cameraAction);
      floor.geometry.dispose(); (floor.material as MeshStandardMaterial).dispose(); grid.geometry.dispose();
      for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) material.dispose();
      environment.dispose(); scene.clear(); renderer.dispose(); host.replaceChildren();
    },
  };
}
