import {
  BoxGeometry, CanvasTexture, CircleGeometry, CylinderGeometry, Group, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace, TorusGeometry,
  type BufferGeometry, type Material,
} from 'three';
import type { PartModel } from './types.ts';
import { getLocale, t } from '../i18n.ts';

/** A display instrument, not a measurement of the real dashboard or sensor hardware. */
export function createInstrumentsModel(): PartModel {
  const root = new Group();
  root.userData.partId = 'instruments';
  root.userData.signals = { rpm: 'telemetry.rpm', boost: 'telemetry.boost (gauge bar)', throttle: 'telemetry.throttle', load: 'telemetry.load', speed: 'unavailable' };
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures: CanvasTexture[] = [];
  const panel = new MeshStandardMaterial({ color: 0x222a2d, metalness: .55, roughness: .66 });
  const edge = new MeshStandardMaterial({ color: 0x101819, metalness: .62, roughness: .4 });
  const chrome = new MeshStandardMaterial({ color: 0x9badae, metalness: .87, roughness: .25 });
  const brass = new MeshStandardMaterial({ color: 0xa78553, metalness: .8, roughness: .32 });
  const red = new MeshStandardMaterial({ color: 0xd35239, metalness: .3, roughness: .35 });
  const glass = new MeshStandardMaterial({ color: 0xc8ebf1, metalness: .12, roughness: .08, transparent: true, opacity: .14, depthWrite: false });
  [panel, edge, chrome, brass, red, glass].forEach(m => materials.add(m));
  function add(parent: Group, geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0): Mesh {
    geometries.add(geometry);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  }
  function disk(parent: Group, radius: number, depth: number, material: Material, z: number): Mesh {
    const mesh = add(parent, new CylinderGeometry(radius, radius, depth, 48), material, 0, 0, z);
    mesh.rotation.x = Math.PI / 2; return mesh;
  }
  add(root, new BoxGeometry(3.82, 1.94, .24), edge, 0, 0, -.18);
  add(root, new BoxGeometry(3.7, 1.82, .12), panel, 0, 0, -.035);
  // A fine, deterministic relief pattern gives the panel a machined texture without external assets.
  for (let i = 0; i < 37; i++) {
    const rib = add(root, new BoxGeometry(.008, 1.7, .006), edge, -1.75 + i * .097, 0, .03);
    rib.material = panel;
  }
  for (const x of [-1.73, 1.73]) for (const y of [-.77, .77]) {
    const screw = new Group(); screw.position.set(x, y, .04); root.add(screw);
    disk(screw, .055, .025, chrome, 0);
    const slot = add(screw, new BoxGeometry(.065, .008, .006), edge, 0, 0, .015); slot.rotation.z = .55;
  }
  const start = Math.PI * 1.25;
  const sweep = Math.PI * 1.5;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
  type Dial = { needle: Group; bezel: Group; backing: Mesh; lens: Group; face: Group; movement: Group; canvas: HTMLCanvasElement; texture: CanvasTexture; radius: number; kind: 'rpm' | 'boost' | 'throttle' | 'load'; max: number };
  const dials: Dial[] = [];
  function makeDial(kind: Dial['kind'], x: number, y: number, radius: number): void {
    const gauge = new Group(); gauge.position.set(x, y, .08); root.add(gauge);
    const movement = new Group(); gauge.add(movement);
    disk(movement, radius * .89, .16, edge, -.1);
    disk(movement, radius * .65, .035, brass, -.005);
    // Exposed movement hardware is visible when the face is moved in cutaway mode.
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      diskAt(movement, radius * .09, .025, chrome, Math.cos(a) * radius * .42, Math.sin(a) * radius * .42, .022);
    }
    const face = new Group(); gauge.add(face);
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
    const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace; textures.push(texture);
    const faceMaterial = new MeshBasicMaterial({ map: texture }); materials.add(faceMaterial);
    add(face, new CircleGeometry(radius * .89, 64), faceMaterial, 0, 0, .045);
    const needle = new Group(); needle.position.z = .075; face.add(needle);
    add(needle, new BoxGeometry(radius * .045, radius * .68, .018), red, 0, radius * .28, 0);
    add(needle, new BoxGeometry(radius * .1, radius * .15, .025), chrome, 0, -radius * .08, .005);
    disk(face, radius * .085, .035, chrome, .09);
    const bezel = new Group(); gauge.add(bezel);
    const backing = disk(bezel, radius, .095, edge, -.035);
    // Ring overlays the case, while the face sits in front of the case.
    add(bezel, new TorusGeometry(radius * .93, radius * .055, 10, 64), chrome, 0, 0, .105);
    add(bezel, new TorusGeometry(radius * .85, radius * .014, 8, 64), brass, 0, 0, .11);
    const lens = new Group(); gauge.add(lens);
    add(lens, new CircleGeometry(radius * .86, 64), glass, 0, 0, .125);
    dials.push({ kind, needle, bezel, backing, lens, face, movement, canvas, texture, radius, max: 1 });
  }
  function diskAt(parent: Group, r: number, d: number, material: Material, x: number, y: number, z: number): void {
    const mesh = disk(parent, r, d, material, z); mesh.position.x = x; mesh.position.y = y;
  }
  makeDial('rpm', -.86, 0, .82);
  makeDial('boost', .43, .42, .43);
  makeDial('throttle', 1.31, .42, .39);
  makeDial('load', .86, -.48, .39);
  function draw(dial: Dial, redline: number, max: number): void {
    const ctx = dial.canvas.getContext('2d');
    if (!ctx) return;
    const size = 512, center = 256, radius = 226;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#101b1e'; ctx.beginPath(); ctx.arc(center, center, 255, 0, Math.PI * 2); ctx.fill();
    // The canvas coordinate system is inverted compared to the mesh plane.
    const point = (fraction: number, r: number): [number, number] => {
      const angle = start - fraction * sweep;
      return [center + Math.cos(angle) * r, center - Math.sin(angle) * r];
    };
    if (dial.kind === 'rpm') {
      const begin = clamp(redline / max, 0, 1);
      ctx.strokeStyle = '#d4533e'; ctx.lineWidth = 18; ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const [x, y] = point(begin + (1 - begin) * i / 64, radius - 8);
        if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    const steps = dial.kind === 'rpm' ? 10 : 8;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= steps * 2; i++) {
      const fraction = i / (steps * 2), major = i % 2 === 0;
      const [x1, y1] = point(fraction, radius - 23), [x2, y2] = point(fraction, radius - (major ? 48 : 36));
      ctx.strokeStyle = '#dce4dd'; ctx.lineWidth = major ? 5 : 2; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      if (major) {
        const [x, y] = point(fraction, radius - 77);
        const value = fraction * max;
        const text = dial.kind === 'rpm' ? (value / 1000).toFixed(value % 1000 ? 1 : 0) : dial.kind === 'boost' ? value.toFixed(value % 1 ? 1 : 0) : Math.round(value * 100).toString();
        ctx.fillStyle = '#edf1e9'; ctx.font = 'bold 27px sans-serif'; ctx.fillText(text, x, y);
      }
    }
    ctx.fillStyle = '#b7c7c3'; ctx.font = 'bold 27px sans-serif';
    ctx.fillText(dial.kind === 'rpm' ? 'rpm × 1000' : dial.kind === 'boost' ? 'bar' : '%', center, 290);
    ctx.font = '22px sans-serif';
    ctx.fillText(t(dial.kind === 'rpm' ? 'Engine' : dial.kind === 'boost' ? 'Boost' : dial.kind === 'throttle' ? 'Throttle' : 'Load'), center, 325, 260);
    dial.texture.needsUpdate = true; dial.max = max;
  }
  let lastRedline = NaN, lastBoostMax = NaN, lastLocale = '';
  return {
    root,
    update(state) {
      const redline = clamp(state.config.redline, 1000, 30000);
      const rpmMax = Math.max(2000, Math.ceil(redline * 1.15 / 2000) * 2000);
      const boostMax = Math.max(1, Math.ceil(clamp(state.config.boostBar, 0, 10) * 2) / 2);
      const locale = getLocale();
      if (redline !== lastRedline || boostMax !== lastBoostMax || locale !== lastLocale) {
        for (const d of dials) draw(d, redline, d.kind === 'rpm' ? rpmMax : d.kind === 'boost' ? boostMax : 1);
        lastRedline = redline; lastBoostMax = boostMax; lastLocale = locale;
      }
      const exploded = clamp(state.exploded, 0, 1);
      for (const d of dials) {
        const value = d.kind === 'rpm' ? (state.running ? state.telemetry.rpm : 0) : d.kind === 'boost' ? state.telemetry.boost : d.kind === 'throttle' ? state.telemetry.throttle : state.telemetry.load;
        const angle = start - clamp(value / d.max, 0, 1) * sweep;
        d.needle.rotation.z = angle - Math.PI / 2;
        d.face.position.x = state.cutaway ? d.radius * .8 : 0;
        d.face.position.z = exploded * .22;
        d.bezel.position.z = exploded * .38;
        d.backing.visible = !state.cutaway;
        d.lens.position.z = exploded * .62;
        d.lens.visible = !state.cutaway;
        d.movement.position.z = -exploded * .12;
      }
    },
    dispose() {
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose()); root.clear();
    },
  };
}
