import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { LINES, LURES, REELS, RODS, WATER_ZONES } from '../data/gameData';
import {
  CaughtFishInstance,
  FishingState,
  FishSpecies,
  LiveFishingHudState,
  SaveSlotData,
  TimeOfDay,
  WaterZoneId,
  WeatherType,
} from '../types/game';
import { createCaughtInstance, rollFishEncounter } from '../utils/storage';
import { clearAndDisposeGroup, disposeObjectSubtree } from '../utils/threeDispose';
import { soundEngine } from '../audio/soundEngine';
import { buildCompositeFishModel, ProceduralFishRig } from './proceduralFish';

// Pre-allocated math temporaries to guarantee zero GC churn inside render loop
const _dummyObj = new THREE.Object3D();
const _tempColor = new THREE.Color();
const _rodTipWorld = new THREE.Vector3();
const _targetCamPos = new THREE.Vector3();
const _targetLookAt = new THREE.Vector3();

interface RippleEntry {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  age: number;
  maxAge: number;
  speed: number;
}

interface DropletEntry {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

interface UnderwaterSwimmer {
  x: number;
  z: number;
  depth: number;
  angle: number;
  speed: number;
  scale: number;
  turnRate: number;
}

export interface FishingSceneCallbacks {
  onHudUpdate: (hud: LiveFishingHudState) => void;
  onFishCaught: (caught: CaughtFishInstance) => void;
  onNotice: (message: string, tone?: 'info' | 'warning' | 'success') => void;
}

let cachedSoftwareGl: boolean | null = null;

export function detectSoftwareWebGL(): boolean {
  if (cachedSoftwareGl !== null) return cachedSoftwareGl;
  try {
    const probeCanvas = document.createElement('canvas');
    const gl = probeCanvas.getContext('webgl2');
    if (!gl) {
      cachedSoftwareGl = true;
      return true;
    }
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    cachedSoftwareGl = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    return cachedSoftwareGl;
  } catch {
    cachedSoftwareGl = false;
    return false;
  }
}

function createCausticTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#021019';
    ctx.fillRect(0, 0, 256, 256);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 28; i++) {
      const cx = (i * 53) % 256;
      const cy = (i * 89) % 256;
      const r = 24 + (i % 4) * 14;
      const g = ctx.createRadialGradient(cx, cy, r * 0.25, cx, cy, r);
      g.addColorStop(0, 'rgba(56, 189, 248, 0.0)');
      g.addColorStop(0.65, 'rgba(94, 234, 212, 0.16)');
      g.addColorStop(1, 'rgba(56, 189, 248, 0.0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(9, 9);
  tex.anisotropy = Math.max(1, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

export class FishingSceneController {
  private container: HTMLElement;
  private callbacks: FishingSceneCallbacks;
  private saveData: SaveSlotData;
  private readonly isSoftwareGl: boolean;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private timer = new THREE.Timer();
  private frameId = 0;
  private isDisposed = false;
  private isContextLost = false;

  // Lighting & Sky
  private sky: Sky;
  private sunPosition = new THREE.Vector3();
  private dirLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;
  private lanternLight: THREE.PointLight;
  private lanternPivot = new THREE.Group();
  private currentLookAt = new THREE.Vector3(0, 1.0, -15);

  // Water, GPU Shader Uniforms, Caustic Seafloor & Biome Groups
  private waterGeo: THREE.PlaneGeometry;
  private waterMat: THREE.MeshPhysicalMaterial;
  private waterUniforms = {
    uWaterTime: { value: 0 },
    uWeatherAmp: { value: 1.0 },
  };
  private waterMesh: THREE.Mesh;
  private causticTex: THREE.CanvasTexture;
  private causticMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private dockGroup = new THREE.Group();
  private biomeGroup = new THREE.Group();
  private astralRings: THREE.Object3D[] = [];
  private lotusPads: THREE.Object3D[] = [];
  private woodMat: THREE.MeshStandardMaterial;
  private lanternBulbMat: THREE.MeshBasicMaterial;

  // Weather & Night Starfield / Rain / Fireflies
  private starsPoints: THREE.Points;
  private rainLines: THREE.LineSegments;
  private rainPositions: Float32Array;
  private firefliesPoints: THREE.Points;
  private fireflyPositions: Float32Array;

  // Underwater ambient fish shadows (InstancedMesh)
  private swimmerCount = 24;
  private swimmerInstanced: THREE.InstancedMesh;
  private swimmers: UnderwaterSwimmer[] = [];

  // Rod, Reel, Bobber, Aim Ring & Line
  private rodGroup = new THREE.Group();
  private rodPivot = new THREE.Group();
  private rodSegments: THREE.Group[] = [];
  private rodTipAnchor = new THREE.Object3D();
  private reelCrank = new THREE.Group();
  private rodBlankMat: THREE.MeshPhysicalMaterial;
  private rodAccentMat: THREE.MeshStandardMaterial;
  private rodHandleMat: THREE.MeshStandardMaterial;
  private reelSpoolMat: THREE.MeshStandardMaterial;

  private bobberGroup = new THREE.Group();
  private bobberTopMat: THREE.MeshStandardMaterial;
  private bobberAntennaMat: THREE.MeshBasicMaterial;
  private aimRingMesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;

  private readonly LINE_POINTS = 40;
  private linePositions: Float32Array;
  private lineGeo: THREE.BufferGeometry;
  private lineMat: THREE.LineBasicMaterial;
  private fishingLine: THREE.Line;

  // Ripples & Splash Droplets Pool
  private rippleGeo: THREE.RingGeometry;
  private ripples: RippleEntry[] = [];
  private dropletCount = 46;
  private dropletInstanced: THREE.InstancedMesh;
  private droplets: DropletEntry[] = [];

  // Dynamic Leaping / Caught 3D Fish Showcase
  private fishMeshGroup = new THREE.Group();
  private activeFishRig: ProceduralFishRig | null = null;

  // Gameplay & Physics State
  private gameState: FishingState = FishingState.IDLE;
  private uiBlocked = false;
  private isInputDown = false;
  private aimAngle = 0;
  private targetAimAngle = 0;
  private castPower = 0;
  private castChargeDir = 1;
  private bobberVelocity = new THREE.Vector3();

  private biteTimer = 0;
  private nibbleTimer = 0;
  private hookWindowTimer = 0;

  private currentFish: FishSpecies | null = null;
  private pendingCaughtInstance: CaughtFishInstance | null = null;
  private lineTension = 30;
  private fishDistance = 20;
  private maxCastDistance = 20;
  private fishLateralX = 0;
  private fishLateralDir = 1;
  private fishStamina = 100;
  private maxFishStamina = 100;
  private fishBurstTimer = 0;
  private isFishBursting = false;
  private fishJumpPhase = -1;
  private reelRotationSpeed = 0;
  private hudSyncAccumulator = 0;

  constructor(
    container: HTMLElement,
    initialSave: SaveSlotData,
    callbacks: FishingSceneCallbacks,
  ) {
    this.container = container;
    this.saveData = initialSave;
    this.callbacks = callbacks;
    this.isSoftwareGl = detectSoftwareWebGL();

    // 1. Scene & Camera
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x1e293b, 0.0052);

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(54, width / height, 0.1, 900);
    this.camera.position.set(0, 2.35, 6.2);
    this.camera.lookAt(this.currentLookAt);

    // 2. Renderer with Software-WebGL Guard & ACES Filmic Pipeline
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2),
    );
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.timer.connect(document);
    container.appendChild(this.renderer.domElement);

    // 3. Studio Environment Reflection + Procedural Sky
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envRT.texture;
    pmremGenerator.dispose();

    this.sky = new Sky();
    this.sky.scale.setScalar(900);
    this.scene.add(this.sky);

    // 4. Balanced 3-Point Outdoor Lighting Rig (Warm Sun/Moon + Cool Sky Hemi + Warm Pier Lantern)
    this.dirLight = new THREE.DirectionalLight(0xffdfa5, 2.6);
    this.dirLight.castShadow = !this.isSoftwareGl;
    this.dirLight.shadow.mapSize.set(2048, 2048);
    this.dirLight.shadow.radius = 2.4;
    this.dirLight.shadow.camera.near = 0.5;
    this.dirLight.shadow.camera.far = 150;
    const d = 28;
    this.dirLight.shadow.camera.left = -d;
    this.dirLight.shadow.camera.right = d;
    this.dirLight.shadow.camera.top = d;
    this.dirLight.shadow.camera.bottom = -d;
    this.dirLight.shadow.bias = -0.0005;
    this.dirLight.shadow.normalBias = 0.02;
    this.scene.add(this.dirLight);

    this.hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x0f172a, 0.72);
    this.scene.add(this.hemiLight);

    this.lanternLight = new THREE.PointLight(0xfbbf24, 2.1, 14, 1.7);
    this.lanternLight.position.set(-1.32, 1.85, 1.8);
    this.scene.add(this.lanternLight);

    // 5. GPU-Accelerated PBR Water Surface (r187 volumetric absorption + onBeforeCompile analytical wave normals)
    const segs = this.isSoftwareGl ? 96 : 196;
    this.waterGeo = new THREE.PlaneGeometry(320, 320, segs, segs);
    this.waterGeo.rotateX(-Math.PI / 2);
    this.waterMat = new THREE.MeshPhysicalMaterial({
      color: 0x064e3b,
      emissive: 0x022c22,
      emissiveIntensity: 0.24,
      roughness: 0.09,
      metalness: 0.14,
      transmission: this.isSoftwareGl ? 0 : 0.68,
      thickness: 1.6,
      attenuationDistance: 3.4,
      attenuationColor: new THREE.Color(0x064e3b),
      iridescence: 0.16,
      iridescenceIOR: 1.333,
      iridescenceThicknessMinimum: 120,
      iridescenceThicknessMaximum: 380,
      transparent: true,
      opacity: this.isSoftwareGl ? 0.88 : 1.0,
      ior: 1.333,
      reflectivity: 0.92,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
    });
    const waterUniforms = this.waterUniforms;
    this.waterMat.customProgramCacheKey = () => 'r187-sanctuary-water-v1';
    this.waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uWaterTime = waterUniforms.uWaterTime;
      shader.uniforms.uWeatherAmp = waterUniforms.uWeatherAmp;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uWaterTime;
          uniform float uWeatherAmp;`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `float wx = position.x;
          float wz = position.z;
          float p1x = wx * 0.25 + uWaterTime * 1.8;
          float p1z = wz * 0.2 + uWaterTime * 1.4;
          float p2 = wx * 0.6 - wz * 0.4 + uWaterTime * 2.6;
          float p3 = wz * 0.8 + uWaterTime * 3.2;
          float dhdx = 0.11 * uWeatherAmp * 0.25 * cos(p1x) * cos(p1z)
                     + 0.038 * uWeatherAmp * 0.6 * cos(p2);
          float dhdz = -0.11 * uWeatherAmp * 0.2 * sin(p1x) * sin(p1z)
                     - 0.038 * uWeatherAmp * 0.4 * cos(p2)
                     - 0.018 * 0.8 * sin(p3);
          vec3 objectNormal = normalize(vec3(-dhdx, 1.0, -dhdz));
          #ifdef USE_TANGENT
            vec3 objectTangent = vec3(tangent.xyz);
          #endif`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          float w1 = sin(position.x * 0.25 + uWaterTime * 1.8) * cos(position.z * 0.2 + uWaterTime * 1.4) * 0.11 * uWeatherAmp;
          float w2 = sin(position.x * 0.6 - position.z * 0.4 + uWaterTime * 2.6) * 0.038 * uWeatherAmp;
          float w3 = cos(position.z * 0.8 + uWaterTime * 3.2) * 0.018;
          transformed.y += w1 + w2 + w3;`,
        );
    };
    this.waterMesh = new THREE.Mesh(this.waterGeo, this.waterMat);
    this.waterMesh.receiveShadow = true;
    this.scene.add(this.waterMesh);

    this.causticTex = createCausticTexture(this.renderer.capabilities.getMaxAnisotropy());
    const causticGeo = new THREE.PlaneGeometry(180, 180);
    causticGeo.rotateX(-Math.PI / 2);
    this.causticMesh = new THREE.Mesh(
      causticGeo,
      new THREE.MeshBasicMaterial({
        map: this.causticTex,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.causticMesh.position.set(0, -1.25, -24);
    this.scene.add(this.causticMesh);

    // 6. Sanctuary Wooden Pier & Craftsmanship Props
    this.woodMat = new THREE.MeshStandardMaterial({
      color: 0x5c3a21,
      roughness: 0.82,
      metalness: 0.05,
    });
    this.lanternBulbMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
    this.buildDock();
    this.scene.add(this.dockGroup);
    this.scene.add(this.biomeGroup);

    // 7. Stars, Rain & Spirit Fireflies
    const starGeo = new THREE.BufferGeometry();
    const starCount = 520;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 280 + Math.random() * 130;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.46;
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.cos(phi) + 12;
      starPos[i * 3 + 2] = -Math.abs(r * Math.sin(phi) * Math.sin(theta));
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.starsPoints = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({
        color: 0xf8fafc,
        size: 1.45,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    this.scene.add(this.starsPoints);

    const rainCount = 340;
    this.rainPositions = new Float32Array(rainCount * 6);
    for (let i = 0; i < rainCount; i++) {
      const rx = (Math.random() - 0.5) * 50;
      const ry = Math.random() * 24;
      const rz = 8 - Math.random() * 56;
      this.rainPositions[i * 6] = rx;
      this.rainPositions[i * 6 + 1] = ry;
      this.rainPositions[i * 6 + 2] = rz;
      this.rainPositions[i * 6 + 3] = rx - 0.08;
      this.rainPositions[i * 6 + 4] = ry - 0.78;
      this.rainPositions[i * 6 + 5] = rz;
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(this.rainPositions, 3));
    this.rainLines = new THREE.LineSegments(
      rainGeo,
      new THREE.LineBasicMaterial({
        color: 0xbae6fd,
        transparent: true,
        opacity: 0.44,
        depthWrite: false,
      }),
    );
    this.rainLines.visible = false;
    this.scene.add(this.rainLines);

    const ffCount = 68;
    this.fireflyPositions = new Float32Array(ffCount * 3);
    for (let i = 0; i < ffCount; i++) {
      this.fireflyPositions[i * 3] = (Math.random() - 0.5) * 38;
      this.fireflyPositions[i * 3 + 1] = 0.45 + Math.random() * 3.8;
      this.fireflyPositions[i * 3 + 2] = 4 - Math.random() * 42;
    }
    const ffGeo = new THREE.BufferGeometry();
    ffGeo.setAttribute('position', new THREE.BufferAttribute(this.fireflyPositions, 3));
    this.firefliesPoints = new THREE.Points(
      ffGeo,
      new THREE.PointsMaterial({
        color: 0x5eead4,
        size: 0.24,
        transparent: true,
        opacity: 0.86,
        depthWrite: false,
      }),
    );
    this.scene.add(this.firefliesPoints);

    // 8. Underwater Swimming Fish Silhouettes (InstancedMesh)
    const shadowGeo = new THREE.ConeGeometry(0.17, 0.92, 10);
    shadowGeo.rotateX(Math.PI / 2);
    shadowGeo.scale(1, 0.34, 1);
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x021713,
      transparent: true,
      opacity: 0.46,
      depthWrite: false,
    });
    this.swimmerInstanced = new THREE.InstancedMesh(
      shadowGeo,
      shadowMat,
      this.swimmerCount,
    );
    this.swimmerInstanced.frustumCulled = false;
    for (let i = 0; i < this.swimmerCount; i++) {
      this.swimmers.push({
        x: (Math.random() - 0.5) * 38,
        z: -4 - Math.random() * 40,
        depth: -0.45 - Math.random() * 0.75,
        angle: Math.random() * Math.PI * 2,
        speed: 0.72 + Math.random() * 1.15,
        scale: 0.72 + Math.random() * 1.2,
        turnRate: (Math.random() - 0.5) * 0.62,
      });
    }
    this.scene.add(this.swimmerInstanced);

    // 9. Composite 12-Segment Rod & Spinning Reel
    this.rodHandleMat = new THREE.MeshStandardMaterial({
      color: 0xd4a373,
      roughness: 0.72,
    });
    this.rodBlankMat = new THREE.MeshPhysicalMaterial({
      color: 0x111827,
      roughness: 0.18,
      metalness: 0.82,
      anisotropy: 0.72,
      clearcoat: 1.0,
    });
    this.rodAccentMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      roughness: 0.24,
      metalness: 0.9,
    });
    this.reelSpoolMat = new THREE.MeshStandardMaterial({
      color: 0xd97706,
      roughness: 0.2,
      metalness: 0.9,
    });
    this.buildRodAndReel();

    // 10. Bobber, Aim Ring, Catenary Line, Ripples & Droplets
    this.bobberTopMat = new THREE.MeshStandardMaterial({
      color: 0xef4444,
      roughness: 0.18,
    });
    this.bobberAntennaMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24 });
    this.buildBobber();

    const aimGeo = new THREE.RingGeometry(0.32, 0.44, 36);
    aimGeo.rotateX(-Math.PI / 2);
    this.aimRingMesh = new THREE.Mesh(
      aimGeo,
      new THREE.MeshBasicMaterial({
        color: 0x2dd4bf,
        transparent: true,
        opacity: 0.52,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.scene.add(this.aimRingMesh);

    this.linePositions = new Float32Array(this.LINE_POINTS * 3);
    this.lineGeo = new THREE.BufferGeometry();
    this.lineGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.linePositions, 3),
    );
    this.lineMat = new THREE.LineBasicMaterial({
      color: 0xe2e8f0,
      transparent: true,
      opacity: 0.88,
    });
    this.fishingLine = new THREE.Line(this.lineGeo, this.lineMat);
    this.fishingLine.frustumCulled = false;
    this.scene.add(this.fishingLine);

    this.rippleGeo = new THREE.RingGeometry(0.12, 0.18, 32);
    this.rippleGeo.rotateX(-Math.PI / 2);

    const dropGeo = new THREE.SphereGeometry(0.042, 7, 7);
    const dropMat = new THREE.MeshBasicMaterial({
      color: 0xe0f2fe,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
    });
    this.dropletInstanced = new THREE.InstancedMesh(
      dropGeo,
      dropMat,
      this.dropletCount,
    );
    this.dropletInstanced.frustumCulled = false;
    for (let i = 0; i < this.dropletCount; i++) {
      this.droplets.push({
        pos: new THREE.Vector3(0, -50, 0),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
      });
    }
    this.scene.add(this.dropletInstanced);

    this.fishMeshGroup.visible = false;
    this.scene.add(this.fishMeshGroup);

    this.applyEnvironmentAndGear(initialSave, true);
    if (!this.isSoftwareGl) {
      void this.renderer.compileAsync(this.scene, this.camera);
    }

    this.bindEvents();
    this.emitHud(true);
    this.startLoop();
  }

  private buildDock(): void {
    const darkWoodMat = new THREE.MeshStandardMaterial({
      color: 0x3b2313,
      roughness: 0.88,
    });
    const ropeMat = new THREE.MeshStandardMaterial({
      color: 0xc29b61,
      roughness: 0.92,
    });
    const ironMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.42,
      metalness: 0.78,
    });

    // Weathered timber planks with subtle natural height jitter
    for (let i = 0; i < 16; i++) {
      const plank = new THREE.Mesh(
        new THREE.BoxGeometry(3.65, 0.12, 0.42),
        this.woodMat,
      );
      plank.position.set(0, 0.75 + ((i * 7) % 3) * 0.004, 7.0 - i * 0.46);
      plank.castShadow = true;
      plank.receiveShadow = true;
      this.dockGroup.add(plank);
    }

    // Side stringers, pilings, rope lashings & waterline foam rings
    const foamMat = new THREE.MeshBasicMaterial({
      color: 0xe2e8f0,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    [-1.64, 1.64].forEach((px) => {
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, 0.16, 7.5),
        darkWoodMat,
      );
      beam.position.set(px, 0.66, 3.5);
      this.dockGroup.add(beam);

      [0.6, 3.6, 6.6].forEach((pz) => {
        const post = new THREE.Mesh(
          new THREE.CylinderGeometry(0.14, 0.155, 3.4, 12),
          darkWoodMat,
        );
        post.position.set(px, 0.18, pz);
        post.castShadow = true;
        this.dockGroup.add(post);

        const ropeWrap = new THREE.Mesh(
          new THREE.TorusGeometry(0.15, 0.024, 8, 18),
          ropeMat,
        );
        ropeWrap.rotation.x = Math.PI / 2;
        ropeWrap.position.set(px, 0.84, pz);
        this.dockGroup.add(ropeWrap);

        const foamRing = new THREE.Mesh(
          new THREE.RingGeometry(0.17, 0.28, 20),
          foamMat,
        );
        foamRing.rotation.x = -Math.PI / 2;
        foamRing.position.set(px, 0.04, pz);
        this.dockGroup.add(foamRing);
      });
    });

    // Hanging Sanctuary Paper/Bronze Lantern on Left Front Post (with gentle wind sway pivot)
    const lanternPost = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.085, 1.45, 10),
      darkWoodMat,
    );
    lanternPost.position.set(-1.64, 1.54, 1.8);
    const lanternArm = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.06, 0.06),
      darkWoodMat,
    );
    lanternArm.position.set(-1.46, 2.18, 1.8);

    this.lanternPivot.position.set(-1.3, 2.15, 1.8);
    const lanternCap = new THREE.Mesh(
      new THREE.ConeGeometry(0.2, 0.15, 8),
      ironMat,
    );
    lanternCap.position.set(0, -0.11, 0);
    const lanternBulb = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.085, 0.24, 10),
      this.lanternBulbMat,
    );
    lanternBulb.position.set(0, -0.26, 0);
    const lanternBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.07, 0.06, 10),
      ironMat,
    );
    lanternBase.position.set(0, -0.39, 0);
    this.lanternPivot.add(lanternCap, lanternBulb, lanternBase);
    this.dockGroup.add(lanternPost, lanternArm, this.lanternPivot);

    // Woven Bamboo Creel Basket + Artisan Tackle Chest + Coiled Mooring Rope on Right Side
    const creelMat = new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.86 });
    const creelBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.28, 0.38, 16),
      creelMat,
    );
    creelBody.position.set(1.28, 1.0, 2.35);
    creelBody.castShadow = true;
    const creelRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.026, 8, 18),
      darkWoodMat,
    );
    creelRim.rotation.x = Math.PI / 2;
    creelRim.position.set(1.28, 1.19, 2.35);

    const tackleChest = new THREE.Mesh(
      new THREE.BoxGeometry(0.44, 0.24, 0.28),
      darkWoodMat,
    );
    tackleChest.position.set(1.24, 0.93, 3.05);
    tackleChest.rotation.y = -0.24;
    tackleChest.castShadow = true;

    const tackleClasp = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.08, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.3, metalness: 0.85 }),
    );
    tackleClasp.position.set(1.24, 0.97, 3.05);
    tackleClasp.rotation.y = -0.24;

    this.dockGroup.add(creelBody, creelRim, tackleChest, tackleClasp);
  }

  private buildRodAndReel(): void {
    this.rodGroup.position.set(0.65, 1.55, 5.2);
    this.scene.add(this.rodGroup);
    this.rodGroup.add(this.rodPivot);

    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.032, 0.038, 0.85, 16),
      this.rodHandleMat,
    );
    handle.rotation.x = -Math.PI / 2;
    handle.position.z = -0.3;
    this.rodPivot.add(handle);

    const buttCap = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 14, 12),
      this.rodAccentMat,
    );
    buttCap.position.z = 0.12;
    this.rodPivot.add(buttCap);

    const reelGroup = new THREE.Group();
    reelGroup.position.set(0, -0.08, -0.55);
    this.rodPivot.add(reelGroup);

    const reelStem = new THREE.Mesh(
      new THREE.BoxGeometry(0.024, 0.07, 0.08),
      this.rodBlankMat,
    );
    reelStem.position.y = 0.04;
    reelGroup.add(reelStem);

    const reelBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.1, 20),
      this.rodBlankMat,
    );
    reelBody.rotation.z = Math.PI / 2;
    reelGroup.add(reelBody);

    const reelSpool = new THREE.Mesh(
      new THREE.CylinderGeometry(0.053, 0.053, 0.074, 20),
      this.reelSpoolMat,
    );
    reelSpool.rotation.z = Math.PI / 2;
    reelGroup.add(reelSpool);

    this.reelCrank.position.set(-0.065, 0, 0);
    const crankArm = new THREE.Mesh(
      new THREE.BoxGeometry(0.014, 0.11, 0.022),
      this.rodAccentMat,
    );
    crankArm.position.y = 0.045;
    const crankKnob = new THREE.Mesh(
      new THREE.CylinderGeometry(0.016, 0.016, 0.045, 10),
      this.rodHandleMat,
    );
    crankKnob.rotation.z = Math.PI / 2;
    crankKnob.position.set(-0.022, 0.095, 0);
    this.reelCrank.add(crankArm, crankKnob);
    reelGroup.add(this.reelCrank);

    const ROD_SEGMENTS = 12;
    let parentNode: THREE.Object3D = this.rodPivot;
    for (let i = 0; i < ROD_SEGMENTS; i++) {
      const segGroup = new THREE.Group();
      const segLen = 0.26;
      segGroup.position.z = i === 0 ? -0.7 : -segLen;

      const rBottom = THREE.MathUtils.lerp(0.026, 0.005, i / ROD_SEGMENTS);
      const rTop = THREE.MathUtils.lerp(0.026, 0.005, (i + 1) / ROD_SEGMENTS);
      const segMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(rTop, rBottom, segLen, 12),
        this.rodBlankMat,
      );
      segMesh.rotation.x = -Math.PI / 2;
      segMesh.position.z = -segLen / 2;
      segMesh.castShadow = true;
      segGroup.add(segMesh);

      if (i % 2 === 1 || i === ROD_SEGMENTS - 1) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(rTop * 1.8 + 0.006, 0.0025, 8, 16),
          this.rodAccentMat,
        );
        ring.position.set(0, -rTop - 0.012, -segLen);
        segGroup.add(ring);
      }

      parentNode.add(segGroup);
      this.rodSegments.push(segGroup);
      parentNode = segGroup;
    }

    this.rodTipAnchor.position.set(0, -0.015, -0.26);
    parentNode.add(this.rodTipAnchor);
  }

  private buildBobber(): void {
    const bobberTop = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 20, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      this.bobberTopMat,
    );
    const bobberBottom = new THREE.Mesh(
      new THREE.SphereGeometry(
        0.11,
        20,
        16,
        0,
        Math.PI * 2,
        Math.PI / 2,
        Math.PI / 2,
      ),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.2 }),
    );
    const bobberCollar = new THREE.Mesh(
      new THREE.TorusGeometry(0.11, 0.013, 8, 20),
      this.rodAccentMat,
    );
    bobberCollar.rotation.x = Math.PI / 2;

    const bobberAntenna = new THREE.Mesh(
      new THREE.CylinderGeometry(0.01, 0.015, 0.3, 8),
      this.bobberAntennaMat,
    );
    bobberAntenna.position.y = 0.21;

    const antennaBead = new THREE.Mesh(
      new THREE.SphereGeometry(0.022, 10, 10),
      this.bobberAntennaMat,
    );
    antennaBead.position.y = 0.36;

    this.bobberGroup.add(bobberTop, bobberBottom, bobberCollar, bobberAntenna, antennaBead);
    this.bobberGroup.position.set(0.65, 0.7, 2.2);
    this.scene.add(this.bobberGroup);
  }

  private buildStoneToroLantern(stoneMat: THREE.Material, glowHex: number): THREE.Group {
    const group = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.72, 0.35, 6), stoneMat);
    base.position.y = 0.18;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.3, 1.35, 8), stoneMat);
    shaft.position.y = 1.0;
    const platform = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.36, 0.2, 6), stoneMat);
    platform.position.y = 1.75;
    const firebox = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.32, 0.44, 6),
      new THREE.MeshBasicMaterial({ color: glowHex }),
    );
    firebox.position.y = 2.06;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.76, 0.45, 6), stoneMat);
    roof.position.y = 2.48;
    const jewel = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 10), stoneMat);
    jewel.position.y = 2.76;
    group.add(base, shaft, platform, firebox, roof, jewel);
    return group;
  }

  private addFloatingLotusCluster(
    positions: Array<[number, number, number]>,
    petalColorHex: number,
  ): void {
    const padMat = new THREE.MeshStandardMaterial({
      color: 0x15803d,
      roughness: 0.65,
      side: THREE.DoubleSide,
    });
    const petalMat = new THREE.MeshStandardMaterial({
      color: petalColorHex,
      roughness: 0.35,
      emissive: petalColorHex,
      emissiveIntensity: 0.22,
    });
    const padGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.025, 18, 1, false, 0.2, Math.PI * 1.88);
    const bloomGeo = new THREE.ConeGeometry(0.16, 0.22, 7);

    for (const [lx, lz, scale] of positions) {
      const lotus = new THREE.Group();
      const pad = new THREE.Mesh(padGeo, padMat);
      lotus.add(pad);
      if (scale > 0.92) {
        const bloom = new THREE.Mesh(bloomGeo, petalMat);
        bloom.position.set(0.05, 0.11, 0.02);
        lotus.add(bloom);
      }
      lotus.position.set(lx, 0.03, lz);
      lotus.rotation.y = lx * 0.7;
      lotus.scale.setScalar(scale);
      this.biomeGroup.add(lotus);
      this.lotusPads.push(lotus);
    }
  }

  private rebuildBiomeEnvironment(zoneId: WaterZoneId): void {
    // Leak-free disposal of previous biome's geometries, materials & textures
    clearAndDisposeGroup(this.biomeGroup);
    this.astralRings = [];
    this.lotusPads = [];

    const zone = WATER_ZONES.find((z) => z.id === zoneId) ?? WATER_ZONES[0];
    this.waterMat.color.setHex(zone.waterColor);
    this.waterMat.attenuationColor.setHex(zone.waterColor);
    this.waterMat.emissive.setHex(zone.waterEmissive);
    this.woodMat.color.setHex(zone.dockWoodColor);

    // Distant Perimeter Mountain Ring (Natural Outdoor Horizon)
    const mountainMat = new THREE.MeshStandardMaterial({
      color: zone.mountainColor,
      roughness: 0.92,
      flatShading: true,
    });

    for (let i = 0; i < 20; i++) {
      const angle = Math.PI * 0.1 + (i / 19) * Math.PI * 0.8;
      const dist = 76 + (i % 3) * 18;
      const h = 18 + ((i * 7) % 19);
      const r = 16 + (i % 4) * 5;
      const peak = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), mountainMat);
      peak.position.set(Math.cos(angle) * dist, h * 0.42 - 2, -Math.sin(angle) * dist);
      peak.rotation.y = i * 0.6;
      this.biomeGroup.add(peak);
    }

    const mossRockMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.88,
      flatShading: true,
    });

    if (zoneId === 'alpine_lake') {
      // Multi-tiered Alpine Conifer Groves + Lakeside Stone Tōrō Lantern + Lotus Pads
      const pineCount = 46;
      const trunkMat = new THREE.MeshStandardMaterial({ color: 0x451a03, roughness: 0.9 });
      const foliageMat = new THREE.MeshStandardMaterial({ color: 0x065f46, roughness: 0.78 });
      const trunkInst = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.18, 0.28, 2.2, 7),
        trunkMat,
        pineCount,
      );
      const tier1Inst = new THREE.InstancedMesh(
        new THREE.ConeGeometry(1.75, 4.2, 7),
        foliageMat,
        pineCount,
      );
      const tier2Inst = new THREE.InstancedMesh(
        new THREE.ConeGeometry(1.3, 3.4, 7),
        foliageMat,
        pineCount,
      );

      for (let i = 0; i < pineCount; i++) {
        const t = i / (pineCount - 1);
        const ang = Math.PI * 0.12 + t * Math.PI * 0.76;
        const rad = 42 + (i % 4) * 5.2;
        const sc = 0.82 + (i % 5) * 0.16;
        const px = Math.cos(ang) * rad;
        const pz = -Math.sin(ang) * rad;

        _dummyObj.position.set(px, 0.9 * sc, pz);
        _dummyObj.rotation.set(0, i * 0.5, 0);
        _dummyObj.scale.setScalar(sc);
        _dummyObj.updateMatrix();
        trunkInst.setMatrixAt(i, _dummyObj.matrix);

        _dummyObj.position.set(px, 2.7 * sc, pz);
        _dummyObj.updateMatrix();
        tier1Inst.setMatrixAt(i, _dummyObj.matrix);

        _dummyObj.position.set(px, 4.4 * sc, pz);
        _dummyObj.updateMatrix();
        tier2Inst.setMatrixAt(i, _dummyObj.matrix);

        _tempColor.setHex(i % 2 === 0 ? 0x065f46 : 0x0f766e);
        tier1Inst.setColorAt(i, _tempColor);
        tier2Inst.setColorAt(i, _tempColor);
      }
      [trunkInst, tier1Inst, tier2Inst].forEach((inst) => {
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        inst.computeBoundingSphere();
        this.biomeGroup.add(inst);
      });

      // Shoreline boulders & glowing stone sanctuary lantern
      [
        [-14, -18, 1.3],
        [15, -22, 1.5],
        [-19, -30, 1.8],
        [18, -14, 1.1],
      ].forEach(([rx, rz, rs], idx) => {
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(2.2, 1), mossRockMat);
        rock.scale.set(rs, rs * 0.6, rs * 1.1);
        rock.position.set(rx, 0.15, rz);
        rock.rotation.y = idx * 1.1;
        this.biomeGroup.add(rock);
      });

      const lakeToro = this.buildStoneToroLantern(mossRockMat, 0xfde68a);
      lakeToro.position.set(-13.5, 0.55, -17.5);
      this.biomeGroup.add(lakeToro);

      this.addFloatingLotusCluster(
        [
          [-4.8, -6.5, 1.05],
          [-5.6, -7.8, 0.85],
          [5.4, -8.2, 1.1],
          [6.3, -7.1, 0.8],
          [-7.2, -13.5, 0.98],
        ],
        0xfda4af,
      );
    } else if (zoneId === 'bamboo_brook') {
      // Towering Jointed Emerald Bamboo Groves + Stone Shrine Lanterns + Brook Boulders
      const bambooCount = 58;
      const culmGeo = new THREE.CylinderGeometry(0.13, 0.17, 11.5, 8);
      const culmMat = new THREE.MeshStandardMaterial({
        color: 0x15803d,
        roughness: 0.42,
      });
      const leafMat = new THREE.MeshStandardMaterial({
        color: 0x22c55e,
        roughness: 0.65,
      });
      const bambooInst = new THREE.InstancedMesh(culmGeo, culmMat, bambooCount);
      const canopyInst = new THREE.InstancedMesh(
        new THREE.ConeGeometry(1.35, 2.2, 6),
        leafMat,
        bambooCount,
      );

      for (let i = 0; i < bambooCount; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const bx = side * (12.5 + (i % 7) * 2.5);
        const bz = -5 - Math.floor(i / 2) * 1.65;
        const sc = 0.85 + (i % 4) * 0.15;
        _dummyObj.position.set(bx, 4.6 * sc, bz);
        _dummyObj.rotation.set((Math.random() - 0.5) * 0.08, i * 0.4, -side * 0.06);
        _dummyObj.scale.setScalar(sc);
        _dummyObj.updateMatrix();
        bambooInst.setMatrixAt(i, _dummyObj.matrix);

        _dummyObj.position.set(bx - side * 0.35, 9.6 * sc, bz);
        _dummyObj.updateMatrix();
        canopyInst.setMatrixAt(i, _dummyObj.matrix);

        _tempColor.setHex(i % 3 === 0 ? 0x22c55e : 0x166534);
        bambooInst.setColorAt(i, _tempColor);
        canopyInst.setColorAt(i, _tempColor);
      }
      [bambooInst, canopyInst].forEach((inst) => {
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        inst.computeBoundingSphere();
        this.biomeGroup.add(inst);
      });

      [-10.5, 11.2, -14.8, 15.4, -12.0].forEach((rx, idx) => {
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(2.5, 1), mossRockMat);
        rock.scale.set(1.4, 0.68, 1.2);
        rock.position.set(rx, 0.2, -10 - idx * 6.8);
        this.biomeGroup.add(rock);
      });

      const brookToroL = this.buildStoneToroLantern(mossRockMat, 0x5eead4);
      brookToroL.position.set(-9.8, 0.55, -15.5);
      const brookToroR = this.buildStoneToroLantern(mossRockMat, 0x5eead4);
      brookToroR.position.set(10.6, 0.55, -22.5);
      this.biomeGroup.add(brookToroL, brookToroR);

      this.addFloatingLotusCluster(
        [
          [-4.2, -8.5, 0.95],
          [4.8, -11.0, 1.08],
          [-6.0, -16.2, 0.88],
        ],
        0x99f6e4,
      );
    } else if (zoneId === 'coral_cove') {
      // Sacred Sunken Myōjin Torii Gate + Bioluminescent Coral Reefs + Giant Pearl Clams
      const toriiGroup = new THREE.Group();
      const vermilionMat = new THREE.MeshStandardMaterial({
        color: 0xc22525,
        roughness: 0.48,
      });
      const stoneCapMat = new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        roughness: 0.72,
      });
      const goldPlaqueMat = new THREE.MeshStandardMaterial({
        color: 0xfacc15,
        roughness: 0.25,
        metalness: 0.88,
      });

      [-4.8, 4.8].forEach((px) => {
        const pedestal = new THREE.Mesh(
          new THREE.CylinderGeometry(0.72, 0.88, 2.2, 12),
          stoneCapMat,
        );
        pedestal.position.set(px, 0.2, 0);
        const pillar = new THREE.Mesh(
          new THREE.CylinderGeometry(0.44, 0.54, 11.8, 16),
          vermilionMat,
        );
        pillar.position.set(px, 5.2, 0);
        pillar.castShadow = true;
        toriiGroup.add(pedestal, pillar);
      });

      const kasagi = new THREE.Mesh(new THREE.BoxGeometry(13.8, 0.62, 0.95), stoneCapMat);
      kasagi.position.set(0, 11.1, 0);
      // Curved upturn tips (sori) on top lintel
      [-6.8, 6.8].forEach((tx) => {
        const tip = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.58, 0.92), stoneCapMat);
        tip.position.set(tx, 11.32, 0);
        tip.rotation.z = tx < 0 ? -0.22 : 0.22;
        toriiGroup.add(tip);
      });
      const shimaki = new THREE.Mesh(new THREE.BoxGeometry(12.6, 0.46, 0.74), vermilionMat);
      shimaki.position.set(0, 10.55, 0);
      const nuki = new THREE.Mesh(new THREE.BoxGeometry(11.4, 0.44, 0.52), vermilionMat);
      nuki.position.set(0, 8.35, 0);
      const gakuzuka = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.1, 0.36), goldPlaqueMat);
      gakuzuka.position.set(0, 9.45, 0);

      toriiGroup.add(kasagi, shimaki, nuki, gakuzuka);
      toriiGroup.position.set(0, -0.5, -42);
      this.biomeGroup.add(toriiGroup);

      // Luminous Reef Coral Clusters
      const coralCount = 36;
      const coralInst = new THREE.InstancedMesh(
        new THREE.DodecahedronGeometry(1.15, 0),
        new THREE.MeshStandardMaterial({
          color: 0xf472b6,
          roughness: 0.38,
          emissive: 0x831843,
          emissiveIntensity: 0.42,
        }),
        coralCount,
      );
      for (let i = 0; i < coralCount; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        _dummyObj.position.set(
          side * (11.5 + (i % 6) * 3.1),
          -0.28 + (i % 3) * 0.24,
          -7 - i * 1.35,
        );
        _dummyObj.rotation.set(i * 0.4, i * 0.8, 0);
        _dummyObj.scale.set(1.2, 0.8 + (i % 3) * 0.45, 1.2);
        _dummyObj.updateMatrix();
        coralInst.setMatrixAt(i, _dummyObj.matrix);
        _tempColor.setHex(i % 3 === 0 ? 0xf472b6 : i % 3 === 1 ? 0x38bdf8 : 0xc084fc);
        coralInst.setColorAt(i, _tempColor);
      }
      coralInst.instanceMatrix.needsUpdate = true;
      if (coralInst.instanceColor) coralInst.instanceColor.needsUpdate = true;
      coralInst.computeBoundingSphere();
      this.biomeGroup.add(coralInst);
    } else if (zoneId === 'cloud_sanctuary') {
      // Celestial Marble Ruin Columns, Counter-Rotating Golden Astrolabe Rings & Sacred Lotus
      const marbleMat = new THREE.MeshPhysicalMaterial({
        color: 0xf8fafc,
        roughness: 0.22,
        metalness: 0.1,
        clearcoat: 0.65,
      });
      const goldTrimMat = new THREE.MeshStandardMaterial({
        color: 0xfacc15,
        roughness: 0.18,
        metalness: 0.92,
        emissive: 0xb45309,
        emissiveIntensity: 0.32,
      });

      for (let i = 0; i < 8; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const colGroup = new THREE.Group();
        const h = 7.5 + (i % 3) * 3.2;
        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(0.64, 0.76, h, 16),
          marbleMat,
        );
        shaft.position.y = h / 2 - 1;
        const plinth = new THREE.Mesh(
          new THREE.BoxGeometry(1.95, 0.85, 1.95),
          marbleMat,
        );
        plinth.position.y = -0.6;
        const capital = new THREE.Mesh(
          new THREE.BoxGeometry(1.75, 0.45, 1.75),
          marbleMat,
        );
        capital.position.y = h - 0.9;
        const goldRing = new THREE.Mesh(
          new THREE.TorusGeometry(0.78, 0.08, 8, 28),
          goldTrimMat,
        );
        goldRing.rotation.x = Math.PI / 2;
        goldRing.position.y = h - 1.3;
        colGroup.add(plinth, shaft, capital, goldRing);
        colGroup.position.set(
          side * (13 + Math.floor(i / 2) * 3.6),
          0,
          -14 - Math.floor(i / 2) * 10,
        );
        this.biomeGroup.add(colGroup);
      }

      const outerHalo = new THREE.Mesh(
        new THREE.TorusGeometry(10.5, 0.2, 14, 72),
        goldTrimMat,
      );
      outerHalo.position.set(0, 9.2, -48);
      outerHalo.rotation.x = 0.25;

      const innerHalo = new THREE.Mesh(
        new THREE.TorusGeometry(7.6, 0.13, 12, 64),
        goldTrimMat,
      );
      innerHalo.position.set(0, 9.2, -48);
      innerHalo.rotation.y = 0.4;

      this.biomeGroup.add(outerHalo, innerHalo);
      this.astralRings.push(outerHalo, innerHalo);

      this.addFloatingLotusCluster(
        [
          [-5.2, -9.0, 1.15],
          [5.6, -10.5, 1.1],
          [-7.5, -18.0, 1.2],
          [7.8, -19.5, 1.05],
        ],
        0xfef08a,
      );
    }
  }

  public applyEnvironmentAndGear(save: SaveSlotData, forceRebuildZone = false): void {
    const prevZone = this.saveData.currentZoneId;
    this.saveData = save;

    if (forceRebuildZone || prevZone !== save.currentZoneId) {
      this.rebuildBiomeEnvironment(save.currentZoneId);
    }

    const rod = RODS.find((r) => r.id === save.equippedRodId) ?? RODS[0];
    const reel = REELS.find((r) => r.id === save.equippedReelId) ?? REELS[0];
    const line = LINES.find((l) => l.id === save.equippedLineId) ?? LINES[0];
    const lure = LURES.find((l) => l.id === save.equippedLureId) ?? LURES[0];

    this.rodBlankMat.color.setHex(rod.blankColor);
    this.rodAccentMat.color.setHex(rod.accentColor);
    this.rodHandleMat.color.setHex(rod.handleColor);
    this.reelSpoolMat.color.setHex(reel.spoolColor);
    this.lineMat.color.setHex(line.lineColor);
    this.bobberTopMat.color.setHex(lure.bobberTopColor);
    this.bobberAntennaMat.color.setHex(lure.antennaColor);

    this.updateAtmosphere(save.timeOfDay, save.weather);
    soundEngine.setWeather(save.weather);
    this.emitHud(true);
  }

  private updateAtmosphere(timeOfDay: TimeOfDay, weather: WeatherType): void {
    const skyUniforms = this.sky.material.uniforms;
    let elevationDeg = 12;
    let azimuthDeg = 195;
    let dirColor = 0xffdfa5;
    let dirIntensity = 2.6;
    let hemiSky = 0x87ceeb;
    let hemiGround = 0x0f172a;
    let fogHex = 0x1e293b;
    let fogDensity = 0.0052;
    let starOpacity = 0;

    if (timeOfDay === 'dawn') {
      elevationDeg = 9;
      azimuthDeg = 162;
      dirColor = 0xfde68a;
      dirIntensity = 2.45;
      hemiSky = 0xbae6fd;
      hemiGround = 0x1e293b;
      fogHex = 0x334155;
      skyUniforms['turbidity'].value = 5.8;
      skyUniforms['rayleigh'].value = 1.85;
    } else if (timeOfDay === 'dusk') {
      elevationDeg = 11;
      azimuthDeg = 198;
      dirColor = 0xffb36b;
      dirIntensity = 2.75;
      hemiSky = 0x7dd3fc;
      hemiGround = 0x0f172a;
      fogHex = 0x1e293b;
      skyUniforms['turbidity'].value = 8.4;
      skyUniforms['rayleigh'].value = 2.75;
    } else {
      elevationDeg = -8;
      azimuthDeg = 205;
      dirColor = 0x93c5fd;
      dirIntensity = 1.2;
      hemiSky = 0x1e3a8a;
      hemiGround = 0x020617;
      fogHex = 0x090d16;
      starOpacity = weather === 'clear' ? 0.9 : 0.38;
      skyUniforms['turbidity'].value = 2.4;
      skyUniforms['rayleigh'].value = 0.45;
    }

    if (weather === 'rain') {
      dirIntensity *= 0.68;
      fogDensity = 0.0108;
      fogHex = timeOfDay === 'night' ? 0x0f172a : 0x334155;
    } else if (weather === 'mist') {
      dirIntensity *= 0.82;
      fogDensity = 0.015;
      fogHex = timeOfDay === 'night' ? 0x132a2e : 0x3b5259;
    }

    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunPosition.setFromSphericalCoords(1, phi, theta);
    skyUniforms['sunPosition'].value.copy(this.sunPosition);

    const lightPhi = THREE.MathUtils.degToRad(
      90 - (timeOfDay === 'night' ? 24 : elevationDeg),
    );
    this.dirLight.position.setFromSphericalCoords(80, lightPhi, theta);
    this.dirLight.color.setHex(dirColor);
    this.dirLight.intensity = dirIntensity;

    this.hemiLight.color.setHex(hemiSky);
    this.hemiLight.groundColor.setHex(hemiGround);
    this.lanternLight.intensity = timeOfDay === 'night' ? 3.4 : 1.75;
    this.causticMesh.material.opacity = timeOfDay === 'night' ? 0.18 : 0.34;

    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.setHex(fogHex);
      this.scene.fog.density = fogDensity;
    }

    (this.starsPoints.material as THREE.PointsMaterial).opacity = starOpacity;
    this.rainLines.visible = weather === 'rain';
    this.waterUniforms.uWeatherAmp.value = weather === 'rain' ? 1.35 : 1.0;
    this.firefliesPoints.visible =
      timeOfDay === 'night' ||
      weather === 'mist' ||
      this.saveData.currentZoneId === 'bamboo_brook' ||
      this.saveData.currentZoneId === 'cloud_sanctuary';
  }

  public setUiBlocked(blocked: boolean): void {
    this.uiBlocked = blocked;
    if (blocked) {
      this.isInputDown = false;
      if (this.gameState === FishingState.CHARGING) {
        this.castPower = 0;
        this.gameState = FishingState.IDLE;
        this.emitHud(true);
      }
    }
  }

  public dismissCaughtShowcase(): void {
    if (this.gameState === FishingState.CAUGHT) {
      this.fishMeshGroup.visible = false;
      clearAndDisposeGroup(this.fishMeshGroup);
      this.activeFishRig = null;
      this.pendingCaughtInstance = null;
      this.currentFish = null;
      this.gameState = FishingState.IDLE;
      this.emitHud(true);
    }
  }

  private getWaterHeight(x: number, z: number, time: number): number {
    const weatherAmp = this.waterUniforms.uWeatherAmp.value;
    const w1 =
      Math.sin(x * 0.25 + time * 1.8) * Math.cos(z * 0.2 + time * 1.4) * 0.11 * weatherAmp;
    const w2 = Math.sin(x * 0.6 - z * 0.4 + time * 2.6) * 0.038 * weatherAmp;
    const w3 = Math.cos(z * 0.8 + time * 3.2) * 0.018;
    return w1 + w2 + w3;
  }

  private spawnRipple(x: number, z: number, scaleSpeed = 1.8, colorHex = 0xe2e8f0): void {
    if (this.ripples.length >= 28) {
      const oldest = this.ripples.shift();
      if (oldest) {
        this.scene.remove(oldest.mesh);
        oldest.mesh.material.dispose();
      }
    }
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.rippleGeo, mat);
    mesh.position.set(x, this.getWaterHeight(x, z, this.timer.getElapsed()) + 0.035, z);
    this.scene.add(mesh);
    this.ripples.push({ mesh, age: 0, speed: scaleSpeed, maxAge: 1.25 });
  }

  private spawnSplashDroplets(
    x: number,
    y: number,
    z: number,
    count = 18,
    speed = 4.2,
  ): void {
    let spawned = 0;
    for (let i = 0; i < this.dropletCount && spawned < count; i++) {
      const d = this.droplets[i];
      if (d.life <= 0) {
        const ang = Math.random() * Math.PI * 2;
        const horiz = (0.3 + Math.random() * 0.8) * speed;
        d.pos.set(x, y + 0.05, z);
        d.vel.set(Math.cos(ang) * horiz, (0.7 + Math.random() * 0.7) * speed, Math.sin(ang) * horiz);
        d.maxLife = 0.48 + Math.random() * 0.35;
        d.life = d.maxLife;
        spawned++;
      }
    }
  }

  private prepareActiveFishModel(species: FishSpecies, weightRatio: number): void {
    clearAndDisposeGroup(this.fishMeshGroup);
    const scale = 0.82 + weightRatio * 0.58;
    this.activeFishRig = buildCompositeFishModel(
      this.fishMeshGroup,
      species,
      scale,
      this.renderer.capabilities.getMaxAnisotropy(),
    );
  }

  private handlePressDown(): void {
    if (this.uiBlocked) return;
    soundEngine.init();
    this.isInputDown = true;

    if (this.gameState === FishingState.IDLE) {
      this.castPower = 14;
      this.castChargeDir = 1;
      this.gameState = FishingState.CHARGING;
      this.emitHud(true);
    } else if (this.gameState === FishingState.WAITING) {
      // Premature hook pull cancels cast cleanly
      soundEngine.playSplash(0.65);
      this.gameState = FishingState.IDLE;
      this.callbacks.onNotice('提竿過早！請耐心等待浮標猛烈下沉時再點擊刺魚。', 'info');
      this.emitHud(true);
    } else if (this.gameState === FishingState.BITE) {
      // Successful hookset! Begin physical reeling battle
      const powerRatio = Math.max(0.2, this.castPower / 100);
      const encountered = rollFishEncounter(
        this.saveData.currentZoneId,
        this.saveData.timeOfDay,
        this.saveData.weather,
        this.saveData.equippedLureId,
        powerRatio,
        this.saveData,
      );
      const caughtInst = createCaughtInstance(encountered, this.saveData);
      this.currentFish = encountered;
      this.pendingCaughtInstance = caughtInst;

      const weightNorm =
        (caughtInst.weight - encountered.minWeight) /
        Math.max(0.01, encountered.maxWeight - encountered.minWeight);
      this.prepareActiveFishModel(encountered, weightNorm);
      this.fishMeshGroup.visible = false;

      this.lineTension = 36;
      this.maxFishStamina = encountered.stamina * (0.9 + weightNorm * 0.28);
      this.fishStamina = this.maxFishStamina;
      this.fishLateralX = this.bobberGroup.position.x;
      this.fishLateralDir = Math.random() < 0.5 ? -1 : 1;
      this.fishDistance = Math.max(8, 4.2 - this.bobberGroup.position.z);
      this.maxCastDistance = this.fishDistance;
      this.fishBurstTimer = 1.6 + Math.random() * 1.4;
      this.isFishBursting = false;
      this.fishJumpPhase = -1;

      this.spawnSplashDroplets(
        this.bobberGroup.position.x,
        0.15,
        this.bobberGroup.position.z,
        20,
        4.6,
      );
      soundEngine.playSplash(1.2);
      soundEngine.setCombatMode(true);
      this.gameState = FishingState.REELING;
      this.emitHud(true);
    }
  }

  private handlePressUp(): void {
    if (!this.isInputDown) return;
    this.isInputDown = false;

    if (this.gameState === FishingState.CHARGING) {
      const rod = RODS.find((r) => r.id === this.saveData.equippedRodId) ?? RODS[0];
      const powerRatio = Math.max(0.18, this.castPower / 100);
      const targetDist = 8 + powerRatio * rod.maxCastDist;
      const flightTime = 0.68 + powerRatio * 0.34;

      this.rodPivot.updateMatrixWorld(true);
      this.rodTipAnchor.getWorldPosition(_rodTipWorld);
      this.bobberGroup.position.copy(_rodTipWorld);

      const targetX = Math.sin(this.aimAngle) * targetDist;
      const targetZ = 4.2 - Math.cos(this.aimAngle) * targetDist;

      this.bobberVelocity.set(
        (targetX - _rodTipWorld.x) / flightTime,
        (0.05 - _rodTipWorld.y + 0.5 * 16.5 * flightTime * flightTime) / flightTime,
        (targetZ - _rodTipWorld.z) / flightTime,
      );

      soundEngine.playCastWhoosh(powerRatio);
      this.gameState = FishingState.CASTING;
      this.emitHud(true);
    }
  }

  private bindEvents(): void {
    const canvas = this.renderer.domElement;

    const onContextLost = (e: Event) => {
      e.preventDefault();
      this.isContextLost = true;
      cancelAnimationFrame(this.frameId);
      clearTimeout(this.frameId);
    };

    const onContextRestored = () => {
      this.isContextLost = false;
      this.timer.reset();
      this.startLoop();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || this.uiBlocked) return;
      this.handlePressDown();
    };

    const onPointerUp = () => {
      this.handlePressUp();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (this.uiBlocked) return;
      if (this.gameState === FishingState.IDLE || this.gameState === FishingState.CHARGING) {
        const rect = canvas.getBoundingClientRect();
        const nx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
        this.targetAimAngle = THREE.MathUtils.clamp(-nx * 0.38, -0.38, 0.38);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (this.uiBlocked) return;
      const activeTag = document.activeElement?.tagName;
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        this.handlePressDown();
      } else if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
        this.targetAimAngle = THREE.MathUtils.clamp(this.targetAimAngle + 0.06, -0.38, 0.38);
      } else if (e.code === 'KeyD' || e.code === 'ArrowRight') {
        this.targetAimAngle = THREE.MathUtils.clamp(this.targetAimAngle - 0.06, -0.38, 0.38);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        this.handlePressUp();
      }
    };

    // Prevent stuck tension & delta spikes when user switches browser tabs or loses window focus
    const onWindowBlurOrHide = () => {
      this.isInputDown = false;
      this.timer.reset();
      if (this.gameState === FishingState.CHARGING) {
        this.castPower = 0;
        this.gameState = FishingState.IDLE;
        this.emitHud(true);
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        onWindowBlurOrHide();
      } else {
        this.timer.reset();
      }
    };

    const onResize = () => {
      if (this.isDisposed) return;
      const w = this.container.clientWidth || window.innerWidth;
      const h = this.container.clientHeight || window.innerHeight;
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    };

    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlurOrHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('resize', onResize);

    this.cleanupListeners = () => {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlurOrHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('resize', onResize);
    };
  }

  private cleanupListeners: () => void = () => {};

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
    gl.flush();
    const poll = () => {
      if (this.isDisposed || this.isContextLost) return;
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private startLoop(): void {
    this.timer.reset();
    const tick = (timestamp?: number) => {
      if (this.isDisposed || this.isContextLost) return;
      this.timer.update(timestamp);
      // Strict 50ms delta cap protects against tab-resume physics/tension spikes
      const rawDelta = this.timer.getDelta();
      const delta = Math.min(rawDelta, 0.05);
      const elapsed = this.timer.getElapsed();

      this.stepSimulation(delta, elapsed);
      this.renderer.render(this.scene, this.camera);

      if (this.isSoftwareGl) {
        this.afterDraw(() => tick());
      } else {
        this.frameId = requestAnimationFrame(tick);
      }
    };
    tick();
  }

  private stepSimulation(delta: number, elapsed: number): void {
    // 1. GPU Water Uniform Sync, Underwater Caustic Drift, Lantern Sway & Lotus Bobbing
    this.waterUniforms.uWaterTime.value = elapsed;
    this.causticTex.offset.set(elapsed * 0.018, Math.sin(elapsed * 0.35) * 0.04);
    this.lanternPivot.rotation.z = Math.sin(elapsed * 1.6) * 0.045;
    this.lanternPivot.rotation.x = Math.cos(elapsed * 1.2) * 0.03;

    for (let i = 0; i < this.lotusPads.length; i++) {
      const pad = this.lotusPads[i];
      pad.position.y = this.getWaterHeight(pad.position.x, pad.position.z, elapsed) + 0.025;
      pad.rotation.z = Math.sin(elapsed * 1.5 + i) * 0.04;
    }

    for (let i = 0; i < this.astralRings.length; i++) {
      const ring = this.astralRings[i];
      ring.rotation.z += delta * (i === 0 ? 0.09 : -0.14);
    }

    this.aimAngle = THREE.MathUtils.damp(this.aimAngle, this.targetAimAngle, 8, delta);

    // Rain animation
    if (this.rainLines.visible) {
      const rAttr = this.rainLines.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < rAttr.count / 2; i++) {
        let y = this.rainPositions[i * 6 + 1] - delta * 26;
        let x = this.rainPositions[i * 6] - delta * 2.2;
        const z = this.rainPositions[i * 6 + 2];
        if (y < 0.1) {
          if (Math.random() < 0.035 && z > -32) {
            this.spawnRipple(x, z, 1.1, 0xbae6fd);
          }
          y = 22 + Math.random() * 4;
          x = (Math.random() - 0.5) * 48;
        }
        this.rainPositions[i * 6] = x;
        this.rainPositions[i * 6 + 1] = y;
        this.rainPositions[i * 6 + 3] = x - 0.08;
        this.rainPositions[i * 6 + 4] = y - 0.78;
      }
      rAttr.needsUpdate = true;
    }

    // Fireflies drift
    if (this.firefliesPoints.visible) {
      const fAttr = this.firefliesPoints.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < fAttr.count; i++) {
        this.fireflyPositions[i * 3] += Math.sin(elapsed * 0.8 + i) * delta * 0.35;
        this.fireflyPositions[i * 3 + 1] =
          0.88 + Math.sin(elapsed * 1.4 + i * 1.7) * 0.65 + (i % 3) * 0.55;
      }
      fAttr.needsUpdate = true;
    }

    // Underwater Swimmer Silhouettes
    for (let i = 0; i < this.swimmerCount; i++) {
      const s = this.swimmers[i];
      if (
        i === 0 &&
        (this.gameState === FishingState.WAITING || this.gameState === FishingState.BITE)
      ) {
        const bx = this.bobberGroup.position.x;
        const bz = this.bobberGroup.position.z;
        const orbitR = this.gameState === FishingState.BITE ? 0.25 : 1.4;
        s.angle += delta * 2.2;
        s.x = THREE.MathUtils.damp(s.x, bx + Math.cos(s.angle) * orbitR, 3, delta);
        s.z = THREE.MathUtils.damp(s.z, bz + Math.sin(s.angle) * orbitR, 3, delta);
      } else {
        s.angle += s.turnRate * delta;
        s.x += Math.cos(s.angle) * s.speed * delta;
        s.z += Math.sin(s.angle) * s.speed * delta;
        if (s.x < -22 || s.x > 22) s.angle = Math.PI - s.angle;
        if (s.z > -2 || s.z < -45) s.angle = -s.angle;
      }
      const wy = this.getWaterHeight(s.x, s.z, elapsed) + s.depth;
      _dummyObj.position.set(s.x, wy, s.z);
      _dummyObj.rotation.set(0, -s.angle + Math.PI / 2 + Math.sin(elapsed * 6 + i) * 0.08, 0);
      _dummyObj.scale.setScalar(s.scale);
      _dummyObj.updateMatrix();
      this.swimmerInstanced.setMatrixAt(i, _dummyObj.matrix);
    }
    this.swimmerInstanced.instanceMatrix.needsUpdate = true;

    // 2. Step Fishing State Machine
    const rod = RODS.find((r) => r.id === this.saveData.equippedRodId) ?? RODS[0];
    const reel = REELS.find((r) => r.id === this.saveData.equippedReelId) ?? REELS[0];
    const line = LINES.find((l) => l.id === this.saveData.equippedLineId) ?? LINES[0];
    const lure = LURES.find((l) => l.id === this.saveData.equippedLureId) ?? LURES[0];

    let targetRodPitch = 0.28;
    let targetRodYaw = this.aimAngle * 0.85;
    let bendAmount = 0.012;
    let bendLateral = 0;

    if (this.gameState === FishingState.IDLE || this.gameState === FishingState.CHARGING) {
      this.aimRingMesh.visible = !this.uiBlocked;
      const previewPower =
        this.gameState === FishingState.CHARGING ? Math.max(0.18, this.castPower / 100) : 0.45;
      const previewDist = 8 + previewPower * rod.maxCastDist;
      const ax = Math.sin(this.aimAngle) * previewDist;
      const az = 4.2 - Math.cos(this.aimAngle) * previewDist;
      this.aimRingMesh.position.set(ax, this.getWaterHeight(ax, az, elapsed) + 0.05, az);
      const pulseScale = 1 + Math.sin(elapsed * 3.5) * 0.08;
      this.aimRingMesh.scale.setScalar(pulseScale);
    } else {
      this.aimRingMesh.visible = false;
    }

    if (this.gameState === FishingState.IDLE) {
      targetRodPitch = 0.32 + Math.sin(elapsed * 1.5) * 0.02;
      this.reelRotationSpeed = THREE.MathUtils.damp(this.reelRotationSpeed, 0, 6, delta);
    } else if (this.gameState === FishingState.CHARGING) {
      this.castPower += this.castChargeDir * delta * 92;
      if (this.castPower >= 100) {
        this.castPower = 100;
        this.castChargeDir = -1;
      } else if (this.castPower <= 12) {
        this.castPower = 12;
        this.castChargeDir = 1;
      }
      targetRodPitch = 0.32 + (this.castPower / 100) * 0.65;
      bendAmount = -0.025 * (this.castPower / 100);
    } else if (this.gameState === FishingState.CASTING) {
      targetRodPitch = 0.08;
      bendAmount = 0.02;
      this.bobberVelocity.y -= 16.5 * delta;
      this.bobberGroup.position.addScaledVector(this.bobberVelocity, delta);
      const waterY = this.getWaterHeight(
        this.bobberGroup.position.x,
        this.bobberGroup.position.z,
        elapsed,
      );
      if (this.bobberGroup.position.y <= waterY) {
        this.bobberGroup.position.y = waterY;
        this.spawnRipple(this.bobberGroup.position.x, this.bobberGroup.position.z, 2.4);
        this.spawnSplashDroplets(
          this.bobberGroup.position.x,
          waterY,
          this.bobberGroup.position.z,
          14,
          3.4,
        );
        soundEngine.playSplash(0.95);
        this.biteTimer = (2.4 + Math.random() * 3.8) / lure.biteSpeedBonus;
        this.nibbleTimer = 0.9 + Math.random() * 0.9;
        this.gameState = FishingState.WAITING;
        this.emitHud(true);
      }
    } else if (this.gameState === FishingState.WAITING) {
      targetRodPitch = 0.22;
      const bx = this.bobberGroup.position.x;
      const bz = this.bobberGroup.position.z;
      const baseWaterY = this.getWaterHeight(bx, bz, elapsed);

      this.nibbleTimer -= delta;
      let nibbleDip = 0;
      if (this.nibbleTimer <= 0) {
        this.nibbleTimer = 1.1 + Math.random() * 1.3;
        this.spawnRipple(bx, bz, 1.35);
        soundEngine.playNibble();
        nibbleDip = -0.09;
      }
      this.bobberGroup.position.y = THREE.MathUtils.damp(
        this.bobberGroup.position.y,
        baseWaterY + nibbleDip,
        10,
        delta,
      );
      this.bobberGroup.rotation.z = Math.sin(elapsed * 2.8) * 0.12;

      this.biteTimer -= delta;
      if (this.biteTimer <= 0) {
        this.gameState = FishingState.BITE;
        this.hookWindowTimer = 1.75;
        this.spawnRipple(bx, bz, 3.0, 0xfca5a5);
        soundEngine.playBiteAlert();
        this.emitHud(true);
      }
    } else if (this.gameState === FishingState.BITE) {
      targetRodPitch = 0.18;
      bendAmount = 0.032 + Math.sin(elapsed * 28) * 0.008;
      const bx = this.bobberGroup.position.x;
      const bz = this.bobberGroup.position.z;
      const baseWaterY = this.getWaterHeight(bx, bz, elapsed);
      this.bobberGroup.position.y = THREE.MathUtils.damp(
        this.bobberGroup.position.y,
        baseWaterY - 0.34 + Math.sin(elapsed * 24) * 0.06,
        14,
        delta,
      );

      this.hookWindowTimer -= delta;
      if (this.hookWindowTimer <= 0) {
        soundEngine.playEscapeOrSnap();
        this.gameState = FishingState.IDLE;
        this.callbacks.onNotice(
          '錯失揚竿時機，魚兒吐鉤游走了！看到浮標急沉請立即點擊或按空白鍵。',
          'warning',
        );
        this.emitHud(true);
      }
    } else if (this.gameState === FishingState.REELING && this.currentFish) {
      const fish = this.currentFish;
      const staminaRatio = Math.max(0, this.fishStamina / this.maxFishStamina);

      this.fishBurstTimer -= delta;
      if (this.fishBurstTimer <= 0) {
        this.isFishBursting = !this.isFishBursting;
        this.fishBurstTimer = this.isFishBursting
          ? 1.1 + Math.random() * 1.1
          : 1.85 + Math.random() * 2.0;
        this.fishLateralDir = Math.random() < 0.5 ? -1 : 1;

        if (this.isFishBursting && this.fishJumpPhase < 0 && this.fishDistance > 5.5) {
          this.fishJumpPhase = 0;
          this.fishMeshGroup.visible = true;
          this.spawnSplashDroplets(
            this.bobberGroup.position.x,
            0.15,
            this.bobberGroup.position.z,
            22,
            5.0,
          );
          soundEngine.playSplash(1.25);
        }
      }

      const pullFactor =
        fish.pullStrength *
        (0.55 + 0.45 * staminaRatio) *
        (this.isFishBursting ? 1.55 : 0.85);

      if (this.isInputDown) {
        const gainRate = (27 * pullFactor) / (rod.tensionBuffer * line.maxTensionLimit);
        this.lineTension += gainRate * delta;
        this.fishDistance -= reel.reelSpeed * (this.isFishBursting ? 0.48 : 1.05) * delta;
        this.fishStamina -= 15 * reel.staminaDrain * delta;
        this.reelRotationSpeed = 16;
      } else {
        const dropRate = 30 - (this.isFishBursting ? 11 * pullFactor : 0);
        this.lineTension -= dropRate * delta;
        const retreat =
          (fish.speed * (this.isFishBursting ? 1.65 : 0.45) * (0.4 + 0.6 * staminaRatio)) /
          reel.dragSmoothness;
        this.fishDistance = Math.min(this.maxCastDistance + 8, this.fishDistance + retreat * delta);
        this.fishStamina -= 4.5 * delta;
        this.reelRotationSpeed = THREE.MathUtils.damp(this.reelRotationSpeed, -4, 6, delta);
      }

      const safeMin = Math.max(12, 24 - rod.safeZoneBonus * 0.5);
      const safeMax = Math.min(90, 80 + rod.safeZoneBonus * 0.5);
      if (this.lineTension >= safeMin && this.lineTension <= safeMax) {
        this.fishStamina -= 9.5 * reel.staminaDrain * delta;
      }
      this.fishStamina = Math.max(0, this.fishStamina);
      soundEngine.tickReelRatchet(delta, this.isInputDown, this.lineTension);

      const maxLat = Math.min(12, this.fishDistance * 0.48);
      this.fishLateralX +=
        this.fishLateralDir *
        fish.speed *
        (this.isFishBursting ? 3.6 : 1.7) *
        delta;
      if (this.fishLateralX > maxLat) {
        this.fishLateralX = maxLat;
        this.fishLateralDir = -1;
      } else if (this.fishLateralX < -maxLat) {
        this.fishLateralX = -maxLat;
        this.fishLateralDir = 1;
      }

      const fz = 4.2 - this.fishDistance;
      const waterY = this.getWaterHeight(this.fishLateralX, fz, elapsed);
      this.bobberGroup.position.set(
        this.fishLateralX,
        waterY - 0.08 + Math.sin(elapsed * 18) * 0.05,
        fz,
      );

      if (Math.random() < (this.isFishBursting ? 0.35 : 0.14)) {
        this.spawnRipple(this.fishLateralX, fz, this.isFishBursting ? 2.6 : 1.5);
      }

      // Animate leaping 3D fish arc out of water during burst
      if (this.fishJumpPhase >= 0) {
        this.fishJumpPhase += delta * 1.65;
        if (this.fishJumpPhase >= 1) {
          this.fishJumpPhase = -1;
          this.fishMeshGroup.visible = false;
          this.spawnSplashDroplets(this.fishLateralX, waterY, fz, 18, 4.4);
          soundEngine.playSplash(1.1);
        } else {
          const arcY = Math.sin(this.fishJumpPhase * Math.PI) * 1.85;
          this.fishMeshGroup.position.set(this.fishLateralX, waterY + arcY, fz);
          this.fishMeshGroup.rotation.set(
            0,
            this.fishLateralDir > 0 ? 0.2 : Math.PI - 0.2,
            (0.5 - this.fishJumpPhase) * 1.15 * this.fishLateralDir,
          );
          this.animateActiveFishFins(elapsed, 8.5);
        }
      }

      targetRodPitch = 0.42 + (this.lineTension / 100) * 0.36;
      targetRodYaw = THREE.MathUtils.clamp(-this.fishLateralX * 0.04, -0.35, 0.35);
      bendAmount = 0.025 + (this.lineTension / 100) * 0.075;
      bendLateral = THREE.MathUtils.clamp(this.fishLateralX * 0.004, -0.03, 0.03);

      // Check Break / Slack Escape / Victory Conditions
      if (this.lineTension >= 100) {
        soundEngine.setCombatMode(false);
        soundEngine.playEscapeOrSnap();
        this.fishMeshGroup.visible = false;
        this.gameState = FishingState.IDLE;
        this.callbacks.onNotice(
          '張力過載斷線！大魚暴衝時請適時放開按鍵卸力，或前往工坊升級釣竿與釣線。',
          'warning',
        );
        this.emitHud(true);
      } else if (this.lineTension <= 2) {
        soundEngine.setCombatMode(false);
        soundEngine.playEscapeOrSnap();
        this.fishMeshGroup.visible = false;
        this.gameState = FishingState.IDLE;
        this.callbacks.onNotice(
          '釣線過度鬆弛導致脫鉤！請間歇點按收線維持安全張力。',
          'warning',
        );
        this.emitHud(true);
      } else if (this.fishDistance <= 2.3 || (this.fishStamina <= 0 && this.fishDistance <= 5.2)) {
        soundEngine.setCombatMode(false);
        soundEngine.playCatchFanfare(fish.rarity);
        this.gameState = FishingState.CAUGHT;
        this.fishMeshGroup.visible = true;
        this.fishJumpPhase = -1;
        if (this.pendingCaughtInstance) {
          this.callbacks.onFishCaught(this.pendingCaughtInstance);
        }
        this.emitHud(true);
      }
    } else if (this.gameState === FishingState.CAUGHT) {
      targetRodPitch = 0.55;
      bendAmount = 0.03;
      // Float caught 3D fish gracefully in left-center foreground so right CatchModal stays clear
      this.fishMeshGroup.visible = true;
      this.fishMeshGroup.position.set(-0.72, 1.88 + Math.sin(elapsed * 2.2) * 0.07, 3.65);
      this.fishMeshGroup.rotation.set(0.08, elapsed * 0.85, Math.sin(elapsed * 1.8) * 0.05);
      this.animateActiveFishFins(elapsed, 4.2);
      this.bobberGroup.position.set(-0.72, 2.32, 3.65);
    }

    // 3. Apply Articulated Rod Kinematics & Reel Crank Spin
    this.rodPivot.rotation.x = THREE.MathUtils.damp(
      this.rodPivot.rotation.x,
      targetRodPitch,
      9,
      delta,
    );
    this.rodGroup.rotation.y = THREE.MathUtils.damp(
      this.rodGroup.rotation.y,
      targetRodYaw,
      8,
      delta,
    );
    this.reelCrank.rotation.x += this.reelRotationSpeed * delta;

    for (let i = 0; i < this.rodSegments.length; i++) {
      const ratio = (i + 1) / this.rodSegments.length;
      const segPitch = -bendAmount * ratio * ratio;
      const segYaw = -bendLateral * ratio;
      this.rodSegments[i].rotation.x = THREE.MathUtils.damp(
        this.rodSegments[i].rotation.x,
        segPitch,
        14,
        delta,
      );
      this.rodSegments[i].rotation.y = THREE.MathUtils.damp(
        this.rodSegments[i].rotation.y,
        segYaw,
        14,
        delta,
      );
    }

    // 4. Update Catenary Fishing Line
    this.rodPivot.updateMatrixWorld(true);
    this.rodTipAnchor.getWorldPosition(_rodTipWorld);

    if (this.gameState === FishingState.IDLE || this.gameState === FishingState.CHARGING) {
      const swayX = Math.sin(elapsed * 2.4) * 0.04;
      this.bobberGroup.position.set(
        _rodTipWorld.x + swayX,
        _rodTipWorld.y - 0.62,
        _rodTipWorld.z,
      );
      this.bobberGroup.rotation.set(0, 0, swayX * 2);
    }

    const endPos = this.bobberGroup.position;
    const sag =
      this.gameState === FishingState.REELING
        ? Math.max(0.02, (1 - this.lineTension / 100) * 0.45)
        : this.gameState === FishingState.WAITING
          ? 0.52
          : 0.14;

    for (let i = 0; i < this.LINE_POINTS; i++) {
      const t = i / (this.LINE_POINTS - 1);
      const lx = THREE.MathUtils.lerp(_rodTipWorld.x, endPos.x, t);
      const ly =
        THREE.MathUtils.lerp(_rodTipWorld.y, endPos.y + 0.25, t) -
        Math.sin(t * Math.PI) * sag;
      const lz = THREE.MathUtils.lerp(_rodTipWorld.z, endPos.z, t);
      this.linePositions[i * 3] = lx;
      this.linePositions[i * 3 + 1] = ly;
      this.linePositions[i * 3 + 2] = lz;
    }
    this.lineGeo.attributes.position.needsUpdate = true;

    // 5. Update Ripples & Splash Droplets
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += delta;
      if (r.age >= r.maxAge) {
        this.scene.remove(r.mesh);
        r.mesh.material.dispose();
        this.ripples.splice(i, 1);
      } else {
        const s = 1 + r.age * r.speed * 4.2;
        r.mesh.scale.setScalar(s);
        r.mesh.material.opacity = 0.82 * (1 - r.age / r.maxAge);
      }
    }

    for (let i = 0; i < this.dropletCount; i++) {
      const d = this.droplets[i];
      if (d.life > 0) {
        d.life -= delta;
        d.vel.y -= 14.5 * delta;
        d.pos.addScaledVector(d.vel, delta);
        _dummyObj.position.copy(d.pos);
        _dummyObj.scale.setScalar(Math.max(0.01, d.life / d.maxLife));
      } else {
        _dummyObj.position.set(0, -50, 0);
        _dummyObj.scale.setScalar(0.001);
      }
      _dummyObj.updateMatrix();
      this.dropletInstanced.setMatrixAt(i, _dummyObj.matrix);
    }
    this.dropletInstanced.instanceMatrix.needsUpdate = true;

    // 6. Smooth Camera Choreography
    if (this.gameState === FishingState.REELING) {
      const shake =
        this.lineTension > 78
          ? Math.sin(elapsed * 42) * 0.035 * ((this.lineTension - 78) / 22)
          : 0;
      _targetCamPos.set(shake, 2.42, 6.05);
      _targetLookAt.set(
        this.bobberGroup.position.x * 0.45,
        0.65,
        Math.max(-28, this.bobberGroup.position.z),
      );
    } else if (this.gameState === FishingState.CHARGING) {
      _targetCamPos.set(0, 2.48, 6.55);
      _targetLookAt.set(Math.sin(this.aimAngle) * 8, 0.9, -16);
    } else if (this.gameState === FishingState.WAITING || this.gameState === FishingState.BITE) {
      _targetCamPos.set(0, 2.28, 5.95);
      _targetLookAt.set(
        this.bobberGroup.position.x * 0.55,
        0.4,
        Math.max(-26, this.bobberGroup.position.z),
      );
    } else if (this.gameState === FishingState.CAUGHT) {
      _targetCamPos.set(0, 2.15, 6.1);
      _targetLookAt.set(-0.25, 1.75, 2.5);
    } else {
      _targetCamPos.set(
        Math.sin(elapsed * 0.45) * 0.06,
        2.35 + Math.cos(elapsed * 0.6) * 0.03,
        6.2,
      );
      _targetLookAt.set(Math.sin(this.aimAngle) * 6, 1.0, -15);
    }

    this.camera.position.lerp(_targetCamPos, 1 - Math.exp(-5 * delta));
    this.currentLookAt.lerp(_targetLookAt, 1 - Math.exp(-5 * delta));
    this.camera.lookAt(this.currentLookAt);

    // 7. Throttled HUD Sync (30 Hz during active states)
    this.hudSyncAccumulator += delta;
    if (this.hudSyncAccumulator >= 0.033) {
      this.hudSyncAccumulator = 0;
      this.emitHud(false);
    }
  }

  private animateActiveFishFins(elapsed: number, freq: number): void {
    if (!this.activeFishRig) return;
    this.activeFishRig.tailPivot.rotation.y = Math.sin(elapsed * freq) * 0.26;
    this.activeFishRig.pectoralL.rotation.x = Math.sin(elapsed * (freq * 0.75)) * 0.16;
    this.activeFishRig.pectoralR.rotation.x = -Math.sin(elapsed * (freq * 0.75)) * 0.16;
    if (this.activeFishRig.haloRing) {
      this.activeFishRig.haloRing.rotation.z = elapsed * 0.7;
    }
    if (this.activeFishRig.outerHaloRing) {
      this.activeFishRig.outerHaloRing.rotation.z = -elapsed * 0.45;
    }
  }

  private emitHud(force: boolean): void {
    if (
      !force &&
      this.gameState !== FishingState.CHARGING &&
      this.gameState !== FishingState.REELING &&
      this.gameState !== FishingState.BITE
    ) {
      return;
    }

    const rod = RODS.find((r) => r.id === this.saveData.equippedRodId) ?? RODS[0];
    const safeZoneMin = Math.round(Math.max(12, 24 - rod.safeZoneBonus * 0.5));
    const safeZoneMax = Math.round(Math.min(90, 80 + rod.safeZoneBonus * 0.5));

    let statusMessage = '滑鼠微調拋投方向 · 按住 [滑鼠左鍵] 或 [空白鍵] 蓄力拋竿';
    if (this.gameState === FishingState.CHARGING) {
      statusMessage = '蓄力中 — 放開按鍵拋出浮標';
    } else if (this.gameState === FishingState.CASTING) {
      statusMessage = '浮標劃破長空...';
    } else if (this.gameState === FishingState.WAITING) {
      statusMessage = '靜觀漣漪 — 待浮標猛然沒入水中時點擊刺魚';
    } else if (this.gameState === FishingState.BITE) {
      statusMessage = '魚兒咬鉤！立即點擊或按 [空白鍵] 揚竿刺魚！';
    } else if (this.gameState === FishingState.REELING) {
      statusMessage = this.isFishBursting
        ? '巨物暴衝中！適時放開按鍵防止斷線！'
        : '搏魚拉鋸中 — 按住收線、放開降張力，維持在翠綠安全區間';
    } else if (this.gameState === FishingState.CAUGHT) {
      statusMessage = '成功起魚！請選擇收入魚護或放流祈福';
    }

    this.callbacks.onHudUpdate({
      state: this.gameState,
      statusMessage,
      isBiteUrgent: this.gameState === FishingState.BITE,
      castPower: Math.round(this.castPower),
      aimAngleDeg: Math.round(THREE.MathUtils.radToDeg(-this.aimAngle)),
      lineTension: Math.round(THREE.MathUtils.clamp(this.lineTension, 0, 100)),
      safeZoneMin,
      safeZoneMax,
      fishDistance: Number(Math.max(0, this.fishDistance).toFixed(1)),
      maxCastDistance: Number(this.maxCastDistance.toFixed(1)),
      fishStamina: Math.round(
        (this.fishStamina / Math.max(1, this.maxFishStamina)) * 100,
      ),
      isFishBursting: this.isFishBursting,
      activeFishRarity: this.currentFish?.rarity,
    });
  }

  public dispose(): void {
    this.isDisposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    this.timer.dispose();
    this.cleanupListeners();

    // Complete recursive WebGL GPU disposal across the entire scene graph
    for (const r of this.ripples) {
      this.scene.remove(r.mesh);
      r.mesh.material.dispose();
    }
    this.ripples = [];

    disposeObjectSubtree(this.scene);
    this.rippleGeo.dispose();
    this.causticTex.dispose();
    if (this.envRT) {
      this.envRT.dispose();
      this.envRT = null;
    }
    this.scene.environment = null;

    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
