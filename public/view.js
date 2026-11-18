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
    'cow', 'windmill', 'barn', 'openBarn', 'wheat', 'pumpkin', 'well', 'bench', 'lamp', 'fountain'],
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
// path layout shared by the ground texture and the grass mask
function drawPaths(g, X, Y, P, grow, fill) {
  g.fillStyle = fill; g.strokeStyle = fill; g.lineCap = 'round'; g.lineJoin = 'round';
  const area = (x0, y0, x1, y1, r) => { rr(g, X(x0 - grow), Y(y0 - grow), (x1 - x0 + 2 * grow) * P, (y1 - y0 + 2 * grow) * P, Math.max(0, r + grow) * P); g.fill(); };
  const path = (pts, w) => { g.lineWidth = (w + 2 * grow) * P; g.beginPath(); g.moveTo(X(pts[0][0]), Y(pts[0][1])); for (const [x, y] of pts.slice(1)) g.lineTo(X(x), Y(y)); g.stroke(); };
  area(WORLD.x0 + .6, 16.9, WORLD.x1 - .6, 25.2, 1.2); // market strip
  area(GX0 - 2, 25.4, GX0 + GW + 2, 27.6, 0);          // customers' road
  path([[10, 17.5], [10, 8.4]], 1.5);                  // yard
  path([[-11, 8.3], [12.8, 8.3]], 1.5);                // yard -> field
  path([[-5.2, 8.3], [-5.2, 17.5]], 1.4);
  path([[12.4, 8.3], [12.4, -5.6]], 1.3);              // yard -> garden
  path([[2.4, -5.6], [17.4, -5.6]], 1.4);
  path([[10, 10.9], [36, 10.9]], 1.3);                 // yard -> pasture
  path([[27, 10.9], [27, 17.5]], 1.3);
  path([[36, 8], [36, 17.5]], 1.3);
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
  for (let i = 0; i < 900; i++) { // soft large-scale colour variation
    const x = srnd() * c.width, y = srnd() * c.height, r = (1.5 + srnd() * 4) * PPU;
    const col = srnd() < .55 ? '150,225,95' : '70,160,45';
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${col},.32)`); gr.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  // tilled soil under the crops
  const soil = (x0, y0, x1, y1) => { rr(g, X(x0), Y(y0), (x1 - x0) * PPU, (y1 - y0) * PPU, .6 * PPU); g.fillStyle = 'rgba(120,80,40,.28)'; g.fill(); };
  soil(-19.4, 1, -10, 7.7); soil(1.6, -14.8, 8.7, -7.7);
  // soft-edged dirt paths: darker grass rim, warm edge, main dirt, lighter centre
  for (const [grow, col] of [[.75, 'rgba(60,110,35,.10)'], [.5, 'rgba(60,110,35,.12)'], [.22, '#d9834a'], [.1, '#e69456'], [0, '#ee9f60'], [-.35, '#f2a96b']]) drawPaths(g, X, Y, PPU, grow, col);
  for (let i = 0; i < 4500; i++) { // pebbles on dirt
    const x = GX0 + srnd() * GW, y = GY0 + srnd() * GH;
    if (!pathMask(x, y)) continue;
    g.fillStyle = srnd() < .5 ? 'rgba(200,120,70,.55)' : 'rgba(255,214,170,.6)';
    g.beginPath(); g.ellipse(X(x), Y(y), (.03 + srnd() * .05) * PPU, (.02 + srnd() * .03) * PPU, srnd() * 3, 0, Math.PI * 2); g.fill();
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GW, GH), newMat({ map: canvasTex(c), roughness: 1, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(GX0 + GW / 2, 0, GY0 + GH / 2); ground.receiveShadow = true;
  scene.add(ground);
}
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
const NO_GRASS = [];
function grassFree(x, y) {
  if (pathMask(x, y)) return false;
  for (const [x0, y0, x1, y1] of NO_GRASS) if (x > x0 && x < x1 && y > y0 && y < y1) return false;
  return true;
}
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
const padDecals = new Map();
function drawPadDecal(p) {
  let d = padDecals.get(p);
  if (!d) { d = decal(1.8, 2.25, p.x, p.y - .22); padDecals.set(p, d); }
  const left = p.cost - padPaid(p), on = p.stand > 0;
  const key = left + '|' + on;
  if (d.key !== key) {
    d.key = key;
    const { g, s } = d; g.clearRect(0, 0, d.c.width, d.c.height);
    const x0 = .12 * s, y0 = .56 * s, w = 1.56 * s, prog = padPaid(p) / p.cost;
    const land = p.kind === 'land';
    rr(g, x0, y0, w, w, .26 * s); g.fillStyle = land ? 'rgba(255,214,90,.6)' : 'rgba(190,240,150,.55)'; g.fill();
    if (prog > 0) { g.save(); rr(g, x0, y0, w, w, .26 * s); g.clip(); g.fillStyle = land ? 'rgba(245,170,40,.85)' : 'rgba(110,215,70,.8)'; g.fillRect(x0, y0 + w * (1 - prog), w, w * prog); g.restore(); }
    g.lineWidth = (on ? .12 : .09) * s; g.strokeStyle = '#fff'; rr(g, x0, y0, w, w, .26 * s); g.stroke();
    padIcon(g, p.icon, x0 + w / 2, y0 + .58 * s, .95 * s);
    const txt = fmtN(left);
    g.font = `900 ${.4 * s}px ${FONT}`;
    const tw = g.measureText(txt).width;
    cashIcon(g, x0 + w / 2 - tw / 2 - .12 * s, y0 + 1.22 * s, s);
    outlinedText(g, txt, x0 + w / 2 + .18 * s, y0 + 1.22 * s, .4 * s, '#fff', '#2f6b28', .1 * s);
    g.font = `900 ${.27 * s}px ${FONT}`;
    const fit = Math.min(.27 * s, .27 * s * 1.7 * s / Math.max(1, g.measureText(p.label).width));
    outlinedText(g, p.label, .9 * s, .27 * s, fit, '#fff', '#2f6b28', .08 * s);
    d.tex.needsUpdate = true;
  }
  d.m.visible = true;
  const sc = on ? 1.04 : 1; d.m.scale.set(sc, sc, 1);
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
function itemMesh(geo, m = BAKED_MAT) {
  const im = new THREE.InstancedMesh(geo, m, MAXI);
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
const ITEMS = {
  egg: itemMesh(coloredGeo([[new THREE.SphereGeometry(.13, 18, 14).scale(1.08, 1.0, 1.0).translate(0, .13, 0), '#fffaf0']])),
  wood: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.11, .11, .66, 14, 1, true).rotateZ(Math.PI / 2).translate(0, .11, 0), '#a8672f'],
    [new THREE.CircleGeometry(.11, 14).rotateY(Math.PI / 2).translate(.33, .11, 0), '#efc58c'], [new THREE.CircleGeometry(.11, 14).rotateY(-Math.PI / 2).translate(-.33, .11, 0), '#efc58c']])),
  pie: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.24, .27, .1, 22).translate(0, .05, 0), '#c27b33'], [new THREE.CylinderGeometry(.22, .24, .05, 22).translate(0, .11, 0), '#f2bb5c']])),
  wheat: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.1, .08, .5, 10).rotateZ(Math.PI / 2).translate(-.06, .1, 0), '#d9b23a'],
    [new THREE.SphereGeometry(.12, 10, 8).scale(1.4, .9, 1).translate(.22, .1, 0), '#f0cf5a'], [new THREE.TorusGeometry(.1, .025, 6, 12).rotateY(Math.PI / 2).translate(.02, .1, 0), '#a86d2a']])),
  flour: itemMesh(coloredGeo([[SACK_GEO.clone().scale(.38, .34, .38), '#f4ecdc'], [new THREE.TorusGeometry(.045, .012, 6, 12).rotateX(Math.PI / 2).translate(0, .26, 0), '#c27b33']])),
  pumpkin: itemMesh(coloredGeo([[new THREE.SphereGeometry(.2, 16, 12).scale(1, .78, 1).translate(0, .16, 0), '#f08a2a'], [new THREE.CylinderGeometry(.03, .04, .1, 8).translate(0, .34, 0), '#6b8a2a']])),
  milk: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.1, .1, .22, 14).translate(0, .11, 0), '#fbfbf6'], [new THREE.CylinderGeometry(.05, .1, .07, 14).translate(0, .255, 0), '#fbfbf6'],
    [new THREE.CylinderGeometry(.055, .055, .05, 12).translate(0, .31, 0), '#3c8fd9'], [new THREE.CylinderGeometry(.102, .102, .06, 14).translate(0, .12, 0), '#7cc0f5']])),
  cheese: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.22, .22, .15, 20).translate(0, .075, 0), '#f5c842'], [new THREE.CylinderGeometry(.205, .205, .152, 20, 1, true).translate(0, .075, 0), '#f5c842']])),
  cake: itemMesh(coloredGeo([[new THREE.CylinderGeometry(.24, .24, .13, 22).translate(0, .065, 0), '#fff2e6'], [new THREE.CylinderGeometry(.245, .245, .03, 22).translate(0, .12, 0), '#ff9cc4'],
    [new THREE.CylinderGeometry(.16, .16, .1, 20).translate(0, .18, 0), '#ffd6e6'], [new THREE.SphereGeometry(.045, 10, 8).translate(0, .26, 0), '#e0303a']])),
  coin: itemMesh(new THREE.BoxGeometry(.46, .045, .25).translate(0, .023, 0),
    [mat('#2f8c2c'), mat('#2f8c2c'), new THREE.MeshLambertMaterial({ map: noteTex }), mat('#2f8c2c'), mat('#2f8c2c'), mat('#2f8c2c')]),
};
const _o = new THREE.Object3D();
const lists = Object.fromEntries(Object.keys(ITEMS).map(k => [k, []]));
function putItem(t, x, y, z, rot = 0) { lists[t].push(x, y, z, rot); }
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

// ---------- static & purchasable buildings ----------
// Every purchasable thing gets a group that is hidden until it is built and pops in when it appears.
const shown = new Map(); // id -> [objects]
function owns(id, ...objs) { if (!shown.has(id)) shown.set(id, []); shown.get(id).push(...objs); }
function fenceRun(x0, y0, x1, y1, parent, h = .62) {
  const f = A.fence2, segLen = f.size.x * (h / f.size.y);
  const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(len / segLen)), ang = Math.atan2(y1 - y0, x1 - x0);
  for (let i = 0; i < n; i++) {
    const t = (i + .5) / n;
    const w = model('fence2', h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, -ang, parent);
    w.scale.x = len / n / segLen;
  }
}
// pens: fence with a gate in the south side, a house in the corner and a pile spot in front of the gate
for (const p of penList) {
  const g = group();
  const [x0, y0, x1, y1] = p.fence, [ga, gb] = p.gate;
  fenceRun(x0, y0, x1, y0, g); fenceRun(x0, y0, x0, y1, g); fenceRun(x1, y0, x1, y1, g); fenceRun(x0, y1, ga, y1, g); fenceRun(gb, y1, x1, y1, g);
  if (p.id === 'coop') model('coop', 1.9, p.house.x, p.house.y, 0, g);
  else model('openBarn', 2.4, p.house.x, p.house.y, 0, g);
  bakeMerge(g);
  NO_GRASS.push([x0 - .2, y0 - .2, x1 + .2, y1 + .3]);
  if (LITE) STATIC_BLOBS.push([p.house.x, p.house.y + .1, 1.3, 1]);
  // pile spot: nest of straw for eggs, a trough for milk
  const pg = group(p.pile.x, p.pile.y);
  if (p.item === 'egg') { mesh(new THREE.CylinderGeometry(.7, .78, .1, 24), '#e3c06c', 0, .05, 0, pg); mesh(new THREE.TorusGeometry(.66, .1, 8, 24).rotateX(Math.PI / 2), '#d1a854', 0, .1, 0, pg); }
  else { rbox(pg, 1.5, .1, 1.0, '#9b6a3a', 0, .05, 0, .03); for (const [w, d, x, z] of [[1.5, .08, 0, -.48], [1.5, .08, 0, .48], [.08, 1, -.72, 0], [.08, 1, .72, 0]]) rbox(pg, w, .16, d, '#b9824a', x, .08, z, .02); }
  bakeMerge(pg);
  NO_GRASS.push([p.pile.x - 1, p.pile.y - 1, p.pile.x + 1, p.pile.y + 1]);
  if (p.id !== 'coop') owns(p.id, g, pg);
}
// plants: trees (crown, stump and sapling), wheat and pumpkin patches
const TREE_GREENS = ['#46b83a', '#55c642', '#3fae35', '#5ccf47'];
const plantMeshes = new Map();
plants.forEach((t, i) => {
  if (t.group === 'grove') {
    const g = group(t.x, t.y);
    const crown = new THREE.Group(); g.add(crown);
    const green = TREE_GREENS[i % TREE_GREENS.length];
    model('tree3', 2.3 + (i % 3) * .25, 0, 0, i * 1.3, crown, { Green: green, Brown: '#8b5a2b' });
    const stump = new THREE.Group(); g.add(stump);
    model('stump', .42, 0, 0, i, stump, { Green: '#7fce4a' });
    const sapling = model('tree1', .9, 0, 0, i, stump, { Green: green });
    bakeMerge(crown); bakeMerge(stump, m => m === sapling); bakeMerge(sapling);
    plantMeshes.set(t, { g, crown, stump, sapling });
  } else {
    NO_GRASS.push([t.x - .8, t.y - .7, t.x + .8, t.y + .7]);
  }
});
// crops are instanced: a soil bed per patch, wheat stalks or a pumpkin on top
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
  const im = new THREE.InstancedMesh(mergeGeometries(geos), BAKED_MAT, n);
  im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; im.count = 0; scene.add(im);
  return im;
}
const wheatIM = dynInstanced('wheat', 30 * 7, .95, { Yellow: '#e8c050' });
const pumpkinIM = dynInstanced('pumpkin', 16, .55, { Orange: '#f08a2a', Brown: '#6b8a2a' });
const sproutIM = itemMesh(coloredGeo([[new THREE.ConeGeometry(.05, .3, 5).translate(0, .15, 0), '#6cc43d']]), BAKED_MAT);
const bedIM = itemMesh(coloredGeo([[new RoundedBoxGeometry(1.25, .12, .95, 2, .05).translate(0, .03, 0), '#9a6436']]), BAKED_MAT);
const leafIM = itemMesh(coloredGeo([[new THREE.SphereGeometry(.2, 8, 6).scale(1.3, .35, 1).translate(.22, .06, .1), '#4fae3a'], [new THREE.SphereGeometry(.18, 8, 6).scale(1.3, .35, 1).translate(-.2, .05, -.12), '#5cbb44']]), BAKED_MAT);
const STALKS = [[-.38, -.22], [0, -.26], [.38, -.22], [-.2, .12], [.2, .12], [-.42, .26], [.4, .28]];

// converters
function zoneLabel(c, which) {
  if (which === 'out') return ITEM[c.out].name.toUpperCase();
  return { oven: 'В ПЕЧЬ', mill: 'НА ПОМОЛ', dairy: 'МОЛОКО', sweets: 'В ТЕСТО' }[c.id];
}
const convMeshes = new Map();
for (const c of convList) {
  const g = group(c.x, c.y);
  let mouth = null;
  if (c.id === 'oven') {
    box(g, 2.0, 1.0, 1.6, '#cf7a52', 0, .5, 0);
    box(g, 2.06, .1, 1.66, '#b8643f', 0, 1.0, 0);
    mesh(new THREE.SphereGeometry(.78, 22, 14, 0, Math.PI * 2, 0, Math.PI / 2), '#d98a62', 0, 1.0, 0, g).scale.set(1, .8, .9);
    box(g, .3, .9, .3, '#8c4a33', .55, 1.4, -.3);
    mouth = mesh(new THREE.CircleGeometry(.36, 20, 0, Math.PI), new THREE.MeshLambertMaterial({ color: '#3a2620', emissive: '#000000' }), 0, .12, .81, g);
    box(g, .72, .12, .02, '#3a2620', 0, .06, .81);
    const d = group(-c.x, -c.y, g); model('crate', .5, 8.0, 5.0, .4, d); model('crate', .42, 7.8, 5.6, 1.1, d); sack(12.0, 5.2, .7, -.3, d);
  } else if (c.id === 'mill') {
    model('windmill', 3.8, 0, -.2, 0, g, { Main: '#d9573a', Walls: '#f3ead2' });
    sack(-1.6, .3, .7, .4, g); sack(1.5, .5, .6, 1.2, g);
  } else if (c.id === 'dairy') {
    modelFit('barn', 2.8, 2.4, 0, 0, 0, g, { DarkRed: '#3c7fc0', LightRed: '#5a9ad6' });
    // a big cheese wheel by the door
    mesh(new THREE.CylinderGeometry(.34, .34, .26, 20), '#f5c842', 1.55, .13, .7, g);
  } else if (c.id === 'sweets') {
    rbox(g, 2.4, 1.4, 1.8, '#fff1dc', 0, .7, 0, .08);
    const roof = mesh(new THREE.CylinderGeometry(.01, 1.75, .9, 4, 1).rotateY(Math.PI / 4).scale(1.05, 1, .8), '#ff8fb8', 0, 1.85, 0, g);
    roof.castShadow = true;
    rbox(g, .6, .9, .06, '#a86a3a', -.5, .45, .9, .03);                 // door
    rbox(g, .6, .5, .05, '#9fd8f5', .55, .85, .9, .03);                  // window
    for (let i = 0; i < 6; i++) rbox(g, .4, .12, .5, i % 2 ? '#ffffff' : '#ff6fa0', -1 + i * .4, 1.35, 1.05, .02); // awning
    mesh(new THREE.CylinderGeometry(.3, .3, .2, 18), '#fff2e6', 0, 2.4, 0, g); mesh(new THREE.CylinderGeometry(.2, .2, .16, 18), '#ff9cc4', 0, 2.58, 0, g);
    mesh(new THREE.SphereGeometry(.07, 10, 8), '#e0303a', 0, 2.72, 0, g);
  }
  bakeMerge(g, m => m === mouth);
  const trays = [c.IN, c.OUT].map(z => box(scene, 1.15, .08, .7, '#b98a52', z.x, .04, z.y));
  const zones = [zoneDecal(c.IN.x, c.IN.y + .05, zoneLabel(c, 'in')), zoneDecal(c.OUT.x, c.OUT.y + .05, zoneLabel(c, 'out'))];
  zones.forEach(z => z.draw(false, true));
  convMeshes.set(c, { g, mouth, trays, zones });
  owns(c.id, g, ...trays, ...zones.map(z => z.m));
  NO_GRASS.push([c.x - c.w / 2 - .6, c.y - c.d / 2 - .6, c.x + c.w / 2 + .6, c.OUT.y + .7]);
}
// stalls
const stallMeshes = new Map();
function makeStall(st) {
  const g = group(st.x, st.y);
  const red = '#e0393f', dark = '#b8272f';
  rbox(g, 2.4, .14, 1.0, red, 0, .78, 0, .06);
  rbox(g, 2.28, .56, .9, dark, 0, .44, 0, .05);
  rbox(g, 2.1, .4, .04, '#c92f37', 0, .46, .46, .02);
  for (const [x, z] of [[-1.05, -.36], [1.05, -.36], [-1.05, .36], [1.05, .36]]) rbox(g, .14, .2, .14, '#8f1f27', x, .1, z, .04);
  // cash register
  rbox(g, .48, .24, .42, '#5fcde0', -.8, .96, .02, .06);
  const scr = rbox(g, .4, .22, .05, '#eafcff', -.8, 1.16, -.14, .02); scr.rotation.x = -.45;
  rbox(g, .32, .04, .2, '#3aa9bc', -.8, 1.09, .1, .015);
  sack(-1.65, .1, .8, .4, g); sack(-1.95, .55, .62, 1.6, g);
  bakeMerge(g);
  return g;
}
const sellZones = new Map(), stallCashiers = new Map();
for (const st of stallList) NO_GRASS.push([st.x - 1.4, st.y - 2.6, st.x + 2.4, st.y + .7]);
// the shed (bag and boots upgrades)
{ const g = group(); model('smallBarn', 2.1, SHED.x, SHED.y, 0, g); bakeMerge(g); NO_GRASS.push([SHED.x - 1.4, SHED.y - 1.1, SHED.x + 1.4, SHED.y + 1.4]); if (LITE) STATIC_BLOBS.push([SHED.x, SHED.y + .1, 1.4, 1]); }
// decorations bought on pads
const DECOR_BUILD = {
  bench: (g) => model('bench', .55, 0, 0, 0, g),
  lamp: (g) => model('lamp', 2.5, 0, 0, 0, g, { Light: '#fff3b0' }),
  well: (g) => model('well', 1.9, 0, 0, 0, g),
  fountain: (g) => modelFit('fountain', 2, 2, 0, 0, 0, g),
  flowers: (g) => {
    for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; mesh(new THREE.DodecahedronGeometry(.12, 0), '#b9b2a4', Math.cos(a) * .62, .06, Math.sin(a) * .48, g); }
    mesh(new THREE.CylinderGeometry(.58, .6, .1, 20).scale(1, 1, .78), '#8a5a35', 0, .05, 0, g);
    const cols = ['#ff6f9a', '#ffd84d', '#ffffff', '#b98cff', '#ff8a3d'];
    for (let k = 0; k < 14; k++) { const a = k * 2.4, r = .1 + (k % 4) * .12; mesh(new THREE.SphereGeometry(.08, 8, 6), cols[k % cols.length], Math.cos(a) * r, .26 + (k % 3) * .04, Math.sin(a) * r * .8, g); }
    for (let k = 0; k < 6; k++) { const a = k * 1.05; mesh(new THREE.SphereGeometry(.13, 8, 6).scale(1, .6, 1), '#4cbb3c', Math.cos(a) * .3, .16, Math.sin(a) * .24, g); }
  },
};
for (const d of DEFS) if (d.kind === 'decor' && d.model) {
  const g = group(d.x, d.y); DECOR_BUILD[d.model](g); g.rotation.y = d.rot || 0; bakeMerge(g); owns(d.id, g);
  NO_GRASS.push([d.x - 1, d.y - 1, d.x + 1, d.y + 1]);
}
let bunting = null;
function makeBunting() {
  const g = new THREE.Group(); scene.add(g);
  const cols = ['#e0453a', '#ffd23f', '#4f8fe0', '#5cc04a', '#ff8fb1'];
  for (const [xa, xb] of [[-19.4, -.8], [1.2, 18.8], [21, 39.4]]) {
    for (const x of [xa, xb]) box(g, .12, 2.6, .12, '#8a5a2b', x, 1.3, 16.6);
    for (let i = 1; i < 26; i++) {
      const t = i / 26, x = xa + (xb - xa) * t, y = 2.5 - Math.sin(t * Math.PI) * .5;
      const f = mesh(new THREE.ConeGeometry(.16, .34, 3).rotateX(Math.PI), cols[i % cols.length], x, y, 16.6, g); f.castShadow = false;
    }
  }
  return g;
}
// locked plots: a fence on the border with the farm and a sign
function signBoard(text, x, y, parent) {
  const g = group(x, y, parent);
  box(g, .1, 1.3, .1, '#8a5a2b', -.55, .65, 0); box(g, .1, 1.3, .1, '#8a5a2b', .55, .65, 0);
  const c = document.createElement('canvas'); c.width = 256; c.height = 96; const k = c.getContext('2d');
  k.fillStyle = '#e9c48a'; k.fillRect(0, 0, 256, 96); k.strokeStyle = '#a8763c'; k.lineWidth = 8; k.strokeRect(4, 4, 248, 88);
  k.font = `900 40px ${FONT}`; k.textAlign = 'center'; k.textBaseline = 'middle'; k.fillStyle = '#6b3f17'; k.fillText(text, 128, 50);
  const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, .55, .06), [mat('#c99a5c'), mat('#c99a5c'), mat('#c99a5c'), mat('#c99a5c'), new THREE.MeshLambertMaterial({ map: canvasTex(c) }), mat('#c99a5c')]);
  b.position.set(0, 1.1, .02); b.castShadow = true; g.add(b);
  return g;
}
const locks = new Map();
{ const g = new THREE.Group(); scene.add(g); fenceRun(WORLD.x0 + .6, -.4, -.4, -.4, g, .75); fenceRun(20.4, -.4, WORLD.x1 - .6, -.4, g, .75); fenceRun(-.4, -.4, -.4, WORLD.y0 + .6, g, .75); fenceRun(20.4, -.4, 20.4, WORLD.y0 + .6, g, .75); bakeMerge(g); }
for (const [zid, z] of Object.entries(ZONES)) {
  if (!z.land) continue;
  const g = new THREE.Group(); scene.add(g);
  const [x0, y0, x1, y1] = z.rect;
  if (zid === 'field') fenceRun(x1 - .4, y0 + .3, x1 - .4, y1 - .2, g, .75);
  if (zid === 'pasture') fenceRun(x0 + .4, y0 + .3, x0 + .4, y1 - .2, g, .75);
  if (zid === 'garden') fenceRun(x0 + .3, y1 - .4, x1 - .3, y1 - .4, g, .75);
  bakeMerge(g);
  const d = DEF[z.land];
  const sx = zid === 'field' ? x1 - 1.8 : zid === 'pasture' ? x0 + 1.8 : d.x + 2.4, sy = zid === 'garden' ? y1 - 1.8 : d.y - .4;
  signBoard(z.title, sx, sy, g);
  locks.set(zid, g);
}
// border: bushes along the edge of the world and a forest beyond it
{
  const decor = new THREE.Group(); scene.add(decor);
  for (let y = WORLD.y0 + 1; y < WORLD.y1 - 1; y += 3.2) { bush(WORLD.x0 + .3 + srnd() * .4, y + srnd(), .9 + srnd() * .5, decor); bush(WORLD.x1 - .3 - srnd() * .4, y + srnd(), .9 + srnd() * .5, decor); }
  for (let x = WORLD.x0 + 1; x < WORLD.x1 - 1; x += 3) bush(x + srnd(), WORLD.y0 + .3 + srnd() * .3, .9 + srnd() * .5, decor);
  model('woodlog', .3, 12.8, 10.0, .7, decor); model('woodlog', .3, 13.2, 9.7, .2, decor);
  model('crate', .55, 1.6, 17.5, .3, decor); model('crate', .45, 1.9, 18.2, .9, decor);
  bakeMerge(decor);
}
for (const p of PADS) NO_GRASS.push([p.x - .95, p.y - .95, p.x + .95, p.y + .95]);
{
  // tuft: five blades with upward normals so they light like the ground
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
  const N = LITE ? 6500 : 12000;
  const grassMat = addWind(newMat({ vertexColors: true, side: THREE.DoubleSide, roughness: 1 }));
  const greens = ['#6cc43d', '#74ca45', '#66bd39', '#7dcf4d'].map(c => new THREE.Color(c));
  const X0 = WORLD.x0 - 3, Y0 = WORLD.y0 - 3, XW = WORLD.x1 - WORLD.x0 + 6, YH = WORLD.y1 - WORLD.y0 + 8;
  const tufts = [];
  for (let tries = 0; tufts.length < N && tries < N * 4; tries++) {
    const x = X0 + srnd() * XW, y = Y0 + srnd() * YH;
    if (grassFree(x, y)) tufts.push([x, y, srnd() * 6.3, .7 + srnd() * .8]);
  }
  const place = (im, list, color) => {
    list.forEach(([x, y, rot, sc], i) => { _o.position.set(x, 0, y); _o.rotation.set(0, rot, 0); _o.scale.setScalar(sc); _o.updateMatrix(); im.setMatrixAt(i, _o.matrix); im.setColorAt(i, color(i)); });
    _o.scale.setScalar(1); _o.rotation.set(0, 0, 0); scene.add(cullable(im));
  };
  let gi = 0;
  for (const part of chunks(tufts)) { const im = new THREE.InstancedMesh(geo, grassMat, part.length); im.receiveShadow = true; place(im, part, () => greens[gi++ % 4]); }
  // flowers, in little clusters
  const F = LITE ? 500 : 900, flGeo = new THREE.SphereGeometry(.055, 8, 6).translate(0, .16, 0), flMat = addWind(newMat({ roughness: .7 }));
  const fc = ['#ffffff', '#ffe14d', '#ff8fb8', '#b98cff', '#ffffff'].map(c => new THREE.Color(c));
  const fls = [];
  for (let tries = 0; fls.length < F && tries < F * 6; tries++) {
    const cx = X0 + srnd() * XW, cy = Y0 + srnd() * YH, col = fc[Math.floor(srnd() * fc.length)];
    for (let k = 0; k < 5 && fls.length < F; k++) {
      const x = cx + (srnd() - .5) * .8, y = cy + (srnd() - .5) * .8;
      if (grassFree(x, y)) fls.push([x, y, 0, .8 + srnd() * .5, col]);
    }
  }
  for (const part of chunks(fls)) place(new THREE.InstancedMesh(flGeo, flMat, part.length), part, (i) => part[i][4]);
}
// split instances into square chunks so three.js can skip the ones off screen (the world is much bigger than the view)
function chunks(items, size = 14) {
  const m = new Map();
  for (const it of items) { const k = Math.floor(it[0] / size) + ',' + Math.floor(it[1] / size); if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
  return [...m.values()];
}
function cullable(im) { im.computeBoundingSphere(); im.frustumCulled = true; return im; }
// forest around the farm: instanced copies of the tree models
const instMats = new Map(); // one set of materials per model part, shared by all chunks
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

// ---------- input ----------
let moved = false;
let upBtn = null; // screen circle of the upgrade button: { x, y, r, id }
// a short tap on the upgrade button opens the card; a drag that starts on it still steers
let tap = null;
ov.addEventListener('pointerdown', e => {
  tap = upBtn && Math.hypot(e.clientX - upBtn.x, e.clientY - upBtn.y) < upBtn.r + 10 ? { x: e.clientX, y: e.clientY, t: performance.now(), id: upBtn.id } : null;
  joy = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY }; ov.setPointerCapture(e.pointerId);
});
ov.addEventListener('pointerup', e => {
  if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 14 && performance.now() - tap.t < 400 && typeof openUpgrades === 'function') openUpgrades(tap.id);
  tap = null;
});
ov.addEventListener('pointermove', e => { if (joy && e.pointerId === joy.id) { joy.x = e.clientX; joy.y = e.clientY; if (Math.hypot(joy.x - joy.ox, joy.y - joy.oy) > 20) moved = true; } });
const endJoy = e => { if (joy && e.pointerId === joy.id) joy = null; };
ov.addEventListener('pointerup', endJoy); ov.addEventListener('pointercancel', endJoy);
addEventListener('keydown', e => { moved = true; if ((e.key === 'e' || e.key === 'у' || e.key === 'Enter') && G.upNear && !G.paused && typeof openUpgrades === 'function') openUpgrades(G.upNear); });

// ---------- juice: dust puffs and pop-in ----------
const dust = new THREE.InstancedMesh(new THREE.SphereGeometry(.12, 10, 8), newMat({ color: '#f1d2a8', transparent: true, opacity: .6, roughness: 1 }), 80);
dust.frustumCulled = false; scene.add(dust);
const puffs = []; let puffT = 0;
function popScale(born) { const t = Math.min(1, (now - born) / .55); if (t >= 1) return 1; const u = t - 1; return Math.max(.01, 1 + 2.70158 * u * u * u + 1.70158 * u * u); }
const born = new Map();
function popIn(obj) { if (!born.has(obj)) born.set(obj, now); obj.scale.setScalar(popScale(born.get(obj))); }
let firstSync = true; // things already built when the game loads appear without the pop

// ---------- per-frame sync of the 3D scene ----------
function sync() {
  camera.position.set(camX, Math.sin(PITCH) * camDist, camY + 1.2 + Math.cos(PITCH) * camDist);
  camera.lookAt(camX, 0, camY + 1.2);
  const sx = Math.round(camX / 6) * 6, sy = Math.round(camY / 6) * 6; // steps, so shadow edges do not crawl every frame
  sun.position.set(sx - 6, 22, sy + 11); sun.target.position.set(sx, 0, sy);

  // buildings that appear when bought
  for (const [id, objs] of shown) {
    const on = built(id);
    for (const ob of objs) {
      ob.visible = on;
      if (on && !ob.isMesh) { if (firstSync) born.set(ob, -9); popIn(ob); } else if (!on) born.delete(ob);
    }
  }
  for (const [zid, g] of locks) g.visible = !zoneOpen(zid);

  // people
  for (const p of people.values()) p.seen = false;
  posePerson(personFor(player, () => ({ model: 'womanA' })), player);
  for (const h of helpers) posePerson(personFor(h, () => ({ model: 'farmer', shirt: h.shirt })), h);
  for (const c of customers) posePerson(personFor(c, () => ({ model: ['womanB', 'casual', 'hoodie', 'womanB', 'casual'][Math.floor(c.id * 5)], shirt: c.shirt, pants: ['#3f5f9e', '#4d4d5e', '#6b4a2e', '#2f4f7a'][Math.floor(c.id * 17) % 4], hair: c.hair })), c, false);
  for (const st of stallList) {
    if (!isOpen(st) || !hasCashier(st)) continue;
    let a = stallCashiers.get(st);
    if (!a) { a = { x: st.x - .8, y: st.y - .85, dir: Math.PI / 2, walk: 0, stack: [], chopping: 0 }; stallCashiers.set(st, a); }
    posePerson(personFor(a, () => ({ model: 'hoodie', shirt: '#2fb6c8', pants: '#3a3a4a' })), a);
  }
  for (const [a, p] of people) if (!p.seen) { scene.remove(p.g); mixers.delete(p.mixer); people.delete(a); }

  // animals
  for (const [c, m] of animalMeshes) if (!penList.some(p => p.animals.includes(c))) { scene.remove(m.g); mixers.delete(m.mixer); animalMeshes.delete(c); }
  for (const pen of penList) for (const c of pen.animals) {
    let m = animalMeshes.get(c);
    if (!m) { m = makeAnimal(pen.animal); animalMeshes.set(c, m); }
    m.g.position.set(c.x, 0, c.y); if (firstSync) born.set(m.g, -9); popIn(m.g);
    const moving = Math.hypot(c.tx - c.x, c.ty - c.y) > .1;
    if (moving) m.g.rotation.y = Math.PI / 2 - Math.atan2(c.ty - c.y, c.tx - c.x);
    const want = moving ? m.k.move : c.peck > .4 ? m.k.eat : m.k.idle;
    if (m.cur !== want && m.actions[want]) { m.actions[m.cur].fadeOut(.2); m.actions[want].reset().fadeIn(.2).play(); m.cur = want; }
    if (m.actions[m.k.move]) m.actions[m.k.move].timeScale = m.k.moveTs;
  }

  // trees and crops
  let nw = 0, np = 0, ns = 0, nb = 0, nl = 0;
  for (const t of plants) {
    if (t.group === 'grove') {
      const m = plantMeshes.get(t), on = t.active;
      m.g.visible = on; if (!on) continue;
      const alive = t.logs > 0;
      m.crown.visible = alive; m.stump.visible = !alive;
      let sc = .82 + Math.min(t.logs, 5) * .06;
      if (t.pop && now - t.pop < .45 && now >= t.pop) sc *= Math.sin(Math.min(1, (now - t.pop) / .45) * Math.PI * .7) / Math.sin(Math.PI * .7);
      m.crown.scale.setScalar(Math.max(.01, sc));
      m.crown.rotation.z = Math.sin(now * 40) * t.shake * .06;
      const gr = 1 - t.regrow / regrowTime('grove'); m.sapling.visible = gr > .3; m.sapling.scale.setScalar(Math.max(.01, gr));
      continue;
    }
    if (!t.active) continue;
    let pop = 1;
    if (t.pop && now >= t.pop && now - t.pop < .45) pop = Math.max(.01, Math.sin(Math.min(1, (now - t.pop) / .45) * Math.PI * .7) / Math.sin(Math.PI * .7));
    _o.rotation.set(0, 0, 0); _o.position.set(t.x, 0, t.y); _o.scale.setScalar(1); _o.updateMatrix(); bedIM.setMatrixAt(nb++, _o.matrix);
    const grown = t.logs > 0, gr = grown ? 1 : clamp(1 - t.regrow / regrowTime(t.group), 0, 1);
    const wob = Math.sin(now * 40) * t.shake * .08;
    if (t.group === 'field') {
      const k = grown ? (t.logs >= 2 ? STALKS.length : 4) : 0;
      for (let s = 0; s < STALKS.length; s++) {
        const [dx, dz] = STALKS[s];
        if (s < k) {
          _o.position.set(t.x + dx, 0, t.y + dz); _o.rotation.set(wob, s * 1.7, 0); _o.scale.setScalar(pop * (.85 + (s % 3) * .08)); _o.updateMatrix(); wheatIM.setMatrixAt(nw++, _o.matrix);
        } else if (!grown && gr > .05) {
          _o.position.set(t.x + dx, 0, t.y + dz); _o.rotation.set(0, s, 0); _o.scale.setScalar(.3 + gr * .9); _o.updateMatrix(); sproutIM.setMatrixAt(ns++, _o.matrix);
        }
      }
    } else {
      _o.position.set(t.x, 0, t.y); _o.rotation.set(0, t.i, 0); _o.scale.setScalar(1); _o.updateMatrix(); leafIM.setMatrixAt(nl++, _o.matrix);
      const s = grown ? pop : .25 + gr * .5;
      _o.position.set(t.x, .02, t.y); _o.rotation.set(wob, t.i * 2.1, 0); _o.scale.setScalar(s); _o.updateMatrix(); pumpkinIM.setMatrixAt(np++, _o.matrix);
    }
  }
  _o.scale.setScalar(1); _o.rotation.set(0, 0, 0);
  for (const [im, n] of [[wheatIM, nw], [pumpkinIM, np], [sproutIM, ns], [bedIM, nb], [leafIM, nl]]) { im.count = n; im.instanceMatrix.needsUpdate = true; }

  // converters
  for (const [c, m] of convMeshes) {
    if (!built(c.id)) continue;
    if (m.mouth) { m.mouth.material.emissive.set(c.cook > 0 ? '#ff8a20' : '#000000'); m.mouth.material.emissiveIntensity = .8 + Math.sin(now * 12) * .2; }
  }
  for (const st of stallList) {
    const open = isOpen(st);
    if (open && !stallMeshes.has(st)) stallMeshes.set(st, makeStall(st));
    if (stallMeshes.has(st)) { const m = stallMeshes.get(st); m.visible = open; if (open) { if (firstSync) born.set(m, -9); popIn(m); } else born.delete(m); }
    if (open && !sellZones.has(st)) sellZones.set(st, zoneDecal(st.drop.x, st.drop.y, 'ПРОДАЖА'));
    if (sellZones.has(st)) { const z = sellZones.get(st); z.m.visible = open; if (open) z.draw(!hasCashier(st) && near(player, st.drop.x, st.drop.y, .95), !hasCashier(st)); }
  }
  if (G.fair && !bunting) bunting = makeBunting();
  if (bunting) bunting.visible = G.fair;

  // pads
  for (const d of padDecals.values()) d.m.visible = false;
  for (const p of PADS) if (padVisible(p)) drawPadDecal(p);

  // items
  const bob = a => Math.abs(Math.sin(a.walk * 1.3)) * .04;
  for (const a of [player, ...helpers]) for (let i = 0; i < a.stack.length; i++) {
    if (a.stack[i].land > now) continue;
    const [x, y, z, d] = stackPos(a, i);
    putItem(a.stack[i].t, x, y, z + bob(a), -d - Math.PI / 2);
  }
  for (const c of customers) for (let i = 0; i < c.got; i++) {
    const t = stalls[c.stall].type;
    putItem(t, c.x + Math.cos(c.dir) * .32, c.y + Math.sin(c.dir) * .32, .78 + i * ITEM[t].h, -c.dir - Math.PI / 2);
  }
  for (const st of stallList) if (isOpen(st)) {
    for (let i = 0; i < st.shelf; i++) { const [x, y, z] = shelfPos(st, i); putItem(st.type, x, y, z + .06, 0); }
    for (let i = 0; i < Math.min(st.coins, 160); i++) { const [x, y, z] = coinPos(st, i); putItem('coin', x, y, z, (i * 1.7 % 1) * .3 - .15); }
  }
  for (const p of penList) for (let i = 0; i < p.stock; i++) { const [x, y, z] = pilePos(p.pile.x, p.pile.y, i, ITEM[p.item].h); putItem(p.item, x, y, z + .1, i * .7); }
  for (const c of convList) if (built(c.id)) {
    for (const t of Object.keys(c.in)) for (let i = 0; i < c.store[t]; i++) { const [x, y, z] = convInPos(c, t, i); putItem(t, x, y, z + .08, t === 'wood' ? Math.PI / 2 : 0); }
    for (let i = 0; i < c.out_n; i++) { const [x, y, z] = pilePos(c.OUT.x, c.OUT.y, i, ITEM[c.out].h); putItem(c.out, x, y, z + .08, 0); }
  }
  for (const f of flyers) {
    const k = Math.min(1, f.age / f.dur), to = typeof f.to === 'function' ? f.to() : f.to;
    putItem(f.t, f.from[0] + (to[0] - f.from[0]) * k, f.from[1] + (to[1] - f.from[1]) * k,
      f.from[2] + (to[2] - f.from[2]) * k + Math.sin(k * Math.PI) * .9, (to[3] ?? 0) * k);
  }
  flushItems();

  // dust puffs from running feet
  puffT -= 1 / 60;
  for (const a of [player, ...helpers]) {
    if (Math.hypot(a.vx, a.vy) > 1.6 && puffT <= 0 && puffs.length < 80) puffs.push({ x: a.x - Math.cos(a.dir) * .2 + (Math.random() - .5) * .2, y: a.y - Math.sin(a.dir) * .2, t: now });
  }
  if (puffT <= 0) puffT = .07;
  while (puffs.length && now - puffs[0].t > .5) puffs.shift();
  puffs.forEach((p, i) => { const k = (now - p.t) / .5; _o.position.set(p.x, .08 + k * .25, p.y); _o.rotation.set(0, 0, 0); _o.scale.setScalar((.5 + k * 1.1) * (1 - k * k)); _o.updateMatrix(); dust.setMatrixAt(i, _o.matrix); });
  dust.count = puffs.length; dust.instanceMatrix.needsUpdate = true; _o.scale.setScalar(1);
  windTime.value = now; clouds.offset.set(now * .006, now * .003);
  if (LITE) {
    const L = STATIC_BLOBS.slice();
    for (const c of convList) if (built(c.id)) L.push([c.x, c.y + .15, c.w * .62, c.d * .55]);
    for (const st of stallList) if (isOpen(st)) L.push([st.x, st.y + .12, 1.45, .7]);
    for (const a of [player, ...helpers, ...customers]) L.push([a.x, a.y, .42, .42]);
    for (const a of stallCashiers.values()) if (people.has(a)) L.push([a.x, a.y, .42, .42]);
    for (const p of penList) for (const c of p.animals) L.push([c.x, c.y, p.animal === 'cow' ? .7 : .28, p.animal === 'cow' ? .5 : .28]);
    for (const d of DEFS) if (d.kind === 'decor' && d.model && built(d.id)) L.push([d.x, d.y + .05, .7, .55]);
    for (const t of plants) if (t.active && t.group === 'grove' && t.logs > 0) L.push([t.x, t.y + .08, .75, .75]);
    drawBlobs(L);
  }

  // particles
  let nc = 0, nsm = 0;
  for (const p of parts) {
    if (p.c === 'smoke') {
      if (nsm >= 160) continue;
      const s = .6 + (1.2 - p.life) * 1.2;
      _o.position.set(p.x, p.z, p.y); _o.rotation.set(0, 0, 0); _o.scale.setScalar(s); _o.updateMatrix(); smoke.setMatrixAt(nsm++, _o.matrix);
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

// ---------- overlay (bubbles, texts, HUD) ----------
function itemIcon(t, x, y, s) { // flat item icons for bubbles
  o.save(); o.translate(x, y); o.scale(s, s); o.lineWidth = .04;
  const el = (cx, cy, rx, ry, c) => { o.beginPath(); o.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); o.fillStyle = c; o.fill(); };
  if (t === 'egg') {
    rr(o, -.42, .02, .84, .26, .06); o.fillStyle = '#c8935a'; o.fill();
    for (const [dx, dy] of [[-.2, -.02], [.2, -.02], [0, -.12]]) el(dx, dy, .17, .21, '#fff');
  } else if (t === 'wood') {
    for (const [dx, dy] of [[-.17, .1], [.17, .1], [0, -.12]]) {
      rr(o, dx - .2, dy - .1, .4, .2, .1); o.fillStyle = '#b06d32'; o.fill();
      el(dx + .19, dy, .07, .1, '#f1c98e');
    }
  } else if (t === 'pie') {
    el(0, .08, .4, .17, '#c27b33'); el(0, 0, .38, .16, '#f2bb5c');
    o.strokeStyle = '#c27b33'; o.beginPath(); o.moveTo(-.2, -.05); o.lineTo(.1, .08); o.moveTo(0, -.1); o.lineTo(.25, .02); o.stroke();
  } else if (t === 'wheat') {
    o.strokeStyle = '#c99a2e'; o.lineWidth = .06; for (const a of [-.3, 0, .3]) { o.beginPath(); o.moveTo(0, .38); o.lineTo(Math.sin(a) * .45, -.1); o.stroke(); }
    for (const a of [-.3, 0, .3]) for (let k = 0; k < 3; k++) el(Math.sin(a) * (.42 + k * .09), -.1 - k * .11, .06, .09, '#f0cf5a');
  } else if (t === 'flour') {
    o.beginPath(); o.moveTo(-.14, -.26); o.quadraticCurveTo(-.36, 0, -.28, .34); o.lineTo(.28, .34); o.quadraticCurveTo(.36, 0, .14, -.26); o.closePath(); o.fillStyle = '#f4ecdc'; o.fill();
    o.fillStyle = '#c27b33'; o.fillRect(-.16, -.34, .32, .08);
  } else if (t === 'pumpkin') {
    for (const dx of [-.18, .18, 0]) el(dx, .08, .2, .26, dx ? '#e07a22' : '#f08a2a');
    o.fillStyle = '#6b8a2a'; o.fillRect(-.04, -.28, .08, .14);
  } else if (t === 'milk') {
    o.beginPath(); o.moveTo(-.16, .38); o.lineTo(-.16, -.02); o.lineTo(-.08, -.16); o.lineTo(-.08, -.28); o.lineTo(.08, -.28); o.lineTo(.08, -.16); o.lineTo(.16, -.02); o.lineTo(.16, .38); o.closePath(); o.fillStyle = '#fff'; o.fill();
    o.fillStyle = '#3c8fd9'; o.fillRect(-.09, -.36, .18, .1); o.fillStyle = '#7cc0f5'; o.fillRect(-.16, .1, .32, .1);
  } else if (t === 'cheese') {
    o.beginPath(); o.moveTo(-.4, .26); o.lineTo(.4, .26); o.lineTo(.4, -.04); o.lineTo(-.4, -.26); o.closePath(); o.fillStyle = '#f5c842'; o.fill();
    el(-.12, .08, .07, .06, '#d9a520'); el(.18, .12, .06, .05, '#d9a520');
  } else if (t === 'cake') {
    rr(o, -.36, .04, .72, .3, .06); o.fillStyle = '#fff2e6'; o.fill(); o.fillStyle = '#ff9cc4'; o.fillRect(-.36, .04, .72, .07);
    rr(o, -.24, -.2, .48, .26, .06); o.fillStyle = '#ffd6e6'; o.fill(); el(0, -.28, .07, .07, '#e0303a');
  }
  o.restore();
}
function text(t, x, y, size, fill = '#fff', stroke = '#1d3557', sw = size * .22, align = 'center') {
  o.font = `900 ${size}px ${FONT}`; o.textAlign = align; o.textBaseline = 'middle'; o.lineJoin = 'round';
  o.lineWidth = sw; o.strokeStyle = stroke; if (sw) o.strokeText(t, x, y); o.fillStyle = fill; o.fillText(t, x, y);
}
function star(cx, cy, r, fill) {
  o.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? r * .45 : r; o.lineTo(cx + Math.cos(a) * q, cy + Math.sin(a) * q); }
  o.closePath(); o.fillStyle = fill; o.fill();
}
function patienceBar(x, y, w, f) {
  rr(o, x - w / 2, y, w, 7, 3.5); o.fillStyle = 'rgba(0,0,0,.35)'; o.fill();
  rr(o, x - w / 2, y, w * f, 7, 3.5); o.fillStyle = f > .5 ? '#6ad44f' : f > .25 ? '#f4b52c' : '#ec4a3c'; o.fill();
}
function upArrow(x, y, s, col) {
  o.beginPath(); o.moveTo(x, y - s); o.lineTo(x + s * .85, y); o.lineTo(x + s * .35, y); o.lineTo(x + s * .35, y + s * .8); o.lineTo(x - s * .35, y + s * .8); o.lineTo(x - s * .35, y); o.lineTo(x - s * .85, y); o.closePath();
  o.fillStyle = col; o.fill();
}
function overlay(U) {
  o.clearRect(0, 0, W, H);
  // customers: dark bubble with item and count (front of queue), bars for others
  for (const c of customers) {
    if (c.state === 'in' && c.entered) {
      const st = stalls[c.stall], f = Math.max(0, Math.min(1, c.pat / c.patMax));
      const [sx, sy] = proj(c.x, c.y, 2.05);
      if (sx < -60 || sx > W + 60 || sy < -60 || sy > H + 60) continue;
      if (st.queue[0] === c) {
        const w = U * 1.05, h = U * .62;
        rr(o, sx - w / 2, sy - h, w, h, U * .16); o.fillStyle = 'rgba(25,25,30,.88)'; o.fill();
        o.beginPath(); o.moveTo(sx - U * .1, sy - 1); o.lineTo(sx + U * .1, sy - 1); o.lineTo(sx, sy + U * .12); o.fill();
        itemIcon(st.type, sx - U * .2, sy - h / 2, U * .55);
        text(String(c.want - c.got), sx + U * .28, sy - h / 2, U * .34, '#fff', 'rgba(0,0,0,0)', 0);
        patienceBar(sx, sy - h - 11, w * .8, f);
      } else patienceBar(sx, sy - 4, U * .55, f);
    } else if (c.state === 'out' && now - c.moodT < 1.6) {
      const t = now - c.moodT, [sx, sy] = proj(c.x, c.y, 1.7 + t * .4);
      o.globalAlpha = 1 - t / 1.6;
      if (c.happy) {
        const s = U * .17; o.fillStyle = '#ff4f73'; o.beginPath();
        o.moveTo(sx, sy + s); o.bezierCurveTo(sx - s * 2, sy - s * .3, sx - s * .8, sy - s * 1.6, sx, sy - s * .5);
        o.bezierCurveTo(sx + s * .8, sy - s * 1.6, sx + s * 2, sy - s * .3, sx, sy + s); o.fill();
      } else text('!!', sx, sy, U * .4, '#ff6b5a', '#fff', U * .08);
      o.globalAlpha = 1;
    }
  }
  // MAX over a full stack
  if (player.stack.length >= player.cap) {
    const [x, y, z] = stackPos(player, player.stack.length);
    const [sx, sy] = proj(x, y, z + .25);
    text('МАКС', sx, sy, U * .38, '#ff4d3d', '#ffffff', U * .1);
  }
  for (const f of floats) {
    const [sx, sy] = proj(f.x, f.y, f.z + f.t * .9);
    o.globalAlpha = 1 - Math.max(0, f.t - .6) / .5;
    text(f.text, sx, sy, U * .36, f.color === '#fff' ? '#fff' : f.color, '#1d3557', U * .1);
    o.globalAlpha = 1;
  }
  // upgrade button over the building the player stands next to
  upBtn = null;
  const h = G.curHint;
  if (G.upNear && !G.paused) {
    const a = upgradeAnchor(G.upNear), [bx, by0] = proj(a.x, a.y, 2.5), ok = anyUpgradeAffordable(G.upNear);
    const r = Math.max(24, U * .42), by = by0 + Math.sin(now * 5) * (ok ? 3 : 0);
    o.beginPath(); o.arc(bx, by, r + 4, 0, Math.PI * 2); o.fillStyle = '#fff'; o.fill();
    o.beginPath(); o.arc(bx, by, r, 0, Math.PI * 2); o.fillStyle = ok ? '#4cbb45' : '#8d9aa6'; o.fill();
    upArrow(bx, by - r * .05, r * .55, '#fff');
    const label = BUILDING_TITLE(G.upNear);
    o.font = `900 ${Math.round(r * .55)}px ${FONT}`;
    const lw = o.measureText(label).width + 18;
    rr(o, bx - lw / 2, by + r + 8, lw, r * .55 + 10, (r * .55 + 10) / 2); o.fillStyle = 'rgba(25,30,45,.62)'; o.fill();
    text(label, bx, by + r + 13 + r * .275, Math.round(r * .55), '#fff', 'rgba(0,0,0,0)', 0);
    upBtn = { x: bx, y: by, r, id: G.upNear };
    if (h && h.up) { // tutorial: point at the button
      const k = Math.abs(Math.sin(now * 4)) * 10;
      o.beginPath(); o.moveTo(bx, by - r - 8 - k); o.lineTo(bx - 14, by - r - 30 - k); o.lineTo(bx + 14, by - r - 30 - k); o.closePath();
      o.fillStyle = '#ffd23f'; o.fill(); o.lineWidth = 3; o.strokeStyle = '#c88a00'; o.stroke();
    }
  }
  // hint arrows
  if (h && h.x !== undefined) {
    const [tx, ty] = proj(h.x, h.y, 1.6 + Math.abs(Math.sin(now * 4)) * .35);
    o.beginPath(); o.moveTo(tx - U * .28, ty - U * .42); o.lineTo(tx + U * .28, ty - U * .42); o.lineTo(tx, ty); o.closePath();
    o.fillStyle = '#ffd23f'; o.fill(); o.lineWidth = 3; o.strokeStyle = '#c88a00'; o.stroke();
    const d = Math.hypot(h.x - player.x, h.y - player.y);
    if (d > 1.6) { // cyan arrow on the ground in front of the player
      const ux = (h.x - player.x) / d, uy = (h.y - player.y) / d;
      const tip = proj(player.x + ux * 1.25, player.y + uy * 1.25), base = proj(player.x + ux * .65, player.y + uy * .65);
      const l = proj(player.x + ux * .65 - uy * .32, player.y + uy * .65 + ux * .32), r = proj(player.x + ux * .65 + uy * .32, player.y + uy * .65 - ux * .32);
      o.beginPath(); o.moveTo(...tip); o.lineTo(...l); o.lineTo(...base); o.lineTo(...r); o.closePath();
      o.fillStyle = 'rgba(110,235,245,.85)'; o.fill(); o.lineWidth = 2; o.strokeStyle = '#ffffff'; o.stroke();
    }
  }
  // HUD: money
  const top = 14;
  o.font = `900 26px ${FONT}`;
  const coinsTxt = fmtN(G.coins), cw = o.measureText(coinsTxt).width;
  rr(o, 12, top, cw + 70, 44, 22); o.fillStyle = 'rgba(0,0,0,.32)'; o.fill();
  cashIcon(o, 38, top + 22, 70);
  text(coinsTxt, 64, top + 23, 26, '#fff', 'rgba(0,0,0,0)', 0, 'left');
  // what to save up for next
  const goal = nextGoal();
  if (goal && G.hint >= 3) {
    const left = goal.cost - padPaid(goal), f = clamp(G.coins / Math.max(1, left), 0, 1);
    const label = goal.label, sub = f >= 1 ? 'можно купить!' : `${fmtN(Math.min(G.coins, left))} / ${fmtN(left)}`;
    o.font = `900 15px ${FONT}`; const lw1 = o.measureText(label).width; o.font = `900 13px ${FONT}`; const lw2 = o.measureText(sub).width;
    const gw = Math.min(W - cw - 160, Math.max(lw1, lw2) + 64), gx = Math.max(cw + 92, W / 2 - gw / 2);
    rr(o, gx, top, gw, 44, 22); o.fillStyle = 'rgba(0,0,0,.32)'; o.fill();
    o.save(); rr(o, gx + 2, top + 2, gw - 4, 40, 20); o.clip();
    o.fillStyle = f >= 1 ? 'rgba(76,187,69,.85)' : 'rgba(76,187,69,.45)'; o.fillRect(gx + 2, top + 2, (gw - 4) * f, 40);
    o.restore();
    padIconHud(goal.icon, gx + 24, top + 22);
    o.save(); rr(o, gx + 42, top, gw - 50, 44, 0); o.clip();
    text(label, gx + 44, top + 15, 15, '#fff', 'rgba(0,0,0,0)', 0, 'left');
    text(sub, gx + 44, top + 32, 13, f >= 1 ? '#eaffd8' : 'rgba(255,255,255,.85)', 'rgba(0,0,0,0)', 0, 'left');
    o.restore();
  }
  // customer rating (affects how many come) — small, bottom left
  const by = H - 26 - 8;
  for (let i = 0; i < 5; i++) {
    const sx = 18 + i * 20;
    star(sx, by, 8, 'rgba(0,0,0,.25)');
    const fl = Math.max(0, Math.min(1, G.rep - i));
    if (fl > 0) { o.save(); o.beginPath(); o.rect(sx - 8, by - 8, 16 * fl, 16); o.clip(); star(sx, by, 8, '#ffd23f'); o.restore(); }
  }
  if (h && h.text) {
    o.font = `900 17px ${FONT}`;
    const hw = o.measureText(h.text).width;
    rr(o, W / 2 - hw / 2 - 18, top + 54, hw + 36, 38, 19); o.fillStyle = 'rgba(25,30,45,.6)'; o.fill();
    text(h.text, W / 2, top + 74, 17, '#fff', 'rgba(0,0,0,0)', 0);
  }
  if (!moved && G.hint === 0) text('ВЕДИ ПАЛЬЦЕМ', W / 2, H * .9, Math.min(36, W * .085), '#ffffff', '#1d3557', 7);
  if (joy) {
    o.beginPath(); o.arc(joy.ox, joy.oy, JOY_R, 0, Math.PI * 2); o.fillStyle = 'rgba(255,255,255,.22)'; o.fill();
    o.lineWidth = 4; o.strokeStyle = 'rgba(255,255,255,.75)'; o.stroke();
    let dx = joy.x - joy.ox, dy = joy.y - joy.oy; const l = Math.hypot(dx, dy), R = JOY_R;
    if (l > R) { dx = dx / l * R; dy = dy / l * R; }
    o.beginPath(); o.arc(joy.ox + dx, joy.oy + dy, 30, 0, Math.PI * 2); o.fillStyle = 'rgba(255,255,255,.9)'; o.fill();
  }
}
function padIconHud(kind, x, y) { padIcon(o, kind, x, y, 30); }

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
window.__game = { G, player, stalls, stallList, pens, convs, plants, PADS, DEFS, DEF, TRACKS, buy, buyUpgrade, update, helpers, customers, render, padVisible, padPaid, derive, save, resetFarm,
  ready: true, scene, gfx: GFX, upBtn: () => upBtn, charOf: (a) => people.get(a), fx: () => useFx, perf: () => ({ ...perf, fps: fpsEma, dpr: DPR }), setCam: (x, y) => { camX = x; camY = y; } };
document.getElementById('loading')?.remove();
uiInit();
