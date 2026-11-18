// 3D view: three.js scene for the world, 2D overlay canvas for bubbles and HUD.
// Simulation state comes from game.js (classic script, shared globals).
import * as THREE from 'three';
import { GLTFLoader } from './vendor/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from './vendor/jsm/utils/SkeletonUtils.js';
import { mergeVertices, mergeGeometries } from './vendor/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from './vendor/jsm/RoundedBoxGeometry.js';
import { RoomEnvironment } from './vendor/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from './vendor/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';

await document.fonts.load('900 40px Nunito').catch(() => {});
const FONT = '"Nunito", system-ui, sans-serif';

// ---------- renderer, camera, lights ----------
const QUALITY = new URLSearchParams(location.search).get('q'); // 'low' | 'high' | auto
const DEBUG = new URLSearchParams(location.search).has('debug');
const glCanvas = document.getElementById('gl');
const ov = document.getElementById('ov'), o = ov.getContext('2d');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, powerPreference: 'high-performance' });
const MOBILE = matchMedia('(pointer: coarse)').matches;
// 'lite' (default on phones): no shadow maps (soft blob shadows instead), simple materials, sparser forest and grass.
// The pause menu switches it (saved in localStorage, applied after a reload); ?q=low|high overrides.
let savedGfx = null; try { savedGfx = localStorage.getItem('lavka-gfx'); } catch (e) {}
const GFX = QUALITY === 'high' ? 'full' : QUALITY === 'low' ? 'lite' : (savedGfx || (MOBILE ? 'lite' : 'full'));
const LITE = GFX === 'lite';
window.__gfx = GFX;
function newMat(p = {}) {
  if (!LITE) return new THREE.MeshStandardMaterial(p);
  const { roughness, metalness, ...q } = p;
  return new THREE.MeshLambertMaterial(q);
}
// shared materials for merged geometry with baked vertex colours (see bakeMerge / mergeSkinned)
const BAKED_MAT = newMat({ vertexColors: true, roughness: .8, metalness: 0 });
const CHAR_MAT = newMat({ vertexColors: true, roughness: .78, metalness: 0 });
let DPR = Math.min(QUALITY === 'high' ? 2 : MOBILE ? 1.5 : 2, devicePixelRatio || 1);
renderer.setPixelRatio(DPR);
renderer.shadowMap.enabled = !LITE;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = .98;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#5fb838');
if (!LITE) {
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), .04).texture;
  scene.environmentIntensity = .42;
}
const camera = new THREE.PerspectiveCamera(42, 1, .5, 200);
const PITCH = 52 * Math.PI / 180;
// post-processing: ambient occlusion gives the soft contact shading; switched off on slow devices
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const ao = new GTAOPass(scene, camera, 2, 2);
ao.updateGtaoMaterial({ radius: .55, distanceExponent: 1.4, thickness: 1.0, scale: 1.15, samples: 12 });
ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 12 });
ao.blendIntensity = .95;
composer.addPass(ao);
composer.addPass(new OutputPass());
let useFx = QUALITY === 'high' || (QUALITY !== 'low' && !MOBILE); // AO is too heavy for most phones
let W = 0, H = 0, camDist = 20;
function resize() {
  W = innerWidth; H = innerHeight;
  renderer.setSize(W, H, false);
  composer.setPixelRatio(Math.min(DPR, 1.5)); composer.setSize(W, H);
  const dpr = Math.min(2, devicePixelRatio || 1);
  ov.width = W * dpr; ov.height = H * dpr; o.setTransform(dpr, 0, 0, dpr, 0, 0);
  camera.aspect = W / H; camera.updateProjectionMatrix();
  const t = Math.tan(camera.fov * Math.PI / 360);
  camDist = Math.max(3.4 / (t * camera.aspect), 4.6 / t); // ~7 units across on a phone
}
addEventListener('resize', resize); resize();

scene.add(new THREE.HemisphereLight('#eef8ff', '#5f9a45', LITE ? 1.55 : 1.0));
const sun = new THREE.DirectionalLight('#fff0d4', 2.75);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -17, right: 17, top: 17, bottom: -17, near: 1, far: 70 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = .03; sun.shadow.radius = 4;
scene.add(sun, sun.target);

// ---------- helpers ----------
const matCache = new Map();
function mat(color, extra) {
  const key = color + (extra ? JSON.stringify(extra) : '');
  if (!matCache.has(key)) matCache.set(key, newMat({ color, roughness: .8, metalness: 0, ...extra }));
  return matCache.get(key);
}
function mesh(geo, m, x = 0, y = 0, z = 0, parent = scene) {
  const r = new THREE.Mesh(geo, typeof m === 'string' ? mat(m) : m);
  r.position.set(x, y, z); r.castShadow = true; r.receiveShadow = true;
  parent.add(r); return r;
}
const box = (parent, w, h, d, c, x, y, z) => mesh(new THREE.BoxGeometry(w, h, d), c, x, y, z, parent);
const _v = new THREE.Vector3();
// world (x, y, height z) -> screen pixels
function proj(x, y, z = 0) { _v.set(x, z, y).project(camera); return [(_v.x + 1) / 2 * W, (1 - _v.y) / 2 * H]; }
function canvasTex(c) { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }
function rr(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, r); }
const rbox = (parent, w, h, d, c, x, y, z, r = .05) => mesh(new RoundedBoxGeometry(w, h, d, 3, r), c, x, y, z, parent);
const group = (x = 0, y = 0, parent = scene) => { const g = new THREE.Group(); g.position.set(x, 0, y); parent.add(g); return g; };

// ---------- CC0 models (Quaternius, Kenney via poly.pizza) ----------
const ASSETS = {
  chars: ['womanA', 'womanB', 'casual', 'hoodie', 'farmer'],
  props: ['chickenB', 'coop', 'smallBarn', 'tree1', 'tree3', 'fence2', 'crate', 'woodlog', 'stump',
    'cow', 'windmill', 'barn', 'openBarn', 'bigBarn', 'wheat', 'pumpkin', 'well', 'bench', 'lamp', 'fountain'],
};
const A = {};
const mixers = new Set();
function vivid(c, ds = 1.35, dl = 1.08) { const h = {}; c.getHSL(h); c.setHSL(h.h, Math.min(1, h.s * ds), Math.min(.92, h.l * dl)); return c; }
function prep(gltf, smooth) {
  gltf.scene.traverse(m => {
    if (!m.isMesh) return;
    m.castShadow = true; m.receiveShadow = true;
    if (smooth) { let g = m.geometry.clone(); g.deleteAttribute('normal'); g = mergeVertices(g, 1e-4); g.computeVertexNormals(); m.geometry = g; }
    const conv = old => {
      const n = newMat({ color: vivid(old.color.clone()), map: old.map || null, alphaTest: old.alphaTest || (old.transparent ? .5 : 0), side: old.side, vertexColors: old.vertexColors, roughness: .78, metalness: 0 });
      n.name = old.name; return n;
    };
    m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
  });
  const b = new THREE.Box3().setFromObject(gltf.scene);
  return { scene: gltf.scene, anims: gltf.animations, size: b.getSize(new THREE.Vector3()), min: b.min.clone(), center: b.getCenter(new THREE.Vector3()) };
}
{
  const loader = new GLTFLoader();
  await Promise.all([
    ...ASSETS.chars.map(n => loader.loadAsync(`assets/chars/${n}.glb`).then(g => { A[n] = prep(g, true); mergeSkinned(A[n].scene); })),
    ...ASSETS.props.map(n => loader.loadAsync(`assets/props/${n}.glb`).then(g => { A[n] = prep(g, false); })),
  ]);
}
function recolorTree(o, map) {
  o.traverse(m => {
    if (!m.isMesh) return;
    const f = mm => { const c = map(mm.name); if (!c) return mm; mm = mm.clone(); mm.color.set(c); return mm; };
    m.material = Array.isArray(m.material) ? m.material.map(f) : f(m.material);
  });
}
// burlap sack tied at the top
const SACK_GEO = (() => {
  const pts = [[0, 0], [.3, .02], [.4, .15], [.42, .38], [.36, .58], [.2, .7], [.1, .74], [.12, .82], [.2, .9], [.06, .93], [0, .93]].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, 20);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const a = Math.atan2(p.getZ(i), p.getX(i)), y = p.getY(i); const k = 1 + Math.sin(a * 3 + y * 4) * .05; p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k * .9); }
  g.computeVertexNormals(); return g;
})();
function sack(x, y, h, rot = 0, parent = scene) { const m = mesh(SACK_GEO, '#c9975a', x, 0, y, parent); m.scale.setScalar(h / .93); m.rotation.y = rot; mesh(new THREE.TorusGeometry(.11, .03, 6, 14).rotateX(Math.PI / 2), '#8a5a2b', 0, .74, 0, m); return m; }
// smooth round bush
function bush(x, y, s, parent = scene) {
  const g = new THREE.Group(); g.position.set(x, 0, y); g.scale.setScalar(s); parent.add(g);
  if (LITE) STATIC_BLOBS.push([x, y + .05, .75 * s, .6 * s]);
  for (const [dx, dy, dz, r, c] of [[0, .32, 0, .42, '#4cbb3c'], [-.32, .24, .12, .3, '#58c646'], [.33, .26, .08, .32, '#45b236'], [.05, .5, -.1, .3, '#62cf4c']]) mesh(new THREE.SphereGeometry(r, 12, 9), c, dx, dy, dz, g);
  return g;
}
// A glTF character arrives as ~10 skinned meshes (one per material) sharing one skeleton. Merge them into one
// skinned mesh with vertex colours; userData.ranges remembers which vertices came from which material/mesh
// so clothes can be recoloured per customer.
function mergeSkinned(root) {
  const parts = []; root.traverse(m => { if (m.isSkinnedMesh) parts.push(m); });
  const sameBones = (p) => p.skeleton.bones.length === parts[0].skeleton.bones.length && p.skeleton.bones.every((b, i) => b === parts[0].skeleton.bones[i]);
  if (parts.length < 2 || !parts.every(sameBones)) { console.warn('character parts not merged'); return; }
  const geos = [], ranges = [];
  let offset = 0;
  for (const p of parts) {
    let g = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'skinIndex', 'skinWeight'].includes(k)) g.deleteAttribute(k);
    const mats = Array.isArray(p.material) ? p.material : [p.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: g.attributes.position.count, materialIndex: 0 }];
    for (const gr of groups) {
      const mt = mats.length === 1 ? mats[0] : mats[gr.materialIndex || 0] || mats[0];
      ranges.push({ start: offset + gr.start, count: gr.count, mat: mt.name, mesh: (p.name || '') + ' ' + (p.parent && p.parent.name || '') });
    }
    colorAttr(g, mats);
    g.applyMatrix4(p.bindMatrix); // bake each part's bind pose so the merged mesh can use an identity bind matrix
    offset += g.attributes.position.count; geos.push(g);
  }
  const merged = new THREE.SkinnedMesh(mergeGeometries(geos), CHAR_MAT);
  merged.name = 'merged'; merged.castShadow = merged.receiveShadow = true; merged.frustumCulled = false;
  merged.userData.ranges = ranges;
  parts[0].parent.add(merged);
  merged.bind(parts[0].skeleton, new THREE.Matrix4());
  for (const p of parts) p.removeFromParent();
}

// static copy of a model scaled to the given height, standing on the ground, centred on (x, y)
function model(name, height, x = 0, y = 0, rotY = 0, parent = scene, colors) {
  const a = A[name], o = a.scene.clone(true), s = height / a.size.y;
  const wrap = new THREE.Group(); wrap.add(o);
  o.scale.setScalar(s); o.position.set(-a.center.x * s, -a.min.y * s, -a.center.z * s);
  wrap.position.set(x, 0, y); wrap.rotation.y = rotY;
  if (colors) recolorTree(o, n => colors[n]);
  parent.add(wrap); return wrap;
}
// the same, scaled to fit a w x d footprint (rotation 0)
function modelFit(name, w, d, x, y, rotY = 0, parent = scene, colors) {
  const a = A[name], s = Math.min(w / a.size.x, d / a.size.z);
  return model(name, a.size.y * s, x, y, rotY, parent, colors);
}

const fmtN = n => n >= 10000 ? (n / 1000).toFixed(1).replace('.', ',') + 'к' : String(n);
let seed = 11; const srnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// ---------- ground ----------
const GX0 = WORLD.x0 - 14, GY0 = WORLD.y0 - 13, GW = WORLD.x1 - WORLD.x0 + 28, GH = WORLD.y1 - WORLD.y0 + 26, PPU = 20;
// dirt layout shared by the ground texture and the grass mask: the market strip and the road
function drawPaths(g, X, Y, P, grow, fill) {
  g.fillStyle = fill; g.strokeStyle = fill; g.lineCap = 'round'; g.lineJoin = 'round';
  const area = (x0, y0, x1, y1, r) => { rr(g, X(x0 - grow), Y(y0 - grow), (x1 - x0 + 2 * grow) * P, (y1 - y0 + 2 * grow) * P, Math.max(0, r + grow) * P); g.fill(); };
  area(WORLD.x0 + .8, 16.9, WORLD.x1 - .8, 25.2, 1.2); // market strip
  area(GX0 - 2, 25.4, GX0 + GW + 2, 27.6, 0);          // customers' road
}
const pathMask = (() => {
  const P = 4, c = document.createElement('canvas'); c.width = GW * P; c.height = GH * P;
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  drawPaths(g, x => (x - GX0) * P, y => (y - GY0) * P, P, .25, '#fff');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  return (x, y) => { const i = (Math.floor((y - GY0) * P) * c.width + Math.floor((x - GX0) * P)) * 4; return d[i] > 128; };
})();
{
  const c = document.createElement('canvas'); c.width = GW * PPU; c.height = GH * PPU;
  const g = c.getContext('2d');
  const X = x => (x - GX0) * PPU, Y = y => (y - GY0) * PPU;
  g.fillStyle = '#66bd38'; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 700; i++) { // soft large-scale colour variation
    const x = srnd() * c.width, y = srnd() * c.height, r = (1.5 + srnd() * 4) * PPU;
    const col = srnd() < .55 ? '150,225,95' : '70,160,45';
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${col},.32)`); gr.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  for (const [grow, col] of [[.75, 'rgba(60,110,35,.10)'], [.5, 'rgba(60,110,35,.12)'], [.22, '#d9834a'], [.1, '#e69456'], [0, '#ee9f60'], [-.35, '#f2a96b']]) drawPaths(g, X, Y, PPU, grow, col);
  for (let i = 0; i < 3000; i++) { // pebbles on dirt
    const x = GX0 + srnd() * GW, y = GY0 + srnd() * GH;
    if (!pathMask(x, y)) continue;
    g.fillStyle = srnd() < .5 ? 'rgba(200,120,70,.55)' : 'rgba(255,214,170,.6)';
    g.beginPath(); g.ellipse(X(x), Y(y), (.03 + srnd() * .05) * PPU, (.02 + srnd() * .03) * PPU, srnd() * 3, 0, Math.PI * 2); g.fill();
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GW, GH), newMat({ map: canvasTex(c), roughness: 1, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(GX0 + GW / 2, 0, GY0 + GH / 2); ground.receiveShadow = true;
  scene.add(ground);
}
// building grid, shown while placing
const gridMesh = (() => {
  const w = BUILD.x1 - BUILD.x0, h = BUILD.y1 - BUILD.y0, P = 32, c = document.createElement('canvas'); c.width = w * P; c.height = h * P;
  const g = c.getContext('2d'); g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 2;
  for (let i = 0; i <= w; i++) { g.beginPath(); g.moveTo(i * P, 0); g.lineTo(i * P, h * P); g.stroke(); }
  for (let j = 0; j <= h; j++) { g.beginPath(); g.moveTo(0, j * P); g.lineTo(w * P, j * P); g.stroke(); }
  g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 6; g.strokeRect(3, 3, w * P - 6, h * P - 6);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: canvasTex(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(BUILD.x0 + w / 2, .03, BUILD.y0 + h / 2); m.renderOrder = 2; m.visible = false;
  scene.add(m); return m;
})();
// moving cloud shadows
const clouds = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 512; const g = c.getContext('2d');
  for (let i = 0; i < 9; i++) {
    const cx = srnd() * 512, cy = srnd() * 512;
    for (let k = 0; k < 6; k++) {
      const x = cx + (srnd() - .5) * 120, y = cy + (srnd() - .5) * 60, r = 40 + srnd() * 50;
      for (const [dx, dy] of [[0, 0], [512, 0], [-512, 0], [0, 512], [0, -512]]) {
        const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        gr.addColorStop(0, 'rgba(0,0,0,.055)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
      }
    }
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(GW / 27, GH / 28);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(GW, GH), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(GX0 + GW / 2, .012, GY0 + GH / 2);
  scene.add(m); return t;
})();
// 3D grass tufts and flowers, swaying in the wind
const windTime = { value: 0 };
function addWind(m) {
  m.onBeforeCompile = sh => {
    sh.uniforms.uTime = windTime;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec4 wpos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float sway = sin(uTime * 1.7 + wpos.x * .6 + wpos.z * .4) * .5 + sin(uTime * 2.9 + wpos.x * 1.3) * .25;
      transformed.x += sway * max(position.y, 0.0) * .55;`);
  };
  return m;
}
const grassFree = (x, y) => !pathMask(x, y);
// ---------- blob shadows (lite mode instead of shadow maps) ----------
const STATIC_BLOBS = []; // [x, y, rx, ry]
const blobs = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(20,40,10,.42)'); gr.addColorStop(.55, 'rgba(20,40,10,.24)'); gr.addColorStop(1, 'rgba(20,40,10,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, toneMapped: false }), 700);
  m.frustumCulled = false; m.count = 0; m.position.y = .014; m.renderOrder = 0; m.visible = LITE;
  scene.add(m); return m;
})();
const _b = new THREE.Object3D();
function drawBlobs(list) {
  let n = 0;
  const vx0 = camX - 14, vx1 = camX + 14, vy0 = camY - 16, vy1 = camY + 12;
  for (const [x, y, rx, ry] of list) {
    if (n >= 700) break;
    if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
    _b.position.set(x, 0, y); _b.scale.set(rx, 1, ry); _b.updateMatrix(); blobs.setMatrixAt(n++, _b.matrix);
  }
  blobs.count = n; blobs.instanceMatrix.needsUpdate = true;
}

// ---------- ground decals (zones, pads) ----------
function decal(w, h, x, y, ppu = 110) {
  const c = document.createElement('canvas'); c.width = Math.round(w * ppu); c.height = Math.round(h * ppu);
  const tex = canvasTex(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, .02, y); m.renderOrder = 1;
  scene.add(m);
  return { m, c, g: c.getContext('2d'), tex, s: ppu, key: null };
}
function outlinedText(g, text, x, y, size, fill, stroke, sw) {
  g.font = `900 ${size}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round'; g.lineWidth = sw; g.strokeStyle = stroke; g.strokeText(text, x, y);
  g.fillStyle = fill; g.fillText(text, x, y);
}
function zoneDecal(x, y, label) {
  const d = decal(1.6, 1.6, x, y);
  d.draw = (active, showLabel) => {
    const key = active + '|' + showLabel; if (d.key === key) return; d.key = key;
    const { g, s } = d; g.clearRect(0, 0, d.c.width, d.c.height);
    rr(g, .08 * s, .08 * s, 1.44 * s, 1.44 * s, .22 * s);
    g.fillStyle = active ? 'rgba(140,240,240,.6)' : 'rgba(140,240,240,.38)'; g.fill();
    g.setLineDash([.2 * s, .12 * s]); g.lineWidth = .08 * s; g.strokeStyle = active ? '#ffffff' : '#62e0ee'; g.stroke(); g.setLineDash([]);
    if (showLabel) {
      g.font = `900 ${.34 * s}px ${FONT}`;
      const fit = Math.min(.34 * s, .34 * s * 1.3 * s / Math.max(1, g.measureText(label).width));
      outlinedText(g, label, .8 * s, .8 * s, fit, '#fff', '#1d4f8f', .09 * s);
    }
    d.tex.needsUpdate = true;
  };
  d.draw(false, true);
  return d;
}

// white silhouette icons for purchase pads (unit square centred on 0, drawn at scale s)
function padIcon(g, kind, x, y, s) {
  g.save(); g.translate(x, y); g.scale(s, s);
  g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
  g.shadowColor = 'rgba(0,0,0,.18)'; g.shadowOffsetY = .03 * 100; g.shadowBlur = 0;
  const circle = (cx, cy, r) => { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); };
  const poly = (pts) => { g.beginPath(); pts.forEach(([px, py], i) => i ? g.lineTo(px, py) : g.moveTo(px, py)); g.closePath(); g.fill(); };
  if (kind === 'person') {
    circle(.08, -.18, .17);
    g.beginPath(); g.moveTo(-.22, .32); g.quadraticCurveTo(-.2, .02, .08, .02); g.quadraticCurveTo(.36, .02, .38, .32); g.closePath(); g.fill();
    g.fillRect(-.42, -.06, .22, .07); g.fillRect(-.345, -.135, .07, .22); // plus
  } else if (kind === 'chick') {
    g.beginPath(); g.ellipse(0, .08, .26, .2, 0, 0, Math.PI * 2); g.fill();
    circle(.2, -.14, .11);
    poly([[-.2, 0], [-.36, -.16], [-.14, -.08]]); poly([[.3, -.16], [.4, -.12], [.3, -.08]]);
    g.fillRect(-.06, .26, .04, .1); g.fillRect(.06, .26, .04, .1);
  } else if (kind === 'tree') {
    g.fillRect(-.05, .05, .1, .3); circle(0, -.08, .24); circle(-.17, .04, .15); circle(.17, .04, .15);
  } else if (kind === 'wood') {
    for (const [dx, dy] of [[-.12, .12], [.12, .12], [0, -.06]]) { rr(g, dx - .2, dy - .08, .4, .16, .08); g.fill(); }
  } else if (kind === 'pie') {
    g.beginPath(); g.ellipse(0, .08, .32, .14, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(0, 0, .3, .12, 0, Math.PI, 0); g.fill();
  } else if (kind === 'egg') {
    g.beginPath(); g.ellipse(0, .02, .2, .27, 0, 0, Math.PI * 2); g.fill();
  } else if (kind === 'flag') {
    g.fillRect(-.2, -.34, .05, .66);
    poly([[-.15, -.34], [.3, -.2], [-.15, -.04]]);
  } else if (kind === 'wheat') {
    g.lineWidth = .05; for (const a of [-.25, 0, .25]) { g.beginPath(); g.moveTo(0, .34); g.lineTo(Math.sin(a) * .4, -.06); g.stroke(); }
    for (const a of [-.25, 0, .25]) for (let k = 0; k < 3; k++) { g.beginPath(); g.ellipse(Math.sin(a) * (.4 + k * .1), -.06 - k * .1, .05, .08, a, 0, Math.PI * 2); g.fill(); }
  } else if (kind === 'mill') {
    poly([[-.16, .34], [-.1, -.1], [.1, -.1], [.16, .34]]);
    g.lineWidth = .08; g.beginPath(); g.moveTo(-.32, -.36); g.lineTo(.32, .16); g.moveTo(.32, -.36); g.lineTo(-.32, .16); g.stroke();
  } else if (kind === 'flour') {
    g.beginPath(); g.moveTo(-.12, -.24); g.quadraticCurveTo(-.3, 0, -.24, .3); g.lineTo(.24, .3); g.quadraticCurveTo(.3, 0, .12, -.24); g.closePath(); g.fill();
    g.fillRect(-.14, -.32, .28, .08);
  } else if (kind === 'cow') {
    rr(g, -.3, -.1, .5, .28, .1); g.fill(); rr(g, .14, -.24, .22, .2, .07); g.fill();
    for (const lx of [-.26, -.1, .04]) g.fillRect(lx, .14, .07, .2);
    poly([[.16, -.24], [.12, -.34], [.2, -.26]]); poly([[.32, -.24], [.36, -.34], [.28, -.26]]);
  } else if (kind === 'milk') {
    poly([[-.13, .34], [-.13, -.06], [-.07, -.18], [-.07, -.28], [.07, -.28], [.07, -.18], [.13, -.06], [.13, .34]]);
  } else if (kind === 'cheese') {
    poly([[-.32, .24], [.32, .24], [.32, -.04], [-.32, -.22]]);
    g.save(); g.globalCompositeOperation = 'destination-out'; circle(-.1, .06, .06); circle(.14, .1, .05); g.restore();
  } else if (kind === 'pumpkin') {
    for (const dx of [-.16, 0, .16]) { g.beginPath(); g.ellipse(dx, .08, .16, .22, 0, 0, Math.PI * 2); g.fill(); }
    g.fillRect(-.03, -.24, .06, .12);
  } else if (kind === 'cake') {
    rr(g, -.3, .04, .6, .26, .05); g.fill(); rr(g, -.2, -.18, .4, .24, .05); g.fill(); circle(0, -.26, .07);
  } else if (kind === 'bench') {
    g.fillRect(-.34, -.04, .68, .1); g.fillRect(-.34, -.26, .68, .08);
    g.fillRect(-.28, .06, .07, .22); g.fillRect(.21, .06, .07, .22);
  } else if (kind === 'flower') {
    for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; circle(Math.cos(a) * .16, -.06 + Math.sin(a) * .16, .1); }
    g.fillRect(-.03, .1, .06, .26);
  } else if (kind === 'lamp') {
    g.fillRect(-.03, -.12, .06, .46); g.fillRect(-.14, .3, .28, .06);
    poly([[-.13, -.12], [.13, -.12], [.09, -.34], [-.09, -.34]]);
  } else if (kind === 'well') {
    poly([[-.32, -.12], [0, -.36], [.32, -.12]]); g.fillRect(-.24, -.12, .05, .24); g.fillRect(.19, -.12, .05, .24);
    rr(g, -.28, .1, .56, .24, .06); g.fill();
  } else if (kind === 'fountain') {
    g.beginPath(); g.ellipse(0, .2, .36, .12, 0, 0, Math.PI * 2); g.fill(); g.fillRect(-.05, -.1, .1, .3);
    g.lineWidth = .05; g.beginPath(); g.moveTo(0, -.12); g.quadraticCurveTo(-.24, -.4, -.3, .06); g.moveTo(0, -.12); g.quadraticCurveTo(.24, -.4, .3, .06); g.stroke();
  } else if (kind === 'land') {
    for (const dx of [-.24, 0, .24]) poly([[dx - .07, .32], [dx - .07, -.18], [dx, -.28], [dx + .07, -.18], [dx + .07, .32]]);
    g.fillRect(-.36, -.06, .72, .07); g.fillRect(-.36, .14, .72, .07);
  } else if (kind === 'field') {
    rr(g, -.34, -.3, .68, .62, .08); g.fill();
    g.save(); g.globalCompositeOperation = 'destination-out'; for (const y of [-.14, .02, .18]) g.fillRect(-.28, y, .56, .05); g.restore();
  } else if (kind === 'bread') {
    g.beginPath(); g.ellipse(0, .04, .36, .2, 0, 0, Math.PI * 2); g.fill();
  } else if (kind === 'juice') {
    poly([[-.13, .34], [-.13, -.04], [-.07, -.14], [-.07, -.3], [.07, -.3], [.07, -.14], [.13, -.04], [.13, .34]]);
  } else if (kind === 'stall') {
    g.fillRect(-.34, .02, .68, .12); g.fillRect(-.3, .14, .08, .2); g.fillRect(.22, .14, .08, .2);
    poly([[-.38, -.08], [-.3, -.3], [.3, -.3], [.38, -.08]]);
  } else if (kind === 'barn') {
    poly([[-.34, .32], [-.34, -.08], [0, -.34], [.34, -.08], [.34, .32]]);
    g.save(); g.globalCompositeOperation = 'destination-out'; g.fillRect(-.12, .06, .24, .26); g.restore();
  }
  g.restore();
}
function cashIcon(g, x, y, s) { // green banknote
  g.save(); g.translate(x, y); g.rotate(-.12);
  rr(g, -.24 * s, -.14 * s, .48 * s, .28 * s, .04 * s); g.fillStyle = '#3fae3a'; g.fill();
  g.lineWidth = .03 * s; g.strokeStyle = '#1f7a22'; g.stroke();
  rr(g, -.2 * s, -.1 * s, .4 * s, .2 * s, .03 * s); g.strokeStyle = '#8ee07a'; g.stroke();
  g.beginPath(); g.arc(0, 0, .065 * s, 0, Math.PI * 2); g.fillStyle = '#8ee07a'; g.fill();
  g.restore();
}

// ---------- items (instanced) ----------
const MAXI = 900;
// several primitives with their own colours merged into one geometry (one draw call per item type)
function coloredGeo(parts) {
  const geos = parts.map(([g, c]) => {
    g = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    const col = new THREE.Color(c), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g;
  });
  return mergeGeometries(geos);
}
function itemMesh(geo, m = BAKED_MAT, n = MAXI) {
  const im = new THREE.InstancedMesh(geo, m, n);
  im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; im.count = 0;
  scene.add(im); return im;
}
const noteTex = (() => {
  const c = document.createElement('canvas'); c.width = 128; c.height = 70; const g = c.getContext('2d');
  g.fillStyle = '#4cbb45'; g.fillRect(0, 0, 128, 70);
  g.strokeStyle = '#9be887'; g.lineWidth = 5; g.strokeRect(8, 8, 112, 54);
  g.fillStyle = '#9be887'; g.beginPath(); g.arc(64, 35, 14, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#2f8c2c'; g.font = `900 20px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('$', 64, 36);
  return canvasTex(c);
})();
const pieGeo = top => coloredGeo([[new THREE.CylinderGeometry(.24, .27, .1, 22).translate(0, .05, 0), '#c27b33'], [new THREE.CylinderGeometry(.22, .24, .05, 22).translate(0, .11, 0), top]]);
const ITEMS = {
  egg: itemMesh(coloredGeo([[new THREE.SphereGeometry(.13, 18, 14).scale(1.08, 1.0, 1.0).translate(0, .13, 0), '#fffaf0']])),
  pie: itemMesh(pieGeo('#e2484f')),
  pumpkinPie: itemMesh(pieGeo('#f08a2a')),
  wheat: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.1, .08, .5, 10).rotateZ(Math.PI / 2).translate(-.06, .1, 0), '#d9b23a'],
    [new THREE.SphereGeometry(.12, 10, 8).scale(1.4, .9, 1).translate(.22, .1, 0), '#f0cf5a'], [new THREE.TorusGeometry(.1, .025, 6, 12).rotateY(Math.PI / 2).translate(.02, .1, 0), '#a86d2a']])),
  carrot: itemMesh(coloredGeo([[new THREE.ConeGeometry(.08, .42, 10).rotateZ(-Math.PI / 2).translate(.06, .09, 0), '#f07a24'],
    [new THREE.ConeGeometry(.045, .2, 6).rotateZ(Math.PI / 2).translate(-.24, .12, .03), '#5cb83a'], [new THREE.ConeGeometry(.045, .2, 6).rotateZ(Math.PI / 2 + .4).translate(-.24, .06, -.03), '#4fae3a']])),
  corn: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.08, .065, .38, 12).rotateZ(Math.PI / 2).translate(.03, .09, 0), '#f5cf3a'],
    [new THREE.ConeGeometry(.1, .3, 8).rotateZ(Math.PI / 2).translate(-.2, .09, 0), '#7cc44f']])),
  strawberry: itemMesh(coloredGeo([[new THREE.SphereGeometry(.11, 12, 10).scale(1, 1.15, 1).translate(0, .11, 0), '#e5333f'], [new THREE.ConeGeometry(.09, .06, 6).translate(0, .24, 0), '#4fae3a']])),
  flour: itemMesh(coloredGeo([[SACK_GEO.clone().scale(.38, .34, .38), '#f4ecdc'], [new THREE.TorusGeometry(.045, .012, 6, 12).rotateX(Math.PI / 2).translate(0, .26, 0), '#c27b33']])),
  bread: itemMesh(coloredGeo([[new THREE.SphereGeometry(.2, 14, 10).scale(1.4, .6, .85).translate(0, .1, 0), '#cf8a3e'],
    ...[-.12, 0, .12].map(x => [new THREE.BoxGeometry(.03, .02, .18).translate(x, .21, 0), '#f2c27a'])])),
  pumpkin: itemMesh(coloredGeo([[new THREE.SphereGeometry(.2, 16, 12).scale(1, .78, 1).translate(0, .16, 0), '#f08a2a'], [new THREE.CylinderGeometry(.03, .04, .1, 8).translate(0, .34, 0), '#6b8a2a']])),
  milk: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.1, .1, .22, 14).translate(0, .11, 0), '#fbfbf6'], [new THREE.CylinderGeometry(.05, .1, .07, 14).translate(0, .255, 0), '#fbfbf6'],
    [new THREE.CylinderGeometry(.055, .055, .05, 12).translate(0, .31, 0), '#3c8fd9'], [new THREE.CylinderGeometry(.102, .102, .06, 14).translate(0, .12, 0), '#7cc0f5']])),
  cream: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.11, .11, .2, 14).translate(0, .1, 0), '#fbf6ec'], [new THREE.CylinderGeometry(.12, .12, .06, 14).translate(0, .23, 0), '#ff9cc4']])),
  juice: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.09, .09, .24, 12).translate(0, .12, 0), '#ff9a2a'], [new THREE.CylinderGeometry(.05, .09, .06, 12).translate(0, .27, 0), '#ffb24a'],
    [new THREE.CylinderGeometry(.05, .05, .04, 10).translate(0, .32, 0), '#2fa84f']])),
  cheese: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.22, .22, .15, 20).translate(0, .075, 0), '#f5c842']])),
  cake: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.24, .24, .13, 22).translate(0, .065, 0), '#fff2e6'], [new THREE.CylinderGeometry(.245, .245, .03, 22).translate(0, .12, 0), '#ff9cc4'],
    [new THREE.CylinderGeometry(.16, .16, .1, 20).translate(0, .18, 0), '#ffd6e6'], [new THREE.SphereGeometry(.045, 10, 8).translate(0, .26, 0), '#e0303a']])),
  coin: itemMesh(new THREE.BoxGeometry(.46, .045, .25).translate(0, .023, 0),
    [mat('#2f8c2c'), mat('#2f8c2c'), new THREE.MeshLambertMaterial({ map: noteTex }), mat('#2f8c2c'), mat('#2f8c2c'), mat('#2f8c2c')]),
};
const _o = new THREE.Object3D();
const lists = Object.fromEntries(Object.keys(ITEMS).map(k => [k, []]));
function putItem(t, x, y, z, rot = 0) { if (lists[t]) lists[t].push(x, y, z, rot); }
function flushItems() {
  for (const t in ITEMS) {
    const im = ITEMS[t], L = lists[t], n = Math.min(MAXI, L.length / 4);
    for (let i = 0; i < n; i++) {
      _o.position.set(L[i * 4], L[i * 4 + 2], L[i * 4 + 1]); _o.rotation.set(0, L[i * 4 + 3], 0); _o.updateMatrix();
      im.setMatrixAt(i, _o.matrix);
    }
    im.count = n; im.instanceMatrix.needsUpdate = true; L.length = 0;
  }
}
// particles: confetti boxes and smoke puffs
const confetti = new THREE.InstancedMesh(new THREE.BoxGeometry(.1, .1, .1), new THREE.MeshLambertMaterial(), 300);
confetti.frustumCulled = false; scene.add(confetti);
const smoke = new THREE.InstancedMesh(new THREE.SphereGeometry(.16, 10, 8), new THREE.MeshLambertMaterial({ color: '#f2f2f2', transparent: true, opacity: .75 }), 160);
smoke.frustumCulled = false; scene.add(smoke);
const _c = new THREE.Color();

// ---------- draw-call reduction: bake material colours into vertex colours and merge ----------
// Each merged group draws in one call instead of one call per mesh and material (matters a lot on phones).
function colorAttr(g, mats) {
  const n = g.attributes.position.count, col = new Float32Array(n * 3), idx = g.index;
  const groups = g.groups.length ? g.groups : [{ start: 0, count: idx ? idx.count : n, materialIndex: 0 }];
  for (const gr of groups) {
    const c = (mats.length === 1 ? mats[0] : mats[gr.materialIndex || 0] || mats[0]).color; // a single material covers every group
    for (let i = gr.start; i < gr.start + gr.count; i++) { const v = idx ? idx.getX(i) : i; col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.clearGroups();
}
function bakeMerge(root, keep = () => false) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), rel = new THREE.Matrix4();
  const geos = [], done = [];
  const kept = (m) => { for (let p = m; p && p !== root; p = p.parent) if (keep(p)) return true; return false; };
  root.traverse(m => {
    if (!m.isMesh || m.isSkinnedMesh || m.isInstancedMesh || kept(m)) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (mats.some(x => x.map || x.transparent || (x.emissive && x.emissive.getHex()))) return;
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    colorAttr(g, mats);
    g.applyMatrix4(rel.multiplyMatrices(inv, m.matrixWorld));
    geos.push(g); done.push(m);
  });
  if (geos.length < 2) return;
  for (const m of done) m.removeFromParent();
  const merged = new THREE.Mesh(mergeGeometries(geos), BAKED_MAT);
  merged.castShadow = merged.receiveShadow = true;
  root.add(merged);
}

// ---------- characters ----------
const CHAR_H = 1.85, HEAD_SCALE = 1.3, CHUNK = 1.14;
// Ground speed the feet cover at timeScale 1, in world units/s at CHAR_H (measured from foot travel while planted,
// ~/scripts/stack-proto/stride.py). Animation speed = movement speed / this, so the feet do not slide.
const STRIDE_K = Number(new URLSearchParams(location.search).get('stride')) || 1.12; // 1.12: least planted-foot slide (slide2.py); ?stride= to retune
const STRIDE = { womanA: { Run: 2.19, Walk: 1.1 }, womanB: { Run: 2.18, Walk: 1.1 }, casual: { Run: 2.6, Walk: 1.36 }, hoodie: { Run: 2.58, Walk: 1.35 }, farmer: { Run: 2.6, Walk: 1.36 } };
const NOT_CLOTHES = /^(Skin|Skin_Darker|Eye|Eyebrows|Hair.*)$/;
function makeChar({ model: name, shirt, pants, hair }) {
  const a = A[name], o = SkeletonUtils.clone(a.scene), s = CHAR_H / a.size.y;
  o.scale.setScalar(s);
  o.traverse(m => {
    if (!m.isSkinnedMesh) return;
    m.frustumCulled = false;
    const R = m.userData.ranges;
    if (!R || !(shirt || pants || hair)) return;
    const g = m.geometry.clone(), col = g.attributes.color.array; // own colours for this character
    for (const r of R) {
      const part = /Body/.test(r.mesh) ? shirt : /Legs|Pants/.test(r.mesh) ? pants : null;
      const c = hair && /^Hair/.test(r.mat) ? hair : part && !NOT_CLOTHES.test(r.mat) ? part : null;
      if (!c) continue;
      _c.set(c);
      for (let i = r.start; i < r.start + r.count; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    }
    m.geometry = g;
  });
  const g = new THREE.Group(); g.add(o); scene.add(g); o.scale.x *= CHUNK; o.scale.z *= CHUNK;
  const mixer = new THREE.AnimationMixer(o); mixers.add(mixer);
  const actions = {};
  for (const n of ['Idle', 'Walk', 'Run', 'Sword_Slash']) { const c = a.anims.find(c => c.name.endsWith('|' + n)); if (c) actions[n] = mixer.clipAction(c); }
  actions.Idle.play();
  const wrist = o.getObjectByName('WristR') || o.getObjectByName('Wrist.R');
  const axe = new THREE.Group(); wrist.add(axe);
  box(axe, .05, .55, .05, '#8a5a2b', 0, .22, 0);
  box(axe, .05, .2, .24, '#c3cbd3', 0, .45, .1);
  axe.visible = false;
  const st = STRIDE[name] || STRIDE.casual, k = STRIDE_K;
  return { g, mixer, actions, cur: 'Idle', head: o.getObjectByName('Head'), wrist, axe, axeFixed: false, stride: { Run: st.Run * CHUNK * k, Walk: st.Walk * CHUNK * k } };
}
function setAnim(c, n, ts = 1) {
  const next = c.actions[n] || c.actions.Idle;
  if (c.cur !== n) { (c.actions[c.cur] || c.actions.Idle).fadeOut(.15); next.reset().fadeIn(.15).play(); c.cur = n; }
  next.timeScale = ts;
}
function posePerson(c, a, run = true) {
  c.g.position.set(a.x, 0, a.y);
  c.g.rotation.y = Math.PI / 2 - a.dir;
  const sp = Math.hypot(a.vx || 0, a.vy || 0);
  if (a.chopping) setAnim(c, 'Sword_Slash', a.tool === 'axe' ? 1.5 : 2);
  else if (sp > .35) { const clip = run ? 'Run' : 'Walk'; setAnim(c, clip, Math.max(.4, sp / c.stride[clip])); }
  else setAnim(c, 'Idle');
  c.axe.visible = !!a.chopping && a.tool === 'axe';
  if (c.axe.visible && !c.axeFixed) { // undo bone/world scaling so the axe keeps its size
    c.g.updateMatrixWorld(true); const ws = new THREE.Vector3(); c.wrist.getWorldScale(ws); c.axe.scale.setScalar(1 / ws.x); c.axeFixed = true;
  }
}
const people = new Map();
function personFor(a, opts) {
  let p = people.get(a);
  if (!p) { p = makeChar(opts()); people.set(a, p); }
  p.seen = true; return p;
}

// animals: chickens and cows
const ANIMAL = {
  chicken: { model: 'chickenB', h: .82, bright: 1.7, idle: 'Idle', eat: 'Idle_Peck', move: 'Run', moveTs: .55 },
  cow: { model: 'cow', h: 1.5, bright: 0, idle: 'Idle', eat: 'Eating', move: 'Walk', moveTs: .7 },
};
function makeAnimal(kind) {
  const k = ANIMAL[kind], a = A[k.model], o = SkeletonUtils.clone(a.scene), s = k.h / a.size.y;
  o.scale.setScalar(s);
  const g = new THREE.Group(); g.add(o); scene.add(g);
  o.traverse(m => { if (m.isMesh) { m.frustumCulled = false; if (k.bright) { m.material = m.material.clone(); m.material.color.setScalar(k.bright); } } });
  const mixer = new THREE.AnimationMixer(o); mixers.add(mixer);
  const actions = {};
  for (const n of [k.idle, k.eat, k.move]) { const c = a.anims.find(c => c.name === n || c.name.endsWith('|' + n)); if (c) actions[n] = mixer.clipAction(c); }
  actions[k.idle].play(); mixer.update(Math.random() * 2);
  return { g, mixer, actions, cur: k.idle, k };
}
const animalMeshes = new Map(); // animal state -> mesh

// ---------- buildings (placed by the player on the grid) ----------
const TREE_GREENS = ['#46b83a', '#55c642', '#3fae35', '#5ccf47'];
function fenceRun(x0, y0, x1, y1, parent, h = .62) {
  const f = A.fence2, segLen = f.size.x * (h / f.size.y);
  const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(len / segLen)), ang = Math.atan2(y1 - y0, x1 - x0);
  for (let i = 0; i < n; i++) {
    const t = (i + .5) / n;
    const w = model('fence2', h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, -ang, parent);
    w.scale.x = len / n / segLen;
  }
}
// fence around a w x h footprint (centred on 0), with a gate in the middle of the front side
function fenceBox(g, w, h) {
  const x0 = -w / 2 + .15, x1 = w / 2 - .15, y0 = -h / 2 + .15, y1 = h / 2 - .15;
  fenceRun(x0, y0, x1, y0, g); fenceRun(x0, y0, x0, y1, g); fenceRun(x1, y0, x1, y1, g);
  fenceRun(x0, y1, -.7, y1, g); fenceRun(.7, y1, x1, y1, g);
}
function cafe(g, wall, roof, stripe, sign) {
  rbox(g, 2.5, 1.4, 2.2, wall, 0, .7, -.1, .08);
  mesh(new THREE.CylinderGeometry(.01, 1.85, .95, 4, 1).rotateY(Math.PI / 4).scale(1.05, 1, .9), roof, 0, 1.87, -.1, g);
  rbox(g, .6, .9, .06, '#a86a3a', -.55, .45, 1.0, .03);
  rbox(g, .65, .5, .05, '#9fd8f5', .55, .85, 1.0, .03);
  for (let i = 0; i < 6; i++) rbox(g, .42, .12, .5, i % 2 ? '#ffffff' : stripe, -1.05 + i * .42, 1.35, 1.12, .02);
  if (sign) sign(g);
}
const BUILDERS = {
  field: g => {
    rbox(g, 1.92, .1, 1.92, '#8a5530', 0, .03, 0, .05);
    for (const z of [-.6, 0, .6]) rbox(g, 1.76, .05, .3, '#9c6438', 0, .09, z, .02);
  },
  coop: g => { fenceBox(g, 4, 3); modelFit('coop', 1.9, 1.5, -.85, -.55, 0, g); },
  cowshed: g => { fenceBox(g, 5, 4); modelFit('openBarn', 2.6, 1.9, -1.0, -.85, 0, g); },
  barn: g => { modelFit('bigBarn', 3.8, 2.8, 0, -.05, 0, g); sack(1.75, 1.25, .6, .3, g); model('crate', .5, -1.75, 1.25, .4, g); },
  mill: g => { model('windmill', 3.6, 0, -.1, 0, g, { Main: '#d9573a', Walls: '#f3ead2' }); sack(1.15, 1.1, .6, .4, g); },
  bakery: g => {
    box(g, 2.2, 1.0, 1.8, '#cf7a52', 0, .5, -.1);
    box(g, 2.26, .1, 1.86, '#b8643f', 0, 1.0, -.1);
    mesh(new THREE.SphereGeometry(.85, 22, 14, 0, Math.PI * 2, 0, Math.PI / 2), '#d98a62', 0, 1.0, -.1, g).scale.set(1, .8, .9);
    box(g, .3, .9, .3, '#8c4a33', .6, 1.4, -.45);
    g.userData.mouth = mesh(new THREE.CircleGeometry(.36, 20, 0, Math.PI), new THREE.MeshLambertMaterial({ color: '#3a2620', emissive: '#000000' }), 0, .12, .81, g);
    model('crate', .45, -1.2, 1.05, .4, g); sack(1.2, 1.05, .6, -.3, g);
  },
  dairy: g => { modelFit('barn', 2.8, 2.6, 0, -.1, 0, g, { DarkRed: '#3c7fc0', LightRed: '#5a9ad6' }); mesh(new THREE.CylinderGeometry(.3, .3, .24, 20), '#f5c842', 1.2, .12, 1.1, g); },
  juicer: g => cafe(g, '#fff4d6', '#5cbb44', '#ff9a2a', g2 => { mesh(new THREE.CylinderGeometry(.22, .2, .5, 16), '#ff9a2a', 0, 2.55, -.1, g2); mesh(new THREE.CylinderGeometry(.03, .03, .4, 6).rotateZ(.4), '#ffffff', .12, 2.9, -.1, g2); }),
  sweets: g => cafe(g, '#fff1dc', '#ff8fb8', '#ff6fa0', g2 => { mesh(new THREE.CylinderGeometry(.3, .3, .2, 18), '#fff2e6', 0, 2.42, -.1, g2); mesh(new THREE.CylinderGeometry(.2, .2, .16, 18), '#ff9cc4', 0, 2.6, -.1, g2); mesh(new THREE.SphereGeometry(.07, 10, 8), '#e0303a', 0, 2.74, -.1, g2); }),
  bench: g => model('bench', .55, 0, 0, 0, g),
  lamp: g => model('lamp', 2.5, 0, 0, 0, g, { Light: '#fff3b0' }),
  well: g => model('well', 1.9, 0, 0, 0, g),
  fountain: g => modelFit('fountain', 1.9, 1.9, 0, 0, 0, g),
  tree: g => model('tree3', 2.4, 0, 0, Math.random() * 6, g, { Green: TREE_GREENS[Math.floor(Math.random() * 4)], Brown: '#8b5a2b' }),
  flowers: g => {
    for (let k = 0; k < 9; k++) { const a = k / 9 * Math.PI * 2; mesh(new THREE.DodecahedronGeometry(.09, 0), '#b9b2a4', Math.cos(a) * .4, .05, Math.sin(a) * .4, g); }
    mesh(new THREE.CylinderGeometry(.38, .4, .08, 18), '#8a5a35', 0, .04, 0, g);
    const cols = ['#ff6f9a', '#ffd84d', '#ffffff', '#b98cff', '#ff8a3d'];
    for (let k = 0; k < 10; k++) { const a = k * 2.4, r = .05 + (k % 3) * .1; mesh(new THREE.SphereGeometry(.07, 8, 6), cols[k % cols.length], Math.cos(a) * r, .22 + (k % 3) * .03, Math.sin(a) * r, g); }
    for (let k = 0; k < 5; k++) { const a = k * 1.25; mesh(new THREE.SphereGeometry(.1, 8, 6).scale(1, .6, 1), '#4cbb3c', Math.cos(a) * .2, .13, Math.sin(a) * .2, g); }
  },
};
// what stands in front of a building: a nest or a trough for pens; a drop zone for the barn; a pickup zone for workshops
function frontDecor(type, g) {
  const c = CATALOG[type], z = c.h / 2 + .7;
  if (c.kind === 'pen') {
    const pg = group(0, z, g);
    if (c.animal === 'chicken') { mesh(new THREE.CylinderGeometry(.7, .78, .1, 24), '#e3c06c', 0, .05, 0, pg); mesh(new THREE.TorusGeometry(.66, .1, 8, 24).rotateX(Math.PI / 2), '#d1a854', 0, .1, 0, pg); }
    else { rbox(pg, 1.5, .1, 1.0, '#9b6a3a', 0, .05, 0, .03); for (const [w, d, x, zz] of [[1.5, .08, 0, -.48], [1.5, .08, 0, .48], [.08, 1, -.72, 0], [.08, 1, .72, 0]]) rbox(pg, w, .16, d, '#b9824a', x, .08, zz, .02); }
  }
  if (c.kind === 'barn' || c.kind === 'factory') {
    const d = zoneDecal(0, 0, c.kind === 'barn' ? 'В АМБАР' : 'ЗАБРАТЬ');
    scene.remove(d.m); d.m.position.set(0, .02, z); g.add(d.m);
  }
}
function makeBuilding(type) {
  const g = new THREE.Group();
  BUILDERS[type](g);
  frontDecor(type, g);
  bakeMerge(g, m => m === g.userData.mouth);
  g.traverse(m => { if (m.isMesh && m.material && m.material.map && !m.material.transparent) m.castShadow = true; });
  return g;
}
const bMeshes = new Map(); // building id -> { g, b }
let gridSig = '';

// crops: per crop an instanced mesh; each field shows a 3 x 3 patch of plants
const CROP_SPOTS = [];
for (const x of [-.6, 0, .6]) for (const z of [-.6, 0, .6]) CROP_SPOTS.push([x, z]);
function dynInstanced(name, n, height, colors) {
  const a = A[name]; a.scene.updateMatrixWorld(true);
  const s = height / a.size.y, base = new THREE.Matrix4().makeTranslation(-a.center.x * s, -a.min.y * s, -a.center.z * s).multiply(new THREE.Matrix4().makeScale(s, s, s));
  const geos = [];
  a.scene.traverse(m => {
    if (!m.isMesh) return;
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    const mats = (Array.isArray(m.material) ? m.material : [m.material]).map(mm => { const c = mm.clone(); if (colors && colors[mm.name]) c.color.set(colors[mm.name]); return c; });
    colorAttr(g, mats); g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(base, m.matrixWorld)); geos.push(g);
  });
  return itemMesh(mergeGeometries(geos), BAKED_MAT, n);
}
const NCROP = 40 * 9;
const CROP_IM = {
  wheat: dynInstanced('wheat', NCROP, .8, { Yellow: '#e8c050' }),
  carrot: itemMesh(coloredGeo([...[0, 2.1, 4.2].map(a => [new THREE.ConeGeometry(.05, .34, 5).rotateZ(.35).rotateY(a).translate(0, .17, 0), '#4fae3a']),
    [new THREE.CylinderGeometry(.07, .05, .06, 10).translate(0, .03, 0), '#f07a24']]), BAKED_MAT, NCROP),
  corn: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.035, .045, .95, 6).translate(0, .47, 0), '#5ca83a'],
    ...[0, 2.4, 4.4].map((a, k) => [new THREE.ConeGeometry(.06, .5, 4).scale(1, 1, .3).rotateZ(1.1).rotateY(a).translate(0, .35 + k * .12, 0), '#6cc43d']),
    [new THREE.CylinderGeometry(.05, .04, .22, 8).rotateZ(.35).translate(.08, .62, 0), '#f5cf3a']]), BAKED_MAT, NCROP),
  strawberry: itemMesh(coloredGeo([[new THREE.SphereGeometry(.2, 10, 8).scale(1.1, .55, 1.1).translate(0, .1, 0), '#3f9f35'],
    ...[[.12, .05], [-.1, .1], [.02, -.13]].map(([x, z]) => [new THREE.SphereGeometry(.055, 8, 6).scale(1, 1.15, 1).translate(x, .17, z), '#e5333f'])]), BAKED_MAT, NCROP),
  pumpkin: dynInstanced('pumpkin', NCROP, .42, { Orange: '#f08a2a', Brown: '#6b8a2a' }),
};
const sproutIM = itemMesh(coloredGeo([[new THREE.ConeGeometry(.045, .26, 5).translate(0, .13, 0), '#6cc43d']]), BAKED_MAT, NCROP);

// stalls in the market row
function makeStall(st) {
  const g = group(st.x, st.y);
  const red = '#e0393f', dark = '#b8272f';
  rbox(g, 2.4, .14, 1.0, red, 0, .78, 0, .06);
  rbox(g, 2.28, .56, .9, dark, 0, .44, 0, .05);
  rbox(g, 2.1, .4, .04, '#c92f37', 0, .46, .46, .02);
  for (const [x, z] of [[-1.05, -.36], [1.05, -.36], [-1.05, .36], [1.05, .36]]) rbox(g, .14, .2, .14, '#8f1f27', x, .1, z, .04);
  rbox(g, .48, .24, .42, '#5fcde0', -.8, .96, .02, .06);
  const scr = rbox(g, .4, .22, .05, '#eafcff', -.8, 1.16, -.14, .02); scr.rotation.x = -.45;
  rbox(g, .32, .04, .2, '#3aa9bc', -.8, 1.09, .1, .015);
  sack(-1.65, .1, .8, .4, g); sack(-1.95, .55, .62, 1.6, g);
  bakeMerge(g);
  return g;
}
const stallMeshes = new Map(), sellZones = new Map(), stallCashiers = new Map();

// border: bushes along the edge of the world and a forest beyond it
{
  const decor = new THREE.Group(); scene.add(decor);
  for (let y = WORLD.y0 + 1; y < WORLD.y1 - 1; y += 3) { bush(WORLD.x0 + .4 + srnd() * .3, y + srnd(), .9 + srnd() * .5, decor); bush(WORLD.x1 - .4 - srnd() * .3, y + srnd(), .9 + srnd() * .5, decor); }
  for (let x = WORLD.x0 + 1; x < WORLD.x1 - 1; x += 3) bush(x + srnd(), WORLD.y0 + .4 + srnd() * .3, .9 + srnd() * .5, decor);
  bakeMerge(decor);
}
// split instances into square chunks so three.js can skip the ones off screen
function chunks(items, size = 14) {
  const m = new Map();
  for (const it of items) { const k = Math.floor(it[0] / size) + ',' + Math.floor(it[1] / size); if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
  return [...m.values()];
}
function cullable(im) { im.computeBoundingSphere(); im.frustumCulled = true; return im; }
// grass and flowers; tufts under buildings are hidden whenever the layout changes
const tufts = [];
{
  const pos = [], col = [];
  for (let k = 0; k < 6; k++) {
    const a = k / 6 * Math.PI * 2 + srnd(), r = .04, h = .09 + srnd() * .08, w = .022, lean = .045;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    pos.push(bx - w * Math.sin(a), 0, bz + w * Math.cos(a), bx + w * Math.sin(a), 0, bz - w * Math.cos(a), bx + Math.cos(a) * lean, h, bz + Math.sin(a) * lean);
    col.push(.82, .95, .7, .82, .95, .7, 1.08, 1.1, .92);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => i % 3 === 1 ? 1 : 0), 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const N = LITE ? 6000 : 11000;
  const grassMat = addWind(newMat({ vertexColors: true, side: THREE.DoubleSide, roughness: 1 }));
  const greens = ['#6cc43d', '#74ca45', '#66bd39', '#7dcf4d'].map(c => new THREE.Color(c));
  const X0 = WORLD.x0 - 3, Y0 = WORLD.y0 - 3, XW = WORLD.x1 - WORLD.x0 + 6, YH = WORLD.y1 - WORLD.y0 + 8;
  const all = [];
  for (let tries = 0; all.length < N && tries < N * 4; tries++) {
    const x = X0 + srnd() * XW, y = Y0 + srnd() * YH;
    if (grassFree(x, y)) all.push([x, y, srnd() * 6.3, .7 + srnd() * .8, null]);
  }
  const F = LITE ? 450 : 800, flGeo = new THREE.SphereGeometry(.055, 8, 6).translate(0, .16, 0), flMat = addWind(newMat({ roughness: .7 }));
  const fc = ['#ffffff', '#ffe14d', '#ff8fb8', '#b98cff', '#ffffff'].map(c => new THREE.Color(c));
  const fls = [];
  for (let tries = 0; fls.length < F && tries < F * 6; tries++) {
    const cx = X0 + srnd() * XW, cy = Y0 + srnd() * YH, col = fc[Math.floor(srnd() * fc.length)];
    for (let k = 0; k < 5 && fls.length < F; k++) {
      const x = cx + (srnd() - .5) * .8, y = cy + (srnd() - .5) * .8;
      if (grassFree(x, y)) fls.push([x, y, 0, .8 + srnd() * .5, col]);
    }
  }
  const place = (im, list, color) => {
    list.forEach((t, i) => {
      const [x, y, rot, sc] = t;
      _o.position.set(x, 0, y); _o.rotation.set(0, rot, 0); _o.scale.setScalar(sc); _o.updateMatrix();
      im.setMatrixAt(i, _o.matrix); im.setColorAt(i, color(i)); tufts.push({ x, y, im, i, m: _o.matrix.clone() });
    });
    _o.scale.setScalar(1); _o.rotation.set(0, 0, 0); scene.add(cullable(im));
  };
  let gi = 0;
  for (const part of chunks(all)) { const im = new THREE.InstancedMesh(geo, grassMat, part.length); im.receiveShadow = true; place(im, part, () => greens[gi++ % 4]); }
  for (const part of chunks(fls)) place(new THREE.InstancedMesh(flGeo, flMat, part.length), part, (i) => part[i][4]);
}
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
function refreshGrass() {
  const rects = B.filter(b => CATALOG[b.type].kind !== 'decor' || (CATALOG[b.type].w > 1)).map(b => { const c = CATALOG[b.type]; return [b.x - .05, b.y - .05, b.x + c.w + .05, b.y + c.h + (hasFront(b.type) ? 1.3 : .05)]; });
  const dirty = new Set();
  for (const t of tufts) {
    const hide = rects.some(([x0, y0, x1, y1]) => t.x > x0 && t.x < x1 && t.y > y0 && t.y < y1);
    if (hide !== !!t.hidden) { t.hidden = hide; t.im.setMatrixAt(t.i, hide ? _zero : t.m); dirty.add(t.im); }
  }
  for (const im of dirty) im.instanceMatrix.needsUpdate = true;
}
// forest around the farm: instanced copies of the tree model
const instMats = new Map();
function instancedModel(name, spots, colorFor) {
  const a = A[name]; a.scene.updateMatrixWorld(true);
  const parts = [];
  a.scene.traverse(m => { if (m.isMesh) parts.push(m); });
  for (const part of parts) {
    const mats = Array.isArray(part.material) ? part.material : [part.material];
    if (!instMats.has(part)) instMats.set(part, mats.map(mm => { const c = mm.clone(); if (colorFor(mm.name)) c.color.set('#ffffff'); return c; }));
    const im = new THREE.InstancedMesh(part.geometry, instMats.get(part), spots.length);
    im.castShadow = true; im.receiveShadow = true;
    spots.forEach(([x, y, h, rot, tint], i) => {
      const s = h / a.size.y;
      _o.position.set(x - a.center.x * s, -a.min.y * s, y - a.center.z * s); _o.rotation.set(0, rot, 0); _o.scale.setScalar(s); _o.updateMatrix();
      im.setMatrixAt(i, _o.matrix.clone().multiply(part.matrixWorld));
      const c = colorFor(mats[0].name, tint); if (c) im.setColorAt(i, new THREE.Color(c));
    });
    scene.add(cullable(im));
  }
  _o.scale.setScalar(1);
}
{
  const spots = [];
  const add = (x, y) => spots.push([x, y, 2.3 + srnd() * 1.4, srnd() * 6.3, Math.floor(srnd() * 4)]);
  const { x0, y0, x1, y1 } = WORLD;
  for (let y = y0 - 6; y < y1 + 8; y += 1.6) { add(x0 - 1.3 - srnd() * 1.2, y + srnd()); add(x0 - 3.6 - srnd() * 1.5, y + srnd()); add(x1 + 1.3 + srnd() * 1.2, y + srnd()); add(x1 + 3.6 + srnd() * 1.5, y + srnd()); }
  for (let x = x0 - .5; x < x1 + 1; x += 1.6) { add(x + srnd(), y0 - 1.2 - srnd() * 1.2); add(x + srnd(), y0 - 3.6 - srnd() * 1.5); add(x + srnd(), ROAD_Y + 2.7 + srnd() * 1.5); }
  const colorFor = (name, tint) => name === 'Green' ? (tint === undefined ? true : TREE_GREENS[tint]) : null;
  const forest = LITE ? spots.filter((_, i) => i % 2 === 0) : spots;
  for (const part of chunks(forest, 16)) instancedModel('tree3', part, colorFor);
  if (LITE) for (const [x, y, h] of forest) STATIC_BLOBS.push([x, y, h * .32, h * .32]);
}

// ---------- placement ghost ----------
const ghost = { type: null, g: null, cells: null };
const cellGeo = new THREE.PlaneGeometry(.94, .94).rotateX(-Math.PI / 2);
// cell tiles: a coloured square with a white rim
function cellMat(fill, rim) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  rr(g, 3, 3, 58, 58, 10); g.fillStyle = fill; g.fill(); g.lineWidth = 5; g.strokeStyle = rim; g.stroke();
  return new THREE.MeshBasicMaterial({ map: canvasTex(c), transparent: true, depthWrite: false, toneMapped: false });
}
const cellMats = { ok: cellMat('rgba(80,220,255,.55)', '#ffffff'), bad: cellMat('rgba(255,80,60,.6)', '#ffffff'), apron: cellMat('rgba(255,255,255,.25)', 'rgba(255,255,255,.7)') };
const ghostCells = new THREE.InstancedMesh(cellGeo, cellMats.ok, 64); ghostCells.frustumCulled = false; ghostCells.count = 0; ghostCells.renderOrder = 3; scene.add(ghostCells);
const ghostApron = new THREE.InstancedMesh(cellGeo, cellMats.apron, 16); ghostApron.frustumCulled = false; ghostApron.count = 0; ghostApron.renderOrder = 3; scene.add(ghostApron);
function syncGhost() {
  const P = G.placing;
  gridMesh.visible = !!P;
  if (!P) { if (ghost.g) ghost.g.visible = false; ghostCells.count = 0; ghostApron.count = 0; return; }
  if (ghost.type !== P.type) { if (ghost.g) scene.remove(ghost.g); ghost.g = makeBuilding(P.type); scene.add(ghost.g); ghost.type = P.type; }
  const c = CATALOG[P.type], ok = canPlace(P.type, P.x, P.y, P.b);
  ghost.g.visible = true; ghost.g.position.set(P.x + c.w / 2, Math.sin(now * 6) * .05 + .08, P.y + c.h / 2);
  if (P.b && bMeshes.has(P.b.id)) bMeshes.get(P.b.id).g.visible = false;
  const { body, apron } = cellsOf(P.type, P.x, P.y);
  ghostCells.material = ok ? cellMats.ok : cellMats.bad;
  body.forEach(([i, j], k) => { _o.position.set(i + .5, .05, j + .5); _o.rotation.set(0, 0, 0); _o.scale.setScalar(1); _o.updateMatrix(); ghostCells.setMatrixAt(k, _o.matrix); });
  ghostCells.count = body.length; ghostCells.instanceMatrix.needsUpdate = true;
  apron.forEach(([i, j], k) => { _o.position.set(i + .5, .05, j + .5); _o.updateMatrix(); ghostApron.setMatrixAt(k, _o.matrix); });
  ghostApron.count = apron.length; ghostApron.instanceMatrix.needsUpdate = true;
  P.ok = ok;
  camX += (clamp(P.x + c.w / 2, WORLD.x0 + 4, WORLD.x1 - 4) - camX) * .12;
  camY += (clamp(P.y + c.h / 2, WORLD.y0 + 5, WORLD.y1 - 6) - camY) * .12;
}

// ---------- input ----------
let moved = false;
const raycaster = new THREE.Raycaster(), groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _hit = new THREE.Vector3();
function groundAt(cx, cy) {
  raycaster.setFromCamera(new THREE.Vector2(cx / W * 2 - 1, -(cy / H * 2 - 1)), camera);
  return raycaster.ray.intersectPlane(groundPlane, _hit) ? { x: _hit.x, y: _hit.z } : null;
}
// what is under a tap: a building (footprint or its front spot) or a stall
function pickAt(cx, cy) {
  const p = groundAt(cx, cy); if (!p) return null;
  for (const b of B) {
    const c = CATALOG[b.type];
    if (p.x > b.x - .1 && p.x < b.x + c.w + .1 && p.y > b.y - .3 && p.y < b.y + c.h + (hasFront(b.type) ? 1.2 : .1)) return { b };
  }
  for (let i = 0; i < G.stalls; i++) { const st = stallState[i]; if (Math.abs(p.x - st.x) < 1.4 && p.y > st.y - 1.8 && p.y < st.y + .7) return { stall: i }; }
  return null;
}
let tap = null, drag = null;
ov.addEventListener('pointerdown', e => {
  ov.setPointerCapture(e.pointerId);
  tap = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (G.placing) { const p = groundAt(e.clientX, e.clientY); drag = p ? { id: e.pointerId, ox: p.x - G.placing.x, oy: p.y - G.placing.y } : null; return; }
  joy = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
});
ov.addEventListener('pointermove', e => {
  if (drag && G.placing && e.pointerId === drag.id) {
    const p = groundAt(e.clientX, e.clientY);
    if (p) { G.placing.x = Math.round(p.x - drag.ox); G.placing.y = Math.round(p.y - drag.oy); }
    return;
  }
  if (joy && e.pointerId === joy.id) { joy.x = e.clientX; joy.y = e.clientY; if (Math.hypot(joy.x - joy.ox, joy.y - joy.oy) > 20) moved = true; }
});
ov.addEventListener('pointerup', e => {
  const isTap = tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 14 && performance.now() - tap.t < 400;
  if (G.placing && isTap) { // a tap moves the building there
    const p = groundAt(e.clientX, e.clientY), c = CATALOG[G.placing.type];
    if (p) { G.placing.x = Math.round(p.x - c.w / 2); G.placing.y = Math.round(p.y - c.h / 2); }
  } else if (!G.placing && isTap && !G.paused && typeof openCard === 'function') {
    const hit = pickAt(e.clientX, e.clientY);
    if (hit) openCard(hit);
  }
  tap = null; drag = null;
  if (joy && e.pointerId === joy.id) joy = null;
});
ov.addEventListener('pointercancel', () => { joy = null; drag = null; tap = null; });
addEventListener('keydown', () => { moved = true; });

// ---------- juice: dust puffs and pop-in ----------
const dust = new THREE.InstancedMesh(new THREE.SphereGeometry(.12, 10, 8), newMat({ color: '#f1d2a8', transparent: true, opacity: .6, roughness: 1 }), 80);
dust.frustumCulled = false; scene.add(dust);
const puffs = []; let puffT = 0;
function popScale(born) { const t = Math.min(1, (now - born) / .55); if (t >= 1) return 1; const u = t - 1; return Math.max(.01, 1 + 2.70158 * u * u * u + 1.70158 * u * u); }

// ---------- per-frame sync of the 3D scene ----------
function sync() {
  syncGhost();
  camera.position.set(camX, Math.sin(PITCH) * camDist, camY + 1.2 + Math.cos(PITCH) * camDist);
  camera.lookAt(camX, 0, camY + 1.2);
  const sx = Math.round(camX / 6) * 6, sy = Math.round(camY / 6) * 6; // steps, so shadow edges do not crawl every frame
  sun.position.set(sx - 6, 22, sy + 11); sun.target.position.set(sx, 0, sy);
  const s = wall();

  // buildings
  const sig = B.map(b => b.id + ':' + b.x + ',' + b.y).join('|');
  if (sig !== gridSig) { gridSig = sig; refreshGrass(); }
  for (const [id, m] of bMeshes) if (!B.includes(m.b)) { scene.remove(m.g); bMeshes.delete(id); }
  for (const b of B) {
    let m = bMeshes.get(b.id);
    if (!m) { m = { g: makeBuilding(b.type), b }; scene.add(m.g); bMeshes.set(b.id, m); }
    const c = center(b);
    m.g.position.set(c.x, 0, c.y); m.g.visible = !(G.placing && G.placing.b === b);
    m.g.scale.setScalar(popScale(b.born ?? -9));
    if (m.g.userData.mouth) { const busy = b.queue && b.queue.length; m.g.userData.mouth.material.emissive.set(busy ? '#ff8a20' : '#000000'); m.g.userData.mouth.material.emissiveIntensity = .8 + Math.sin(now * 12) * .2; }
    if (b.queue && b.queue.length && Math.random() < .1) parts.push({ x: c.x + .5 + rnd(-.1, .1), y: c.y - .3, z: 2.2, vx: rnd(-.1, .3), vy: 0, vz: 1.2, life: 1.2, c: 'smoke' });
  }

  // people
  for (const p of people.values()) p.seen = false;
  posePerson(personFor(player, () => ({ model: 'womanA' })), player);
  for (const h of helpers) posePerson(personFor(h, () => ({ model: 'farmer', shirt: h.shirt })), h);
  for (const c of customers) posePerson(personFor(c, () => ({ model: ['womanB', 'casual', 'hoodie', 'womanB', 'casual'][Math.floor(c.id * 5)], shirt: c.shirt, pants: ['#3f5f9e', '#4d4d5e', '#6b4a2e', '#2f4f7a'][Math.floor(c.id * 17) % 4], hair: c.hair })), c, false);
  for (let i = 0; i < G.stalls; i++) {
    if (!G.cashiers[i]) continue;
    const st = stallState[i];
    let a = stallCashiers.get(i);
    if (!a) { a = { x: st.x - .8, y: st.y - .85, dir: Math.PI / 2, walk: 0, stack: [], chopping: 0 }; stallCashiers.set(i, a); }
    posePerson(personFor(a, () => ({ model: 'hoodie', shirt: '#2fb6c8', pants: '#3a3a4a' })), a);
  }
  for (const [a, p] of people) if (!p.seen) { scene.remove(p.g); mixers.delete(p.mixer); people.delete(a); }

  // animals
  const alive = new Set(); for (const b of B) if (b.animals) for (const c of b.animals) alive.add(c);
  for (const [c, m] of animalMeshes) if (!alive.has(c)) { scene.remove(m.g); mixers.delete(m.mixer); animalMeshes.delete(c); }
  for (const b of B) if (b.animals) for (const c of b.animals) {
    let m = animalMeshes.get(c);
    if (!m) { m = makeAnimal(CATALOG[b.type].animal); animalMeshes.set(c, m); }
    m.g.position.set(c.x, 0, c.y);
    const moving = Math.hypot(c.tx - c.x, c.ty - c.y) > .1;
    if (moving) m.g.rotation.y = Math.PI / 2 - Math.atan2(c.ty - c.y, c.tx - c.x);
    const want = moving ? m.k.move : c.peck > .4 ? m.k.eat : m.k.idle;
    if (m.cur !== want && m.actions[want]) { m.actions[m.cur].fadeOut(.2); m.actions[want].reset().fadeIn(.2).play(); m.cur = want; }
    if (m.actions[m.k.move]) m.actions[m.k.move].timeScale = m.k.moveTs;
    m.g.visible = !(G.placing && G.placing.b === b);
  }

  // crops
  const cnt = Object.fromEntries(Object.keys(CROP_IM).map(k => [k, 0])); let nsp = 0;
  for (const b of B) {
    if (!b.crop || (G.placing && G.placing.b === b)) continue;
    const c = center(b), cr = CROPS[b.crop], st = fieldState(b, s), gr = st === 'ripe' ? 1 : clamp((s - b.at) / cr.t, 0, 1);
    const im = CROP_IM[b.crop], left = st === 'ripe' ? Math.ceil(9 * b.left / cr.yield) : 9;
    CROP_SPOTS.forEach(([dx, dz], k) => {
      if (k >= left) return;
      const jit = ((b.id * 7 + k * 13) % 10) / 10 - .5;
      if (gr < .25) { _o.position.set(c.x + dx, 0, c.y + dz); _o.rotation.set(0, k, 0); _o.scale.setScalar(.4 + gr * 2); _o.updateMatrix(); sproutIM.setMatrixAt(nsp++, _o.matrix); return; }
      const sc = st === 'ripe' ? 1 + Math.sin(now * 2 + k) * .03 : .35 + gr * .55;
      _o.position.set(c.x + dx + jit * .12, 0, c.y + dz - jit * .1); _o.rotation.set(0, k * 1.7 + b.id, 0); _o.scale.setScalar(sc); _o.updateMatrix();
      im.setMatrixAt(cnt[b.crop]++, _o.matrix);
    });
  }
  _o.scale.setScalar(1); _o.rotation.set(0, 0, 0);
  for (const k in CROP_IM) { CROP_IM[k].count = cnt[k]; CROP_IM[k].instanceMatrix.needsUpdate = true; }
  sproutIM.count = nsp; sproutIM.instanceMatrix.needsUpdate = true;

  // stalls
  for (let i = 0; i < STALL_SLOTS.length; i++) {
    const st = stallState[i], open = i < G.stalls;
    if (open && !stallMeshes.has(i)) { const g = makeStall(st); stallMeshes.set(i, g); g.userData.born = now; }
    if (stallMeshes.has(i)) { const g = stallMeshes.get(i); g.visible = open; g.scale.setScalar(popScale(firstSync ? -9 : g.userData.born)); }
    if (open && !sellZones.has(i)) sellZones.set(i, zoneDecal(st.counter.x, st.counter.y, 'ПРОДАЖА'));
    if (sellZones.has(i)) { const z = sellZones.get(i); z.m.visible = open; if (open) z.draw(!G.cashiers[i] && near(player, st.counter.x, st.counter.y, .95), !G.cashiers[i]); }
  }

  // items
  const bob = a => Math.abs(Math.sin(a.walk * 1.3)) * .04;
  for (const a of [player, ...helpers]) for (let i = 0; i < a.stack.length; i++) {
    if (a.stack[i].land > now) continue;
    const [x, y, z, d] = stackPos(a, i);
    putItem(a.stack[i].t, x, y, z + bob(a), -d - Math.PI / 2);
  }
  for (const c of customers) for (let i = 0; i < c.got; i++) putItem(c.item, c.x + Math.cos(c.dir) * .32, c.y + Math.sin(c.dir) * .32, .78 + i * ITEM[c.item].h, -c.dir - Math.PI / 2);
  for (let i = 0; i < G.stalls; i++) { const st = stallState[i]; for (let k = 0; k < Math.min(st.coins, 160); k++) { const [x, y, z] = coinPos(st, k); putItem('coin', x, y, z, (k * 1.7 % 1) * .3 - .15); } }
  for (const b of B) {
    if (G.placing && G.placing.b === b) continue;
    const k = CATALOG[b.type].kind, f = front(b);
    if (k === 'pen') { const it = ANIMALS[CATALOG[b.type].animal].item; for (let i = 0; i < b.stock; i++) { const [x, y, z] = pilePos(f.x, f.y, i, ITEM[it].h); putItem(it, x, y, z + .1, i * .7); } }
    if (k === 'factory') b.out.forEach((t, i) => { const [x, y, z] = pilePos(f.x, f.y, i, ITEM[t].h); putItem(t, x, y, z + .05, 0); });
  }
  for (const fl of flyers) {
    const k = Math.min(1, fl.age / fl.dur), to = typeof fl.to === 'function' ? fl.to() : fl.to;
    putItem(fl.t, fl.from[0] + (to[0] - fl.from[0]) * k, fl.from[1] + (to[1] - fl.from[1]) * k, fl.from[2] + (to[2] - fl.from[2]) * k + Math.sin(k * Math.PI) * .9, (to[3] ?? 0) * k);
  }
  flushItems();

  // dust puffs from running feet
  puffT -= 1 / 60;
  for (const a of [player, ...helpers]) if (Math.hypot(a.vx, a.vy) > 1.6 && puffT <= 0 && puffs.length < 80) puffs.push({ x: a.x - Math.cos(a.dir) * .2 + (Math.random() - .5) * .2, y: a.y - Math.sin(a.dir) * .2, t: now });
  if (puffT <= 0) puffT = .07;
  while (puffs.length && now - puffs[0].t > .5) puffs.shift();
  puffs.forEach((p, i) => { const k = (now - p.t) / .5; _o.position.set(p.x, .08 + k * .25, p.y); _o.rotation.set(0, 0, 0); _o.scale.setScalar((.5 + k * 1.1) * (1 - k * k)); _o.updateMatrix(); dust.setMatrixAt(i, _o.matrix); });
  dust.count = puffs.length; dust.instanceMatrix.needsUpdate = true; _o.scale.setScalar(1);
  windTime.value = now; clouds.offset.set(now * .006, now * .003);
  if (LITE) {
    const L = STATIC_BLOBS.slice();
    for (const b of B) { const c = CATALOG[b.type], m = center(b); if (c.kind !== 'field') L.push([m.x, m.y + .1, c.w * .55, c.h * .5]); }
    for (let i = 0; i < G.stalls; i++) L.push([stallState[i].x, 19.12, 1.45, .7]);
    for (const a of [player, ...helpers, ...customers]) L.push([a.x, a.y, .42, .42]);
    for (const b of B) if (b.animals) for (const c of b.animals) L.push([c.x, c.y, b.type === 'cowshed' ? .7 : .28, b.type === 'cowshed' ? .5 : .28]);
    drawBlobs(L);
  }

  // particles
  let nc = 0, nsm = 0;
  for (const p of parts) {
    if (p.c === 'smoke') {
      if (nsm >= 160) continue;
      const sc = .6 + (1.2 - p.life) * 1.2;
      _o.position.set(p.x, p.z, p.y); _o.rotation.set(0, 0, 0); _o.scale.setScalar(sc); _o.updateMatrix(); smoke.setMatrixAt(nsm++, _o.matrix);
    } else {
      if (nc >= 300) continue;
      _o.position.set(p.x, p.z + .05, p.y); _o.rotation.set(p.life * 9, p.life * 7, 0); _o.scale.setScalar(1); _o.updateMatrix();
      confetti.setMatrixAt(nc, _o.matrix); confetti.setColorAt(nc++, _c.set(p.c));
    }
  }
  _o.scale.setScalar(1);
  confetti.count = nc; smoke.count = nsm;
  confetti.instanceMatrix.needsUpdate = true; if (confetti.instanceColor) confetti.instanceColor.needsUpdate = true;
  smoke.instanceMatrix.needsUpdate = true;
  firstSync = false;
}
let firstSync = true;

// ---------- overlay (bubbles, texts, HUD) ----------
function itemIcon(t, x, y, s, g = o) { // flat item icons for bubbles and cards
  g.save(); g.translate(x, y); g.scale(s, s); g.lineWidth = .04;
  const el = (cx, cy, rx, ry, c, rot = 0) => { g.beginPath(); g.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2); g.fillStyle = c; g.fill(); };
  const poly = (pts, c) => { g.beginPath(); pts.forEach(([px, py], i) => i ? g.lineTo(px, py) : g.moveTo(px, py)); g.closePath(); g.fillStyle = c; g.fill(); };
  if (t === 'egg') { el(0, .02, .26, .33, '#fff8ec'); el(-.08, -.1, .06, .1, '#ffffff'); }
  else if (t === 'pie' || t === 'pumpkinPie') {
    el(0, .1, .4, .18, '#c27b33'); el(0, .02, .38, .16, t === 'pie' ? '#e2484f' : '#f08a2a');
    g.strokeStyle = '#f2c27a'; g.lineWidth = .05; g.beginPath(); g.moveTo(-.25, .0); g.lineTo(.25, .04); g.moveTo(-.1, -.1); g.lineTo(.05, .14); g.stroke();
  } else if (t === 'wheat') {
    g.strokeStyle = '#c99a2e'; g.lineWidth = .06; for (const a of [-.3, 0, .3]) { g.beginPath(); g.moveTo(0, .38); g.lineTo(Math.sin(a) * .45, -.1); g.stroke(); }
    for (const a of [-.3, 0, .3]) for (let k = 0; k < 3; k++) el(Math.sin(a) * (.42 + k * .09), -.1 - k * .11, .06, .09, '#f0cf5a', a);
  } else if (t === 'carrot') {
    poly([[-.1, -.12], [.1, -.12], [0, .4]], '#f07a24');
    for (const a of [-.4, 0, .4]) el(Math.sin(a) * .12, -.25, .06, .16, '#4fae3a', a);
  } else if (t === 'corn') {
    el(0, .05, .14, .3, '#f5cf3a'); poly([[-.18, .38], [-.05, -.1], [-.02, .38]], '#7cc44f'); poly([[.18, .38], [.05, -.1], [.02, .38]], '#6cb83f');
  } else if (t === 'strawberry') {
    g.beginPath(); g.moveTo(-.26, -.12); g.quadraticCurveTo(-.3, .2, 0, .38); g.quadraticCurveTo(.3, .2, .26, -.12); g.closePath(); g.fillStyle = '#e5333f'; g.fill();
    for (const [dx, dy] of [[-.1, .02], [.1, .04], [0, .18], [-.06, -.06], [.08, -.08]]) el(dx, dy, .025, .035, '#ffe08a');
    poly([[-.24, -.12], [0, -.3], [.24, -.12], [0, -.06]], '#4fae3a');
  } else if (t === 'flour') {
    g.beginPath(); g.moveTo(-.14, -.26); g.quadraticCurveTo(-.36, 0, -.28, .34); g.lineTo(.28, .34); g.quadraticCurveTo(.36, 0, .14, -.26); g.closePath(); g.fillStyle = '#f4ecdc'; g.fill();
    g.fillStyle = '#c27b33'; g.fillRect(-.16, -.34, .32, .08);
  } else if (t === 'bread') {
    el(0, .05, .42, .24, '#cf8a3e'); g.strokeStyle = '#f2c27a'; g.lineWidth = .05;
    for (const dx of [-.18, 0, .18]) { g.beginPath(); g.moveTo(dx - .06, -.1); g.lineTo(dx + .06, .12); g.stroke(); }
  } else if (t === 'pumpkin') {
    for (const dx of [-.18, .18, 0]) el(dx, .08, .2, .26, dx ? '#e07a22' : '#f08a2a');
    g.fillStyle = '#6b8a2a'; g.fillRect(-.04, -.28, .08, .14);
  } else if (t === 'milk') {
    poly([[-.16, .38], [-.16, -.02], [-.08, -.16], [-.08, -.28], [.08, -.28], [.08, -.16], [.16, -.02], [.16, .38]], '#ffffff');
    g.fillStyle = '#3c8fd9'; g.fillRect(-.09, -.36, .18, .1); g.fillStyle = '#7cc0f5'; g.fillRect(-.16, .1, .32, .1);
  } else if (t === 'cream') {
    rr(g, -.2, -.12, .4, .48, .06); g.fillStyle = '#fbf6ec'; g.fill(); rr(g, -.23, -.24, .46, .14, .04); g.fillStyle = '#ff9cc4'; g.fill();
  } else if (t === 'juice') {
    poly([[-.16, .38], [-.16, -.02], [-.08, -.14], [-.08, -.26], [.08, -.26], [.08, -.14], [.16, -.02], [.16, .38]], '#ff9a2a');
    g.fillStyle = '#2fa84f'; g.fillRect(-.09, -.34, .18, .09); g.fillStyle = '#ffd08a'; g.fillRect(-.16, .1, .32, .12);
  } else if (t === 'cheese') {
    poly([[-.4, .26], [.4, .26], [.4, -.04], [-.4, -.26]], '#f5c842');
    el(-.12, .08, .07, .06, '#d9a520'); el(.18, .12, .06, .05, '#d9a520');
  } else if (t === 'cake') {
    rr(g, -.36, .04, .72, .3, .06); g.fillStyle = '#fff2e6'; g.fill(); g.fillStyle = '#ff9cc4'; g.fillRect(-.36, .04, .72, .07);
    rr(g, -.24, -.2, .48, .26, .06); g.fillStyle = '#ffd6e6'; g.fill(); el(0, -.28, .07, .07, '#e0303a');
  } else if (t === 'coin') { cashIcon(g, 0, 0, 1.6); }
  g.restore();
}
// icons for the DOM cards: item pictures, or a white building silhouette on a green tile
const iconCache = new Map();
window.iconURL = (kind) => {
  if (iconCache.has(kind)) return iconCache.get(kind);
  const c = document.createElement('canvas'); c.width = c.height = 96; const g = c.getContext('2d');
  if (ITEM[kind]) { g.shadowColor = 'rgba(70,45,20,.55)'; g.shadowBlur = 5; g.shadowOffsetY = 2; itemIcon(kind, 48, 50, 92, g); }
  else { rr(g, 4, 4, 88, 88, 22); g.fillStyle = '#6cc04a'; g.fill(); padIcon(g, kind, 48, 50, 70); }
  const u = c.toDataURL(); iconCache.set(kind, u); return u;
};
function text(t, x, y, size, fill = '#fff', stroke = '#1d3557', sw = size * .22, align = 'center') {
  o.font = `900 ${size}px ${FONT}`; o.textAlign = align; o.textBaseline = 'middle'; o.lineJoin = 'round';
  o.lineWidth = sw; o.strokeStyle = stroke; if (sw) o.strokeText(t, x, y); o.fillStyle = fill; o.fillText(t, x, y);
}
function star(cx, cy, r, fill) {
  o.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? r * .45 : r; o.lineTo(cx + Math.cos(a) * q, cy + Math.sin(a) * q); }
  o.closePath(); o.fillStyle = fill; o.fill();
}
function bar(x, y, w, h, f, col, bg = 'rgba(0,0,0,.35)') {
  rr(o, x - w / 2, y, w, h, h / 2); o.fillStyle = bg; o.fill();
  if (f > 0) { rr(o, x - w / 2, y, Math.max(h, w * Math.min(1, f)), h, h / 2); o.fillStyle = col; o.fill(); }
}
// a white bubble with an item and a number
function bubble(x, y, item, label, U) {
  o.font = `900 ${Math.round(U * .3)}px ${FONT}`;
  const tw = label ? o.measureText(label).width + U * .12 : 0, w = U * .62 + tw, h = U * .58;
  rr(o, x - w / 2, y - h, w, h, h / 2); o.fillStyle = 'rgba(255,255,255,.95)'; o.fill();
  o.beginPath(); o.moveTo(x - U * .08, y - 1); o.lineTo(x + U * .08, y - 1); o.lineTo(x, y + U * .1); o.fill();
  itemIcon(item, x - w / 2 + U * .3, y - h / 2, U * .46);
  if (label) text(label, x - w / 2 + U * .58 + tw / 2, y - h / 2 + 1, Math.round(U * .3), '#3b3a36', 'rgba(0,0,0,0)', 0);
}
function overlay(U) {
  o.clearRect(0, 0, W, H);
  const s = wall(), onScreen = (x, y) => x > -80 && x < W + 80 && y > -80 && y < H + 80;
  // building bubbles: what is ready to collect, what is cooking
  if (!G.placing) for (const b of B) {
    const k = CATALOG[b.type].kind, c = center(b);
    if (k === 'factory') {
      const [bx, by] = proj(c.x, c.y, 3.3); if (!onScreen(bx, by)) continue;
      if (b.out.length) bubble(bx, by, b.out.at(-1), '×' + b.out.length, U);
      else if (b.queue.length) {
        const j = b.queue[0], r = RECIPES[b.type][j.r], f = clamp((s - j.start) / (j.end - j.start), 0, 1);
        itemIcon(r.out, bx - U * .45, by - U * .1, U * .4); bar(bx + U * .1, by - U * .17, U * .8, U * .14, f, '#6ad44f');
      }
    } else if (k === 'pen' && b.stock > 0) {
      const f = front(b), [bx, by] = proj(f.x, f.y, 1.4); if (onScreen(bx, by)) bubble(bx, by, ANIMALS[CATALOG[b.type].animal].item, '×' + b.stock, U * .85);
    }
  }
  // what the heroine stands at: name and timer
  const nb = G.near;
  if (nb && !G.placing) {
    const k = CATALOG[nb.type].kind, c = k === 'field' ? center(nb) : front(nb);
    let label = null;
    if (k === 'field') label = nb.crop ? (fieldState(nb, s) === 'ripe' ? ITEM[nb.crop].name + ': созрело' : ITEM[nb.crop].name + ': ' + fmtTime(timeLeft(nb, s))) : 'Пустая грядка';
    else if (k === 'barn') label = `Амбар ${barnUsed()}/${G.barnCap}`;
    else if (k === 'factory') label = CATALOG[nb.type].name + (nb.queue.length ? ' · ' + fmtTime(timeLeft(nb, s)) : ' · свободна');
    else if (k === 'pen') label = CATALOG[nb.type].name + (nb.stock < penCap(nb) ? ' · ' + fmtTime(timeLeft(nb, s)) : ' · полно');
    if (label) {
      const [lx, ly] = proj(c.x, c.y, k === 'field' ? 1.3 : 2.2);
      o.font = `900 15px ${FONT}`; const lw = o.measureText(label).width + 22;
      rr(o, lx - lw / 2, ly - 15, lw, 30, 15); o.fillStyle = 'rgba(25,30,45,.66)'; o.fill();
      text(label, lx, ly, 15, '#fff', 'rgba(0,0,0,0)', 0);
    }
  }
  // customers: what they want
  for (const c of customers) {
    if (c.state === 'in' && c.entered) {
      const st = stallState[c.stall], f = clamp(c.pat / c.patMax, 0, 1);
      const [sx, sy] = proj(c.x, c.y, 2.05);
      if (!onScreen(sx, sy)) continue;
      if (st.queue[0] === c) {
        const w = U * 1.05, h = U * .62;
        rr(o, sx - w / 2, sy - h, w, h, U * .16); o.fillStyle = 'rgba(25,25,30,.88)'; o.fill();
        o.beginPath(); o.moveTo(sx - U * .1, sy - 1); o.lineTo(sx + U * .1, sy - 1); o.lineTo(sx, sy + U * .12); o.fill();
        itemIcon(c.item, sx - U * .2, sy - h / 2, U * .5);
        text(String(c.want - c.got), sx + U * .28, sy - h / 2, U * .34, have(c.item) ? '#fff' : '#ff8a7a', 'rgba(0,0,0,0)', 0);
        bar(sx, sy - h - 11, w * .8, 7, f, f > .5 ? '#6ad44f' : f > .25 ? '#f4b52c' : '#ec4a3c');
      } else bar(sx, sy - 4, U * .55, 7, f, f > .5 ? '#6ad44f' : f > .25 ? '#f4b52c' : '#ec4a3c');
    } else if (c.state === 'out' && now - c.moodT < 1.6) {
      const t = now - c.moodT, [sx, sy] = proj(c.x, c.y, 1.7 + t * .4);
      o.globalAlpha = 1 - t / 1.6;
      if (c.happy) {
        const q = U * .17; o.fillStyle = '#ff4f73'; o.beginPath();
        o.moveTo(sx, sy + q); o.bezierCurveTo(sx - q * 2, sy - q * .3, sx - q * .8, sy - q * 1.6, sx, sy - q * .5);
        o.bezierCurveTo(sx + q * .8, sy - q * 1.6, sx + q * 2, sy - q * .3, sx, sy + q); o.fill();
      } else text('!!', sx, sy, U * .4, '#ff6b5a', '#fff', U * .08);
      o.globalAlpha = 1;
    }
  }
  if (player.stack.length >= player.cap) {
    const [x, y, z] = stackPos(player, player.stack.length), [sx, sy] = proj(x, y, z + .25);
    text('МАКС', sx, sy, U * .38, '#ff4d3d', '#ffffff', U * .1);
  }
  for (const f of floats) {
    const [sx, sy] = proj(f.x, f.y, f.z + f.t * .9);
    o.globalAlpha = 1 - Math.max(0, f.t - .6) / .5;
    text(f.text, sx, sy, U * .36, f.color, '#1d3557', U * .1);
    o.globalAlpha = 1;
  }
  // tutorial arrow for the first steps
  const h = hintTarget();
  if (h && !G.placing) {
    const [tx, ty] = proj(h.x, h.y, 1.6 + Math.abs(Math.sin(now * 4)) * .35);
    o.beginPath(); o.moveTo(tx - U * .28, ty - U * .42); o.lineTo(tx + U * .28, ty - U * .42); o.lineTo(tx, ty); o.closePath();
    o.fillStyle = '#ffd23f'; o.fill(); o.lineWidth = 3; o.strokeStyle = '#c88a00'; o.stroke();
    const d = Math.hypot(h.x - player.x, h.y - player.y);
    if (d > 1.6) {
      const ux = (h.x - player.x) / d, uy = (h.y - player.y) / d;
      const tip = proj(player.x + ux * 1.25, player.y + uy * 1.25), base = proj(player.x + ux * .65, player.y + uy * .65);
      const l = proj(player.x + ux * .65 - uy * .32, player.y + uy * .65 + ux * .32), r = proj(player.x + ux * .65 + uy * .32, player.y + uy * .65 - ux * .32);
      o.beginPath(); o.moveTo(...tip); o.lineTo(...l); o.lineTo(...base); o.lineTo(...r); o.closePath();
      o.fillStyle = 'rgba(110,235,245,.85)'; o.fill(); o.lineWidth = 2; o.strokeStyle = '#ffffff'; o.stroke();
    }
  }
  if (G.placing) return;
  // HUD: money, level and xp
  const top = 14;
  o.font = `900 24px ${FONT}`;
  const coinsTxt = fmtN(G.coins), cw = o.measureText(coinsTxt).width;
  rr(o, 12, top, cw + 66, 42, 21); o.fillStyle = 'rgba(0,0,0,.32)'; o.fill();
  cashIcon(o, 37, top + 21, 66);
  text(coinsTxt, 62, top + 22, 24, '#fff', 'rgba(0,0,0,0)', 0, 'left');
  const lx = 12, ly = top + 50, xf = (G.xp - xpFor(G.lvl)) / Math.max(1, xpFor(G.lvl + 1) - xpFor(G.lvl));
  rr(o, lx, ly, 118, 30, 15); o.fillStyle = 'rgba(0,0,0,.32)'; o.fill();
  star(lx + 16, ly + 15, 12, '#ffd23f'); text(String(G.lvl), lx + 16, ly + 16, 12, '#7a4b00', 'rgba(0,0,0,0)', 0);
  bar(lx + 74, ly + 11, 78, 9, xf, '#7ed0ff', 'rgba(255,255,255,.25)');
  // the current task
  const t = curTask();
  if (t) {
    const label = `${t.text}  ${Math.min(G.taskN, t.n)}/${t.n}`;
    // between the money on the left and the pause button on the right; the font shrinks to fit
    const x0 = cw + 88, x1 = W - 66, room = x1 - x0;
    o.font = `900 15px ${FONT}`;
    const fs = clamp(Math.floor(15 * (room - 24) / o.measureText(label).width), 11, 15);
    o.font = `900 ${fs}px ${FONT}`;
    const tw = Math.min(room, o.measureText(label).width + 26), tx = x0 + (room - tw) / 2;
    rr(o, tx, top, tw, 42, 21); o.fillStyle = 'rgba(25,30,45,.6)'; o.fill();
    o.save(); rr(o, tx, top, tw, 42, 21); o.clip();
    o.fillStyle = 'rgba(76,187,69,.55)'; o.fillRect(tx, top + 36, tw * Math.min(1, G.taskN / t.n), 6);
    text(label, tx + tw / 2, top + 20, fs, '#fff', 'rgba(0,0,0,0)', 0);
    o.restore();
  }
  // customer rating — small, bottom left
  const by = H - 26 - 8;
  for (let i = 0; i < 5; i++) {
    const sx = 18 + i * 20;
    star(sx, by, 8, 'rgba(0,0,0,.25)');
    const fl = clamp(G.rep - i, 0, 1);
    if (fl > 0) { o.save(); o.beginPath(); o.rect(sx - 8, by - 8, 16 * fl, 16); o.clip(); star(sx, by, 8, '#ffd23f'); o.restore(); }
  }
  if (!moved && G.task === 0) text('ВЕДИ ПАЛЬЦЕМ', W / 2, H * .66, Math.min(36, W * .085), '#ffffff', '#1d3557', 7);
  if (joy) {
    o.beginPath(); o.arc(joy.ox, joy.oy, JOY_R, 0, Math.PI * 2); o.fillStyle = 'rgba(255,255,255,.22)'; o.fill();
    o.lineWidth = 4; o.strokeStyle = 'rgba(255,255,255,.75)'; o.stroke();
    let dx = joy.x - joy.ox, dy = joy.y - joy.oy; const l = Math.hypot(dx, dy), R = JOY_R;
    if (l > R) { dx = dx / l * R; dy = dy / l * R; }
    o.beginPath(); o.arc(joy.ox + dx, joy.oy + dy, 30, 0, Math.PI * 2); o.fillStyle = 'rgba(255,255,255,.9)'; o.fill();
  }
}
// where the arrow points during the first story steps
function hintTarget() {
  if (G.task > 4) return null;
  const t = curTask(), s = wall();
  if (t.ev === 'harvest' || (t.ev === 'plant')) {
    const want = t.ev === 'harvest' ? 'ripe' : 'empty', f = B.find(b => b.type === 'field' && fieldState(b, s) === want);
    if (player.stack.length >= player.cap) { const barn = B.find(b => b.type === 'barn'); return front(barn); }
    return f && G.near !== f ? center(f) : null;
  }
  if (t.ev === 'store') { const barn = B.find(b => b.type === 'barn'); return player.stack.length ? front(barn) : null; }
  if (t.ev === 'sell') { const st = stallState[0]; return near(player, st.counter.x, st.counter.y, 1) ? null : st.counter; }
  if (t.ev === 'collect') { const p = B.find(b => b.type === 'coop'); return p && G.near !== p ? front(p) : null; }
  return null;
}

const perf = { upd: 0, sync: 0, draw: 0, calls: 0, tris: 0 };
const ema = (k, v) => { perf[k] += (v - perf[k]) * .1; };
function render(dt = 0) {
  let t0 = performance.now();
  sync();
  ema('sync', performance.now() - t0); t0 = performance.now();
  for (const m of mixers) m.update(dt);
  for (const p of people.values()) if (p.head) p.head.scale.setScalar(HEAD_SCALE);
  if (useFx) composer.render(dt); else renderer.render(scene, camera);
  ema('draw', performance.now() - t0); perf.calls = renderer.info.render.calls; perf.tris = renderer.info.render.triangles;
  const a = proj(camX, camY), b = proj(camX + 1, camY);
  overlay(Math.hypot(b[0] - a[0], b[1] - a[1]));
}

// ---------- loop ----------
load();
let last = performance.now();
// automatic quality: while the game runs slowly, step down: AO off -> lower resolution -> smaller shadows -> lowest resolution
let perfT = 0, perfN = 0, perfStage = QUALITY ? 9 : 0, fpsEma = 60;
function lowerQuality() {
  if (useFx) { useFx = false; return true; }
  if (DPR > 1.25) { DPR = 1.25; renderer.setPixelRatio(DPR); resize(); return true; }
  if (sun.shadow.mapSize.x > 1024) { sun.shadow.mapSize.set(1024, 1024); sun.shadow.map?.dispose(); sun.shadow.map = null; return true; }
  if (DPR > 1) { DPR = 1; renderer.setPixelRatio(DPR); resize(); return true; }
  return false;
}
function watchPerf(raw) {
  if (raw > 0 && raw < .5) fpsEma += (1 / raw - fpsEma) * .05;
  window.__fps = fpsEma;
  if (perfStage > 8 || document.hidden) return;
  perfT += raw; perfN++;
  if (perfT < 2) return;
  const fps = perfN / perfT; perfT = 0; perfN = 0;
  if (fps < 45 && lowerQuality()) perfStage++;
  else if (fps >= 45 || perfStage > 3) perfStage = 9;
}
let lastError = null, started = performance.now();
function frame(t) {
  requestAnimationFrame(frame); // first, so one bad frame cannot stop the game
  const raw = (t - last) / 1000;
  const dt = Math.min(.1, raw); last = t; // up to 10 fps the game still runs in real time
  try {
    if (t - started > 1500 && raw < .5) watchPerf(raw);
    const t0 = performance.now(); update(dt); ema('upd', performance.now() - t0);
    render(dt);
    if (DEBUG) { o.font = '12px system-ui'; o.fillStyle = '#000'; o.fillText(`${Math.round(fpsEma)} fps · js ${perf.upd.toFixed(1)}+${perf.sync.toFixed(1)} ms · gl ${perf.draw.toFixed(1)} ms · ${perf.calls} calls · ${Math.round(perf.tris / 1000)}k tris · dpr ${DPR}${useFx ? ' · ao' : ''}`, 8, H - 50); }
  } catch (e) {
    if (!lastError) console.error(e);
    lastError = String(e && e.message || e);
    o.setTransform(1, 0, 0, 1, 0, 0); o.font = '12px system-ui'; o.fillStyle = '#b00020';
    o.fillText('ошибка: ' + lastError.slice(0, 80), 8, ov.height - 12);
    o.setTransform(Math.min(2, devicePixelRatio || 1), 0, 0, Math.min(2, devicePixelRatio || 1), 0, 0);
  }
}
requestAnimationFrame(frame);
window.__game = { G, player, CATALOG, CROPS, RECIPES, ITEM, update, helpers, customers, stallState, render, build, canBuy, canPlace, freeSpot, moveBuilding, plant, enqueue, speedUp, fieldState, save, resetFarm, derive,
  get B() { return B; }, ready: true, scene, gfx: GFX, charOf: (a) => people.get(a), fx: () => useFx, perf: () => ({ ...perf, fps: fpsEma, dpr: DPR }), setCam: (x, y) => { camX = x; camY = y; }, pickAt, groundAt };
document.getElementById('loading')?.remove();
uiInit();
