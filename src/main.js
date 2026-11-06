import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { LAMP, rIn } from './sim.js';
import { globeVert, globeFrag, GradeShader } from './shaders.js';

// ------------------------------------------------------------------ constants
const GY = 0.118;                 // height of the globe's inner bottom above the lamp's foot
const SPACING = 0.19;             // distance between lamps on the shelf
const MAX_LAMPS = 5;
const LAYER_GLOBE = 2, LAYER_PROXY = 1, LAYER_REFL = 3; // REFL: seen only in reflections

const PRESETS = {
  'Red in Purple':    { wax: '#ff2a12', liquid: '#7b3dff', clarity: 0.55 },
  'Yellow in Pink':   { wax: '#ffd21c', liquid: '#ff3c9a', clarity: 0.55 },
  'Red in Clear':     { wax: '#ff1f3d', liquid: '#fff4ee', clarity: 0.2 },
  'White in Blue':    { wax: '#f2f7ff', liquid: '#1e64ff', clarity: 0.6 },
  'Green in Yellow':  { wax: '#69ff2a', liquid: '#f4ff9c', clarity: 0.35 },
  'Orange in Clear':  { wax: '#ff7a0e', liquid: '#fff6e6', clarity: 0.2 },
  'Aqua in Teal':     { wax: '#bdfdff', liquid: '#14b8d4', clarity: 0.55 },
  'Pink in Clear':    { wax: '#ff3fb0', liquid: '#fff2fa', clarity: 0.2 },
};
const FINISHES = {
  Silver: { color: '#d4d7dc', metalness: 1, roughness: 0.2 },
  Gold:   { color: '#e9c27a', metalness: 1, roughness: 0.28 },
  Copper: { color: '#e09a6c', metalness: 1, roughness: 0.3 },
  Black:  { color: '#1a1a1c', metalness: 0.65, roughness: 0.42 },
};
// presets / finishes handed out to lamps by shelf position (centre lamp first)
const LINEUP = [
  ['Red in Purple', 'Silver'], ['White in Blue', 'Black'], ['Yellow in Pink', 'Gold'],
  ['Green in Yellow', 'Silver'], ['Pink in Clear', 'Copper'],
];
const QUALITY = {
  Auto:   { pr: 2, steps: 150, auto: true },
  Low:    { pr: 1, steps: 90 },
  Medium: { pr: 1.5, steps: 140 },
  High:   { pr: 2, steps: 200 },
};

const Q = new URLSearchParams(location.search);
const view = {
  lamps: Math.max(1, Math.min(MAX_LAMPS, +(Q.get('lamps') ?? 3) || 3)),
  speed: 1.0, roomLight: 0.4, exposure: 1.0, bloom: 0.55, vignette: 0.55, thermal: false,
  quality: 'Auto', autoRotate: false,
};

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.NoToneMapping; // tone mapping happens in the grade pass
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color();

const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.01, 30);
camera.position.set(0.12, 0.27, 0.8);
camera.layers.enable(LAYER_GLOBE);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.205, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 0.22;
controls.maxDistance = 2.4;
controls.maxPolarAngle = Math.PI * 0.53;
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.autoRotateSpeed = 0.35;
if (Q.get('cam') === 'close') { camera.position.set(0.08, 0.27, 0.42); }
if (Q.get('cam') === 'wide') { camera.position.set(0.25, 0.42, 1.25); controls.target.set(0, 0.18, 0); }

// ------------------------------------------------------------------ room: a plain, evenly lit studio
const room = new THREE.Group(); scene.add(room);
const floorMat = new THREE.MeshStandardMaterial({ color: 0x4a443f, roughness: 0.82, metalness: 0 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), floorMat);
floor.rotation.x = -Math.PI / 2; room.add(floor);
// seamless backdrop: floor curving up into a wall
const cove = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 8, 32, 1, true, Math.PI, Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x4a443f, roughness: 0.9, side: THREE.BackSide }));
cove.rotation.z = Math.PI / 2; cove.position.set(0, 0.5, -0.45); room.add(cove);
const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 4), new THREE.MeshStandardMaterial({ color: 0x4a443f, roughness: 0.9 }));
wall.position.set(0, 2.5, -0.95); room.add(wall);
const hemi = new THREE.HemisphereLight(0xfff3e8, 0x3a332e, 1); room.add(hemi);
const key = new THREE.DirectionalLight(0xfff0e4, 1); key.position.set(-1.2, 2.5, 2.0); room.add(key);
// studio softboxes: only visible in reflections, they give the metal and glass real highlights
const softMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
for (const [w, h, x, y, z] of [[1.2, 0.5, -0.9, 1.4, 1.2], [0.5, 1.4, 1.6, 0.6, 1.0], [2.0, 0.35, 0, 1.9, -0.2]]) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), softMat);
  m.position.set(x, y, z); m.lookAt(0, 0.2, 0); m.layers.set(LAYER_REFL); room.add(m);
}

// soft contact shadow under each lamp (cheap stand-in for ambient occlusion)
const contactTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 10, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.45, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
const contactMat = new THREE.MeshBasicMaterial({ map: contactTex, transparent: true, depthWrite: false });

function applyRoomLight() {
  const L = view.roomLight;
  hemi.intensity = 0.04 + 1.5 * L;
  key.intensity = 1.1 * L;
  softMat.color.setScalar(0.2 + 1.3 * L);
  const bg = new THREE.Color(0x4a443f).multiplyScalar(0.03 + 0.9 * L);
  scene.background.copy(bg);
  envDirty = true;
}

// ------------------------------------------------------------------ shared lamp geometry
const smax = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; };
function baseR(y) {
  const lower = 0.066 - (0.066 - 0.0335) * (y - 0.012) / (0.088 - 0.012);
  const upper = 0.0335 + (0.0512 - 0.0335) * (y - 0.088) / (0.1385 - 0.088);
  return smax(lower, upper, 0.012);
}
const basePts = [new THREE.Vector2(0.0, 0.0), new THREE.Vector2(0.06, 0.0), new THREE.Vector2(0.0655, 0.0012), new THREE.Vector2(0.0678, 0.0045), new THREE.Vector2(0.0679, 0.009), new THREE.Vector2(0.0665, 0.0118)];
for (let i = 1; i <= 60; i++) { const y = 0.012 + (0.1385 - 0.012) * i / 60; basePts.push(new THREE.Vector2(baseR(y), y)); }
basePts.push(new THREE.Vector2(0.0522, 0.1405), new THREE.Vector2(0.0524, 0.1425), new THREE.Vector2(0.0518, 0.1437), new THREE.Vector2(0.0510, 0.1430), new THREE.Vector2(0.0508, 0.125));
const baseGeo = new THREE.LatheGeometry(basePts, 128);

const capPts = [new THREE.Vector2(0.0332, 0.3310), new THREE.Vector2(0.0336, 0.3215), new THREE.Vector2(0.0352, 0.3210), new THREE.Vector2(0.0358, 0.3223), new THREE.Vector2(0.0355, 0.3242)];
for (let i = 1; i <= 24; i++) { const t = i / 24; capPts.push(new THREE.Vector2(0.0353 + (0.0226 - 0.0353) * t, 0.3242 + (0.3775 - 0.3242) * t)); }
capPts.push(new THREE.Vector2(0.0222, 0.3792), new THREE.Vector2(0.0212, 0.3802), new THREE.Vector2(0.0195, 0.3806), new THREE.Vector2(0.0, 0.3806));
const capGeo = new THREE.LatheGeometry(capPts, 96);

const globePts = [];
const yTop = LAMP.H + LAMP.glass;
for (let i = 0; i <= 90; i++) {
  const y = 0.004 + (yTop - 0.004) * i / 90;
  globePts.push(new THREE.Vector2(rIn(Math.min(y, LAMP.H)) + LAMP.glass, y + GY));
}
const globeGeo = new THREE.LatheGeometry(globePts, 128);
// glowing stand-in for the globe, seen only by the metal's reflection probes
const proxyGeo = globeGeo.clone();
{
  const pos = proxyGeo.attributes.position, col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) { const y = (pos.getY(i) - GY) / LAMP.H; const v = 0.15 + 1.6 * Math.exp(-y * 4.0); col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v; }
  proxyGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
const contactGeo = new THREE.PlaneGeometry(0.2, 0.2).rotateX(-Math.PI / 2).translate(0, 0.0005, 0);

const brushed = (() => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 1024;
  const g = c.getContext('2d');
  for (let y = 0; y < 1024; y++) { const v = 100 + Math.random() * 70; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, y, 64, 1); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
})();

// The globe is a big soft emitter: its light on the metal comes from the reflection probes
// (which see the glowing proxy), so the point light's tiny specular highlight is scaled down.
const directSpec = { value: 0.03 };
function makeMetal() {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xd4d7dc, metalness: 1, roughness: 0.3, roughnessMap: brushed, anisotropy: 0.5 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDirectSpec = directSpec;
    sh.fragmentShader = 'uniform float uDirectSpec;\n' + sh.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n reflectedLight.directSpecular *= uDirectSpec;');
  };
  m.customProgramCacheKey = () => 'metal-softspec';
  return m;
}

// ------------------------------------------------------------------ shared render state
let qual = QUALITY[view.quality];
const shared = {
  uBg: { value: null }, uEnv: { value: null }, uViewProj: { value: new THREE.Matrix4() },
  uThermal: { value: 0 }, uTime: { value: 0 }, uSteps: { value: qual.steps }, uAmbient: { value: 1 },
};
const PROBE_SIZE = 64;
const envRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
const envCam = new THREE.CubeCamera(0.01, 20, envRT);
envCam.position.set(0, GY + 0.11, 0);
envCam.children.forEach(c => { c.layers.disableAll(); c.layers.enable(0); c.layers.enable(LAYER_REFL); });
scene.add(envCam);
shared.uEnv.value = envRT.texture;
let envDirty = true;

let stateSnapshots = null; // loaded below

// ------------------------------------------------------------------ a lava lamp
class Lamp {
  constructor(slot) {
    this.slot = slot;
    const [preset, finish] = LINEUP[slot % LINEUP.length];
    this.s = { preset, ...PRESETS[preset], finish, power: true, heat: 1.0 };
    this.group = new THREE.Group(); scene.add(this.group);
    this.metal = makeMetal(); this.capMetal = makeMetal();
    this.base = new THREE.Mesh(baseGeo, this.metal);
    this.cap = new THREE.Mesh(capGeo, this.capMetal);
    this.contact = new THREE.Mesh(contactGeo, contactMat);
    this.uniforms = {
      ...shared,
      uField: { value: null }, uFieldMin: { value: new THREE.Vector3() }, uFieldSize: { value: new THREE.Vector3(1, 1, 1) },
      uVoxel: { value: 0.002 }, uIso: { value: 0.25 }, uEnvIntensity: { value: 1 },
      uGlobeOrigin: { value: new THREE.Vector3(0, GY, 0) },
      uWax: { value: new THREE.Color() }, uLiquid: { value: new THREE.Color() }, uBulbColor: { value: new THREE.Color(1.0, 0.8, 0.58) },
      uBulb: { value: 1 }, uLiquidDensity: { value: 10 }, uScatter: { value: 6.0 },
      uCloud: { value: 0 }, uWaxGain: { value: 1 },
      uProf: { value: new THREE.Vector4(LAMP.H, LAMP.Rb, LAMP.Rt, LAMP.r0) },
      uProf2: { value: new THREE.Vector4(LAMP.yb, LAMP.glass, LAMP.top, LAMP.top + 0.012) },
    };
    this.globe = new THREE.Mesh(globeGeo, new THREE.ShaderMaterial({ vertexShader: globeVert, fragmentShader: globeFrag, uniforms: this.uniforms }));
    this.globe.layers.set(LAYER_GLOBE);
    this.proxyMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
    this.proxy = new THREE.Mesh(proxyGeo, this.proxyMat); this.proxy.layers.set(LAYER_PROXY);
    this.light = new THREE.PointLight(0xff5533, 0.3, 0, 2); this.light.position.set(0, GY + 0.1, 0);
    this.group.add(this.base, this.cap, this.contact, this.globe, this.proxy, this.light);
    for (const m of [this.base, this.cap, this.globe]) m.userData.lamp = this;

    this.probeBase = this.makeProbe(0.075); this.probeCap = this.makeProbe(0.372);
    this.metal.envMap = this.probeBase.rt.texture; this.capMetal.envMap = this.probeCap.rt.texture;

    this.bulb = 1; this.bulbTarget = 1; this.glow = new THREE.Color();
    this.shake = { x: 0, z: 0, vx: 0, vz: 0 };
    this.stats = null; this.ready = false; this.inFlight = false; this.returnBuf = null; this.pending = null;
    this.startWorker();
    this.applyColors(); this.applyFinish();
  }
  makeProbe(y) {
    const rt = new THREE.WebGLCubeRenderTarget(PROBE_SIZE, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    const cam = new THREE.CubeCamera(0.01, 20, rt);
    cam.position.set(0, y, 0);
    cam.children.forEach(c => { c.layers.disableAll(); c.layers.enable(0); c.layers.enable(LAYER_PROXY); c.layers.enable(LAYER_REFL); });
    this.group.add(cam);
    return { rt, cam };
  }
  setX(x) { this.x = x; this.group.position.x = x; }
  startWorker() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    const snaps = stateSnapshots || [];
    const st = snaps.length ? snaps[this.slot % snaps.length] : null;
    this.worker.postMessage({
      type: 'init', params: { heat: this.s.heat, seed: 7 + this.slot }, field: {}, state: st,
      rotate: this.slot * 2.1, mirror: this.slot % 2 === 1, preroll: snaps.length > this.slot ? 0 : this.slot * 12,
    });
    this.worker.postMessage({ type: 'speed', value: view.speed });
  }
  onMessage(m) {
    if (m.type === 'progress') { if (this.slot === 0) loading.querySelector('span').textContent = `Warming up the wax… ${Math.round(m.value * 100)}%`; }
    if (m.type === 'ready') {
      const [nx, ny, nz] = m.dims;
      const tex = new THREE.Data3DTexture(new Uint8Array(nx * ny * nz * 4), nx, ny, nz);
      tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
      tex.unpackAlignment = 1; tex.needsUpdate = true;
      this.tex = tex;
      this.uniforms.uField.value = tex;
      this.uniforms.uFieldMin.value.fromArray(m.min);
      this.uniforms.uFieldSize.value.fromArray(m.size);
      this.uniforms.uVoxel.value = m.voxel;
      this.ready = true;
      this.request(true);
    }
    if (m.type === 'field') {
      this.inFlight = false;
      if (m.fresh) { this.pending = new Uint8Array(m.buffer); this.stats = m.stats; }
      else this.returnBuf = new Uint8Array(m.buffer);
    }
    if (m.type === 'dump') console.log(JSON.stringify(m.state));
  }
  request(force = false) {
    if (this.inFlight || !this.ready) return;
    this.inFlight = true;
    const msg = { type: 'frame', force };
    if (this.returnBuf) { msg.buffer = this.returnBuf.buffer; this.worker.postMessage(msg, [this.returnBuf.buffer]); this.returnBuf = null; }
    else this.worker.postMessage(msg);
  }
  sendHeat() { this.worker.postMessage({ type: 'set', key: 'heat', value: this.s.power ? this.s.heat : 0 }); }
  applyColors() {
    const wax = new THREE.Color(this.s.wax), liq = new THREE.Color(this.s.liquid);
    this.uniforms.uWax.value.copy(wax); this.uniforms.uLiquid.value.copy(liq);
    this.uniforms.uLiquidDensity.value = 1 + this.s.clarity * 26;
    // colour of the light leaving the globe: liquid-tinted, with the wax's glow mixed in
    this.glow.copy(liq).lerp(wax, 0.45).multiply(new THREE.Color(1.0, 0.8, 0.58));
    this.glow.multiplyScalar(1 / Math.max(this.glow.r, this.glow.g, this.glow.b));
    this.light.color.copy(this.glow);
    this.probesDirty = 2;
  }
  applyFinish() {
    const f = FINISHES[this.s.finish];
    for (const m of [this.metal, this.capMetal]) { m.color.set(f.color); m.metalness = f.metalness; m.roughness = f.roughness; m.needsUpdate = true; }
  }
  nudge(dir) {
    const a = dir ?? Math.random() * Math.PI * 2;
    this.shake.vx += Math.cos(a) * 0.12; this.shake.vz += Math.sin(a) * 0.12;
    // in the lamp's frame the wax feels the opposite acceleration
    this.worker.postMessage({ type: 'nudge', ax: -Math.cos(a) * 60, az: -Math.sin(a) * 60, dur: 0.12 });
  }
  coldStart() {
    this.worker.postMessage({ type: 'cold' });
    this.s.power = true; this.bulbTarget = 1; this.sendHeat();
  }
  updateProbes(which) {
    if (which !== 'cap') { this.base.visible = false; this.probeBase.cam.update(renderer, scene); this.base.visible = true; this.probeBase.rt.texture.needsPMREMUpdate = true; }
    if (which !== 'base') { this.cap.visible = false; this.probeCap.cam.update(renderer, scene); this.cap.visible = true; this.probeCap.rt.texture.needsPMREMUpdate = true; }
  }
  tick(dt, t) {
    this.bulb += (this.bulbTarget - this.bulb) * (1 - Math.exp(-dt * (this.bulbTarget > this.bulb ? 5 : 3)));
    const flicker = 1 + 0.012 * Math.sin(t * 7.3 + this.slot) * Math.sin(t * 3.1 + this.slot * 2);
    const lt = this.stats ? this.stats.lightTop : 1;
    this.uniforms.uBulb.value = this.bulb * flicker;
    this.light.intensity = this.bulb * (0.12 + 0.22 * lt) * flicker;
    this.proxyMat.color.copy(this.glow).multiplyScalar(this.bulb * 0.25 + 0.01);
    const sh = this.shake;
    sh.vx += (-sh.x * 900 - sh.vx * 14) * dt; sh.vz += (-sh.z * 900 - sh.vz * 14) * dt;
    sh.x += sh.vx * dt; sh.z += sh.vz * dt;
    this.group.position.set(this.x + sh.x * 0.02, 0, sh.z * 0.02);
    this.group.rotation.set(sh.z * 0.25, 0, -sh.x * 0.25);
    this.uniforms.uGlobeOrigin.value.set(this.group.position.x, GY, this.group.position.z);
    if (this.pending && this.tex) {
      this.tex.image.data = this.pending; this.tex.needsUpdate = true;
      this.returnBuf = this.pending; this.pending = null;
    }
  }
  dispose() {
    this.worker.terminate();
    scene.remove(this.group);
    this.globe.material.dispose(); this.metal.dispose(); this.capMetal.dispose(); this.proxyMat.dispose();
    this.probeBase.rt.dispose(); this.probeCap.rt.dispose(); this.tex && this.tex.dispose();
    this.light.dispose();
  }
}

// ------------------------------------------------------------------ lamp lineup
const lamps = []; // ordered by slot (0 = centre)
let selected = null;
const slotX = (slot) => { // centre, then alternate left/right
  if (slot === 0) return 0;
  const k = Math.ceil(slot / 2); return (slot % 2 ? -1 : 1) * k * SPACING;
};
function setLampCount(n) {
  while (lamps.length > n) { const l = lamps.pop(); if (selected === l) selected = null; l.dispose(); }
  while (lamps.length < n) { const l = new Lamp(lamps.length); l.setX(slotX(l.slot)); lamps.push(l); }
  if (!selected) select(lamps[0]);
  envDirty = true; lamps.forEach(l => l.probesDirty = 2);
}

// ------------------------------------------------------------------ post
const bgRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
shared.uBg.value = bgRT.texture;
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType }));
const grade = new ShaderPass(GradeShader);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), view.bloom, 0.75, 0.82);
composer.addPass(bloom);
composer.addPass(grade);
grade.uniforms.uVignette.value = view.vignette;

// dynamic resolution: keep the frame rate at the display's refresh rate
let prScale = 1, curPR = 1;
function resize() {
  qual = QUALITY[view.quality];
  const pr = Math.max(0.5, Math.min(window.devicePixelRatio, qual.pr) * (qual.auto ? prScale : 1));
  curPR = pr;
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight);
  composer.setPixelRatio(pr);
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  bgRT.setSize(Math.floor(innerWidth * pr), Math.floor(innerHeight * pr));
  shared.uSteps.value = qual.steps;
}
addEventListener('resize', resize);
resize();
const perf = { hist: [], interval: 0, lastAdjust: 0, good: 0, ceiling: 1, ceilingUntil: 0, median: 16.7 };
function adaptResolution(dtMs, now) {
  const h = perf.hist; h.push(dtMs); if (h.length > 90) h.shift();
  if (h.length < 90) return;
  const sorted = [...h].sort((a, b) => a - b); perf.median = sorted[45];
  if (!perf.interval) { // display refresh interval, snapped to common rates
    perf.interval = [1000 / 144, 1000 / 120, 1000 / 90, 1000 / 75, 1000 / 60, 1000 / 30].reduce((best, v) => Math.abs(v - perf.median) < Math.abs(best - perf.median) ? v : best);
  }
  if (!qual.auto || now - perf.lastAdjust < 1200) return;
  const slow = perf.median > Math.max(perf.interval, 1000 / 60) * 1.18;
  if (slow && prScale > 0.42) {
    perf.ceiling = prScale; perf.ceilingUntil = now + 20000; // don't climb back into this for a while
    prScale = Math.max(0.42, prScale * 0.85); perf.lastAdjust = now; perf.good = 0; h.length = 0; resize();
  } else if (!slow) {
    const cap = now < perf.ceilingUntil ? perf.ceiling * 0.95 : 1;
    if (++perf.good > 4 && prScale < cap) { prScale = Math.min(cap, prScale * 1.1); perf.lastAdjust = now; perf.good = 0; h.length = 0; resize(); }
    else perf.lastAdjust = now - 600;
  } else perf.lastAdjust = now - 600;
}

// ------------------------------------------------------------------ interaction
const ray = new THREE.Raycaster(); ray.layers.enableAll();
function pickLamp(e) {
  const v = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(v, camera);
  const hit = ray.intersectObjects(lamps.flatMap(l => [l.globe, l.base, l.cap]), false)[0];
  return hit ? { lamp: hit.object.userData.lamp, point: hit.point } : null;
}
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const h = pickLamp(e); if (h) select(h.lamp);
});
renderer.domElement.addEventListener('dblclick', (e) => {
  const h = pickLamp(e);
  if (h) { const d = new THREE.Vector3().subVectors(h.point, camera.position); h.lamp.nudge(Math.atan2(d.z, d.x)); }
});

// ------------------------------------------------------------------ GUI
const gui = new GUI({ title: 'Lava Lamps' });
const fScene = gui.addFolder('Scene');
fScene.add(view, 'lamps', 1, MAX_LAMPS, 1).name('Lamps').onFinishChange(setLampCount);
fScene.add(view, 'speed', 0.25, 12, 0.05).name('Time speed').onChange(v => lamps.forEach(l => l.worker.postMessage({ type: 'speed', value: v })));
fScene.add(view, 'roomLight', 0, 1, 0.01).name('Room light').onChange(applyRoomLight);
fScene.add(view, 'exposure', 0.2, 2.5, 0.01).name('Exposure').onChange(v => grade.uniforms.uExposure.value = v);
fScene.add(view, 'bloom', 0, 1.5, 0.01).name('Glow').onChange(v => bloom.strength = v);
fScene.add(view, 'vignette', 0, 1, 0.01).name('Vignette').onChange(v => grade.uniforms.uVignette.value = v);
fScene.add(view, 'thermal').name('Thermal camera').onChange(v => shared.uThermal.value = v ? 1 : 0);
fScene.add(view, 'autoRotate').name('Slow orbit').onChange(v => controls.autoRotate = v);
fScene.add(view, 'quality', Object.keys(QUALITY)).name('Quality').onChange(() => { prScale = 1; resize(); });
fScene.add({ shot: () => { composer.render(); const a = document.createElement('a'); a.download = 'lava-lamp.png'; a.href = renderer.domElement.toDataURL('image/png'); a.click(); } }, 'shot').name('Save screenshot');

const fLamp = gui.addFolder('Selected lamp');
const sel = { preset: '', wax: '#ffffff', liquid: '#ffffff', clarity: 0.5, finish: 'Silver', power: true, heat: 1 };
const ctl = {};
ctl.preset = fLamp.add(sel, 'preset', Object.keys(PRESETS)).name('Colours').onChange(k => { Object.assign(selected.s, PRESETS[k], { preset: k }); selected.applyColors(); syncSel(); });
ctl.wax = fLamp.addColor(sel, 'wax').name('Wax').onChange(v => { selected.s.wax = v; selected.applyColors(); });
ctl.liquid = fLamp.addColor(sel, 'liquid').name('Liquid').onChange(v => { selected.s.liquid = v; selected.applyColors(); });
ctl.clarity = fLamp.add(sel, 'clarity', 0, 1, 0.01).name('Liquid tint').onChange(v => { selected.s.clarity = v; selected.applyColors(); });
ctl.finish = fLamp.add(sel, 'finish', Object.keys(FINISHES)).name('Base finish').onChange(v => { selected.s.finish = v; selected.applyFinish(); });
ctl.power = fLamp.add(sel, 'power').name('Power').onChange(v => { selected.s.power = v; selected.bulbTarget = v ? 1 : 0; selected.sendHeat(); });
ctl.heat = fLamp.add(sel, 'heat', 0.6, 1.5, 0.01).name('Bulb wattage').onChange(v => { selected.s.heat = v; selected.sendHeat(); });
fLamp.add({ nudge: () => selected.nudge() }, 'nudge').name('Nudge (or double-click)');
fLamp.add({ cold: () => { selected.coldStart(); syncSel(); } }, 'cold').name('Cold start');
function syncSel() {
  if (!selected) return;
  Object.assign(sel, { preset: selected.s.preset, wax: selected.s.wax, liquid: selected.s.liquid, clarity: selected.s.clarity, finish: selected.s.finish, power: selected.s.power, heat: selected.s.heat });
  Object.values(ctl).forEach(c => c.updateDisplay());
  fLamp.title(lamps.length > 1 ? `Selected lamp (click a lamp to switch)` : 'Lamp');
}
function select(l) { selected = l; syncSel(); }
if (innerWidth < 700) gui.close();

// URL overrides (handy for screenshots)
if (Q.get('speed')) view.speed = +Q.get('speed');
if (Q.get('room')) view.roomLight = +Q.get('room');
if (Q.get('thermal')) { view.thermal = true; shared.uThermal.value = 1; }
if (Q.get('hideui')) { gui.hide(); document.getElementById('hint').style.display = 'none'; }
applyRoomLight();

// ------------------------------------------------------------------ HUD
const hud = document.getElementById('hud');
const loading = document.getElementById('loading');
const toC = (t) => Math.round(20 + t * 93);
function updateHud() {
  const l = selected, st = l && l.stats; if (!st) return;
  let phase;
  if (!l.s.power) phase = st.waxT > 0.3 ? 'Cooling down' : 'Off · wax solid';
  else if (st.W < 0.6) phase = 'Warming up';
  else phase = 'Flowing';
  const which = lamps.length > 1 ? `${l.s.preset} · ` : '';
  hud.textContent = `${which}${phase} · liquid ${toC(st.liqBottom)}°C · wax ${toC(st.waxT)}°C${view.speed !== 1 ? ` · ${view.speed.toFixed(2).replace(/\.?0+$/, '')}× time` : ''}`;
}

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
let frame = 0, hudT = 0, probeCursor = 0;
function tick() {
  requestAnimationFrame(tick);
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);
  const t = clock.elapsedTime;
  adaptResolution(rawDt * 1000, performance.now());
  controls.update();
  for (const l of lamps) l.tick(dt, t);

  // reflections: the shared room probe only when something changed, the metal probes round-robin
  if (envDirty) {
    for (const l of lamps) { l.base.visible = l.cap.visible = false; }
    envCam.update(renderer, scene);
    for (const l of lamps) { l.base.visible = l.cap.visible = true; }
    envDirty = false;
  }
  for (const l of lamps) if (l.probesDirty > 0) { l.updateProbes('all'); l.probesDirty--; }
  if (frame % 3 === 0 && lamps.length) {
    const k = probeCursor++ % (lamps.length * 2);
    lamps[k >> 1].updateProbes(k & 1 ? 'cap' : 'base');
  }

  camera.updateMatrixWorld();
  shared.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  shared.uTime.value = t;
  shared.uAmbient.value = 1.0 - 0.35 * view.roomLight; // the env map already brightens with the room

  // background pass (everything but the globes) for refraction
  camera.layers.disable(LAYER_GLOBE);
  renderer.setRenderTarget(bgRT); renderer.render(scene, camera); renderer.setRenderTarget(null);
  camera.layers.enable(LAYER_GLOBE);

  grade.uniforms.uTime.value = t;
  composer.render();
  for (const l of lamps) l.request();

  if (loading && !loading.classList.contains('hide') && lamps.every(l => l.stats)) loading.classList.add('hide');
  if ((hudT += dt) > 0.5) { hudT = 0; updateHud(); }
  frame++;
}

window.LL = {
  THREE, lamps, view, shared, applyRoomLight, camera, controls, renderer, bloom, grade, scene, setLampCount, select, perf,
  get stats() { return lamps.length && lamps.every(l => l.stats) ? lamps[0].stats : null; },
  get pr() { return curPR; },
};

// start: load the pre-warmed snapshots, then build the lineup
fetch(new URL('./states.json', import.meta.url)).then(r => r.ok ? r.json() : null).catch(() => null)
  .then(s => s || fetch(new URL('./state.json', import.meta.url)).then(r => r.ok ? r.json() : null).then(x => x && [x]).catch(() => null))
  .then(s => { stateSnapshots = s; setLampCount(view.lamps); tick(); });
