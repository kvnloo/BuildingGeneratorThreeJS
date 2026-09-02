import {
  ACESFilmicToneMapping, BufferGeometry, Clock, Color, DoubleSide, EdgesGeometry,
  Group, InstancedMesh, LineBasicMaterial, LineSegments, MathUtils,
  Material, Matrix4, Mesh, MeshBasicMaterial, MeshNormalMaterial, MeshStandardMaterial,
  Object3D, PerspectiveCamera, PlaneGeometry, Raycaster, Scene, ShaderMaterial,
  SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import GUI from "lil-gui";
import { defaultParams, type BuildingParams } from "./params";
import { generateBuilding } from "./generator";
import { Kit } from "./kit";
import { Environment, type Bounds } from "./environment";
import { PostFX } from "./postfx";
import { createSnow } from "./snow";
import { createSnowAccumUniforms, createSnowShellMaterial } from "./snowAccum";
import { createRain } from "./rain";
import { createWetUniforms, applyWet } from "./wet";

const app = document.getElementById("app")!;
// logarithmicDepthBuffer spreads depth precision so near-coplanar surfaces (posters
// on walls, glass in frames, awnings flush to the facade) stop z-fighting
const renderer = new WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new Scene();

// tight near/far ratio = far more usable depth precision (building is ~15u, orbit
// distance is clamped to [3, 120] below), which kills most of the z-fighting
const camera = new PerspectiveCamera(30, innerWidth / innerHeight, 0.5, 600);
camera.position.set(12, 7, 14);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 3.5, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.54; // keep the camera above the ground plane
controls.minDistance = 3;
controls.maxDistance = 120;

// realistic lighting + sky + PBR environment
const env = new Environment(scene, renderer);

// ground
const ground = new Mesh(
  new PlaneGeometry(600, 600),
  new MeshStandardMaterial({ color: 0x404040, roughness: 1, metalness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Blender is Z-up: build everything in Blender space inside a rotated root.
// rotation.z (Blender up axis) spins the whole building 180°; with the default XYZ
// Euler order it is applied before the -90° X tilt, so it reads as a world-Y turn.
const root = new Group();
root.rotation.set(-Math.PI / 2, 0, Math.PI);
scene.add(root);

const kit = new Kit();
const params: BuildingParams = defaultParams();
let building: Group | null = null;

// ---- snow: falling flakes (world space) + accumulation shell on the building ----
const snowShared = { uTime: { value: 0 }, uWind: { value: new Vector3(2, 0, 1) } };
const accumU = createSnowAccumUniforms(snowShared.uTime);
kit.snowShellMaterial = createSnowShellMaterial(accumU);
const snow = createSnow({ camera, shared: snowShared });
snow.mesh.visible = false;
// draw flakes on top of the building instead of being occluded by it
snow.material.depthTest = false;
snow.mesh.renderOrder = 10;
scene.add(snow.mesh);

const snowState = { enabled: false, density: 0.5 };
const wind = { strength: 2, direction: 20 };
function applyWind(): void {
  const a = (wind.direction * Math.PI) / 180;
  snowShared.uWind.value.set(Math.cos(a) * wind.strength, 0, Math.sin(a) * wind.strength);
}
applyWind();
function applySnowEnabled(v: boolean): void {
  // snow and rain are mutually exclusive — turning one on turns the other off
  if (v && rainState.enabled) {
    rainState.enabled = false;
    applyRainEnabled(false);
  }
  snow.mesh.visible = v;
  const shell = building?.getObjectByName("snowShell");
  if (shell) shell.visible = v;
  gui.controllersRecursive().forEach(c => c.updateDisplay());
}

// ---- rain: falling streaks (world space) + in-place wet accumulation on the ----
// building materials (no shell geometry — the wet shader is injected straight into
// the building/floor materials via onBeforeCompile, keyed off WORLD up)
const rainShared = { uTime: { value: 0 }, uWind: { value: new Vector3(3, 0, 1) }, uLightning: { value: 0 } };
const wetU = createWetUniforms(rainShared.uTime, rainShared.uWind);
const rain = createRain({ camera, shared: rainShared });
rain.mesh.visible = false;
// draw streaks on top of the building instead of being occluded by it
rain.material.depthTest = false;
rain.mesh.renderOrder = 10;
scene.add(rain.mesh);

const rainState = { enabled: false, density: 0.4 };
const rainWind = { strength: 3, direction: 20 };
function applyRainWind(): void {
  const a = (rainWind.direction * Math.PI) / 180;
  rainShared.uWind.value.set(Math.cos(a) * rainWind.strength, 0, Math.sin(a) * rainWind.strength);
}
applyRainWind();
function applyRainEnabled(v: boolean): void {
  // snow and rain are mutually exclusive — turning one on turns the other off
  if (v && snowState.enabled) {
    snowState.enabled = false;
    applySnowEnabled(false);
  }
  rain.mesh.visible = v;
  wetU.uWet.value = v ? 1 : 0; // master gate: building dries out when rain is off
  gui.controllersRecursive().forEach(c => c.updateDisplay());
}

/** world-space bounds of the current building, for camera framing + shadow fitting */
function getBounds(): Bounds {
  const h = params.floor + 0.4;
  return { center: new Vector3(0, h / 2, 0), radius: 0.5 * Math.hypot(params.length, params.width, h) };
}

// ---- debug isolation modes (root-cause hunting, driven via window.__debug) ----
// "albedo":  unlit textures — if facades differ here, the difference is in the texture
// "normals": MeshNormalMaterial — visualizes geometry normals; inverted/mirrored
//            normals show up as wrong colors
// "uniform": white uniform ambient only — if facades match here, the difference is
//            the directional/colored light rig
type DebugMode = "off" | "albedo" | "normals" | "uniform";
let debugMode: DebugMode = "off";
const albedoCache = new Map<Material, Material>();
const normalViewMat = new MeshNormalMaterial({ side: DoubleSide });
const lightDefaults = {
  key: 3.0, fill: 0.6, rim: 120, ambColor: 0x223044, amb: 0.4,
};

function applyDebugMaterials(g: Group): void {
  if (debugMode !== "albedo" && debugMode !== "normals") return;
  g.traverse(o => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    if (debugMode === "normals") {
      mesh.material = normalViewMat;
      return;
    }
    const orig = mesh.material as MeshStandardMaterial;
    let dbg = albedoCache.get(orig);
    if (!dbg) {
      dbg = new MeshBasicMaterial({
        map: orig.map ?? null,
        color: orig.map ? 0xffffff : (orig.color?.getHex() ?? 0xffffff),
        side: DoubleSide,
        transparent: orig.transparent,
        opacity: orig.opacity,
        alphaTest: orig.alphaTest,
      });
      albedoCache.set(orig, dbg);
    }
    mesh.material = dbg;
  });
}

function applyDebugLighting(): void {
  if (debugMode === "uniform") {
    env.key.intensity = 0;
    env.fill.intensity = 0;
    env.rim.intensity = 0;
    env.ambient.color.set(0xffffff);
    env.ambient.intensity = 3.0;
    scene.environmentIntensity = 0;
    scene.fog = null;
  } else {
    env.key.intensity = lightDefaults.key;
    env.fill.intensity = lightDefaults.fill;
    env.rim.intensity = lightDefaults.rim;
    env.ambient.color.set(lightDefaults.ambColor);
    env.ambient.intensity = lightDefaults.amb;
    env.refresh();
  }
}

function regenerate(): void {
  if (building) {
    root.remove(building);
    building.traverse(o => {
      const im = o as { isInstancedMesh?: boolean; dispose?: () => void };
      if (im.isInstancedMesh) im.dispose?.();
    });
  }
  building = kit.buildGroup(generateBuilding(params, kit));
  applyDebugMaterials(building);
  root.add(building);
  applySnowEnabled(snowState.enabled); // new snowShell group starts hidden
  env.frame(getBounds());
}

// ---- mesh inspector: hover a mesh to outline it + read its name/polycount ----
const inspect = { enabled: false };
const raycaster = new Raycaster();
const pointer = new Vector2();
let pointerInside = false;

// bright edge overlay drawn on top of the hovered instance (depthTest off so it
// reads through the building); geometry swapped per-hover from an edges cache
const edgesCache = new Map<BufferGeometry, EdgesGeometry>();
const outline = new LineSegments(
  new BufferGeometry(),
  new LineBasicMaterial({ color: 0x00e5ff, depthTest: false, transparent: true, opacity: 0.9 }),
);
outline.frustumCulled = false;
outline.matrixAutoUpdate = false;
outline.renderOrder = 999;
outline.visible = false;
scene.add(outline);

// floating label (name + polycount) that follows the cursor
const tip = document.createElement("div");
tip.style.cssText =
  "position:fixed;pointer-events:none;z-index:10;padding:4px 8px;border-radius:4px;" +
  "background:rgba(0,0,0,0.8);color:#00e5ff;font:12px/1.4 monospace;white-space:nowrap;" +
  "border:1px solid rgba(0,229,255,0.5);display:none;transform:translate(12px,12px)";
document.body.appendChild(tip);

function edgesFor(geom: BufferGeometry): EdgesGeometry {
  let e = edgesCache.get(geom);
  if (!e) edgesCache.set(geom, (e = new EdgesGeometry(geom, 30)));
  return e;
}

function triCount(geom: BufferGeometry): number {
  const n = geom.index ? geom.index.count : geom.getAttribute("position").count;
  return Math.floor(n / 3);
}

/** true only for pickable opaque building instances (skip the hidden snow shell) */
function isPickable(o: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p.name === "snowShell") return false;
  }
  return true;
}

const _instMat = new Matrix4();
function clearInspect(): void {
  outline.visible = false;
  tip.style.display = "none";
}
function updateInspect(): void {
  if (!inspect.enabled || !pointerInside || !building) return clearInspect();
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(building, true);
  const hit = hits.find(
    h => (h.object as InstancedMesh).isInstancedMesh && isPickable(h.object),
  );
  if (!hit) return clearInspect();
  const im = hit.object as InstancedMesh;
  const geom = im.geometry;
  outline.geometry = edgesFor(geom);
  // world matrix of the hovered instance = mesh world * per-instance matrix
  im.getMatrixAt(hit.instanceId!, _instMat);
  outline.matrix.copy(im.matrixWorld).multiply(_instMat);
  outline.matrixWorld.copy(outline.matrix);
  outline.visible = true;
  tip.textContent = `${im.name}  •  ${triCount(geom).toLocaleString()} tris  •  #${hit.instanceId}`;
  tip.style.display = "block";
}

renderer.domElement.addEventListener("pointermove", e => {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  pointerInside = true;
  tip.style.left = `${e.clientX}px`;
  tip.style.top = `${e.clientY}px`;
});
renderer.domElement.addEventListener("pointerleave", () => {
  pointerInside = false;
  clearInspect();
});

// cinematic post-processing (ported from SnowSystemThreeJS)
const post = new PostFX(renderer, scene, camera);

// cinematic camera prefs — auto-orbit via OrbitControls, plus fov + letterbox
const cine = { autoOrbit: false, orbitSpeed: 0.6, fov: 30, letterbox: false };
controls.autoRotate = cine.autoOrbit;
controls.autoRotateSpeed = cine.orbitSpeed;
camera.fov = cine.fov;
camera.updateProjectionMatrix();

// letterbox bars (CSS overlay, styled in index.html)
const barTop = document.getElementById("bar-top") as HTMLElement | null;
const barBottom = document.getElementById("bar-bottom") as HTMLElement | null;
function applyLetterbox(): void {
  const h = cine.letterbox ? "8vh" : "0";
  if (barTop) barTop.style.height = h;
  if (barBottom) barBottom.style.height = h;
}
applyLetterbox();

// focus-plane visualizer — a translucent grid shown at the DoF focus distance
// while the Focus Distance slider is dragged, then fades out on its own
const focusPlaneMat = new ShaderMaterial({
  transparent: true,
  depthWrite: false,
  side: DoubleSide,
  uniforms: { uOpacity: { value: 0 }, uColor: { value: new Color(0x8fcfff) } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform float uOpacity; uniform vec3 uColor; varying vec2 vUv;
    void main() {
      vec2 grid = abs(fract(vUv * 12.0) - 0.5);
      vec2 d = grid / fwidth(vUv * 12.0);
      float line = 1.0 - clamp(min(d.x, d.y), 0.0, 1.0);
      vec2 c = abs(vUv - 0.5);
      float cross = step(c.x, 0.0015) + step(c.y, 0.0015);
      float a = (line * 0.55 + 0.05 + cross * 0.9) * uOpacity;
      if (a <= 0.001) discard;
      gl_FragColor = vec4(uColor, a);
    }
  `,
});
const focusPlane = new Mesh(new PlaneGeometry(1, 1), focusPlaneMat);
focusPlane.frustumCulled = false;
focusPlane.visible = false;
scene.add(focusPlane);

let focusTimer = 0;
const _focusDir = new Vector3();
function showFocusPlane(): void {
  focusTimer = 1.2;
  focusPlane.visible = true;
}
function updateFocusPlane(dt: number): void {
  if (focusTimer <= 0) {
    if (focusPlane.visible) focusPlane.visible = false;
    return;
  }
  focusTimer -= dt;
  const dist = post.bokehUniforms["focus"].value;
  camera.getWorldDirection(_focusDir);
  focusPlane.position.copy(camera.position).addScaledVector(_focusDir, dist);
  focusPlane.quaternion.copy(camera.quaternion);
  const halfH = Math.tan(MathUtils.degToRad(camera.fov / 2)) * dist;
  const halfW = halfH * camera.aspect;
  focusPlane.scale.set(halfW * 2 * 0.92, halfH * 2 * 0.92, 1);
  focusPlaneMat.uniforms.uOpacity.value = 0.9 * Math.min(1, focusTimer / 0.4);
}

// ---- GUI ----
const gui = new GUI({ title: "hong kong building" });

// --- building settings (top of the list): every generator param, flat ---
const fBuild = gui.addFolder("building settings");
fBuild.add(params, "floor", 3, 40, 1);
fBuild.add(params, "length", 2, 40, 1);
fBuild.add(params, "width", 2, 40, 1);
fBuild.add(params, "acUnit", 0, 1, 0.01).name("AC unit");
fBuild.add(params, "roofProbability", 0, 1, 0.01).name("window awning");
fBuild.add(params, "clothlineProbability", 0, 1, 0.01).name("clothline");
fBuild.add(params, "lights", 0, 1, 0.01).name("lights");
fBuild.add(params, "windowType", 0, 1, 0.01).name("window type");
fBuild.add(params, "windowOpenAmount", 0, 1, 0.01).name("window open");
fBuild.add(params, "curtainClose", 0, 1, 0.01).name("curtain close");
fBuild.add(params, "closedOpenStore", 0, 1, 0.01).name("open store");
fBuild.add(params, "roofOnStore", 0, 1, 0.01).name("roof on store");
fBuild.add(params, "objectOnGround", 0, 1, 0.01).name("ground objects");
fBuild.add(params, "storeSign", 0, 1, 0.01).name("store sign");
fBuild.add(params, "objectOnRoof", 0, 1, 0.01).name("roof objects");
// floor emissive multiplier (glowing signage) — a material tweak, so it updates the
// floor material live instead of rebuilding the instanced meshes
const emissiveParams = { emissive: 1 };
const emissiveCtrl = fBuild.add(emissiveParams, "emissive", 1, 50, 1).name("emissive")
  .onChange((v: number) => kit.setFloorEmissive(v));
fBuild.add(params, "randomise", 0, 1000, 1).name("seed");
// any building-settings change regenerates the mesh — except the emissive slider,
// which only nudges the floor material (no need to rebuild ~900 instanced meshes)
fBuild.onChange(ev => {
  if (ev.controller !== emissiveCtrl) regenerate();
});

// --- fps counter (debug) — a small corner overlay, updated ~twice a second ---
const fpsState = { enabled: false };
const fpsEl = document.createElement("div");
fpsEl.style.cssText =
  "position:fixed;top:8px;left:8px;z-index:10;padding:3px 7px;border-radius:4px;" +
  "background:rgba(0,0,0,0.7);color:#7CFC00;font:12px/1.3 monospace;pointer-events:none;display:none";
document.body.appendChild(fpsEl);
let fpsLastT = performance.now();
let fpsFrames = 0;
function updateFps(): void {
  if (!fpsState.enabled) return;
  fpsFrames++;
  const now = performance.now();
  if (now - fpsLastT >= 500) {
    fpsEl.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsLastT))} fps`;
    fpsFrames = 0;
    fpsLastT = now;
  }
}

// --- debug: hover a mesh to inspect its contour, name + polycount ---
const fDebug = gui.addFolder("debug");
fDebug.add(inspect, "enabled").name("inspect meshes").onChange((v: boolean) => {
  if (!v) clearInspect();
  renderer.domElement.style.cursor = v ? "crosshair" : "";
});
fDebug.add(fpsState, "enabled").name("fps").onChange((v: boolean) => {
  fpsEl.style.display = v ? "block" : "none";
  if (v) { fpsLastT = performance.now(); fpsFrames = 0; } // clean first reading
});
fDebug.close();

env.addGui(gui);

// ---- snow GUI (one master toggle, ported params from SnowSystemThreeJS) ----
const fSnow = gui.addFolder("snow");
fSnow.add(snowState, "enabled").name("enabled").onChange(applySnowEnabled);
const fFall = fSnow.addFolder("snowfall");
fFall.add(snowState, "density", 0, 1, 0.01).name("density").onChange((v: number) => snow.setDensity(v));
fFall.add(snow.uniforms.uSpeed, "value", 0.5, 12, 0.1).name("fall speed");
fFall.add(snow.uniforms.uSize, "value", 0.01, 0.25, 0.001).name("flake size");
fFall.add(snow.uniforms.uSway, "value", 0, 3, 0.01).name("sway");
fFall.add(snow.uniforms.uOpacity, "value", 0, 1, 0.01).name("opacity");
fFall.addColor({ c: "#ffffff" }, "c").name("color").onChange((v: string) => snow.uniforms.uColor.value.set(v));
fFall.add(snow.uniforms.uVolume.value, "y", 10, 80, 1).name("fall height");
fFall.add(wind, "strength", 0, 25, 0.1).name("wind").onChange(applyWind);
fFall.add(wind, "direction", 0, 360, 1).name("wind dir").onChange(applyWind);
fFall.close();
const fAccum = fSnow.addFolder("accumulation");
fAccum.add(accumU.uSnowCoverage, "value", 0, 1, 0.01).name("coverage");
fAccum.add(accumU.uSnowScale, "value", 0.1, 4, 0.01).name("patch scale");
fAccum.add(accumU.uSnowEdge, "value", 0.01, 0.4, 0.005).name("patch softness");
fAccum.add(accumU.uSnowHeightVar, "value", 0, 2, 0.01).name("height variation");
fAccum.add(accumU.uSnowSeed.value, "x", -50, 50, 0.1).name("seed x").listen();
fAccum.add(accumU.uSnowSeed.value, "y", -50, 50, 0.1).name("seed y").listen();
fAccum.add({ randomize: () => accumU.uSnowSeed.value.set((Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100) },
  "randomize").name("🎲 randomize seed");
fAccum.add(accumU.uSnowFlatThreshold, "value", 0, 1, 0.01).name("flatness");
fAccum.addColor({ c: "#eaf1ff" }, "c").name("color").onChange((v: string) => accumU.uSnowColor.value.set(v));
fAccum.add(accumU.uSnowRoughness, "value", 0.3, 1, 0.01).name("roughness");
fAccum.add(accumU.uSnowBump, "value", 0, 1.5, 0.01).name("relief strength");
fAccum.add(accumU.uSnowBumpScale, "value", 0.5, 8, 0.05).name("relief scale");
fAccum.add(accumU.uSnowSparkle, "value", 0, 1, 0.01).name("sparkle");
fAccum.add(accumU.uSnowSparkleScale, "value", 30, 300, 1).name("sparkle density");
fAccum.close();
fSnow.close();

// ---- rain GUI (master toggle, ported from RainSystemThreeJS) ----
const fRain = gui.addFolder("rain");
fRain.add(rainState, "enabled").name("enabled").onChange(applyRainEnabled);
const fRainfall = fRain.addFolder("rainfall");
fRainfall.add(rainState, "density", 0, 1, 0.01).name("density").onChange((v: number) => rain.setDensity(v));
fRainfall.add(rain.uniforms.uSpeed, "value", 2, 60, 0.5).name("fall speed");
fRainfall.add(rain.uniforms.uLength, "value", 0.2, 4, 0.01).name("streak length");
fRainfall.add(rain.uniforms.uWidth, "value", 0.002, 0.05, 0.001).name("streak width");
fRainfall.add(rain.uniforms.uOpacity, "value", 0, 1, 0.01).name("opacity");
fRainfall.addColor({ c: "#b4b8bf" }, "c").name("color").onChange((v: string) => rain.uniforms.uColor.value.set(v));
fRainfall.add(rain.uniforms.uVolume.value, "y", 10, 80, 1).name("fall height");
fRainfall.add(rainWind, "strength", 0, 25, 0.1).name("wind").onChange(applyRainWind);
fRainfall.add(rainWind, "direction", 0, 360, 1).name("wind dir").onChange(applyRainWind);
fRainfall.close();
const fWet = fRain.addFolder("wetness");
fWet.add(wetU.uPuddleCoverage, "value", 0, 1, 0.01).name("coverage");
fWet.add(wetU.uPuddleScale, "value", 0.02, 2, 0.01).name("mask scale");
fWet.add(wetU.uPuddleEdge, "value", 0.001, 0.4, 0.001).name("mask softness");
fWet.add(wetU.uPuddleHeightVar, "value", 0, 2, 0.01).name("height variation");
fWet.add(wetU.uPuddleSeed.value, "x", -50, 50, 0.1).name("seed x").listen();
fWet.add(wetU.uPuddleSeed.value, "y", -50, 50, 0.1).name("seed y").listen();
fWet.add({ randomize: () => wetU.uPuddleSeed.value.set((Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100) },
  "randomize").name("🎲 randomize seed");
fWet.add(wetU.uWetness, "value", 0, 1, 0.01).name("surface wetness");
fWet.add(wetU.uWaterDarkness, "value", 0, 1, 0.01).name("wet darkness");
fWet.add(wetU.uPuddleRoughness, "value", 0, 0.5, 0.001).name("reflection roughness");
fWet.add(wetU.uDropletAmount, "value", 0, 1, 0.01).name("droplet beading");
fWet.add(wetU.uDropletScale, "value", 2, 40, 0.5).name("droplet density");
fWet.add(wetU.uTopPuddle, "value", 0, 1, 0.01).name("top puddles");
fWet.add(wetU.uFlatThreshold, "value", 0.2, 0.99, 0.01).name("flatness");
fWet.add(wetU.uRainRipple, "value", 0, 0.3, 0.001).name("ripple strength");
fWet.add(wetU.uRippleScale, "value", 1, 20, 0.1).name("ripple scale");
fWet.add(wetU.uRippleSpeed, "value", 0, 4, 0.01).name("ripple speed");
fWet.add(wetU.uRippleDensity, "value", 0, 1, 0.01).name("ripple density");
fWet.close();
fRain.close();

// --- 🎬 Cinematic (last in the list): Camera / Depth of Field / Effects ---
const fCine = gui.addFolder("🎬 cinematic");
const fCam = fCine.addFolder("Camera");
fCam.add(cine, "autoOrbit").name("Auto Orbit").onChange((v: boolean) => (controls.autoRotate = v));
fCam.add(cine, "orbitSpeed", -3, 3, 0.05).name("Orbit Speed").onChange((v: number) => (controls.autoRotateSpeed = v));
fCam.add(cine, "fov", 18, 80, 1).name("Focal / FOV").onChange((v: number) => {
  camera.fov = v;
  camera.updateProjectionMatrix();
});
fCam.add(cine, "letterbox").name("Letterbox").onChange(applyLetterbox);

const dofParams = { enabled: false };
const fDof = fCine.addFolder("Depth of Field");
fDof.add(dofParams, "enabled").name("Enable DoF").onChange((v: boolean) => (post.bokeh.enabled = v));
fDof.add(post.bokehUniforms["focus"], "value", 0, 2, 0.01).name("Focus Distance").onChange(showFocusPlane);
fDof.add(post.bokehUniforms["aperture"], "value", 0, 0.004, 0.00005).name("Aperture");
fDof.add(post.bokehUniforms["maxblur"], "value", 0, 0.02, 0.0005).name("Max Blur");

const fFx = fCine.addFolder("Effects");
fFx.add(post.bloom, "strength", 0, 2, 0.01).name("Bloom");
fFx.add(post.bloom, "radius", 0, 2, 0.01).name("Bloom Radius");
fFx.add(post.bloom, "threshold", 0, 1, 0.01).name("Bloom Threshold");
fFx.add(post.gradeUniforms["uGrain"], "value", 0, 0.25, 0.005).name("Film Grain");
fFx.add(post.gradeUniforms["uVignette"], "value", 0, 1.5, 0.01).name("Vignette");
fFx.add(post.gradeUniforms["uChroma"], "value", 0, 0.01, 0.0001).name("Chromatic Aberration");
fFx.add(post.gradeUniforms["uContrast"], "value", 0.7, 1.6, 0.01).name("Contrast");
fFx.add(post.gradeUniforms["uSaturation"], "value", 0, 2, 0.01).name("Saturation");
fCine.close();

// dev hooks for headless verification
const devWindow = window as unknown as {
  __setParams?: (p: Partial<BuildingParams>) => void;
  __setCamera?: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => void;
  __shot?: (name?: string) => void;
  __setEnv?: (s: Partial<Environment["settings"]>) => void;
};
devWindow.__setParams = p => {
  Object.assign(params, p);
  gui.controllersRecursive().forEach(c => c.updateDisplay());
  regenerate();
};
devWindow.__setCamera = (px, py, pz, tx, ty, tz) => {
  controls.autoRotate = false;
  camera.position.set(px, py, pz);
  controls.target.set(tx, ty, tz);
  controls.update();
};
devWindow.__shot = () => {}; // kept as a no-op for the snapshot tools
(devWindow as { __debug?: (m: DebugMode) => void }).__debug = m => {
  debugMode = m;
  applyDebugLighting();
  regenerate();
};
(devWindow as { __snow?: (on: boolean) => void }).__snow = on => {
  snowState.enabled = on;
  applySnowEnabled(on);
  gui.controllersRecursive().forEach(c => c.updateDisplay());
};
devWindow.__setEnv = s => {
  Object.assign(env.settings, s);
  gui.controllersRecursive().forEach(c => c.updateDisplay());
  env.refresh();
  env.frame(getBounds());
};

kit.load("/assets/kit.glb", "/assets/kit_manifest.json").then(() => {
  document.getElementById("loading")?.remove();
  // inject the wet-surface shader into the building materials once (inert while
  // uWet = 0; the rain toggle raises it to 1). No shell geometry — it lives in the
  // building/floor materials themselves.
  applyWet(kit.materials.building, wetU);
  applyWet(kit.materials.floor, wetU);
  regenerate();
  // fixed 3/4 framing (snow-system style: fixed camera + OrbitControls)
  camera.position.set(9, 5.5, 11);
  controls.target.set(0, 3, 0);
  controls.update();
}).catch(err => {
  const el = document.getElementById("loading");
  if (el) el.textContent = `FAILED TO LOAD KIT: ${err}`;
  console.error(err);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(innerWidth, innerHeight);
});

const clock = new Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  controls.update(); // drives damping + auto-orbit
  if (camera.position.y < 0.2) camera.position.y = 0.2; // never let the camera go below the ground plane
  env.tick();
  if (snowState.enabled) {
    snowShared.uTime.value += dt; // drives flake fall + sparkle twinkle
    snow.update();
  }
  if (rainState.enabled) {
    rainShared.uTime.value += dt; // drives streak fall + puddle ripples
    rain.update();
  }
  updateFocusPlane(dt);
  updateInspect();
  updateFps();
  post.render(dt);
});
