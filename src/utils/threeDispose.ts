import * as THREE from 'three';

/**
 * Recursively disposes all BufferGeometries, Materials, and embedded Textures
 * inside a Three.js Object3D subtree (excluding any shared resources passed in `keep`).
 * Eliminates WebGL GPU memory leaks when switching water biomes or previewing fish.
 */
export function disposeObjectSubtree(
  root: THREE.Object3D,
  keep?: {
    geometries?: Set<THREE.BufferGeometry>;
    materials?: Set<THREE.Material>;
    textures?: Set<THREE.Texture>;
  },
): void {
  const seenGeos = new Set<THREE.BufferGeometry>();
  const seenMats = new Set<THREE.Material>();
  const seenTexs = new Set<THREE.Texture>();

  const disposeMaterial = (mat: THREE.Material) => {
    if (seenMats.has(mat) || keep?.materials?.has(mat)) return;
    seenMats.add(mat);

    const record = mat as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (value instanceof THREE.Texture) {
        if (!seenTexs.has(value) && !keep?.textures?.has(value)) {
          seenTexs.add(value);
          value.dispose();
        }
      }
    }
    mat.dispose();
  };

  root.traverse((obj) => {
    const meshLike = obj as THREE.Mesh | THREE.Points | THREE.Line;
    if (meshLike.geometry instanceof THREE.BufferGeometry) {
      const geo = meshLike.geometry;
      if (!seenGeos.has(geo) && !keep?.geometries?.has(geo)) {
        seenGeos.add(geo);
        geo.dispose();
      }
    }

    const materialField = (meshLike as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(materialField)) {
      for (const m of materialField) {
        if (m instanceof THREE.Material) disposeMaterial(m);
      }
    } else if (materialField instanceof THREE.Material) {
      disposeMaterial(materialField);
    }
  });
}

export function clearAndDisposeGroup(
  group: THREE.Group,
  keep?: {
    geometries?: Set<THREE.BufferGeometry>;
    materials?: Set<THREE.Material>;
    textures?: Set<THREE.Texture>;
  },
): void {
  disposeObjectSubtree(group, keep);
  group.clear();
}
