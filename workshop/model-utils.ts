import { CylinderGeometry, Mesh, MeshStandardMaterial, TubeGeometry, CatmullRomCurve3, Vector3, type Object3D, type Material } from 'three';

export const metal = (color: number, roughness = .36, metalness = .7) => new MeshStandardMaterial({ color, roughness, metalness });
export function cylinderBetween(a: Vector3, b: Vector3, radius: number, material: Material, segments = 16): Mesh {
  const direction = new Vector3().subVectors(b, a);
  const mesh = new Mesh(new CylinderGeometry(radius, radius, direction.length(), segments), material);
  mesh.position.copy(a).add(b).multiplyScalar(.5);
  mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize());
  return mesh;
}
export function tubePath(points: Vector3[], radius: number, material: Material, segments = 48): Mesh {
  return new Mesh(new TubeGeometry(new CatmullRomCurve3(points), segments, radius, 10, false), material);
}
export function disposeGroup(root: Object3D): void {
  const geometries = new Set<{dispose(): void}>();
  const materials = new Set<Material>();
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  root.clear();
}
