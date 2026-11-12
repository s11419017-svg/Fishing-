import * as THREE from 'three';
import { FishSpecies } from '../types/game';

export interface ProceduralFishRig {
  root: THREE.Group;
  tailPivot: THREE.Group;
  pectoralL: THREE.Object3D;
  pectoralR: THREE.Object3D;
  dorsalFin?: THREE.Object3D;
  haloRing?: THREE.Object3D;
  outerHaloRing?: THREE.Object3D;
}

function hexToCss(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return alpha < 1 ? `rgba(${r}, ${g}, ${b}, ${alpha})` : `rgb(${r}, ${g}, ${b})`;
}

/**
 * Generates a 512x256 high-DPI procedural fish skin texture with dorsal-to-belly
 * pearlescent shading, imbricated diamond fish scales, lateral line, operculum
 * gill crease, and species-specific ecological markings.
 */
function createFishScaleTexture(
  species: FishSpecies,
  maxAnisotropy: number,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    // 1. Dorsal-to-ventral organic countershading gradient
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0.0, hexToCss(species.finColor));
    grad.addColorStop(0.26, hexToCss(species.bodyColor));
    grad.addColorStop(0.62, hexToCss(species.bodyColor));
    grad.addColorStop(0.88, hexToCss(species.bellyColor));
    grad.addColorStop(1.0, hexToCss(species.bellyColor));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. Subtle iridescent mid-flank sheen band
    const flankGrad = ctx.createLinearGradient(0, 78, 0, 168);
    flankGrad.addColorStop(0, 'rgba(255,255,255,0)');
    flankGrad.addColorStop(
      0.5,
      species.glowColor ? hexToCss(species.glowColor, 0.24) : 'rgba(255,255,255,0.18)',
    );
    flankGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = flankGrad;
    ctx.fillRect(0, 78, canvas.width, 90);

    // 3. Imbricated diamond/crescent fish scales
    const scaleW = species.bodyStyle === 'carp' || species.bodyStyle === 'leviathan' ? 22 : 14;
    const scaleH = species.bodyStyle === 'carp' || species.bodyStyle === 'leviathan' ? 18 : 12;
    ctx.lineWidth = species.bodyStyle === 'leviathan' ? 1.4 : 1.0;

    for (let row = 0; row < Math.ceil(canvas.height / scaleH) + 1; row++) {
      const y = row * scaleH;
      const rowNorm = y / canvas.height;
      const alpha = rowNorm > 0.82 ? 0.08 : 0.22;
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
      const xOffset = (row % 2) * (scaleW * 0.5);
      for (let col = -1; col < Math.ceil(canvas.width / scaleW) + 1; col++) {
        const x = col * scaleW + xOffset;
        ctx.beginPath();
        ctx.arc(x, y, scaleW * 0.52, -Math.PI * 0.42, Math.PI * 0.42);
        ctx.stroke();
      }
    }

    // 4. Species-specific ecological markings
    if (species.bodyStyle === 'trout') {
      // Crimson / starry parr marks & speckles along dorsal and mid-flank
      for (let i = 0; i < 48; i++) {
        const sx = 45 + ((i * 73) % 420);
        const sy = 26 + ((i * 41) % 135);
        const r = 2.2 + (i % 4) * 1.1;
        ctx.fillStyle = hexToCss(species.patternColor, 0.58);
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        if (i % 3 === 0 && species.glowColor) {
          ctx.fillStyle = hexToCss(species.glowColor, 0.45);
          ctx.beginPath();
          ctx.arc(sx + 4, sy + 3, r * 0.65, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (species.bodyStyle === 'bass' || species.bodyStyle === 'tuna') {
      // Predatory vertical bars / hydrodynamic stripes
      const barCount = species.bodyStyle === 'tuna' ? 14 : 9;
      for (let i = 0; i < barCount; i++) {
        const bx = 65 + i * (360 / barCount);
        const barGrad = ctx.createLinearGradient(bx, 18, bx + 12, 165);
        barGrad.addColorStop(0, hexToCss(species.patternColor, 0.55));
        barGrad.addColorStop(1, hexToCss(species.patternColor, 0.0));
        ctx.fillStyle = barGrad;
        ctx.beginPath();
        ctx.ellipse(bx, 88, species.bodyStyle === 'tuna' ? 5 : 10, 68, 0.14, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (species.bodyStyle === 'carp') {
      // Ornamental painterly koi / spirit carp cloud blotches
      for (let i = 0; i < 7; i++) {
        const cx = 80 + ((i * 61) % 340);
        const cy = 35 + ((i * 37) % 95);
        ctx.fillStyle = hexToCss(species.patternColor, 0.42);
        ctx.beginPath();
        ctx.ellipse(cx, cy, 26 + (i % 3) * 10, 14 + (i % 2) * 8, (i * 0.5) % 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (species.bodyStyle === 'ray') {
      // Bioluminescent starry ocelli & nebula rings
      for (let i = 0; i < 36; i++) {
        const rx = 40 + ((i * 89) % 430);
        const ry = 24 + ((i * 53) % 150);
        ctx.fillStyle = hexToCss(species.patternColor, 0.72);
        ctx.beginPath();
        ctx.arc(rx, ry, 2.5 + (i % 3) * 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (species.bodyStyle === 'leviathan') {
      // Sacred celestial filigree wave crest along lateral line
      ctx.strokeStyle = hexToCss(species.finColor, 0.78);
      ctx.lineWidth = 3.0;
      ctx.beginPath();
      for (let x = 30; x < 480; x += 6) {
        const wy = 112 + Math.sin(x * 0.055) * 14;
        if (x === 30) ctx.moveTo(x, wy);
        else ctx.lineTo(x, wy);
      }
      ctx.stroke();
    }

    // 5. Sensory lateral line & subtle gill operculum arc
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(64, 118);
    ctx.quadraticCurveTo(256, 108, 468, 124);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = Math.max(1, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a delicate ray-ribbed translucent fin texture so dorsal, pectoral,
 * and caudal fins look organically veined rather than solid flat polygons.
 */
function createFinRayTexture(species: FishSpecies, maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 128, 128);
    grad.addColorStop(0, hexToCss(species.finColor, 0.95));
    grad.addColorStop(
      0.7,
      hexToCss(species.glowColor ?? species.bodyColor, 0.82),
    );
    grad.addColorStop(1, hexToCss(species.bellyColor, 0.55));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 16; i++) {
      ctx.beginPath();
      ctx.moveTo(0, 64);
      ctx.lineTo(128, i * 8.5);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.max(1, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds an articulated, multi-part composite 3D fish model (10–14 parts)
 * tailored to the species' ecological bodyStyle and rarity.
 */
export function buildCompositeFishModel(
  targetGroup: THREE.Group,
  species: FishSpecies,
  weightScale = 1.0,
  maxAnisotropy = 4,
): ProceduralFishRig {
  const root = new THREE.Group();

  const isRay = species.bodyStyle === 'ray';
  const isLeviathan = species.bodyStyle === 'leviathan';
  const isCarp = species.bodyStyle === 'carp';
  const isTuna = species.bodyStyle === 'tuna';
  const isBass = species.bodyStyle === 'bass';

  const lengthMul = isLeviathan
    ? 1.58
    : isTuna
      ? 1.28
      : isCarp
        ? 1.12
        : isRay
          ? 0.96
          : 1.04;
  const heightMul = isRay
    ? 0.24
    : isBass || isCarp
      ? 0.54
      : isTuna
        ? 0.46
        : isLeviathan
          ? 0.36
          : 0.41;
  const widthMul = isRay ? 0.92 : isCarp || isTuna ? 0.32 : isLeviathan ? 0.26 : 0.24;

  const scaleTex = createFishScaleTexture(species, maxAnisotropy);
  const finTex = createFinRayTexture(species, maxAnisotropy);

  const bodyMat = new THREE.MeshPhysicalMaterial({
    map: scaleTex,
    roughness: isLeviathan ? 0.16 : 0.24,
    metalness: species.isGuardian ? 0.38 : 0.18,
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
    iridescence: species.rarity === 'N' ? 0.28 : 0.72,
    iridescenceIOR: 1.34,
    iridescenceThicknessMinimum: 140,
    iridescenceThicknessMaximum: 480,
    sheen: 0.35,
    sheenRoughness: 0.28,
    sheenColor: new THREE.Color(species.glowColor ?? species.finColor),
    emissive: new THREE.Color(species.glowColor ?? 0x000000),
    emissiveIntensity: species.glowColor ? (species.rarity === 'UR' ? 0.34 : 0.18) : 0,
  });

  const finMat = new THREE.MeshPhysicalMaterial({
    map: finTex,
    color: 0xffffff,
    roughness: 0.28,
    metalness: 0.12,
    clearcoat: 0.85,
    iridescence: 0.42,
    iridescenceIOR: 1.32,
    iridescenceThicknessMinimum: 180,
    iridescenceThicknessMaximum: 420,
    transparent: true,
    opacity: isRay ? 0.92 : 0.86,
    side: THREE.DoubleSide,
    emissive: new THREE.Color(species.glowColor ?? species.finColor),
    emissiveIntensity: species.glowColor ? 0.26 : 0.05,
  });

  // 1. Sculpted Hydrodynamic Fuselage
  const bodyGeo = new THREE.SphereGeometry(0.55, 40, 28);
  const posAttr = bodyGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i); // +X is head, -X is tail
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);

    const normX = x / 0.55; // [-1, 1]
    const tailTaper = normX < 0 ? Math.max(0.16, 1 + normX * 0.78) : 1.0;
    const headTaper = normX > 0.35 ? 1 - Math.pow((normX - 0.35) / 0.65, 1.65) * 0.42 : 1.0;
    const dorsalArch = y > 0 ? 1 + (1 - Math.abs(normX)) * 0.22 : 1 + (1 - Math.abs(normX)) * 0.08;
    const spineWave = isLeviathan ? Math.sin(normX * Math.PI * 1.1) * 0.045 : 0;

    const profile = tailTaper * headTaper * dorsalArch;
    posAttr.setXYZ(
      i,
      x * lengthMul,
      y * heightMul * profile + spineWave,
      z * widthMul * profile,
    );
  }
  bodyGeo.computeVertexNormals();

  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  root.add(bodyMesh);

  const headX = 0.55 * lengthMul;
  const tailX = -0.55 * lengthMul;

  // 2. Sculpted Operculum (Gill Plates) on Left & Right
  const gillMat = new THREE.MeshStandardMaterial({
    color: species.finColor,
    roughness: 0.35,
    metalness: 0.35,
  });
  const gillGeo = new THREE.SphereGeometry(0.11, 14, 12);
  gillGeo.scale(0.65, 1.35 * (heightMul / 0.42), 0.22);
  [-1, 1].forEach((side) => {
    const gill = new THREE.Mesh(gillGeo, gillMat);
    gill.position.set(headX * 0.48, 0.01, side * (0.52 * widthMul * 0.88));
    gill.rotation.y = side * 0.22;
    root.add(gill);
  });

  // 3. Layered Anatomical Eyes (Metallic Iris Ring + Glossy Obsidian Pupil)
  const irisMat = new THREE.MeshStandardMaterial({
    color: species.glowColor ?? 0xfbbf24,
    roughness: 0.2,
    metalness: 0.85,
    emissive: new THREE.Color(species.glowColor ?? 0x78350f),
    emissiveIntensity: species.glowColor ? 0.4 : 0.12,
  });
  const pupilMat = new THREE.MeshPhysicalMaterial({
    color: 0x020617,
    roughness: 0.05,
    clearcoat: 1.0,
  });
  const irisGeo = new THREE.SphereGeometry(0.042, 14, 12);
  const pupilGeo = new THREE.SphereGeometry(0.027, 12, 10);

  [-1, 1].forEach((side) => {
    const eyeGroup = new THREE.Group();
    const iris = new THREE.Mesh(irisGeo, irisMat);
    iris.scale.set(1.0, 1.0, 0.45);
    const pupil = new THREE.Mesh(pupilGeo, pupilMat);
    pupil.position.z = side * 0.014;
    eyeGroup.add(iris, pupil);
    eyeGroup.position.set(
      headX * 0.68,
      isRay ? 0.065 : 0.06 * (heightMul / 0.41),
      side * (isRay ? 0.16 : 0.52 * widthMul * 0.72),
    );
    root.add(eyeGroup);
  });

  // 4. Primary Dorsal Sail / Fin
  const dorsalShape = new THREE.Shape();
  const dBase = isLeviathan ? 0.58 : isCarp ? 0.42 : 0.28;
  const dHeight = isLeviathan ? 0.34 : isTuna ? 0.28 : isRay ? 0.09 : 0.22;
  dorsalShape.moveTo(dBase * 0.5, 0);
  dorsalShape.quadraticCurveTo(dBase * 0.1, dHeight * 1.15, -dBase * 0.55, dHeight * 0.82);
  dorsalShape.quadraticCurveTo(-dBase * 0.35, dHeight * 0.3, -dBase * 0.48, 0);
  dorsalShape.closePath();

  const dorsalGeo = new THREE.ExtrudeGeometry(dorsalShape, {
    depth: 0.012,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 1,
  });
  dorsalGeo.translate(0, 0, -0.006);
  const dorsalFin = new THREE.Mesh(dorsalGeo, finMat);
  dorsalFin.position.set(-0.02 * lengthMul, 0.46 * heightMul, 0);
  dorsalFin.castShadow = true;
  root.add(dorsalFin);

  // 5. Ventral / Anal & Pelvic Stabilizer Fins
  if (!isRay) {
    const analShape = new THREE.Shape();
    analShape.moveTo(0.11, 0);
    analShape.quadraticCurveTo(0.0, -0.15, -0.14, -0.12);
    analShape.lineTo(-0.1, 0);
    analShape.closePath();
    const analGeo = new THREE.ExtrudeGeometry(analShape, {
      depth: 0.008,
      bevelEnabled: false,
    });
    analGeo.translate(0, 0, -0.004);
    const analFin = new THREE.Mesh(analGeo, finMat);
    analFin.position.set(tailX * 0.52, -0.34 * heightMul, 0);
    root.add(analFin);

    // Paired pelvic fins beneath belly
    [-1, 1].forEach((side) => {
      const pelv = new THREE.Mesh(analGeo, finMat);
      pelv.scale.set(0.78, 0.78, 1);
      pelv.position.set(0.06 * lengthMul, -0.42 * heightMul, side * 0.045);
      pelv.rotation.x = side * 0.32;
      root.add(pelv);
    });
  }

  // 6. Articulated Pectoral Fins / Manta Ray Wings
  const pecShape = new THREE.Shape();
  if (isRay) {
    pecShape.moveTo(0.28, 0);
    pecShape.quadraticCurveTo(0.06, 0.72, -0.32, 0.46);
    pecShape.quadraticCurveTo(-0.24, 0.16, -0.26, 0);
    pecShape.closePath();
  } else if (isLeviathan) {
    pecShape.moveTo(0.14, 0);
    pecShape.quadraticCurveTo(0.02, 0.36, -0.26, 0.28);
    pecShape.quadraticCurveTo(-0.16, 0.08, -0.14, 0);
    pecShape.closePath();
  } else {
    pecShape.moveTo(0.09, 0);
    pecShape.quadraticCurveTo(-0.02, 0.24, -0.16, 0.17);
    pecShape.lineTo(-0.11, 0);
    pecShape.closePath();
  }
  const pecGeo = new THREE.ExtrudeGeometry(pecShape, {
    depth: 0.01,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.003,
    bevelSegments: 1,
  });
  pecGeo.rotateX(Math.PI / 2);

  const pectoralL = new THREE.Mesh(pecGeo, finMat);
  pectoralL.position.set(headX * 0.24, -0.05 * heightMul, 0.5 * widthMul * 0.85);
  pectoralL.rotation.z = -0.18;

  const pectoralR = new THREE.Mesh(pecGeo.clone(), finMat);
  pectoralR.scale.z = -1;
  pectoralR.position.set(headX * 0.24, -0.05 * heightMul, -0.5 * widthMul * 0.85);
  pectoralR.rotation.z = -0.18;
  root.add(pectoralL, pectoralR);

  // 7. Hinged Forked Caudal (Tail) Fin on Pivot
  const tailPivot = new THREE.Group();
  tailPivot.position.set(tailX + 0.04, 0, 0);

  const tailShape = new THREE.Shape();
  const tailSpan = isLeviathan ? 0.46 : isTuna ? 0.38 : isRay ? 0.14 : 0.3;
  const tailLen = isLeviathan ? 0.52 : isRay ? 0.48 : 0.34;
  tailShape.moveTo(0, 0.042);
  tailShape.quadraticCurveTo(-tailLen * 0.52, tailSpan, -tailLen, tailSpan * 0.94);
  tailShape.quadraticCurveTo(-tailLen * 0.48, 0, -tailLen, -tailSpan * 0.94);
  tailShape.quadraticCurveTo(-tailLen * 0.52, -tailSpan, 0, -0.042);
  tailShape.closePath();

  const tailGeo = new THREE.ExtrudeGeometry(tailShape, {
    depth: 0.014,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 2,
  });
  tailGeo.translate(0, 0, -0.007);
  const tailMesh = new THREE.Mesh(tailGeo, finMat);
  tailMesh.castShadow = true;
  tailPivot.add(tailMesh);
  root.add(tailPivot);

  // 8. Dragon Whiskers (Barbels) for Carp & Leviathan + Crown Antlers for UR Deity
  if (isCarp || isLeviathan) {
    const whiskerMat = new THREE.MeshStandardMaterial({
      color: 0xfbbf24,
      roughness: 0.22,
      metalness: 0.85,
      emissive: new THREE.Color(species.glowColor ?? 0xb45309),
      emissiveIntensity: 0.35,
    });
    [-1, 1].forEach((side) => {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(headX * 0.92, -0.02, side * 0.055),
        new THREE.Vector3(headX * 0.72, -0.11, side * 0.17),
        new THREE.Vector3(headX * 0.36, -0.17, side * 0.26),
      ]);
      const whiskerGeo = new THREE.TubeGeometry(curve, 16, 0.008, 6, false);
      const whisker = new THREE.Mesh(whiskerGeo, whiskerMat);
      root.add(whisker);
    });
  }

  // 9. Sacred Guardian / Deity Resonance Halo Rings
  let haloRing: THREE.Mesh | undefined;
  let outerHaloRing: THREE.Mesh | undefined;
  if (species.rarity === 'UR' || species.isGuardian) {
    const ringMat = new THREE.MeshBasicMaterial({
      color: species.glowColor ?? 0xfbbf24,
      transparent: true,
      opacity: species.rarity === 'UR' ? 0.62 : 0.34,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    haloRing = new THREE.Mesh(new THREE.RingGeometry(0.41, 0.445, 48), ringMat);
    haloRing.rotation.y = Math.PI / 2;
    haloRing.position.set(headX * 0.28, 0.05, 0);
    root.add(haloRing);

    if (species.rarity === 'UR') {
      const outerMat = new THREE.MeshBasicMaterial({
        color: 0xfde047,
        transparent: true,
        opacity: 0.38,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      outerHaloRing = new THREE.Mesh(new THREE.RingGeometry(0.52, 0.545, 48), outerMat);
      outerHaloRing.rotation.y = Math.PI / 2;
      outerHaloRing.rotation.x = 0.35;
      outerHaloRing.position.set(headX * 0.28, 0.05, 0);
      root.add(outerHaloRing);
    }
  }

  const finalScale = THREE.MathUtils.clamp(weightScale, 0.65, 2.15);
  root.scale.setScalar(finalScale);
  targetGroup.add(root);

  return {
    root,
    tailPivot,
    pectoralL,
    pectoralR,
    dorsalFin,
    haloRing,
    outerHaloRing,
  };
}
