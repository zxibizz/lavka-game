// Offline: every game file goes into the cache on install and is served from it from then on.
// When any file in public/ changes, bump VERSION here and in game.js — otherwise devices stay on the old version.
// A new version installs in the background and takes over the next time the game is opened.
const VERSION = '0.2.2';
const CACHE = `lavka-v${VERSION}`;
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'ui.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'assets/chars/casual.glb',
  'assets/chars/farmer.glb',
  'assets/chars/hoodie.glb',
  'assets/chars/womanA.glb',
  'assets/chars/womanB.glb',
  'assets/props/chickenB.glb',
  'assets/props/coop.glb',
  'assets/props/crate.glb',
  'assets/props/fence2.glb',
  'assets/props/smallBarn.glb',
  'assets/props/stump.glb',
  'assets/props/tree1.glb',
  'assets/props/tree3.glb',
  'assets/props/woodlog.glb',
  'game.js',
  'vendor/jsm/RoundedBoxGeometry.js',
  'vendor/jsm/environments/RoomEnvironment.js',
  'vendor/jsm/loaders/GLTFLoader.js',
  'vendor/jsm/math/SimplexNoise.js',
  'vendor/jsm/postprocessing/EffectComposer.js',
  'vendor/jsm/postprocessing/GTAOPass.js',
  'vendor/jsm/postprocessing/MaskPass.js',
  'vendor/jsm/postprocessing/OutputPass.js',
  'vendor/jsm/postprocessing/Pass.js',
  'vendor/jsm/postprocessing/RenderPass.js',
  'vendor/jsm/postprocessing/ShaderPass.js',
  'vendor/jsm/shaders/CopyShader.js',
  'vendor/jsm/shaders/GTAOShader.js',
  'vendor/jsm/shaders/OutputShader.js',
  'vendor/jsm/shaders/PoissonDenoiseShader.js',
  'vendor/jsm/utils/BufferGeometryUtils.js',
  'vendor/jsm/utils/SkeletonUtils.js',
  'vendor/nunito-cyrillic-900-normal.woff2',
  'vendor/nunito-latin-900-normal.woff2',
  'vendor/three.module.min.js',
  'view.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lavka-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('/healthz')) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const page = await c.match('index.html');
        if (page) return page;
      }
      return fetch(req);
    }),
  );
});
