'use strict';
// Bump together with VERSION in sw.js whenever anything in public/ changes.
const VERSION = '0.2.2';
// Game state and simulation. No rendering here: view.js draws the world.
let camX = 10, camY = 14;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const near = (a, x, y, r) => Math.hypot(a.x - x, a.y - y) < r;

// ---------- world layout ----------
const MAP_W = 20, MAP_H = 25.4;
const ITEM = { egg: { h: .25, price: 2 }, wood: { h: .22, price: 3 }, pie: { h: .15, price: 8 } };
const NEST = { x: 4.5, y: 7.9 };
const OVEN_IN = { x: 8.8, y: 7.7 }, OVEN_OUT = { x: 11.2, y: 7.7 };
const ROAD_Y = 26.5;

const G = { level: -1, done: false, coins: 0, coinsEver: 0, rep: 3, bought: new Set(['eggStall']), padPaid: {}, time: 0, won: false, hint: 0, hintT: 0, spawnT: 2, served: 0,
  sold: { egg: 0, wood: 0, pie: 0 }, earned: 0, baked: 0 };
let now = 0;

function mkActor(x, y, kind) {
  return { x, y, vx: 0, vy: 0, face: 1, dir: Math.PI / 2, stack: [], cap: 6, walk: 0, sx: 0, sy: 0, svx: 0, svy: 0, tx: 0, chopT: 0, chopping: 0, kind };
}
const player = mkActor(10, 13.5, 'player');
player.speed = 5.2;

function mkStall(type, id, x) {
  return { type, id, x, y: 19, shelf: 0, max: 14, coins: 0, queue: [], t: 0,
    drop: { x: x + .2, y: 17.75 }, cz: { x: x + 1.5, y: 17.7 } };
}
const stalls = { egg: mkStall('egg', 'eggStall', 10), wood: mkStall('wood', 'woodStall', 14.6), pie: mkStall('pie', 'pieStall', 5.4) };
const stallList = Object.values(stalls);
const isOpen = st => G.bought.has(st.id);
const CASH_ID = { egg: 'cashEgg', wood: 'cashWood', pie: 'cashPie' };
const hasCashier = st => G.bought.has(CASH_ID[st.type]);
const isSelling = st => hasCashier(st) || near(player, st.drop.x, st.drop.y, .95);

const coop = { n: 1, eggs: 4, t: 0, max: 12 };
const chickens = [];
function addChicken() { chickens.push({ x: rnd(2.8, 6.5), y: rnd(4.8, 6.6), tx: 4, ty: 5, t: 0, face: 1, peck: 0 }); }

const TREE_POS = [[14.3, 3.6], [16.5, 3.1], [18.4, 4.3], [15.1, 6.0], [17.4, 6.5], [18.7, 8.4], [15.9, 8.6], [13.6, 8.0]];
const trees = TREE_POS.map(([x, y]) => ({ x, y, logs: 3, regrow: 0, shake: 0 }));
const TREE_REGROW = 10;

const oven = { egg: 0, wood: 0, pies: 0, cook: 0, max: 6, outMax: 12 };

const customers = [];
const helpers = [];
const flyers = [], floats = [], parts = [];

const PADS = [
  { id: 'chick2', x: 8.4, y: 4.6, cost: 10, label: 'Курица', icon: 'chick', req: [] },
  { id: 'cashEgg', x: 10.2, y: 16.0, cost: 30, label: 'Продавец', icon: 'person', req: ['chick2'] },
  { id: 'grove', x: 16.2, y: 5.8, cost: 25, label: 'Роща', icon: 'tree', req: ['chick2'] },
  { id: 'woodStall', x: 14.6, y: 19, cost: 30, label: 'Прилавок дров', icon: 'wood', req: ['grove'] },
  { id: 'bag1', x: 7.4, y: 12.6, cost: 35, label: 'Корзина +4', icon: 'bag', req: ['grove'] },
  { id: 'chick3', x: 8.4, y: 4.6, cost: 45, label: 'Курица', icon: 'chick', req: ['chick2', 'woodStall'] },
  { id: 'boots', x: 12.6, y: 12.6, cost: 50, label: 'Сапоги-скороходы', icon: 'boots', req: ['woodStall'] },
  { id: 'oven', x: 10, y: 5.6, cost: 80, label: 'Пекарня', icon: 'pie', req: ['woodStall'] },
  { id: 'pieStall', x: 5.4, y: 19, cost: 70, label: 'Прилавок пирогов', icon: 'pie', req: ['oven'] },
  { id: 'helper', x: 4.6, y: 11.4, cost: 120, label: 'Помощник: яйца', icon: 'person', req: ['pieStall'] },
  { id: 'bag2', x: 7.4, y: 12.6, cost: 120, label: 'Корзина +6', icon: 'bag', req: ['bag1', 'pieStall'] },
  { id: 'chick4', x: 8.4, y: 4.6, cost: 110, label: 'Курица', icon: 'chick', req: ['chick3', 'helper'] },
  { id: 'helper2', x: 4.6, y: 11.4, cost: 220, label: 'Помощник: дрова', icon: 'person', req: ['helper'] },
    { id: 'cashWood', x: 14.8, y: 16.0, cost: 70, label: 'Продавец', icon: 'person', req: ['woodStall'] },
  { id: 'cashPie', x: 5.6, y: 16.0, cost: 120, label: 'Продавец', icon: 'person', req: ['pieStall'] },
  { id: 'fair', x: 10, y: 14.0, cost: 500, label: 'Ярмарка', icon: 'flag', req: ['helper2', 'bag2', 'chick4', 'boots', 'cashEgg', 'cashWood', 'cashPie'] },
];
PADS.forEach(p => { p.stand = 0; p.payT = 0; p.pop = 0; });

// ---------- levels (missions) and meta progression ----------
// A level starts from a fresh farm: `start` is already built, only `pads` can be bought.
// Stars by time: <= gold -> 3, <= silver -> 2, otherwise 1. A level cannot be lost.
// gold/silver come from bot runs (test/calibrate.mjs): gold ~ 1.3x the bot, silver ~ 1.7x gold.
const ALL_PADS = PADS.map(p => p.id);
const LEVELS = [
  { title: 'Первые яйца', start: ['eggStall'], pads: ['chick2'], goals: [{ k: 'sell', t: 'egg', n: 10 }], reward: 10, gold: 50, silver: 85 },
  { title: 'Свой продавец', start: ['eggStall'], pads: ['chick2', 'cashEgg', 'chick3'], goals: [{ k: 'earn', n: 70 }, { k: 'build', id: 'cashEgg' }], reward: 14, gold: 95, silver: 160 },
  { title: 'Дрова на продажу', start: ['eggStall'], coins: 15, pads: ['chick2', 'grove', 'woodStall', 'bag1'], goals: [{ k: 'sell', t: 'wood', n: 12 }, { k: 'sell', t: 'egg', n: 12 }], reward: 18, gold: 160, silver: 270 },
  { title: 'Довольные покупатели', start: ['eggStall', 'grove', 'woodStall'], pads: ['chick2', 'chick3', 'cashEgg', 'bag1'], goals: [{ k: 'serve', n: 20 }, { k: 'rep', n: 4.5 }], pat: .85, reward: 22, gold: 120, silver: 205 },
  { title: 'Большая корзина', start: ['eggStall', 'grove', 'woodStall'], pads: ['chick2', 'chick3', 'bag1', 'boots', 'cashEgg', 'cashWood'], goals: [{ k: 'earn', n: 180 }], reward: 26, gold: 165, silver: 280 },
  { title: 'Пекарня', start: ['eggStall', 'grove', 'woodStall'], coins: 30, pads: ['chick2', 'oven', 'cashEgg', 'bag1'], goals: [{ k: 'build', id: 'oven' }, { k: 'bake', n: 6 }], reward: 30, gold: 150, silver: 255 },
  { title: 'Пироги к чаю', start: ['eggStall', 'grove', 'woodStall', 'oven'], pads: ['pieStall', 'cashPie', 'chick2', 'chick3', 'bag1'], goals: [{ k: 'sell', t: 'pie', n: 8 }, { k: 'serve', n: 20 }], reward: 34, gold: 375, silver: 640 },
  { title: 'Помощник', start: ['eggStall', 'grove', 'woodStall', 'oven', 'pieStall'], pads: ['helper', 'chick2', 'chick3', 'bag1', 'cashEgg'], goals: [{ k: 'build', id: 'helper' }, { k: 'earn', n: 300 }], reward: 38, gold: 245, silver: 415 },
  { title: 'Спешка', start: ['eggStall', 'grove', 'woodStall'], pads: ['chick2', 'chick3', 'cashEgg', 'cashWood', 'bag1', 'boots'], goals: [{ k: 'earn', n: 250 }], rate: 1.5, pat: .7, reward: 42, gold: 220, silver: 375 },
  { title: 'Только пироги', start: ['pieStall', 'grove', 'oven'], pads: ['chick2', 'chick3', 'chick4', 'cashPie', 'bag1', 'helper2'], goals: [{ k: 'bake', n: 15 }, { k: 'sell', t: 'pie', n: 12 }], reward: 46, gold: 120, silver: 205 },
  { title: 'Ярмарочный день', start: ['eggStall', 'grove', 'woodStall', 'oven', 'pieStall', 'chick2'], pads: ['chick3', 'chick4', 'cashEgg', 'cashWood', 'cashPie', 'helper', 'bag1', 'boots'], goals: [{ k: 'sell', t: 'egg', n: 30 }, { k: 'sell', t: 'wood', n: 20 }, { k: 'sell', t: 'pie', n: 12 }], rate: 1.3, reward: 52, gold: 500, silver: 850 },
  { title: 'Без продавцов', start: ['eggStall', 'grove', 'woodStall'], pads: ['chick2', 'chick3', 'bag1', 'boots', 'helper'], goals: [{ k: 'serve', n: 40 }, { k: 'rep', n: 4 }], rate: 1.3, reward: 56, gold: 220, silver: 375 },
  { title: 'Большой заказ', start: ['eggStall', 'grove', 'woodStall'], pads: ['chick2', 'chick3', 'chick4', 'bag1', 'bag2', 'boots', 'cashEgg', 'cashWood', 'helper', 'helper2'], goals: [{ k: 'sell', t: 'egg', n: 50 }, { k: 'sell', t: 'wood', n: 45 }], reward: 60, gold: 285, silver: 485 },
  { title: 'Строгие гости', start: ['eggStall', 'grove', 'woodStall', 'oven', 'pieStall'], pads: ['chick2', 'chick3', 'cashEgg', 'cashWood', 'cashPie', 'bag1', 'boots', 'helper'], goals: [{ k: 'serve', n: 45 }, { k: 'rep', n: 4.5 }], rate: 1.3, pat: .75, reward: 66, gold: 510, silver: 865 },
  { title: 'Ярмарка', start: ['eggStall'], pads: ALL_PADS, goals: [{ k: 'build', id: 'fair' }], reward: 80, gold: 820, silver: 1395 },
];
const LV = () => LEVELS[Math.max(0, G.level)];
const GOAL_ICON = { sell: g => g.t, earn: () => 'coin', bake: () => 'pie', serve: () => 'person', build: () => 'build', rep: () => 'star' };
function goalProgress(g) {
  if (g.k === 'sell') return [G.sold[g.t], g.n];
  if (g.k === 'earn') return [G.earned, g.n];
  if (g.k === 'bake') return [G.baked, g.n];
  if (g.k === 'serve') return [G.served, g.n];
  if (g.k === 'build') return [G.bought.has(g.id) ? 1 : 0, 1];
  if (g.k === 'rep') return [Math.floor(G.rep * 10) / 10, g.n];
  return [0, 1];
}
const goalDone = g => { const [c, n] = goalProgress(g); return c >= n; };
function goalText(g) {
  const item = { egg: 'яйца', wood: 'дрова', pie: 'пироги' };
  if (g.k === 'sell') return `Продай ${item[g.t]}: ${g.n}`;
  if (g.k === 'earn') return `Заработай ${g.n} монет`;
  if (g.k === 'bake') return `Испеки пироги: ${g.n}`;
  if (g.k === 'serve') return `Обслужи покупателей: ${g.n}`;
  if (g.k === 'build') return `Построй: ${PADS.find(p => p.id === g.id).label}`;
  if (g.k === 'rep') return `Рейтинг ${String(g.n).replace('.', ',')} звезды`;
  return '';
}

const UPGRADES = [
  { id: 'bag', title: 'Большая корзина', text: '+1 место в корзине' },
  { id: 'speed', title: 'Лёгкие кроссовки', text: 'ходишь на 6% быстрее' },
  { id: 'hens', title: 'Отборный корм', text: 'куры несутся на 8% чаще' },
  { id: 'oven', title: 'Жаркая печь', text: 'пироги пекутся на 12% быстрее' },
  { id: 'patience', title: 'Скамейка у прилавка', text: 'покупатели ждут на 10% дольше' },
  { id: 'start', title: 'Копилка', text: '+10 монет в начале уровня' },
];
const UPGRADE_COST = [15, 30, 50, 80, 120];
const UPGRADE_MAX = UPGRADE_COST.length;
const META = { bank: 0, stars: {}, best: {}, up: {} };
const up = id => META.up[id] || 0;
const META_KEY = 'lavka-meta-v1', RUN_KEY = 'lavka-run-v1';
function saveMeta() { try { localStorage.setItem(META_KEY, JSON.stringify(META)); } catch (e) {} }
function loadMeta() {
  try { const d = JSON.parse(localStorage.getItem(META_KEY)); if (d) Object.assign(META, d); } catch (e) {}
  try { localStorage.removeItem('lavka-proto-v1'); } catch (e) {} // pre-levels prototype save
}
function upgradeCost(id) { return up(id) < UPGRADE_MAX ? UPGRADE_COST[up(id)] : null; }
function buyUpgrade(id) {
  const c = upgradeCost(id);
  if (c === null || META.bank < c) return false;
  META.bank -= c; META.up[id] = up(id) + 1; saveMeta();
  return true;
}
const levelUnlocked = i => i === 0 || (META.stars[i - 1] || 0) > 0;
const totalStars = () => Object.values(META.stars).reduce((a, b) => a + b, 0);
function medalTimes(i) { const L = LEVELS[i]; return { gold: L.gold, silver: L.silver }; }
function starsFor(i, t) { const { gold, silver } = medalTimes(i); return t <= gold ? 3 : t <= silver ? 2 : 1; }

function resetWorld() {
  const L = LV();
  Object.assign(G, { done: false, coins: (L.coins || 0) + up('start') * 10, coinsEver: 0, rep: 3, bought: new Set(L.start), padPaid: {}, time: 0, won: false,
    hint: G.level === 0 && !META.stars[0] ? 0 : 5, hintT: 0, spawnT: 2, served: 0, sold: { egg: 0, wood: 0, pie: 0 }, earned: 0, baked: 0 });
  for (const st of stallList) { st.shelf = 0; st.coins = 0; st.queue.length = 0; st.t = 0; }
  Object.assign(coop, { eggs: 4, t: 0 }); chickens.length = 0;
  for (const t of trees) Object.assign(t, { logs: 3, regrow: 0, shake: 0, pop: 0 });
  Object.assign(oven, { egg: 0, wood: 0, pies: 0, cook: 0 });
  customers.length = 0; helpers.length = 0; flyers.length = 0; floats.length = 0; parts.length = 0;
  for (const p of PADS) { p.stand = 0; p.payT = 0; }
  Object.assign(player, { x: 10, y: 13.5, vx: 0, vy: 0, dir: Math.PI / 2, stack: [], walk: 0, sx: 0, sy: 0, svx: 0, svy: 0, tx: 0, chopT: 0, chopping: 0 });
  camX = clamp(player.x, 4, MAP_W - 4); camY = clamp(player.y, 5, MAP_H - 6);
  derive();
}
function startLevel(i) { G.level = i; resetWorld(); save(); }
function quitLevel() { G.level = -1; G.done = false; try { localStorage.removeItem(RUN_KEY); } catch (e) {} }
function finishLevel() {
  G.done = true;
  const i = G.level, t = G.time, stars = starsFor(i, t), first = !META.stars[i];
  const reward = Math.round(LEVELS[i].reward * stars * (first ? 1 : .5));
  META.stars[i] = Math.max(META.stars[i] || 0, stars);
  META.best[i] = Math.min(META.best[i] ?? Infinity, Math.round(t));
  META.bank += reward;
  saveMeta();
  try { localStorage.removeItem(RUN_KEY); } catch (e) {}
  const result = { level: i, time: t, stars, reward, first, best: META.best[i], hasNext: i + 1 < LEVELS.length };
  if (typeof onLevelDone === 'function') onLevelDone(result);
  return result;
}

const inLevel = id => LV().pads.includes(id) || LV().start.includes(id);
const padVisible = p => !G.bought.has(p.id) && LV().pads.includes(p.id) && p.req.every(r => G.bought.has(r) || !inLevel(r));
const padPaid = p => G.padPaid[p.id] || 0;

// solid obstacles (axis-aligned rects), active depending on what is built
function solids() {
  const r = [[1.9, 2.7, 7.1, 7.15]]; // coop fence
  for (const st of stallList) if (isOpen(st)) r.push([st.x - 1.15, st.y - .45, st.x + 1.15, st.y + .45]);
  if (G.bought.has('oven')) r.push([8.9, 4.7, 11.1, 6.5]);
  return r;
}
function collide(a, rad) {
  for (const [x0, y0, x1, y1] of solids()) {
    const cx = clamp(a.x, x0, x1), cy = clamp(a.y, y0, y1);
    const dx = a.x - cx, dy = a.y - cy, d = Math.hypot(dx, dy);
    if (d < rad) {
      if (d < 1e-4) { // inside: push out along the shallowest axis
        const opts = [[a.x - x0, -1, 0], [x1 - a.x, 1, 0], [a.y - y0, 0, -1], [y1 - a.y, 0, 1]].sort((p, q) => p[0] - q[0])[0];
        a.x += opts[1] * (opts[0] + rad); a.y += opts[2] * (opts[0] + rad);
      } else { a.x = cx + dx / d * rad; a.y = cy + dy / d * rad; }
    }
  }
  if (G.bought.has('grove')) for (const t of trees) {
    if (t.logs <= 0 && t.regrow > TREE_REGROW * .6) continue;
    const dx = a.x - t.x, dy = a.y - t.y, d = Math.hypot(dx, dy), m = rad + .28;
    if (d < m && d > 1e-4) { a.x = t.x + dx / d * m; a.y = t.y + dy / d * m; }
  }
  a.x = clamp(a.x, .5, MAP_W - .5); a.y = clamp(a.y, 1.2, MAP_H - .4);
}

// ---------- stacks & flyers ----------
const stackH = (a, n = a.stack.length) => { let h = 0; for (let i = 0; i < n; i++) h += ITEM[a.stack[i].t].h; return h; };
function stackPos(a, i) {
  const k = (i / 10) ** 2, bx = Math.cos(a.dir), by = Math.sin(a.dir);
  return [a.x - bx * .46 + a.sx * k, a.y - by * .46 + a.sy * k, .92 + stackH(a, i), a.dir];
}
function countIn(a, t) { let n = 0; for (const s of a.stack) if (s.t === t) n++; return n; }
function pushStack(a, t, from) {
  const i = a.stack.length;
  a.stack.push({ t, land: now + .22 });
  flyers.push({ t, from, to: () => stackPos(a, Math.min(i, a.stack.length - 1)), age: 0, dur: .22 });
}
function popStack(a, t, to) {
  for (let i = a.stack.length - 1; i >= 0; i--) if (a.stack[i].t === t) {
    const from = stackPos(a, i);
    a.stack.splice(i, 1);
    flyers.push({ t, from, to, age: 0, dur: .22 });
    return true;
  }
  return false;
}
function fly(t, from, to, dur = .25) { flyers.push({ t, from, to, age: 0, dur }); }
function floatText(x, y, z, text, color = '#fff') { floats.push({ x, y, z, text, color, t: 0 }); }
function burst(x, y, z, colors, n = 18) {
  for (let i = 0; i < n; i++) parts.push({ x, y, z, vx: rnd(-2, 2), vy: rnd(-1.4, 1.4), vz: rnd(2, 5), life: rnd(.6, 1.1), c: colors[i % colors.length] });
}

function shelfPos(st, i) {
  const col = i % 5, layer = Math.floor(i / 5);
  return [st.x - .4 + col * .32, st.y - .05, .76 + layer * ITEM[st.type].h];
}
function pilePos(x, y, i, h) {
  const col = i % 3, row = Math.floor(i / 3) % 3, layer = Math.floor(i / 9);
  return [x + (col - 1) * .3 + (layer % 2) * .1, y + (row - 1) * .26, layer * h * .8];
}
function coinPos(st, i) {
  const col = Math.floor(i / 10) % 4, z = (i % 10) * .05 + Math.floor(i / 40) * .5;
  return [st.cz.x + (col % 2 - .5) * .3, st.cz.y + (col > 1 ? .2 : -.1), z];
}

// ---------- derived state & buying ----------
function derive() {
  player.cap = 6 + up('bag') + (G.bought.has('bag1') ? 4 : 0) + (G.bought.has('bag2') ? 6 : 0);
  player.speed = (G.bought.has('boots') ? 6.8 : 5.2) * (1 + .06 * up('speed'));
  coop.n = 1 + ['chick2', 'chick3', 'chick4'].filter(id => G.bought.has(id)).length;
  coop.max = 8 + coop.n * 4;
  while (chickens.length < coop.n) addChicken();
  if (G.bought.has('helper') && !helpers.some(h => h.job === 'egg')) addHelper('egg');
  if (G.bought.has('helper2') && !helpers.some(h => h.job === 'wood')) addHelper('wood');
}
function addHelper(job) {
  const h = mkActor(4.6, 11.4, 'helper');
  Object.assign(h, { job, cap: 5, speed: 2.8, state: 'toSrc', wait: 0, tree: null, shirt: job === 'egg' ? '#e58b3a' : '#7c5bc4' });
  helpers.push(h);
}
function buy(p) {
  G.bought.add(p.id);
  delete G.padPaid[p.id];
  derive();
  burst(p.x, p.y, .3, ['#ffd84d', '#ff7a59', '#7ed0ff', '#ffffff', '#9be15d'], 30);
  floatText(p.x, p.y, 1.2, p.label + '!', '#fff');
  if (p.id === 'grove') trees.forEach((t, i) => { t.logs = 3; t.regrow = 0; t.pop = now + i * .07; });
  if (p.id === 'fair') G.won = true;
  save();
}


// ---------- input state (pointer listeners live in view.js) ----------
const keys = {};
addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; });
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
let joy = null;
const JOY_R = 64;


// ---------- update ----------
function moveActor(a, ix, iy, speed, dt) {
  const len = Math.hypot(ix, iy);
  if (len > 1) { ix /= len; iy /= len; }
  const tvx = ix * speed, tvy = iy * speed, k = Math.min(1, dt * 14);
  a.vx += (tvx - a.vx) * k; a.vy += (tvy - a.vy) * k;
  a.x += a.vx * dt; a.y += a.vy * dt;
  const sp = Math.hypot(a.vx, a.vy);
  if (Math.abs(a.vx) > .3) a.face = Math.sign(a.vx);
  if (sp > .4) turnTo(a, Math.atan2(a.vy, a.vx), dt);
  a.walk += sp * dt * 3.2;
  if (sp < .2) a.walk = 0;
  // stack sway: a damped spring that lags behind the movement
  a.svx += (-a.vx * .14 - a.sx) * 60 * dt; a.svy += (-a.vy * .14 - a.sy) * 60 * dt;
  const damp = Math.exp(-7 * dt); a.svx *= damp; a.svy *= damp;
  a.sx += a.svx * dt; a.sy += a.svy * dt;
}
function turnTo(a, ang, dt) {
  let d = ang - a.dir; d = Math.atan2(Math.sin(d), Math.cos(d));
  a.dir += d * Math.min(1, dt * 14);
}
function walkTo(a, x, y, dt) {
  const dx = x - a.x, dy = y - a.y, d = Math.hypot(dx, dy);
  if (d < .12) { moveActor(a, 0, 0, a.speed, dt); return true; }
  const s = Math.min(1, d / .5);
  moveActor(a, dx / d * s, dy / d * s, a.speed, dt);
  return false;
}

function update(dt) {
  if (G.level < 0 || G.done || G.paused) return;
  now += dt; G.time += dt;
  // player movement
  let ix = 0, iy = 0;
  if (keys['arrowleft'] || keys['a'] || keys['ф']) ix -= 1;
  if (keys['arrowright'] || keys['d'] || keys['в']) ix += 1;
  if (keys['arrowup'] || keys['w'] || keys['ц']) iy -= 1;
  if (keys['arrowdown'] || keys['s'] || keys['ы']) iy += 1;
  if (joy) {
    const jx = (joy.x - joy.ox) / JOY_R, jy = (joy.y - joy.oy) / JOY_R, l = Math.hypot(jx, jy);
    if (l > .12) { ix = jx / l; iy = jy / l; } // direction only: one speed however far the finger goes; screen up = north
  }
  moveActor(player, ix, iy, player.speed, dt);
  collide(player, .3);
  camX += (clamp(player.x, 4, MAP_W - 4) - camX) * Math.min(1, dt * 5);
  camY += (clamp(player.y, 5, MAP_H - 6) - camY) * Math.min(1, dt * 5);

  updateCoop(dt); updateTrees(dt); updateOven(dt);
  updateStalls(dt); updateCustomers(dt);
  for (const h of helpers) updateHelper(h, dt);
  playerInteract(dt);
  updatePads(dt);
  G.curHint = hint();
  if (LV().goals.every(goalDone)) finishLevel();

  for (let i = flyers.length - 1; i >= 0; i--) { const f = flyers[i]; f.age += dt; if (f.age >= f.dur) flyers.splice(i, 1); }
  for (let i = floats.length - 1; i >= 0; i--) { floats[i].t += dt; if (floats[i].t > 1.1) floats.splice(i, 1); }
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]; p.life -= dt; p.vz -= 12 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z = Math.max(0, p.z + p.vz * dt);
    if (p.life <= 0) parts.splice(i, 1);
  }
}

function updateCoop(dt) {
  const period = 3.2 * (1 - .08 * up('hens'));
  coop.t += dt * coop.n;
  while (coop.t >= period) {
    coop.t -= period;
    if (coop.eggs < coop.max) {
      coop.eggs++;
      const c = chickens[Math.floor(Math.random() * chickens.length)];
      if (c) fly('egg', [c.x, c.y, .2], pilePos(NEST.x, NEST.y, coop.eggs - 1, ITEM.egg.h), .4);
    }
  }
  for (const c of chickens) {
    c.t -= dt;
    if (c.t <= 0) { c.tx = rnd(2.6, 6.6); c.ty = rnd(4.7, 6.7); c.t = rnd(1.5, 4); }
    const dx = c.tx - c.x, dy = c.ty - c.y, d = Math.hypot(dx, dy);
    if (d > .1) { c.x += dx / d * .8 * dt; c.y += dy / d * .8 * dt; c.face = Math.sign(dx) || c.face; c.peck = 0; }
    else c.peck += dt;
  }
}
function updateTrees(dt) {
  for (const t of trees) {
    t.shake = Math.max(0, t.shake - dt * 4);
    if (t.logs <= 0) { t.regrow -= dt; if (t.regrow <= 0) { t.logs = 3; t.pop = now; } }
  }
}
function updateOven(dt) {
  if (!G.bought.has('oven')) return;
  if (oven.cook > 0) {
    oven.cook -= dt;
    if (Math.random() < dt * 6) parts.push({ x: 10.65 + rnd(-.05, .05), y: 5.15, z: 1.7, vx: rnd(-.1, .3), vy: 0, vz: 1.2, life: 1.2, c: 'smoke' });
    if (oven.cook <= 0) { oven.pies++; G.baked++; fly('pie', [10, 6.4, .4], pilePos(OVEN_OUT.x, OVEN_OUT.y, oven.pies - 1, ITEM.pie.h), .35); }
  } else if (oven.egg > 0 && oven.wood > 0 && oven.pies < oven.outMax) {
    oven.egg--; oven.wood--; oven.cook = 2.4 * (1 - .12 * up('oven'));
  }
}

function priceOf(t) { return ITEM[t].price; }
function updateStalls(dt) {
  for (const st of stallList) {
    if (!isOpen(st)) continue;
    st.t -= dt;
    const c = st.queue[0];
    if (c && c.arrived && c.got < c.want && st.shelf > 0 && st.t <= 0 && isSelling(st)) {
      st.shelf--; c.got++; st.t = .3; G.sold[st.type]++;
      fly(st.type, shelfPos(st, st.shelf), [c.x, c.y, 1.0], .25);
      if (c.got >= c.want) {
        let pay = c.want * priceOf(st.type);
        const fast = c.pat / c.patMax > .5;
        if (fast) pay += Math.ceil(pay * .3);
        fly('coin', [c.x, c.y, 1], coinPos(st, st.coins), .35);
        st.coins += pay;
        floatText(c.x, c.y, 2.1, '+' + pay + (fast ? '  чаевые!' : ''), '#ffe46b');
        G.rep = clamp(G.rep + (fast ? .08 : .04), 1, 5);
        G.served++;
        leave(c, true);
      }
    }
  }
}
function leave(c, happy) {
  const st = stalls[c.stall];
  st.queue.splice(st.queue.indexOf(c), 1);
  c.state = 'out'; c.happy = happy; c.moodT = now;
  const ex = Math.random() < .5 ? -1.5 : MAP_W + 1.5;
  c.path = [[c.x + (c.x < 10 ? -.8 : .8), ROAD_Y], [ex, ROAD_Y]];
}
const SHIRTS = ['#4f8fe0', '#e05f7a', '#58b368', '#f0a43a', '#9a6ad6', '#3cb7b0', '#e2c84a'];
const HAIR = ['#3b2a1e', '#6b4226', '#d9b26f', '#222', '#a0522d'];
function spawnCustomer() {
  const open = stallList.filter(st => isOpen(st) && st.queue.length < (hasCashier(st) ? 4 : 3));
  if (!open.length) return;
  open.sort((a, b) => a.queue.length - b.queue.length + rnd(-1.2, 1.2));
  const st = open[0];
  const want = st.type === 'pie' ? 1 + Math.floor(Math.random() * 2) : 1 + Math.floor(Math.random() * 3);
  const fromLeft = Math.random() < .5;
  const patMax = (45 - Math.min(12, G.served * .08)) * (LV().pat || 1) * (1 + .1 * up('patience'));
  const c = { x: fromLeft ? -1.5 : MAP_W + 1.5, y: ROAD_Y, vx: 0, vy: 0, face: fromLeft ? 1 : -1, dir: fromLeft ? 0 : Math.PI, walk: 0, sx: 0, sy: 0, svx: 0, svy: 0, stack: [], id: Math.random(),
    speed: 2.3, stall: st.type, want, got: 0, pat: patMax, patMax, state: 'in', arrived: false,
    shirt: SHIRTS[Math.floor(Math.random() * SHIRTS.length)], hair: HAIR[Math.floor(Math.random() * HAIR.length)], entered: false };
  st.queue.push(c); customers.push(c);
}
function updateCustomers(dt) {
  const openN = stallList.filter(isOpen).length;
  G.spawnT -= dt;
  if (G.spawnT <= 0) {
    spawnCustomer();
    G.spawnT = 5.5 * (3 / G.rep) / Math.pow(openN, .75) / (LV().rate || 1) * rnd(.7, 1.3);
  }
  for (let i = customers.length - 1; i >= 0; i--) {
    const c = customers[i];
    if (c.state === 'in') {
      const st = stalls[c.stall], qi = st.queue.indexOf(c);
      const tx = st.x + (qi % 2 ? .12 : -.12), ty = st.y + .95 + qi * 1.0;
      if (!c.entered) { // walk along the road first, then up to the stall
        if (walkTo(c, st.x + (c.x < st.x ? -.6 : .6), ROAD_Y, dt)) c.entered = true;
      } else c.arrived = walkTo(c, tx, ty, dt) || (c.arrived && Math.hypot(tx - c.x, ty - c.y) < .3);
      if (c.arrived) { c.face = c.x < st.x ? 1 : -1; turnTo(c, -Math.PI / 2, dt); }
      if (c.entered) {
        c.pat -= dt;
        if (c.pat <= 0) {
          leave(c, false);
          floatText(c.x, c.y, 2.1, 'не дождался…', '#ffb3a8');
          G.rep = clamp(G.rep - .2, 1, 5);
        }
      }
    } else {
      const [px, py] = c.path[0];
      if (walkTo(c, px, py, dt)) { c.path.shift(); if (!c.path.length) customers.splice(i, 1); }
    }
  }
}

function nearestTree(a, maxD) {
  if (!G.bought.has('grove')) return null;
  let best = null, bd = maxD;
  for (const t of trees) if (t.logs > 0) { const d = Math.hypot(a.x - t.x, a.y - t.y); if (d < bd) { bd = d; best = t; } }
  return best;
}
function chopTree(a, t, from) {
  t.logs--; t.shake = 1;
  if (t.logs <= 0) t.regrow = TREE_REGROW;
  pushStack(a, 'wood', [t.x, t.y, .9]);
  burst(t.x, t.y + .1, .8, ['#5fae3e', '#7cc44f'], 5);
}

function playerInteract(dt) {
  const a = player, full = a.stack.length >= a.cap;
  a.tx -= dt;
  // chopping
  const tree = full ? null : nearestTree(a, 1.05);
  if (tree) {
    a.chopping += dt; a.chopT += dt;
    a.face = tree.x > a.x ? 1 : -1; turnTo(a, Math.atan2(tree.y - a.y, tree.x - a.x), dt);
    if (a.chopT >= .42) { a.chopT = 0; chopTree(a, tree); }
  } else { a.chopT = 0; a.chopping = 0; }

  if (a.tx <= 0) {
    let did = false;
    if (near(a, NEST.x, NEST.y, .95) && coop.eggs > 0 && !full) {
      coop.eggs--; pushStack(a, 'egg', pilePos(NEST.x, NEST.y, coop.eggs, ITEM.egg.h)); did = true;
    } else if (G.bought.has('oven') && near(a, OVEN_OUT.x, OVEN_OUT.y, .95) && oven.pies > 0 && !full) {
      oven.pies--; pushStack(a, 'pie', pilePos(OVEN_OUT.x, OVEN_OUT.y, oven.pies, ITEM.pie.h)); did = true;
    } else if (G.bought.has('oven') && near(a, OVEN_IN.x, OVEN_IN.y, .95)) {
      did = feedOven(a);
    } else {
      for (const st of stallList) if (isOpen(st) && near(a, st.drop.x, st.drop.y, .95)) did = stockStall(a, st) || did;
    }
    if (did) a.tx = .085;
  }
  // coins: collect quickly in chunks
  for (const st of stallList) if (isOpen(st) && st.coins > 0 && near(a, st.cz.x, st.cz.y, 1)) {
    const chunk = Math.max(1, Math.ceil(st.coins / 6));
    st.coins -= chunk; G.coins += chunk; G.coinsEver += chunk; G.earned += chunk;
    fly('coin', coinPos(st, st.coins), () => [player.x, player.y, 1.2], .3);
  }
}
function feedOven(a) {
  const he = countIn(a, 'egg'), hw = countIn(a, 'wood');
  const pos = (t, n) => [OVEN_IN.x + (t === 'egg' ? -.3 : .3), OVEN_IN.y, n * ITEM[t].h];
  const canE = he > 0 && oven.egg < oven.max, canW = hw > 0 && oven.wood < oven.max;
  let t = null;
  if (canE && canW) t = oven.egg <= oven.wood ? 'egg' : 'wood'; else if (canE) t = 'egg'; else if (canW) t = 'wood';
  if (!t) return false;
  popStack(a, t, pos(t, oven[t])); oven[t]++;
  return true;
}
function stockStall(a, st) {
  if (st.shelf >= st.max || !countIn(a, st.type)) return false;
  popStack(a, st.type, shelfPos(st, st.shelf)); st.shelf++;
  return true;
}

function updatePads(dt) {
  for (const p of PADS) {
    if (!padVisible(p)) { p.stand = 0; continue; }
    if (!near(player, p.x, p.y, .85)) { p.stand = 0; continue; }
    p.stand += dt; p.payT -= dt;
    if (p.stand > .25 && G.coins > 0 && p.payT <= 0) {
      const left = p.cost - padPaid(p);
      const chunk = Math.min(G.coins, left, Math.max(1, Math.round(p.cost / 40)));
      G.coins -= chunk; G.padPaid[p.id] = padPaid(p) + chunk; p.payT = .045;
      fly('coin', [player.x, player.y, 1.2], [p.x, p.y, 0], .22);
      if (padPaid(p) >= p.cost) buy(p);
    }
  }
}

function updateHelper(h, dt) {
  h.tx -= dt;
  const full = h.stack.length >= h.cap;
  if (h.job === 'egg') {
    const st = stalls.egg;
    if (h.state === 'toSrc') { if (walkTo(h, NEST.x + .3, NEST.y + .35, dt)) { h.state = 'pick'; h.wait = 0; } }
    else if (h.state === 'pick') {
      moveActor(h, 0, 0, h.speed, dt);
      if (h.tx <= 0 && coop.eggs > 0 && !full) { coop.eggs--; pushStack(h, 'egg', pilePos(NEST.x, NEST.y, coop.eggs, ITEM.egg.h)); h.tx = .16; h.wait = 0; }
      if (coop.eggs === 0 && h.stack.length) h.wait += dt;
      if (full || h.wait > 1.5) h.state = 'toDst';
    } else if (h.state === 'toDst') { if (walkTo(h, st.drop.x + .35, st.drop.y - .25, dt)) h.state = 'drop'; }
    else if (h.state === 'drop') {
      moveActor(h, 0, 0, h.speed, dt);
      if (h.tx <= 0 && stockStall(h, st)) h.tx = .16;
      if (!h.stack.length) h.state = 'toSrc';
    }
  } else {
    if (h.state === 'toSrc') {
      if (!h.tree || h.tree.logs <= 0) h.tree = nearestTree(h, 99);
      if (!h.tree) { if (h.stack.length) h.state = 'toDst'; else moveActor(h, 0, 0, h.speed, dt); return; }
      if (walkTo(h, h.tree.x, h.tree.y + .75, dt)) { h.state = 'chop'; h.chopT = 0; }
    } else if (h.state === 'chop') {
      moveActor(h, 0, 0, h.speed, dt);
      h.chopping += dt;
      if (!h.tree || h.tree.logs <= 0) { h.tree = null; h.chopping = 0; h.state = full ? 'toDst' : 'toSrc'; return; }
      h.face = h.tree.x > h.x ? 1 : -1; turnTo(h, Math.atan2(h.tree.y - h.y, h.tree.x - h.x), dt);
      h.chopT += dt;
      if (h.chopT >= .6) { h.chopT = 0; chopTree(h, h.tree); }
      if (h.stack.length >= h.cap) { h.chopping = 0; h.state = 'toDst'; }
    } else if (h.state === 'toDst') {
      const st = stalls.wood;
      const toOven = G.bought.has('oven') && (st.shelf >= st.max - 2 || oven.wood < 2);
      h.dst = toOven ? 'oven' : 'stall';
      const [x, y] = toOven ? [OVEN_IN.x + .3, OVEN_IN.y + .35] : [st.drop.x + .35, st.drop.y - .25];
      if (walkTo(h, x, y, dt)) h.state = 'drop';
    } else if (h.state === 'drop') {
      moveActor(h, 0, 0, h.speed, dt);
      if (h.tx <= 0) {
        const ok = h.dst === 'oven' ? (oven.wood < oven.max && popStack(h, 'wood', [OVEN_IN.x + .3, OVEN_IN.y, oven.wood * ITEM.wood.h]) && ++oven.wood)
          : stockStall(h, stalls.wood);
        if (ok) h.tx = .16;
        else if (h.dst === 'stall' && G.bought.has('oven') && oven.wood < oven.max) h.state = 'toDst';
      }
      if (!h.stack.length) h.state = 'toSrc';
    }
  }
}

// ---------- hints ----------
function hint() {
  const eggSt = stalls.egg;
  if (G.hint === 0) {
    if (countIn(player, 'egg') >= 3 || (coop.eggs === 0 && player.stack.length)) G.hint = 1;
    return { x: NEST.x, y: NEST.y, text: 'Собери яйца у курятника' };
  }
  if (G.hint === 1) {
    if (eggSt.shelf > 0 && !countIn(player, 'egg')) G.hint = 2;
    return { x: eggSt.drop.x, y: eggSt.drop.y, text: 'Встань у прилавка: яйца лягут на полку' };
  }
  if (G.hint === 2) {
    if (G.coinsEver > 0) G.hint = 3;
    if (eggSt.coins > 0) return { x: eggSt.cz.x, y: eggSt.cz.y, text: 'Забери монеты' };
    if (!near(player, eggSt.drop.x, eggSt.drop.y, .95)) return { x: eggSt.drop.x, y: eggSt.drop.y, text: 'Продавать можно, только стоя за прилавком' };
    return { text: 'Стой за прилавком, пока покупатель берёт яйца' };
  }
  if (G.hint === 3) {
    if (G.bought.has('chick2')) { G.hint = 4; G.hintT = now; }
    const p = PADS[0];
    if (!padVisible(p)) { G.hint = 5; return null; }
    if (G.coins + padPaid(p) < p.cost) return { text: 'Копи монеты: курица стоит ' + p.cost };
    return { x: p.x, y: p.y, text: 'Встань на площадку — купишь курицу' };
  }
  if (G.hint === 4) {
    if (now - G.hintT > 5) G.hint = 5;
    return { text: 'Больше кур — больше яиц. Открывай новое!' };
  }
  // afterwards: quietly point at an affordable pad
  let best = null, bd = 1e9;
  for (const p of PADS) if (padVisible(p) && G.coins + padPaid(p) >= p.cost) {
    const d = Math.hypot(p.x - player.x, p.y - player.y); if (d < bd) { bd = d; best = p; }
  }
  if (best && bd > 1.2) return { x: best.x, y: best.y, text: null };
  return null;
}

// ---------- save / load ----------
// META (stars, savings, upgrades) is saved on every change; the level in progress — every 2 s.
function save() {
  if (G.level < 0 || G.done) return;
  const d = { level: G.level, coins: G.coins, coinsEver: G.coinsEver, rep: G.rep, bought: [...G.bought], padPaid: G.padPaid, time: G.time, won: G.won, hint: G.hint, served: G.served,
    sold: G.sold, earned: G.earned, baked: G.baked,
    shelves: Object.fromEntries(stallList.map(s => [s.type, [s.shelf, s.coins]])), eggs: coop.eggs, oven: [oven.egg, oven.wood, oven.pies],
    stack: player.stack.map(s => s.t), px: player.x, py: player.y };
  try { localStorage.setItem(RUN_KEY, JSON.stringify(d)); } catch (e) {}
}
// Loads progress; returns true when a level was in progress (it stays paused until the UI resumes it).
function load() {
  loadMeta();
  let d; try { d = JSON.parse(localStorage.getItem(RUN_KEY)); } catch (e) {}
  if (!d || !LEVELS[d.level]) { G.level = -1; return false; }
  G.level = d.level; resetWorld();
  Object.assign(G, { coins: d.coins, coinsEver: d.coinsEver, rep: d.rep, padPaid: d.padPaid || {}, time: d.time, won: d.won, hint: d.hint, served: d.served || 0,
    sold: d.sold || G.sold, earned: d.earned || 0, baked: d.baked || 0 });
  G.bought = new Set(d.bought);
  for (const s of stallList) if (d.shelves[s.type]) [s.shelf, s.coins] = d.shelves[s.type];
  coop.eggs = d.eggs; [oven.egg, oven.wood, oven.pies] = d.oven;
  player.stack = d.stack.map(t => ({ t, land: 0 })); player.x = d.px; player.y = d.py;
  camX = player.x; camY = player.y;
  derive();
  if (G.hint === 4) G.hint = 5;
  return true;
}
setInterval(save, 2000);
addEventListener('visibilitychange', () => { if (document.hidden) save(); });

function fmtClock(t) { t = Math.max(0, Math.floor(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); }
