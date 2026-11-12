import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FishSpecies } from '../types/game';
import { detectSoftwareWebGL } from '../three/FishingSceneController';
import { buildCompositeFishModel, ProceduralFishRig } from '../three/proceduralFish';
import { clearAndDisposeGroup } from '../utils/threeDispose';

interface FishPreview3DProps {
  species: FishSpecies;
  unlocked: boolean;
}

interface PreviewContextRefs {
  renderer: THREE.WebGLRenderer;
  fishGroup: THREE.Group;
  keyLight: THREE.DirectionalLight;
  rimLight: THREE.DirectionalLight;
  hemiLight: THREE.HemisphereLight;
  rig: ProceduralFishRig | null;
}

/**
 * Persistent single-WebGL-context 360° fish specimen viewer.
 * Reuses one WebGLRenderer & PMREM environment across species selection changes,
 * disposing only the previous fish mesh/textures to prevent WebGL context exhaustion.
 */
export function FishPreview3D({ species, unlocked }: FishPreview3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const ctxRef = useRef<PreviewContextRefs | null>(null);

  // 1. Initialize WebGL context, environment & studio lighting once on mount
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareWebGL();
    const width = container.clientWidth || 320;
    const height = container.clientHeight || 220;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, width / Math.max(1, height), 0.1, 50);
    camera.position.set(0, 0.32, 2.35);

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.setSize(width, height);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    pmrem.dispose();

    const keyLight = new THREE.DirectionalLight(0xfffbeb, 2.4);
    keyLight.position.set(3, 4, 4);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 1.45);
    rimLight.position.set(-3, 2, -4);
    scene.add(rimLight);

    const hemiLight = new THREE.HemisphereLight(0xbae6fd, 0x0f172a, 0.85);
    scene.add(hemiLight);

    const fishGroup = new THREE.Group();
    scene.add(fishGroup);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.enablePan = false;
    controls.minDistance = 1.35;
    controls.maxDistance = 3.8;
    controls.autoRotate = !isSoftwareGl;
    controls.autoRotateSpeed = 1.75;

    const sharedRefs: PreviewContextRefs = {
      renderer,
      fishGroup,
      keyLight,
      rimLight,
      hemiLight,
      rig: null,
    };
    ctxRef.current = sharedRefs;

    let disposed = false;
    let contextLost = false;
    let frameId = 0;
    const timer = new THREE.Timer();
    timer.connect(document);

    const afterDraw = (cb: () => void) => {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      gl.flush();
      const poll = () => {
        if (disposed || contextLost) return;
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    };

    const tick = (timestamp?: number) => {
      if (disposed || contextLost) return;
      timer.update(timestamp);
      const elapsed = timer.getElapsed();
      const rig = sharedRefs.rig;
      if (rig) {
        rig.tailPivot.rotation.y = Math.sin(elapsed * 4.2) * 0.24;
        rig.pectoralL.rotation.x = Math.sin(elapsed * 3.2) * 0.15;
        rig.pectoralR.rotation.x = -Math.sin(elapsed * 3.2) * 0.15;
        if (rig.haloRing) {
          rig.haloRing.rotation.z = elapsed * 0.65;
        }
        if (rig.outerHaloRing) {
          rig.outerHaloRing.rotation.z = -elapsed * 0.42;
        }
      }
      controls.update();
      renderer.render(scene, camera);
      if (isSoftwareGl) {
        afterDraw(() => tick());
      } else {
        frameId = requestAnimationFrame(tick);
      }
    };
    tick();

    const onContextLost = (e: Event) => {
      e.preventDefault();
      contextLost = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
    };

    const onContextRestored = () => {
      contextLost = false;
      timer.reset();
      tick();
    };

    const handleResize = () => {
      if (disposed || !container) return;
      const w = container.clientWidth || 320;
      const h = container.clientHeight || 220;
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);
    window.addEventListener('resize', handleResize);

    return () => {
      disposed = true;
      ctxRef.current = null;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      timer.dispose();
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      window.removeEventListener('resize', handleResize);
      controls.dispose();
      clearAndDisposeGroup(fishGroup);
      envRT.dispose();
      scene.environment = null;
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // 2. Swap & cleanly dispose only the procedural fish model when species/unlocked changes
  useEffect(() => {
    const shared = ctxRef.current;
    if (!shared) return;

    clearAndDisposeGroup(shared.fishGroup);

    shared.keyLight.intensity = unlocked ? 2.4 : 0.25;
    shared.rimLight.intensity = unlocked ? 1.45 : 0.85;
    shared.hemiLight.intensity = unlocked ? 0.85 : 0.16;

    shared.rig = buildCompositeFishModel(
      shared.fishGroup,
      unlocked
        ? species
        : {
            ...species,
            bodyColor: 0x0f172a,
            bellyColor: 0x090d16,
            finColor: 0x1e293b,
            patternColor: 0x020617,
            glowColor: undefined,
          },
      0.95,
      shared.renderer.capabilities.getMaxAnisotropy(),
    );
  }, [species, unlocked]);

  return (
    <div className="relative w-full h-56 rounded-xl bg-[radial-gradient(ellipse_at_center,_#13263b_0%,_#080e18_85%)] border border-white/10 overflow-hidden">
      <div ref={mountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />
      <div className="pointer-events-none absolute bottom-2.5 right-3 text-xs text-slate-400">
        拖曳旋轉 360° 活體檢視
      </div>
    </div>
  );
}
