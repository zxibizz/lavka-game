'use strict';
// Bump together with VERSION in sw.js whenever anything in public/ changes.
const VERSION = '0.4.0';
// Game state and simulation. No rendering here: view.js draws the world, ui.js the cards and menus.
// One persistent farm in real time: crops grow, animals lay and workshops cook by the wall clock,
// also while the game is closed. The heroine carries harvests to the barn; workshops and the stalls
// take what they need from the barn. Everything is placed on a grid and can be moved.
let camX = 16, camY = 12;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const near = (a, x, y, r) => Math.hypot(a.x - x, a.y - y) < r;
const wall = () => Date.now() / 1000; // seconds, real time (tests replace Date)

// ---------- world ----------
const WORLD = { x0: -2, y0: -10, x1: 34, y1: 25.4 };
const BUILD = { x0: 0, y0: -8, x1: 32, y1: 16 };   // buildable cells (integer grid), the market strip is below
const ROAD_Y = 26.5, ROAD_X0 = WORLD.x0 - 3, ROAD_X1 = WORLD.x1 + 3;
const STALL_SLOTS = [16, 9.5, 22.5];               // market row, x of each stall (y = 19)

const ITEM = {
  wheat: { h: .2, price: 3, name: 'Пшеница' }, carrot: { h: .2, price: 7, name: 'Морковь' }, corn: { h: .22, price: 10, name: 'Кукуруза' },
  strawberry: { h: .18, price: 15, name: 'Клубника' }, pumpkin: { h: .34, price: 22, name: 'Тыква' },
  egg: { h: .25, price: 5, name: 'Яйца' }, milk: { h: .34, price: 10, name: 'Молоко' },
  flour: { h: .3, price: 9, name: 'Мука' }, bread: { h: .2, price: 22, name: 'Хлеб' }, pie: { h: .15, price: 48, name: 'Пирог' },
  cream: { h: .28, price: 16, name: 'Сливки' }, cheese: { h: .17, price: 32, name: 'Сыр' }, juice: { h: .32, price: 25, name: 'Сок' },
  cake: { h: .26, price: 85, name: 'Торт' }, pumpkinPie: { h: .16, price: 70, name: 'Тыквенный пирог' },
};
const CROPS = {
  wheat: { t: 120, seed: 0, yield: 2, xp: 1, lvl: 1 }, carrot: { t: 300, seed: 2, yield: 2, xp: 2, lvl: 4 },
  corn: { t: 600, seed: 3, yield: 2, xp: 3, lvl: 6 }, strawberry: { t: 1200, seed: 5, yield: 2, xp: 4, lvl: 7 },
  pumpkin: { t: 2400, seed: 8, yield: 2, xp: 6, lvl: 9 },
};
const ANIMALS = { chicken: { item: 'egg', t: 240, xp: 1, name: 'курица', price: k => 30 * (k + 1), max: 6 }, cow: { item: 'milk', t: 480, xp: 2, name: 'корова', price: k => 150 * (k + 1), max: 5 } };
const RECIPES = {
  mill: [{ out: 'flour', in: { wheat: 2 }, t: 120, xp: 2 }],
  bakery: [{ out: 'bread', in: { flour: 1, egg: 1 }, t: 300, xp: 4 }, { out: 'pie', in: { flour: 1, egg: 1, strawberry: 1 }, t: 900, xp: 8, lvl: 7 }],
  dairy: [{ out: 'cream', in: { milk: 1 }, t: 240, xp: 3 }, { out: 'cheese', in: { milk: 2 }, t: 720, xp: 7 }],
  juicer: [{ out: 'juice', in: { carrot: 2 }, t: 420, xp: 5 }],
  sweets: [{ out: 'cake', in: { flour: 1, cream: 1, strawberry: 1 }, t: 1800, xp: 15 }, { out: 'pumpkinPie', in: { flour: 1, pumpkin: 1, egg: 1 }, t: 1200, xp: 12, lvl: 9 }],
};
// what can be built: kind decides the behaviour; w x h cells; buildings with a front spot (barn, pens, workshops)
// keep the row of cells in front of them free
const CATALOG = {
  field: { name: 'Грядка', cat: 'farm', kind: 'field', w: 2, h: 2, lvl: 1, cost: n => 10 + 6 * n, limit: L => Math.min(40, 4 + 2 * L), icon: 'field' },
  coop: { name: 'Курятник', cat: 'farm', kind: 'pen', animal: 'chicken', w: 4, h: 3, lvl: 1, cost: n => 150 * (n + 1), limit: L => (L >= 8 ? 2 : 1), icon: 'chick' },
  cowshed: { name: 'Коровник', cat: 'farm', kind: 'pen', animal: 'cow', w: 5, h: 4, lvl: 4, cost: n => 400 * (n + 1), limit: L => (L >= 10 ? 2 : 1), icon: 'cow' },
  stall: { name: 'Прилавок', cat: 'farm', kind: 'stall', lvl: 1, cost: n => [0, 200, 800][n], limit: L => (L >= 6 ? 3 : L >= 3 ? 2 : 1), icon: 'stall' },
  barn: { name: 'Амбар', cat: 'farm', kind: 'barn', w: 4, h: 3, lvl: 99, cost: () => 0, limit: () => 1, icon: 'barn' },
  mill: { name: 'Мельница', cat: 'factory', kind: 'factory', w: 3, h: 3, lvl: 2, cost: () => 120, limit: () => 1, icon: 'mill' },
  bakery: { name: 'Пекарня', cat: 'factory', kind: 'factory', w: 3, h: 3, lvl: 3, cost: () => 300, limit: () => 1, icon: 'bread' },
  dairy: { name: 'Молочная', cat: 'factory', kind: 'factory', w: 3, h: 3, lvl: 5, cost: () => 600, limit: () => 1, icon: 'cheese' },
  juicer: { name: 'Соковарня', cat: 'factory', kind: 'factory', w: 3, h: 3, lvl: 6, cost: () => 900, limit: () => 1, icon: 'juice' },
  sweets: { name: 'Кондитерская', cat: 'factory', kind: 'factory', w: 3, h: 3, lvl: 8, cost: () => 1800, limit: () => 1, icon: 'cake' },
  flowers: { name: 'Клумба', cat: 'decor', kind: 'decor', w: 1, h: 1, lvl: 2, cost: () => 20, limit: () => 99, cozy: 1, icon: 'flower' },
  bench: { name: 'Скамейка', cat: 'decor', kind: 'decor', w: 1, h: 1, lvl: 2, cost: () => 30, limit: () => 99, cozy: 2, icon: 'bench' },
  lamp: { name: 'Фонарь', cat: 'decor', kind: 'decor', w: 1, h: 1, lvl: 3, cost: () => 50, limit: () => 99, cozy: 2, icon: 'lamp', solid: true },
  tree: { name: 'Дерево', cat: 'decor', kind: 'decor', w: 1, h: 1, lvl: 3, cost: () => 40, limit: () => 99, cozy: 2, icon: 'tree', solid: true },
  well: { name: 'Колодец', cat: 'decor', kind: 'decor', w: 2, h: 2, lvl: 4, cost: () => 200, limit: () => 99, cozy: 6, icon: 'well', solid: true },
  fountain: { name: 'Фонтан', cat: 'decor', kind: 'decor', w: 2, h: 2, lvl: 6, cost: () => 600, limit: () => 99, cozy: 12, icon: 'fountain', solid: true },
};
const hasFront = t => ['barn', 'pen', 'factory'].includes(CATALOG[t].kind);

// ---------- levels ----------
const LEVEL_XP = [0, 15, 60, 140, 260, 430, 660, 960, 1350, 1850, 2500, 3300, 4300, 5500, 7000];
const xpFor = L => L - 1 < LEVEL_XP.length ? LEVEL_XP[L - 1] : Math.round(LEVEL_XP.at(-1) * Math.pow(1.3, L - LEVEL_XP.length));

const G = { coins: 0, xp: 0, lvl: 1, rep: 3, barn: {}, barnCap: 40, up: {}, served: 0, task: 0, taskN: 0, spawnT: 2, cozy: 0, paused: false, seed: 'wheat', stalls: 1, cashiers: [], workers: 0, hint: 0, levelUp: null };
const lvl = key => G.up[key] || 0;
let B = []; // placed buildings: { id, type, x, y, ...state }
let nextId = 1;

function mkActor(x, y, kind) {
  return { x, y, vx: 0, vy: 0, face: 1, dir: Math.PI / 2, stack: [], cap: 8, walk: 0, sx: 0, sy: 0, svx: 0, svy: 0, tx: 0, chopT: 0, chopping: 0, kind };
}
const player = mkActor(16, 15.6, 'player');
player.speed = 5.2;
const customers = [], helpers = [], flyers = [], floats = [], parts = [];
let now = 0; // seconds since the page opened, for animations

// ---------- barn ----------
const barnUsed = () => Object.values(G.barn).reduce((a, b) => a + b, 0);
const have = t => G.barn[t] || 0;
function barnAdd(t, n = 1) { G.barn[t] = have(t) + n; }
function barnTake(t, n = 1) { if (have(t) < n) return false; G.barn[t] -= n; if (!G.barn[t]) delete G.barn[t]; return true; }
const BARN_UP = [80, 200, 450, 900, 1600, 2500, 4000];
const BAG_UP = [40, 90, 180, 350, 600, 1000];
const BOOTS_UP = [60, 150, 350, 700];
const SLOT_UP = [50, 150, 400];
const CASHIER_COST = [100, 400, 1000];
const WORKER_COST = [500, 1500];
const workerLimit = () => (G.lvl >= 9 ? 2 : G.lvl >= 6 ? 1 : 0);

// ---------- placement grid ----------
const fp = b => ({ x: b.x, y: b.y, w: CATALOG[b.type].w, h: CATALOG[b.type].h });
const center = b => { const f = fp(b); return { x: f.x + f.w / 2, y: f.y + f.h / 2 }; };
const front = b => { const f = fp(b); return { x: f.x + f.w / 2, y: f.y + f.h + .7 }; };
// cells a building would take: body cells and (for buildings with a front spot) the apron row in front
function cellsOf(type, x, y) {
  const { w, h } = CATALOG[type], body = [], apron = [];
  for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) body.push([x + i, y + j]);
  if (hasFront(type)) for (let i = Math.floor(w / 2) - 1; i <= Math.ceil(w / 2); i++) if (i >= 0 && i < w) apron.push([x + i, y + h]);
  return { body, apron };
}
function canPlace(type, x, y, ignore) {
  const c = CATALOG[type];
  if (x < BUILD.x0 || y < BUILD.y0 || x + c.w > BUILD.x1 || y + c.h > BUILD.y1) return false;
  const { body, apron } = cellsOf(type, x, y);
  if (apron.some(([, j]) => j >= BUILD.y1)) return false;
  const occ = new Map();
  for (const b of B) if (b !== ignore && CATALOG[b.type].w) {
    const o = cellsOf(b.type, b.x, b.y);
    for (const [i, j] of o.body) occ.set(i + ',' + j, 'B');
    for (const [i, j] of o.apron) if (!occ.has(i + ',' + j)) occ.set(i + ',' + j, 'A');
  }
  if (body.some(([i, j]) => occ.has(i + ',' + j))) return false;
  if (apron.some(([i, j]) => occ.get(i + ',' + j) === 'B')) return false;
  // solid buildings may not land on the heroine
  const k = CATALOG[type].kind;
  if (k !== 'field' && !(k === 'decor' && !c.solid) && body.some(([i, j]) => player.x > i - .3 && player.x < i + 1.3 && player.y > j - .3 && player.y < j + 1.3)) return false;
  return true;
}
// a free spot near (cx, cy), spiralling out
function freeSpot(type, cx, cy, ignore) {
  const c = CATALOG[type];
  for (let r = 0; r < 30; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const x = Math.round(cx - c.w / 2) + dx, y = Math.round(cy - c.h / 2) + dy;
    if (canPlace(type, x, y, ignore)) return { x, y };
  }
  return null;
}
const countOf = type => B.filter(b => b.type === type).length;
const builtCount = type => (type === 'stall' ? G.stalls : countOf(type));
function canBuy(type) {
  const c = CATALOG[type];
  if (G.lvl < c.lvl) return 'lvl';
  if (builtCount(type) >= c.limit(G.lvl)) return 'limit';
  if (G.coins < c.cost(builtCount(type))) return 'coins';
  return 'ok';
}
function addBuilding(type, x, y, extra = {}) {
  const b = { id: nextId++, type, x, y, born: now };
  const k = CATALOG[type].kind;
  if (k === 'field') Object.assign(b, { crop: null, at: 0, left: 0 });
  if (k === 'pen') Object.assign(b, { n: 1, t: wall(), stock: 0, animals: [] });
  if (k === 'factory') Object.assign(b, { queue: [], slots: 2, out: [] });
  Object.assign(b, extra);
  B.push(b); derive();
  return b;
}
// build: pay and place (view.js picks the cell in placement mode)
function build(type, x, y) {
  if (canBuy(type) !== 'ok') return null;
  const c = CATALOG[type], cost = c.cost(builtCount(type));
  if (type === 'stall') {
    G.coins -= cost; G.stalls++;
    const st = stallState[G.stalls - 1]; burst(st.x, st.y, .5, ['#ffd84d', '#ff7a59', '#7ed0ff', '#ffffff'], 26);
    addXp(Math.ceil(cost / 10)); event('build', type); derive(); save(); return { type };
  }
  if (!canPlace(type, x, y)) return null;
  G.coins -= cost;
  const b = addBuilding(type, x, y);
  const m = center(b);
  burst(m.x, m.y, .4, ['#ffd84d', '#ff7a59', '#7ed0ff', '#ffffff', '#9be15d'], 26);
  addXp(Math.max(1, Math.ceil(cost / 10)));
  event('build', type);
  save();
  return b;
}
function moveBuilding(b, x, y) {
  if (!canPlace(b.type, x, y, b)) return false;
  b.x = x; b.y = y; b.born = now;
  if (CATALOG[b.type].kind === 'pen') { b.animals.length = 0; }
  derive(); save(); return true;
}

// ---------- derived state ----------
let SOLIDS = [];
function derive() {
  player.cap = 8 + 2 * lvl('bag');
  player.speed = 5.2 * (1 + .08 * lvl('boots'));
  G.barnCap = 40 + 25 * lvl('barn');
  G.cozy = Math.min(100, B.reduce((s, b) => s + (CATALOG[b.type].cozy || 0), 0));
  for (const b of B) if (CATALOG[b.type].kind === 'pen') { while (b.animals.length < b.n) addAnimal(b); b.animals.length = b.n; }
  while (helpers.length < G.workers) addWorker();
  const r = [];
  for (const b of B) {
    const c = CATALOG[b.type];
    if (c.kind === 'field' || (c.kind === 'decor' && !c.solid)) continue;
    const ins = c.kind === 'decor' ? .25 : .12;
    r.push([b.x + ins, b.y + ins, b.x + c.w - ins, b.y + c.h - ins]);
  }
  for (let i = 0; i < G.stalls; i++) { const x = STALL_SLOTS[i]; r.push([x - 1.15, 19 - .45, x + 1.15, 19 + .45]); }
  SOLIDS = r;
}
function addAnimal(b) {
  const [x0, y0, x1, y1] = penArea(b);
  b.animals.push({ x: rnd(x0, x1), y: rnd(y0, y1), tx: (x0 + x1) / 2, ty: (y0 + y1) / 2, t: 0, face: 1, peck: 0 });
}
const penArea = b => { const f = fp(b); return [f.x + .7, f.y + 1.3, f.x + f.w - .7, f.y + f.h - .6]; };

function collide(a, rad) {
  for (const [x0, y0, x1, y1] of SOLIDS) {
    const cx = clamp(a.x, x0, x1), cy = clamp(a.y, y0, y1);
    const dx = a.x - cx, dy = a.y - cy, d = Math.hypot(dx, dy);
    if (d < rad) {
      if (d < 1e-4) {
        const opts = [[a.x - x0, -1, 0], [x1 - a.x, 1, 0], [a.y - y0, 0, -1], [y1 - a.y, 0, 1]].sort((p, q) => p[0] - q[0])[0];
        a.x += opts[1] * (opts[0] + rad); a.y += opts[2] * (opts[0] + rad);
      } else { a.x = cx + dx / d * rad; a.y = cy + dy / d * rad; }
    }
  }
  a.x = clamp(a.x, WORLD.x0 + .5, WORLD.x1 - .5); a.y = clamp(a.y, WORLD.y0 + .5, WORLD.y1 - .4);
}

// ---------- stacks & effects ----------
const stackH = (a, n = a.stack.length) => { let h = 0; for (let i = 0; i < n; i++) h += ITEM[a.stack[i].t].h; return h; };
function stackPos(a, i) {
  const k = (i / 10) ** 2, bx = Math.cos(a.dir), by = Math.sin(a.dir);
  return [a.x - bx * .46 + a.sx * k, a.y - by * .46 + a.sy * k, .92 + stackH(a, i), a.dir];
}
function pushStack(a, t, from) {
  const i = a.stack.length;
  a.stack.push({ t, land: now + .22 });
  flyers.push({ t, from, to: () => stackPos(a, Math.min(i, a.stack.length - 1)), age: 0, dur: .22 });
}
function popStack(a, to) {
  const s = a.stack.pop(); if (!s) return null;
  flyers.push({ t: s.t, from: stackPos(a, a.stack.length), to, age: 0, dur: .22 });
  return s.t;
}
function fly(t, from, to, dur = .25) { flyers.push({ t, from, to, age: 0, dur }); }
function floatText(x, y, z, text, color = '#fff') { floats.push({ x, y, z, text, color, t: 0 }); }
function burst(x, y, z, colors, n = 18) {
  for (let i = 0; i < n; i++) parts.push({ x, y, z, vx: rnd(-2, 2), vy: rnd(-1.4, 1.4), vz: rnd(2, 5), life: rnd(.6, 1.1), c: colors[i % colors.length] });
}
function pilePos(x, y, i, h) {
  const col = i % 3, row = Math.floor(i / 3) % 3, layer = Math.floor(i / 9);
  return [x + (col - 1) * .3 + (layer % 2) * .1, y + (row - 1) * .26, layer * h * .8];
}
const stallState = []; // per stall slot: position, customers' queue, coins on the counter
for (let i = 0; i < STALL_SLOTS.length; i++) {
  const x = STALL_SLOTS[i];
  stallState.push({ i, x, y: 19, counter: { x: x + .2, y: 17.75 }, cz: { x: x + 1.5, y: 17.7 }, queue: [], coins: 0, t: 0 });
}
function coinPos(st, i) {
  const col = Math.floor(i / 10) % 4, z = (i % 10) * .05 + Math.floor(i / 40) * .5;
  return [st.cz.x + (col % 2 - .5) * .3, st.cz.y + (col > 1 ? .2 : -.1), z];
}

// ---------- xp, levels, tasks ----------
function addXp(n) {
  G.xp += n;
  while (G.xp >= xpFor(G.lvl + 1)) {
    G.lvl++;
    G.levelUp = { lvl: G.lvl, unlocks: unlocksAt(G.lvl) };
    burst(player.x, player.y, 1.5, ['#ffd84d', '#ff7a59', '#7ed0ff', '#ffffff', '#9be15d'], 40);
    floatText(player.x, player.y, 2.6, 'Уровень ' + G.lvl + '!', '#ffe46b');
    derive();
  }
}
function unlocksAt(L) {
  const r = [];
  for (const c of Object.values(CATALOG)) if (c.lvl === L) r.push({ icon: c.icon, name: c.name });
  for (const [k, c] of Object.entries(CROPS)) if (c.lvl === L) r.push({ icon: k, name: ITEM[k].name });
  for (const rs of Object.values(RECIPES)) for (const rc of rs) if (rc.lvl === L) r.push({ icon: rc.out, name: ITEM[rc.out].name });
  for (const c of Object.values(CATALOG)) if (c.lvl < L && c.limit(L) > c.limit(L - 1) && c.limit(L) < 40) r.push({ icon: c.icon, name: c.name + ': ещё один' });
  if (L === 6 || L === 9) r.push({ icon: 'person', name: 'Работник' });
  if (L === 2) r.push({ icon: 'person', name: 'Продавец' });
  return r;
}
// a short story of first steps, then endless small goals made from what the farm can do
const TASKS = [
  { text: 'Собери пшеницу', ev: 'harvest', what: 'wheat', n: 4, coins: 10, xp: 3 },
  { text: 'Отнеси урожай в амбар', ev: 'store', n: 4, coins: 10, xp: 3 },
  { text: 'Продай покупателям', ev: 'sell', n: 3, coins: 15, xp: 4 },
  { text: 'Посади пшеницу', ev: 'plant', what: 'wheat', n: 4, coins: 10, xp: 3 },
  { text: 'Собери яйца', ev: 'collect', what: 'egg', n: 2, coins: 10, xp: 3 },
  { text: 'Построй грядку', ev: 'build', what: 'field', n: 1, coins: 15, xp: 4 },
  { text: 'Построй мельницу', ev: 'build', what: 'mill', n: 1, coins: 30, xp: 6 },
  { text: 'Смели муку', ev: 'make', what: 'flour', n: 2, coins: 25, xp: 6 },
  { text: 'Купи ещё курицу', ev: 'animal', what: 'chicken', n: 1, coins: 20, xp: 5 },
  { text: 'Поставь скамейку', ev: 'build', what: 'bench', n: 1, coins: 20, xp: 5 },
  { text: 'Построй пекарню', ev: 'build', what: 'bakery', n: 1, coins: 40, xp: 8 },
  { text: 'Испеки хлеб', ev: 'make', what: 'bread', n: 3, coins: 40, xp: 8 },
  { text: 'Открой второй прилавок', ev: 'build', what: 'stall', n: 1, coins: 50, xp: 10 },
  { text: 'Найми продавца', ev: 'cashier', n: 1, coins: 60, xp: 10 },
  { text: 'Посади морковь', ev: 'plant', what: 'carrot', n: 4, coins: 40, xp: 8 },
  { text: 'Построй коровник', ev: 'build', what: 'cowshed', n: 1, coins: 60, xp: 10 },
  { text: 'Собери молоко', ev: 'collect', what: 'milk', n: 3, coins: 50, xp: 10 },
  { text: 'Построй молочную', ev: 'build', what: 'dairy', n: 1, coins: 80, xp: 12 },
  { text: 'Сделай сыр', ev: 'make', what: 'cheese', n: 2, coins: 80, xp: 12 },
  { text: 'Построй соковарню', ev: 'build', what: 'juicer', n: 1, coins: 100, xp: 15 },
  { text: 'Найми работника', ev: 'worker', n: 1, coins: 100, xp: 15 },
];
const isCrop = t => !!CROPS[t];
const isAnimal = t => Object.values(ANIMALS).some(a => a.item === t);
function producible(t) {
  if (CROPS[t]) return G.lvl >= CROPS[t].lvl;
  for (const b of B) {
    const c = CATALOG[b.type];
    if (c.kind === 'pen' && ANIMALS[c.animal].item === t) return true;
    if (c.kind === 'factory' && RECIPES[b.type].some(r => r.out === t && G.lvl >= (r.lvl || 1))) return true;
  }
  return false;
}
// after the story: alternate making and selling things the farm already makes
function genTask(k) {
  const made = Object.keys(ITEM).filter(producible);
  const t = made[(k * 7) % made.length] || 'wheat';
  const n = 3 + Math.min(12, Math.floor(k / 4));
  const sell = k % 2 === 1;
  const ev = sell ? 'sell' : isCrop(t) ? 'harvest' : isAnimal(t) ? 'collect' : 'make';
  return { text: (sell ? 'Продай: ' : ev === 'make' ? 'Сделай: ' : 'Собери: ') + ITEM[t].name.toLowerCase(), ev, what: t, n,
    coins: Math.round(ITEM[t].price * n * .6), xp: Math.max(4, Math.round(n * 2 + k / 2)) };
}
const curTask = () => (G.task < TASKS.length ? TASKS[G.task] : genTask(G.task - TASKS.length));
function event(ev, what, n = 1) {
  const t = curTask();
  if (t.ev !== ev || (t.what && t.what !== what)) return;
  G.taskN += n;
  if (G.taskN >= t.n) {
    G.coins += t.coins; addXp(t.xp);
    floatText(player.x, player.y, 2.2, `Задание! +${t.coins}`, '#ffe46b');
    burst(player.x, player.y, 1.4, ['#ffd84d', '#ffffff', '#9be15d'], 20);
    G.task++; G.taskN = 0;
    skipDoneTasks();
  }
}
// skip story steps that are already done (the building exists, the worker is hired...)
function skipDoneTasks() {
  for (let guard = 0; guard < 8 && G.task < TASKS.length; guard++) {
    const t = TASKS[G.task];
    const done = (t.ev === 'build' && t.what !== 'stall' && countOf(t.what) >= t.n) || (t.ev === 'build' && t.what === 'stall' && G.stalls > 1)
      || (t.ev === 'cashier' && G.cashiers.some(Boolean)) || (t.ev === 'worker' && G.workers > 0);
    if (!done) break;
    G.task++; G.taskN = 0;
  }
}

// ---------- real-time state ----------
function fieldState(b, s = wall()) {
  if (!b.crop) return 'empty';
  return s >= b.at + CROPS[b.crop].t ? 'ripe' : 'growing';
}
function plant(b, crop) {
  const c = CROPS[crop];
  if (!c || G.lvl < c.lvl || fieldState(b) !== 'empty' || G.coins < c.seed) return false;
  G.coins -= c.seed; b.crop = crop; b.at = wall(); b.left = c.yield;
  const m = center(b); burst(m.x, m.y, .2, ['#8a5a2b', '#7cc44f'], 5);
  event('plant', crop);
  return true;
}
const penCap = b => 4 + 3 * b.n;
function penTick(b, s = wall()) {
  const a = ANIMALS[CATALOG[b.type].animal];
  if (b.stock >= penCap(b)) { b.t = s; return; }
  const period = a.t / b.n, k = Math.floor((s - b.t) / period);
  if (k > 0) { b.stock = Math.min(penCap(b), b.stock + k); b.t += k * period; if (b.stock >= penCap(b)) b.t = s; }
}
const penNext = (b, s = wall()) => Math.max(0, b.t + ANIMALS[CATALOG[b.type].animal].t / b.n - s);
// the factory queue runs back to back; finished products move to the output pile while it has room
const OUT_CAP = 8;
function factoryTick(b, s = wall()) {
  while (b.queue.length && s >= b.queue[0].end && b.out.length < OUT_CAP) b.out.push(RECIPES[b.type][b.queue.shift().r].out);
  // a full pile blocks the line: the finished job waits, the ones behind it are pushed back
  if (b.queue.length && s >= b.queue[0].end) {
    const late = s - b.queue[0].end;
    for (const j of b.queue) { j.start += late; j.end += late; }
  }
}
function enqueue(b, ri) {
  const r = RECIPES[b.type][ri];
  if (!r || G.lvl < (r.lvl || 1) || b.queue.length >= b.slots) return false;
  if (!Object.entries(r.in).every(([t, n]) => have(t) >= n)) return false;
  for (const [t, n] of Object.entries(r.in)) barnTake(t, n);
  const s = wall(), start = b.queue.length ? Math.max(s, b.queue.at(-1).end) : s;
  b.queue.push({ r: ri, start, end: start + r.t });
  save();
  return true;
}
// speeding up costs coins: one coin per 30 s left, at least 1
const speedCost = left => Math.max(1, Math.ceil(left / 30));
function timeLeft(b, s = wall()) {
  const k = CATALOG[b.type].kind;
  if (k === 'field' && fieldState(b, s) === 'growing') return b.at + CROPS[b.crop].t - s;
  if (k === 'factory' && b.queue.length) return Math.max(0, b.queue[0].end - s);
  if (k === 'pen' && b.stock < penCap(b)) return penNext(b, s);
  return 0;
}
function speedUp(b) {
  const left = timeLeft(b); if (left <= 0) return false;
  const c = speedCost(left); if (G.coins < c) return false;
  G.coins -= c;
  const k = CATALOG[b.type].kind;
  if (k === 'field') b.at -= left + 1;
  else if (k === 'factory') for (const j of b.queue) { j.start -= left + .01; j.end -= left + .01; }
  else if (k === 'pen') b.t -= left + .01;
  tickAll(); save();
  return true;
}
function tickAll(s = wall()) {
  for (const b of B) {
    const k = CATALOG[b.type].kind;
    if (k === 'pen') penTick(b, s); else if (k === 'factory') factoryTick(b, s);
  }
}

// ---------- upgrades bought from cards ----------
const UPGRADES = {
  barn: { title: 'Больше места', costs: BARN_UP, text: () => `${G.barnCap} → ${G.barnCap + 25}` },
  bag: { title: 'Большая корзина', costs: BAG_UP, text: () => `несёшь ${player.cap} → ${player.cap + 2}` },
  boots: { title: 'Сапоги-скороходы', costs: BOOTS_UP, text: () => 'ходишь на 8% быстрее' },
};
function upgradeCost(key) { const u = UPGRADES[key]; return lvl(key) < u.costs.length ? u.costs[lvl(key)] : null; }
function buyUpgrade(key) {
  const c = upgradeCost(key);
  if (c === null || G.coins < c) return false;
  G.coins -= c; G.up[key] = lvl(key) + 1; derive(); save(); return true;
}
const slotCost = b => (b.slots - 2 < SLOT_UP.length ? Math.round(SLOT_UP[b.slots - 2] * (1 + CATALOG[b.type].cost(0) / 600)) : null);
function buySlot(b) { const c = slotCost(b); if (c === null || G.coins < c) return false; G.coins -= c; b.slots++; save(); return true; }
const animalCost = b => (b.n < ANIMALS[CATALOG[b.type].animal].max ? ANIMALS[CATALOG[b.type].animal].price(b.n - 1) : null);
function buyAnimal(b) {
  const c = animalCost(b); if (c === null || G.coins < c) return false;
  penTick(b); G.coins -= c; b.n++; derive(); event('animal', CATALOG[b.type].animal); save(); return true;
}
const cashierCost = i => (i < G.stalls && !G.cashiers[i] && G.lvl >= 2 ? CASHIER_COST[i] : null);
function hireCashier(i) { const c = cashierCost(i); if (c === null || G.coins < c) return false; G.coins -= c; G.cashiers[i] = true; event('cashier'); save(); return true; }
const workerCost = () => (G.workers < workerLimit() ? WORKER_COST[G.workers] : null);
function hireWorker() { const c = workerCost(); if (c === null || G.coins < c) return false; G.coins -= c; G.workers++; derive(); event('worker'); save(); return true; }

// ---------- input state (pointer listeners live in view.js) ----------
const keys = {};
addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; });
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
let joy = null;
const JOY_R = 64;

// ---------- movement ----------
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
  a.svx += (-a.vx * .14 - a.sx) * 60 * dt; a.svy += (-a.vy * .14 - a.sy) * 60 * dt;
  const damp = Math.exp(-7 * dt); a.svx *= damp; a.svy *= damp;
  a.sx += a.svx * dt; a.sy += a.svy * dt;
}
function turnTo(a, ang, dt) { let d = ang - a.dir; d = Math.atan2(Math.sin(d), Math.cos(d)); a.dir += d * Math.min(1, dt * 14); }
function walkTo(a, x, y, dt) {
  const dx = x - a.x, dy = y - a.y, d = Math.hypot(dx, dy);
  if (d < .12) { moveActor(a, 0, 0, a.speed, dt); return true; }
  const s = Math.min(1, d / .5);
  moveActor(a, dx / d * s, dy / d * s, a.speed, dt);
  return false;
}
// grid path (breadth-first) around solid buildings; fields can be walked over
function findPath(sx, sy, tx, ty) {
  const W = WORLD.x1 - WORLD.x0, H = Math.ceil(WORLD.y1 - WORLD.y0), ox = WORLD.x0, oy = WORLD.y0;
  const blocked = new Uint8Array(W * H);
  for (const [x0, y0, x1, y1] of SOLIDS) for (let i = Math.floor(x0 - ox); i < Math.ceil(x1 - ox); i++) for (let j = Math.floor(y0 - oy); j < Math.ceil(y1 - oy); j++) if (i >= 0 && j >= 0 && i < W && j < H) blocked[j * W + i] = 1;
  const cl = (v, m) => clamp(v, 0, m - 1);
  const S = [cl(Math.floor(sx - ox), W), cl(Math.floor(sy - oy), H)], T = [cl(Math.floor(tx - ox), W), cl(Math.floor(ty - oy), H)];
  const idx = (i, j) => j * W + i, prev = new Int32Array(W * H).fill(-1), q = [idx(...S)];
  blocked[idx(...S)] = 0; blocked[idx(...T)] = 0; prev[idx(...S)] = idx(...S);
  for (let h = 0; h < q.length; h++) {
    const c = q[h]; if (c === idx(...T)) break;
    const ci = c % W, cj = Math.floor(c / W);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const n = idx(ni, nj); if (blocked[n] || prev[n] >= 0) continue;
      prev[n] = c; q.push(n);
    }
  }
  if (prev[idx(...T)] < 0) return [[tx, ty]];
  const path = []; for (let c = idx(...T); c !== idx(...S); c = prev[c]) path.push([c % W + ox + .5, Math.floor(c / W) + oy + .5]);
  path.reverse(); if (path.length) path[path.length - 1] = [tx, ty]; else path.push([tx, ty]);
  return path.filter((p, i) => i === 0 || i === path.length - 1 || !((path[i - 1][0] === p[0] && path[i + 1][0] === p[0]) || (path[i - 1][1] === p[1] && path[i + 1][1] === p[1])));
}

// ---------- update ----------
function update(dt) {
  if (G.paused) return;
  now += dt;
  const s = wall();
  let ix = 0, iy = 0;
  if (keys['arrowleft'] || keys['a'] || keys['ф']) ix -= 1;
  if (keys['arrowright'] || keys['d'] || keys['в']) ix += 1;
  if (keys['arrowup'] || keys['w'] || keys['ц']) iy -= 1;
  if (keys['arrowdown'] || keys['s'] || keys['ы']) iy += 1;
  if (joy && !G.placing) {
    const jx = (joy.x - joy.ox) / JOY_R, jy = (joy.y - joy.oy) / JOY_R, l = Math.hypot(jx, jy);
    if (l > .12) { ix = jx / l; iy = jy / l; }
  }
  moveActor(player, ix, iy, player.speed, dt);
  collide(player, .3);
  if (!G.placing) {
    camX += (clamp(player.x, WORLD.x0 + 4, WORLD.x1 - 4) - camX) * Math.min(1, dt * 5);
    camY += (clamp(player.y, WORLD.y0 + 5, WORLD.y1 - 6) - camY) * Math.min(1, dt * 5);
  }
  tickAll(s);
  updateAnimals(dt);
  updateStalls(dt); updateCustomers(dt);
  for (const h of helpers) updateWorker(h, dt, s);
  playerInteract(dt, s);
  const nb = nearestBuilding(player, 1.2);
  if (G.near && G.near !== nb) G.near.fresh = false;
  G.near = nb;

  for (let i = flyers.length - 1; i >= 0; i--) { const f = flyers[i]; f.age += dt; if (f.age >= f.dur) flyers.splice(i, 1); }
  for (let i = floats.length - 1; i >= 0; i--) { floats[i].t += dt; if (floats[i].t > 1.1) floats.splice(i, 1); }
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]; p.life -= dt; p.vz -= 12 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z = Math.max(0, p.z + p.vz * dt);
    if (p.life <= 0) parts.splice(i, 1);
  }
}
function updateAnimals(dt) {
  for (const b of B) {
    if (CATALOG[b.type].kind !== 'pen') continue;
    const [x0, y0, x1, y1] = penArea(b), cow = CATALOG[b.type].animal === 'cow', sp = cow ? .55 : .8;
    for (const c of b.animals) {
      c.t -= dt;
      if (c.t <= 0) { c.tx = rnd(x0, x1); c.ty = rnd(y0, y1); c.t = rnd(2, cow ? 7 : 4); }
      c.x = clamp(c.x, x0 - .3, x1 + .3); c.y = clamp(c.y, y0 - .3, y1 + .3);
      const dx = c.tx - c.x, dy = c.ty - c.y, d = Math.hypot(dx, dy);
      if (d > .1) { c.x += dx / d * sp * dt; c.y += dy / d * sp * dt; c.face = Math.sign(dx) || c.face; c.peck = 0; } else c.peck += dt;
    }
  }
}
// the building the actor stands at: inside a field, or at the front spot of the others
function nearestBuilding(a, r) {
  let best = null, bd = r;
  for (const b of B) {
    const k = CATALOG[b.type].kind;
    if (k === 'field') { const f = fp(b); if (a.x > f.x - .1 && a.x < f.x + f.w + .1 && a.y > f.y - .1 && a.y < f.y + f.h + .1) return b; continue; }
    if (!hasFront(b.type)) continue;
    const p = front(b), d = Math.hypot(a.x - p.x, a.y - p.y);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

// ---------- the market ----------
// customers want something; the stall takes it from the barn while someone stands at the counter
const priceOf = t => ITEM[t].price;
const selling = i => G.cashiers[i] || near(player, stallState[i].counter.x, stallState[i].counter.y, .95);
function updateStalls(dt) {
  for (let i = 0; i < G.stalls; i++) {
    const st = stallState[i];
    st.t -= dt;
    const c = st.queue[0];
    if (c && c.arrived && c.got < c.want && st.t <= 0 && selling(i) && barnTake(c.item)) {
      c.got++; st.t = .3;
      fly(c.item, [st.x - .3, st.y - .2, 1], [c.x, c.y, 1.0], .3);
      if (c.got >= c.want) {
        let pay = c.want * priceOf(c.item);
        const fast = c.pat / c.patMax > .5;
        if (fast) pay += Math.ceil(pay * .2);
        fly('coin', [c.x, c.y, 1], coinPos(st, st.coins), .35);
        st.coins += pay;
        floatText(c.x, c.y, 2.1, '+' + pay + (fast ? '  чаевые!' : ''), '#ffe46b');
        G.rep = clamp(G.rep + (fast ? .08 : .04), 1, 5);
        G.served++; addXp(1);
        event('sell', c.item, c.want);
        leave(c, true);
      }
    }
  }
}
function leave(c, happy) {
  const st = stallState[c.stall];
  st.queue.splice(st.queue.indexOf(c), 1);
  c.state = 'out'; c.happy = happy; c.moodT = now;
  c.path = [[c.x + (c.from < 0 ? -.8 : .8), ROAD_Y], [c.from < 0 ? ROAD_X0 : ROAD_X1, ROAD_Y]];
}
const SHIRTS = ['#4f8fe0', '#e05f7a', '#58b368', '#f0a43a', '#9a6ad6', '#3cb7b0', '#e2c84a'];
const HAIR = ['#3b2a1e', '#6b4226', '#d9b26f', '#222', '#a0522d'];
// customers ask for what the barn has; with an empty barn nobody comes
function wantedItem() {
  const inBarn = Object.keys(G.barn).filter(t => have(t) > 0);
  return inBarn.length ? inBarn[Math.floor(Math.random() * inBarn.length)] : null;
}
function spawnCustomer() {
  const open = [];
  for (let i = 0; i < G.stalls; i++) if (stallState[i].queue.length < (G.cashiers[i] ? 4 : 3)) open.push(i);
  if (!open.length) return;
  const i = open.sort((a, b) => stallState[a].queue.length - stallState[b].queue.length + rnd(-1, 1))[0], st = stallState[i];
  const item = wantedItem(); if (!item) return;
  const want = Math.max(1, Math.min(ITEM[item].price >= 30 ? 2 : 3, 1 + Math.floor(Math.random() * 3), have(item))); // never more than the barn has
  const fromLeft = Math.random() < .5;
  const patMax = 80 * (1 + G.cozy / 150);
  const c = { x: fromLeft ? ROAD_X0 : ROAD_X1, y: ROAD_Y, vx: 0, vy: 0, face: fromLeft ? 1 : -1, dir: fromLeft ? 0 : Math.PI, walk: 0, sx: 0, sy: 0, svx: 0, svy: 0, stack: [], id: Math.random(),
    speed: 3.4, stall: i, item, want, got: 0, pat: patMax, patMax, state: 'in', arrived: false, from: fromLeft ? -1 : 1,
    shirt: SHIRTS[Math.floor(Math.random() * SHIRTS.length)], hair: HAIR[Math.floor(Math.random() * HAIR.length)], entered: false };
  st.queue.push(c); customers.push(c);
}
function updateCustomers(dt) {
  G.spawnT -= dt;
  if (G.spawnT <= 0) { spawnCustomer(); G.spawnT = 5.5 * (3 / G.rep) / Math.pow(G.stalls, .7) / (1 + G.cozy / 100) * rnd(.7, 1.3); }
  for (let i = customers.length - 1; i >= 0; i--) {
    const c = customers[i];
    if (c.state === 'in') {
      const st = stallState[c.stall], qi = st.queue.indexOf(c);
      const tx = st.x + (qi % 2 ? .12 : -.12), ty = st.y + .95 + qi * 1.0;
      if (!c.entered) { if (walkTo(c, st.x + (c.x < st.x ? -.6 : .6), ROAD_Y, dt)) c.entered = true; }
      else c.arrived = walkTo(c, tx, ty, dt) || (c.arrived && Math.hypot(tx - c.x, ty - c.y) < .3);
      if (c.arrived) { c.face = c.x < st.x ? 1 : -1; turnTo(c, -Math.PI / 2, dt); }
      if (c.entered) {
        c.pat -= dt;
        if (c.pat <= 0) { leave(c, false); floatText(c.x, c.y, 2.1, 'не дождался…', '#ffb3a8'); G.rep = clamp(G.rep - .05, 2, 5); }
      }
    } else {
      const [px, py] = c.path[0];
      if (walkTo(c, px, py, dt)) { c.path.shift(); if (!c.path.length) customers.splice(i, 1); }
    }
  }
}

// ---------- the heroine at work ----------
function harvestField(a, b) {
  if (fieldState(b) !== 'ripe' || b.left <= 0 || a.stack.length >= a.cap) return false;
  b.left--;
  const m = center(b), crop = b.crop;
  pushStack(a, crop, [m.x + rnd(-.4, .4), m.y + rnd(-.4, .4), .4]);
  burst(m.x, m.y, .5, ['#f0d264', '#7cc44f'], 4);
  addXp(CROPS[crop].xp);
  event('harvest', crop);
  if (b.left <= 0) { b.crop = null; b.at = 0; if (a === player) b.fresh = true; }
  return true;
}
function collectPen(a, b) {
  penTick(b);
  if (b.stock <= 0 || a.stack.length >= a.cap) return false;
  const p = front(b), an = ANIMALS[CATALOG[b.type].animal];
  b.stock--; pushStack(a, an.item, pilePos(p.x, p.y, b.stock, ITEM[an.item].h));
  addXp(an.xp); event('collect', an.item);
  return true;
}
function collectFactory(a, b) {
  if (!b.out.length || a.stack.length >= a.cap) return false;
  const p = front(b), t = b.out.pop();
  pushStack(a, t, pilePos(p.x, p.y, b.out.length, ITEM[t].h));
  addXp(RECIPES[b.type].find(r => r.out === t).xp); event('make', t);
  factoryTick(b);
  return true;
}
function unload(a, b) {
  if (!a.stack.length) return false;
  if (barnUsed() >= G.barnCap) {
    if (a === player && (!a.fullT || now - a.fullT > 2)) { a.fullT = now; const p = front(b); floatText(p.x, p.y, 2, 'Амбар полон!', '#ffb3a8'); }
    return false;
  }
  const p = front(b), t = popStack(a, [p.x, p.y - .9, 1]);
  barnAdd(t); if (a === player) event('store', t);
  return true;
}
function playerInteract(dt, s) {
  const a = player;
  a.tx -= dt; a.chopping = Math.max(0, a.chopping - dt);
  if (a.tx <= 0) {
    const b = nearestBuilding(a, .95);
    let did = false;
    if (b) {
      const k = CATALOG[b.type].kind;
      if (k === 'field') {
        const st = fieldState(b, s);
        if (st === 'ripe') { did = harvestField(a, b); if (did) { a.chopping = .25; a.tool = 'none'; } }
        // walking onto an empty field sows the chosen seed; the field just harvested waits for a choice in the seed bar
        else if (st === 'empty' && G.seed && G.autoPlant && !b.fresh) did = plant(b, G.seed);
      } else if (k === 'pen') did = collectPen(a, b);
      else if (k === 'factory') did = collectFactory(a, b);
      else if (k === 'barn') did = unload(a, b);
    }
    if (did) a.tx = .1;
  }
  for (let i = 0; i < G.stalls; i++) {
    const st = stallState[i];
    if (st.coins > 0 && near(a, st.cz.x, st.cz.y, 1)) {
      const chunk = Math.max(1, Math.ceil(st.coins / 6));
      st.coins -= chunk; G.coins += chunk;
      fly('coin', coinPos(st, st.coins), () => [player.x, player.y, 1.2], .3);
    }
  }
}

// ---------- workers: harvest ripe fields (and sow the same again), collect eggs, milk and products, carry to the barn ----------
function addWorker() {
  const barn = B.find(b => b.type === 'barn'), p = barn ? front(barn) : { x: 16, y: 14 };
  const h = mkActor(p.x + rnd(-1, 1), p.y + .5, 'helper');
  Object.assign(h, { cap: 8, speed: 3.2, job: null, path: [], shirt: ['#e58b3a', '#7c5bc4'][helpers.length % 2] });
  helpers.push(h);
}
function workerJob(h, s) {
  if (h.stack.length >= h.cap) return null;
  const taken = new Set(helpers.filter(o => o !== h && o.job).map(o => o.job.b));
  let best = null, bd = 1e9;
  for (const b of B) {
    if (taken.has(b)) continue;
    const k = CATALOG[b.type].kind;
    const ok = (k === 'field' && fieldState(b, s) === 'ripe') || (k === 'pen' && b.stock >= 2) || (k === 'factory' && b.out.length > 0);
    if (!ok) continue;
    const p = k === 'field' ? center(b) : front(b), d = Math.hypot(p.x - h.x, p.y - h.y);
    if (d < bd) { bd = d; best = { b, x: p.x, y: p.y }; }
  }
  return best;
}
function updateWorker(h, dt, s) {
  h.tx -= dt; h.chopping = Math.max(0, h.chopping - dt);
  if (!h.job) {
    const j = workerJob(h, s);
    if (j) { h.job = j; h.path = findPath(h.x, h.y, j.x, j.y); }
    else if (h.stack.length) { const barn = B.find(b => b.type === 'barn'), p = front(barn); h.job = { b: barn, x: p.x, y: p.y, unload: true }; h.path = findPath(h.x, h.y, p.x, p.y); }
    else { moveActor(h, 0, 0, h.speed, dt); return; }
  }
  if (h.path.length) {
    const [x, y] = h.path[0];
    if (walkTo(h, x, y, dt) || Math.hypot(x - h.x, y - h.y) < .25) h.path.shift();
    return;
  }
  moveActor(h, 0, 0, h.speed, dt);
  if (h.tx > 0) return;
  const b = h.job.b, k = CATALOG[b.type].kind;
  let did = false;
  if (!B.includes(b)) did = false;
  else if (h.job.unload) did = unload(h, b);
  else if (k === 'field') {
    const crop = b.crop;
    did = harvestField(h, b);
    if (did) { h.chopping = .25; h.tool = 'none'; if (!b.crop && G.coins >= CROPS[crop].seed) plant(b, crop); }
  } else if (k === 'pen') did = collectPen(h, b);
  else if (k === 'factory') did = collectFactory(h, b);
  if (did) h.tx = .18; else h.job = null;
}

// ---------- save / load ----------
const SAVE_KEY = 'lavka-v4';
let loaded = false; // nothing is saved until load() ran: the blank start state must never overwrite a farm
function snapshot() {
  return { v: 4, G: { coins: G.coins, xp: G.xp, lvl: G.lvl, rep: G.rep, barn: G.barn, up: G.up, served: G.served, task: G.task, taskN: G.taskN, seed: G.seed, stalls: G.stalls, cashiers: G.cashiers, workers: G.workers, hint: G.hint },
    B: B.map(b => { const { animals, born, fresh, ...rest } = b; return rest; }), nextId,
    stalls: stallState.map(s => s.coins), stack: player.stack.map(s => s.t), px: player.x, py: player.y, saved: wall() };
}
function save() { if (!loaded) return; try { localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot())); } catch (e) {} }
function newFarm() {
  Object.assign(G, { coins: 30, xp: 0, lvl: 1, rep: 3, barn: {}, up: {}, served: 0, task: 0, taskN: 0, spawnT: 2, seed: 'wheat', stalls: 1, cashiers: [], workers: 0, hint: 0, levelUp: null, placing: null, autoPlant: true, away: 0 });
  B = []; nextId = 1;
  customers.length = 0; helpers.length = 0; flyers.length = 0; floats.length = 0; parts.length = 0;
  for (const st of stallState) { st.queue.length = 0; st.coins = 0; }
  const s = wall();
  addBuilding('barn', 14, 10);
  addBuilding('coop', 5, 7, { stock: 2 });
  for (const [x, y] of [[21, 7], [23, 7], [21, 9], [23, 9]]) addBuilding('field', x, y, { crop: 'wheat', at: s - 999, left: 2 });
  Object.assign(player, { x: 16, y: 15.6, vx: 0, vy: 0, dir: -Math.PI / 2, stack: [], walk: 0, sx: 0, sy: 0, svx: 0, svy: 0, tx: 0 });
  camX = player.x; camY = player.y;
  derive();
}
function resetFarm() { newFarm(); loaded = true; save(); }
function load() {
  try { for (const k of ['lavka-meta-v1', 'lavka-run-v1', 'lavka-proto-v1', 'lavka-farm-v1']) localStorage.removeItem(k); } catch (e) {}
  newFarm();
  loaded = true;
  let d; try { d = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) {}
  if (!d || d.v !== 4) return false;
  Object.assign(G, d.G);
  B = (d.B || []).filter(b => CATALOG[b.type]).map(b => ({ ...b, born: -9, animals: [] }));
  nextId = d.nextId || B.length + 1;
  (d.stalls || []).forEach((c, i) => { if (stallState[i]) stallState[i].coins = c; });
  player.stack = (d.stack || []).filter(t => ITEM[t]).map(t => ({ t, land: 0 }));
  if (typeof d.px === 'number') { player.x = d.px; player.y = d.py; }
  camX = player.x; camY = player.y;
  derive();
  tickAll(); // catch up on everything that happened while the game was closed
  G.away = d.saved ? Math.max(0, wall() - d.saved) : 0;
  return true;
}
setInterval(save, 3000);
addEventListener('visibilitychange', () => { if (document.hidden) save(); else tickAll(); });
addEventListener('pagehide', save);

function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  if (s < 60) return s + ' с';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' мин' + (m < 10 && s % 60 ? ' ' + (s % 60) + ' с' : '');
  return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
}
