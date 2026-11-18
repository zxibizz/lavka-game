'use strict';
// Bump together with VERSION in sw.js whenever anything in public/ changes.
const VERSION = '0.3.0';
// Game state and simulation. No rendering here: view.js draws the world, ui.js the menus.
// One persistent farm: everything bought stays bought; the world is saved continuously.
// No offline progress: while the game is closed the farm waits.
let camX = 10, camY = 14;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const near = (a, x, y, r) => Math.hypot(a.x - x, a.y - y) < r;

// ---------- world layout ----------
// x grows east, y grows south. The market strip runs along the south edge, customers walk the road below it.
const WORLD = { x0: -21, y0: -17, x1: 41, y1: 25.4 };
const ROAD_Y = 26.5, ROAD_X0 = WORLD.x0 - 3, ROAD_X1 = WORLD.x1 + 3;
const ITEM = {
  egg: { h: .25, price: 2, name: 'Яйца' }, wood: { h: .22, price: 3, name: 'Дрова' }, pie: { h: .15, price: 8, name: 'Пироги' },
  wheat: { h: .2, price: 2, name: 'Пшеница' }, flour: { h: .3, price: 6, name: 'Мука' }, pumpkin: { h: .34, price: 9, name: 'Тыквы' },
  milk: { h: .34, price: 5, name: 'Молоко' }, cheese: { h: .17, price: 15, name: 'Сыр' }, cake: { h: .26, price: 30, name: 'Торты' },
};
// Land plots. The yard is owned from the start; the rest is fenced off until its land is bought.
const ZONES = {
  yard: { rect: [0, 0, 20, 25.4], title: 'Двор' },
  field: { rect: [-21, 0, -.6, 25.4], land: 'landField', title: 'Поле' },
  pasture: { rect: [20.6, 0, 41, 25.4], land: 'landPasture', title: 'Пастбище' },
  garden: { rect: [0, -17, 20, -.6], land: 'landGarden', title: 'Огород' },
};

const G = { coins: 0, coinsEver: 0, rep: 3, built: new Set(), up: {}, padPaid: {}, time: 0, hint: 0, hintT: 0, spawnT: 2, served: 0, earned: 0, cozy: 0, paused: false, fair: false };
let now = 0;
const built = id => G.built.has(id);
const lvl = key => G.up[key] || 0; // upgrade level of a track, key = '<building>.<track>'
const zoneOpen = z => !ZONES[z].land || built(ZONES[z].land);

function mkActor(x, y, kind) {
  return { x, y, vx: 0, vy: 0, face: 1, dir: Math.PI / 2, stack: [], cap: 6, walk: 0, sx: 0, sy: 0, svx: 0, svy: 0, tx: 0, chopT: 0, chopping: 0, kind };
}
const player = mkActor(10, 13.5, 'player');
player.speed = 5.2;

// ---------- buildings ----------
// stalls: one per item, in a row along the market strip
const stalls = {};
function mkStall(item, id, x, zone, base) {
  stalls[item] = { type: item, id, x, y: 19, zone, base, shelf: 0, max: 14, coins: 0, queue: [], t: 0, drop: { x: x + .2, y: 17.75 }, cz: { x: x + 1.5, y: 17.7 } };
}
mkStall('pie', 'pieStall', 5.4, 'yard', 90); mkStall('egg', 'eggStall', 10, 'yard', 40); mkStall('wood', 'woodStall', 14.6, 'yard', 50);
mkStall('flour', 'flourStall', -4.6, 'field', 200); mkStall('pumpkin', 'pumpkinStall', -9.2, 'field', 400);
mkStall('milk', 'milkStall', 25.4, 'pasture', 300); mkStall('cheese', 'cheeseStall', 30, 'pasture', 600); mkStall('cake', 'cakeStall', 34.6, 'pasture', 1200);
const stallList = Object.values(stalls);
const isOpen = st => built(st.id);
const CASH_ID = { egg: 'cashEgg', wood: 'cashWood', pie: 'cashPie', flour: 'cashFlour', pumpkin: 'cashPumpkin', milk: 'cashMilk', cheese: 'cashCheese', cake: 'cashCake' };
const hasCashier = st => built(CASH_ID[st.type]);
const isSelling = st => hasCashier(st) || near(player, st.drop.x, st.drop.y, .95);

// pens: animals inside a fence lay into a pile in front of it
const pens = {
  coop: { id: 'coop', item: 'egg', animal: 'chicken', pile: { x: 4.5, y: 7.9 }, area: [2.6, 4.7, 6.6, 6.7], fence: [2, 2.8, 7, 7], gate: [3.7, 5.3], house: { x: 3.3, y: 3.75 },
    period: 3.2, n: 1, stock: 4, t: 0, max: 12, animals: [] },
  cows: { id: 'cows', item: 'milk', animal: 'cow', pile: { x: 27, y: 10 }, area: [23.6, 3.8, 30.4, 8], fence: [22.6, 2.6, 31.4, 9.2], gate: [26, 28], house: { x: 24.6, y: 3.6 },
    period: 5, n: 1, stock: 0, t: 0, max: 12, animals: [] },
};
const penList = Object.values(pens);

// plants: trees are chopped with an axe, crops are picked; both grow back
const plants = [];
const TREE_POS = [[14.3, 3.6], [16.5, 3.1], [18.4, 4.3], [15.1, 6.0], [17.4, 6.5], [18.7, 8.4], [15.9, 8.6], [13.6, 8.0]];
for (const [x, y] of TREE_POS) plants.push({ group: 'grove', x, y });
// wheat patches, nearest to the mill first so the field grows outwards
{ const ps = []; for (let i = 0; i < 6; i++) for (let j = 0; j < 5; j++) ps.push([-10.9 - i * 1.5, 1.9 + j * 1.25]);
  ps.sort((a, b) => Math.hypot(a[0] + 9, a[1] - 7) - Math.hypot(b[0] + 9, b[1] - 7)); for (const [x, y] of ps) plants.push({ group: 'field', x, y }); }
{ const ps = []; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) ps.push([2.6 + i * 1.7, -13.8 + j * 1.7]);
  ps.sort((a, b) => Math.hypot(a[0] - 9, a[1] + 6) - Math.hypot(b[0] - 9, b[1] + 6)); for (const [x, y] of ps) plants.push({ group: 'garden', x, y }); }
const PLANT_GROUPS = {
  grove: { item: 'wood', kind: 'tree', regrow: 10, chop: .42, count: () => TREE_POS.length, logs: () => 3 + lvl('grove.logs') },
  field: { item: 'wheat', kind: 'wheat', regrow: 9, chop: .2, count: () => 6 + 4 * lvl('field.more'), logs: () => 2 },
  garden: { item: 'pumpkin', kind: 'pumpkin', regrow: 12, chop: .3, count: () => 4 + 2 * lvl('garden.more'), logs: () => 1 },
};
plants.forEach((p, i) => Object.assign(p, { i, logs: 0, regrow: 0, shake: 0, pop: 0 }));
const plantActive = p => built(p.group) && plants.filter(q => q.group === p.group).indexOf(p) < PLANT_GROUPS[p.group].count();
function plantIdx(p) { let k = 0; for (const q of plants) { if (q === p) return k; if (q.group === p.group) k++; } return -1; }
const regrowTime = g => PLANT_GROUPS[g].regrow * Math.pow(.8, lvl(g + '.regrow'));

// converters: take inputs at IN, cook, put the product on the OUT pile
const convs = {
  oven: { id: 'oven', in: { egg: 1, wood: 1 }, out: 'pie', time: 2.4, x: 10, y: 5.6, w: 2.2, d: 1.8, IN: { x: 8.8, y: 7.7 }, OUT: { x: 11.2, y: 7.7 } },
  mill: { id: 'mill', in: { wheat: 2 }, out: 'flour', time: 2, x: -5.2, y: 4.4, w: 2.4, d: 2.2, IN: { x: -6.4, y: 7.6 }, OUT: { x: -4, y: 7.6 } },
  dairy: { id: 'dairy', in: { milk: 2 }, out: 'cheese', time: 2.8, x: 36, y: 4.4, w: 2.6, d: 2.2, IN: { x: 34.8, y: 7.6 }, OUT: { x: 37.2, y: 7.6 } },
  sweets: { id: 'sweets', in: { flour: 1, milk: 1 }, out: 'cake', time: 3.2, x: 14.5, y: -9, w: 2.6, d: 2.2, IN: { x: 13.3, y: -6.4 }, OUT: { x: 15.7, y: -6.4 } },
};
const convList = Object.values(convs);
for (const c of convList) Object.assign(c, { store: Object.fromEntries(Object.keys(c.in).map(k => [k, 0])), out_n: 0, cook: 0, max: 6, outMax: 12 });
const convTime = c => c.time * Math.pow(.85, lvl(c.id + '.speed'));

// who makes each item (helpers fetch from here)
const PRODUCER = { egg: ['pen', 'coop'], milk: ['pen', 'cows'], wood: ['plants', 'grove'], wheat: ['plants', 'field'], pumpkin: ['plants', 'garden'],
  pie: ['conv', 'oven'], flour: ['conv', 'mill'], cheese: ['conv', 'dairy'], cake: ['conv', 'sweets'] };
const producerBuilt = item => built(PRODUCER[item][1]);

const customers = [];
const helpers = [];
const flyers = [], floats = [], parts = [];

// ---------- everything that can be bought ----------
// kind: stall | pen | plants | conv | cashier | helper | land | decor. A pad (stand on it to pay) appears once `req` is met
// and the pad's zone is owned. Buildings then get upgrade tracks (TRACKS), bought from a card near the building.
const DEFS = [
  { id: 'eggStall', kind: 'stall', label: 'Прилавок яиц', start: true },
  { id: 'coop', kind: 'pen', label: 'Курятник', start: true },
  { id: 'shed', kind: 'shed', label: 'Сарай', start: true },
  { id: 'cashEgg', kind: 'cashier', label: 'Продавец', icon: 'person', cost: 30, pad: [10.2, 16], req: [['coop.hens', 1]] },
  { id: 'grove', kind: 'plants', label: 'Роща', icon: 'tree', cost: 25, pad: [16.2, 5.8], req: [['coop.hens', 1]] },
  { id: 'woodStall', kind: 'stall', label: 'Прилавок дров', icon: 'wood', cost: 30, pad: [14.6, 19], req: ['grove'] },
  { id: 'oven', kind: 'conv', label: 'Пекарня', icon: 'pie', cost: 80, pad: [10, 5.6], req: ['woodStall'] },
  { id: 'cashWood', kind: 'cashier', label: 'Продавец', icon: 'person', cost: 70, pad: [14.8, 16], req: ['woodStall', 'oven'] },
  { id: 'pieStall', kind: 'stall', label: 'Прилавок пирогов', icon: 'pie', cost: 70, pad: [5.4, 19], req: ['oven'] },
  { id: 'cashPie', kind: 'cashier', label: 'Продавец', icon: 'person', cost: 120, pad: [5.6, 16], req: ['pieStall'] },
  { id: 'helperEgg', kind: 'helper', item: 'egg', label: 'Помощник: яйца', icon: 'person', cost: 120, pad: [4.6, 11.4], req: ['pieStall'] },
  { id: 'helperWood', kind: 'helper', item: 'wood', label: 'Помощник: дрова', icon: 'person', cost: 200, pad: [14.4, 11.4], req: ['helperEgg'] },
  { id: 'helperPie', kind: 'helper', item: 'pie', label: 'Помощник: пироги', icon: 'person', cost: 260, pad: [7.4, 13.2], req: ['helperWood'] },
  { id: 'bench1', kind: 'decor', label: 'Скамейка', icon: 'bench', cost: 50, pad: [3.2, 15.4], model: 'bench', rot: 0, cozy: 4, req: ['pieStall'] },
  { id: 'flowers1', kind: 'decor', label: 'Клумба', icon: 'flower', cost: 40, pad: [12.6, 14], model: 'flowers', cozy: 3, req: ['pieStall'] },
  { id: 'lamp1', kind: 'decor', label: 'Фонарь', icon: 'lamp', cost: 70, pad: [7.6, 16.2], model: 'lamp', cozy: 4, req: ['bench1'] },
  { id: 'well', kind: 'decor', label: 'Колодец', icon: 'well', cost: 160, pad: [1.8, 9.6], model: 'well', cozy: 8, req: ['bench1', 'flowers1'], solid: .7 },
  { id: 'landField', kind: 'land', zone: 'field', label: 'Земля: Поле', icon: 'land', cost: 300, pad: [1.4, 13], req: ['pieStall'] },
  // field (west)
  { id: 'field', kind: 'plants', label: 'Пшеничное поле', icon: 'wheat', cost: 60, pad: [-12.4, 4.4], req: ['landField'] },
  { id: 'mill', kind: 'conv', label: 'Мельница', icon: 'mill', cost: 160, pad: [-5.2, 4.4], req: ['field'] },
  { id: 'flourStall', kind: 'stall', label: 'Прилавок муки', icon: 'flour', cost: 150, pad: [-4.6, 19], req: ['mill'] },
  { id: 'cashFlour', kind: 'cashier', label: 'Продавец', icon: 'person', cost: 260, pad: [-4.4, 16], req: ['flourStall'] },
  { id: 'helperWheat', kind: 'helper', item: 'wheat', label: 'Помощник: пшеница', icon: 'person', cost: 350, pad: [-9.4, 10.4], req: ['flourStall'] },
  { id: 'helperFlour', kind: 'helper', item: 'flour', label: 'Помощник: мука', icon: 'person', cost: 450, pad: [-2.4, 12.4], req: ['helperWheat'] },
  { id: 'bench2', kind: 'decor', label: 'Скамейка', icon: 'bench', cost: 120, pad: [-1.8, 15.4], model: 'bench', rot: 0, cozy: 4, req: ['flourStall'] },
  { id: 'flowers2', kind: 'decor', label: 'Клумба', icon: 'flower', cost: 90, pad: [-14.4, 14.2], model: 'flowers', cozy: 3, req: ['flourStall'] },
  { id: 'fountain', kind: 'decor', label: 'Фонтан', icon: 'fountain', cost: 600, pad: [-8.4, 13.8], model: 'fountain', cozy: 15, req: ['flourStall', 'well'], solid: 1.1 },
  { id: 'landPasture', kind: 'land', zone: 'pasture', label: 'Земля: Пастбище', icon: 'land', cost: 1000, pad: [18.8, 13.8], req: ['flourStall'] },
  // pasture (east)
  { id: 'cows', kind: 'pen', label: 'Коровник', icon: 'cow', cost: 250, pad: [27, 6], req: ['landPasture'] },
  { id: 'milkStall', kind: 'stall', label: 'Прилавок молока', icon: 'milk', cost: 200, pad: [25.4, 19], req: ['cows'] },
  { id: 'dairy', kind: 'conv', label: 'Сыроварня', icon: 'cheese', cost: 500, pad: [36, 4.4], req: ['milkStall'] },
  { id: 'cheeseStall', kind: 'stall', label: 'Прилавок сыра', icon: 'cheese', cost: 450, pad: [30, 19], req: ['dairy'] },
  { id: 'cashMilk', kind: 'cashier', label: 'Продавец', icon: 'person', cost: 500, pad: [25.6, 16], req: ['milkStall'] },
  { id: 'cashCheese', kind: 'cashier', label: 'Продавец', icon: 'person', cost: 800, pad: [30.2, 16], req: ['cheeseStall'] },
  { id: 'helperMilk', kind: 'helper', item: 'milk', label: 'Помощник: молоко', icon: 'person', cost: 900, pad: [24.2, 12.2], req: ['cheeseStall'] },
  { id: 'helperCheese', kind: 'helper', item: 'cheese', label: 'Помощник: сыр', icon: 'person', cost: 1100, pad: [33.4, 12.2], req: ['helperMilk'] },
  { id: 'lamp2', kind: 'decor', label: 'Фонарь', icon: 'lamp', cost: 250, pad: [22.4, 16.2], model: 'lamp', cozy: 4, req: ['milkStall'] },
  { id: 'bench3', kind: 'decor', label: 'Скамейка', icon: 'bench', cost: 300, pad: [38.6, 15.4], model: 'bench', rot: 0, cozy: 4, req: ['cheeseStall'] },
  { id: 'flowers3', kind: 'decor', label: 'Клумба', icon: 'flower', cost: 260, pad: [39, 11], model: 'flowers', cozy: 3, req: ['cheeseStall'] },
  { id: 'landGarden', kind: 'land', zone: 'garden', label: 'Земля: Огород', icon: 'land', cost: 2000, pad: [12.4, 1.4], req: ['cheeseStall'] },
  // garden (north)
  { id: 'garden', kind: 'plants', label: 'Тыквенные грядки', icon: 'pumpkin', cost: 400, pad: [5.6, -9.6], req: ['landGarden'] },
  { id: 'pumpkinStall', kind: 'stall', label: 'Прилавок тыкв', icon: 'pumpkin', cost: 600, pad: [-9.2, 19], req: ['garden'] },
  { id: 'sweets', kind: 'conv', label: 'Кондитерская', icon: 'cake', cost: 1500, pad: [14.5, -9], req: ['garden'] },
  { id: 'cakeStall', kind: 'stall', label: 'Прилавок тортов', icon: 'cake', cost: 1500, pad: [34.6, 19], req: ['sweets'] },
  { id: 'cashPumpkin', kind: 'cashier', label: 'Продавец', icon: 'person', cost: 1000, pad: [-9, 16], req: ['pumpkinStall'] },
  { id: 'cashCake', kind: 'cashier', label: 'Продавец', icon: 'person', cost: 2000, pad: [34.8, 16], req: ['cakeStall'] },
  { id: 'helperPumpkin', kind: 'helper', item: 'pumpkin', label: 'Помощник: тыквы', icon: 'person', cost: 1800, pad: [9.6, -3.4], req: ['pumpkinStall'] },
  { id: 'helperCake', kind: 'helper', item: 'cake', label: 'Помощник: торты', icon: 'person', cost: 2600, pad: [17.6, -4], req: ['cakeStall'] },
  { id: 'lamp3', kind: 'decor', label: 'Фонарь', icon: 'lamp', cost: 600, pad: [1.4, -2.4], model: 'lamp', cozy: 4, req: ['garden'] },
  { id: 'flowers4', kind: 'decor', label: 'Клумба', icon: 'flower', cost: 500, pad: [18, -14], model: 'flowers', cozy: 3, req: ['sweets'] },
  { id: 'fair', kind: 'decor', label: 'Ярмарка', icon: 'flag', cost: 12000, pad: [10, 12.4], cozy: 30,
    req: ['cakeStall', 'pumpkinStall', 'fountain', 'helperCake', 'helperCheese', 'helperFlour', 'helperPie'] },
];
const DEF = Object.fromEntries(DEFS.map(d => [d.id, d]));
for (const d of DEFS) { // which plot each pad stands in
  if (d.zone && d.kind === 'land') d.padZone = 'yard';
  else d.padZone = Object.keys(ZONES).find(z => { const [x0, y0, x1, y1] = ZONES[z].rect; return d.pad && d.pad[0] >= x0 && d.pad[0] <= x1 && d.pad[1] >= y0 && d.pad[1] <= y1; }) || 'yard';
}
const PADS = DEFS.filter(d => d.pad);
PADS.forEach(p => { p.x = p.pad[0]; p.y = p.pad[1]; p.stand = 0; p.payT = 0; p.pop = 0; });
const reqOk = r => typeof r === 'string' ? built(r) : lvl(r[0]) >= r[1];
const padVisible = p => !built(p.id) && zoneOpen(p.padZone) && (p.req || []).every(reqOk);
const padPaid = p => G.padPaid[p.id] || 0;

// ---------- upgrade tracks ----------
// Each building has tracks; a track's level goes up by buying from the upgrade card (ui.js) near the building.
const geo = (base, n, k = 2.1) => Array.from({ length: n }, (_, i) => Math.round(base * Math.pow(k, i) / 5) * 5 || base);
const TRACKS = {
  coop: [
    { key: 'hens', title: 'Ещё курица', text: l => `кур: ${1 + l} → ${2 + l}`, costs: [10, 25, 45, 80, 130, 200, 300] },
    { key: 'feed', title: 'Отборный корм', text: () => 'куры несутся на 12% чаще', costs: geo(60, 5) },
  ],
  cows: [
    { key: 'herd', title: 'Ещё корова', text: l => `коров: ${1 + l} → ${2 + l}`, costs: [300, 550, 900, 1400, 2100] },
    { key: 'feed', title: 'Сочное сено', text: () => 'молока на 12% больше', costs: geo(400, 5) },
  ],
  shed: [
    { key: 'bag', title: 'Большая корзина', text: l => `несёшь ${6 + 2 * l} → ${8 + 2 * l}`, costs: geo(20, 8, 1.9) },
    { key: 'boots', title: 'Сапоги-скороходы', text: () => 'ходишь на 8% быстрее', costs: geo(50, 5) },
  ],
  grove: [
    { key: 'regrow', title: 'Удобрение', text: () => 'деревья растут на 20% быстрее', costs: geo(40, 4) },
    { key: 'logs', title: 'Большие деревья', text: l => `поленьев с дерева: ${3 + l} → ${4 + l}`, costs: [90, 260] },
  ],
  field: [
    { key: 'more', title: 'Распахать ещё', text: l => `грядок: ${6 + 4 * l} → ${10 + 4 * l}`, costs: geo(80, 6, 1.7) },
    { key: 'regrow', title: 'Полив', text: () => 'пшеница растёт на 20% быстрее', costs: geo(120, 4) },
  ],
  garden: [
    { key: 'more', title: 'Ещё грядки', text: l => `грядок: ${4 + 2 * l} → ${6 + 2 * l}`, costs: geo(500, 6, 1.6) },
    { key: 'regrow', title: 'Полив', text: () => 'тыквы растут на 20% быстрее', costs: geo(700, 4) },
  ],
};
const CONV_BASE = { oven: 60, mill: 150, dairy: 400, sweets: 1000 };
for (const c of convList) TRACKS[c.id] = [{ key: 'speed', title: 'Мастерство', text: () => 'готовит на 15% быстрее', costs: geo(CONV_BASE[c.id], 5) }];
for (const st of stallList) TRACKS[st.id] = [{ key: 'level', title: 'Нарядный прилавок', text: l => `полка ${14 + 4 * l} → ${18 + 4 * l}, цена +10%`, costs: geo(st.base, 6, 2) }];
function trackOf(id, key) { return (TRACKS[id] || []).find(t => t.key === key); }
function upgradeCost(id, key) { const t = trackOf(id, key), l = lvl(id + '.' + key); return t && l < t.costs.length ? t.costs[l] : null; }
function buyUpgrade(id, key) {
  const c = upgradeCost(id, key);
  if (c === null || G.coins < c || !built(id)) return false;
  G.coins -= c; G.up[id + '.' + key] = lvl(id + '.' + key) + 1;
  derive();
  const a = upgradeAnchor(id);
  if (a) { burst(a.x, a.y, 1, ['#ffd84d', '#7ed0ff', '#ffffff', '#9be15d'], 22); floatText(a.x, a.y, 2.2, trackOf(id, key).title + '!', '#fff'); }
  save();
  return true;
}
const anyUpgradeAffordable = id => (TRACKS[id] || []).some(t => { const c = upgradeCost(id, t.key); return c !== null && c <= G.coins; });
const SHED = { x: 17.6, y: 12.8 };
// where the upgrade button floats; the player has to stand within UP_R of it
function upgradeAnchor(id) {
  if (pens[id]) return pens[id].pile;
  if (convs[id]) return { x: convs[id].x, y: convs[id].y + 1.9 };
  if (id === 'shed') return { x: SHED.x, y: SHED.y + 1.6 };
  if (id === 'grove') return { x: 16, y: 10 };
  if (id === 'field') return { x: -10, y: 9 };
  if (id === 'garden') return { x: 9.2, y: -4.2 };
  const st = stallList.find(s => s.id === id);
  if (st) return { x: st.x - .9, y: 17.3 };
  return null;
}
const UP_R = 2.2;
const BUILDING_TITLE = id => (DEF[id] && DEF[id].label) || id;
// the building whose upgrade button shows now: the closest one in reach
function nearbyUpgrade() {
  let best = null, bd = UP_R;
  for (const id of Object.keys(TRACKS)) {
    if (!built(id)) continue;
    const a = upgradeAnchor(id); if (!a) continue;
    const d = Math.hypot(player.x - a.x, player.y - a.y);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}

// ---------- solids & movement limits ----------
function solids() {
  const r = [];
  for (const p of penList) if (built(p.id) || p.id === 'coop') {
    const [x0, y0, x1, y1] = p.fence; r.push([x0 - .1, y0 - .1, x1 + .1, y1 + .15]);
  }
  for (const st of stallList) if (isOpen(st)) r.push([st.x - 1.15, st.y - .45, st.x + 1.15, st.y + .45]);
  for (const c of convList) if (built(c.id)) r.push([c.x - c.w / 2, c.y - c.d / 2, c.x + c.w / 2, c.y + c.d / 2]);
  r.push([SHED.x - 1.1, SHED.y - .8, SHED.x + 1.1, SHED.y + .8]);
  for (const d of DEFS) if (d.solid && built(d.id)) r.push([d.x - d.solid, d.y - d.solid, d.x + d.solid, d.y + d.solid]);
  for (const z of Object.values(ZONES)) if (z.land && !built(z.land)) r.push(z.rect);
  return r;
}
let SOLIDS = [];
function collide(a, rad) {
  for (const [x0, y0, x1, y1] of SOLIDS) {
    const cx = clamp(a.x, x0, x1), cy = clamp(a.y, y0, y1);
    const dx = a.x - cx, dy = a.y - cy, d = Math.hypot(dx, dy);
    if (d < rad) {
      if (d < 1e-4) { // inside: push out along the shallowest axis
        const opts = [[a.x - x0, -1, 0], [x1 - a.x, 1, 0], [a.y - y0, 0, -1], [y1 - a.y, 0, 1]].sort((p, q) => p[0] - q[0])[0];
        a.x += opts[1] * (opts[0] + rad); a.y += opts[2] * (opts[0] + rad);
      } else { a.x = cx + dx / d * rad; a.y = cy + dy / d * rad; }
    }
  }
  for (const t of plants) {
    if (t.group !== 'grove' || !t.active) continue;
    if (t.logs <= 0 && t.regrow > regrowTime('grove') * .6) continue;
    const dx = a.x - t.x, dy = a.y - t.y, d = Math.hypot(dx, dy), m = rad + .28;
    if (d < m && d > 1e-4) { a.x = t.x + dx / d * m; a.y = t.y + dy / d * m; }
  }
  a.x = clamp(a.x, WORLD.x0 + .5, WORLD.x1 - .5); a.y = clamp(a.y, WORLD.y0 + .5, WORLD.y1 - .4);
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
function convInPos(c, t, n) {
  const keys = Object.keys(c.in), k = keys.indexOf(t), dx = keys.length === 1 ? 0 : (k - (keys.length - 1) / 2) * .6;
  return [c.IN.x + dx, c.IN.y, n * ITEM[t].h];
}

// ---------- derived state & buying ----------
function derive() {
  player.cap = 6 + 2 * lvl('shed.bag');
  player.speed = 5.2 * (1 + .08 * lvl('shed.boots'));
  pens.coop.n = 1 + lvl('coop.hens');
  pens.cows.n = built('cows') ? 1 + lvl('cows.herd') : 0;
  for (const p of penList) {
    p.max = 8 + p.n * 4;
    while (p.animals.length < p.n) addAnimal(p);
  }
  for (const st of stallList) st.max = 14 + 4 * lvl(st.id + '.level');
  for (const t of plants) {
    const was = t.active; t.active = plantActive(t);
    if (t.active && !was && !t.inited) { t.logs = PLANT_GROUPS[t.group].logs(); t.inited = true; t.pop = now + plantIdx(t) * .05; }
  }
  for (const d of DEFS) if (d.kind === 'helper' && built(d.id) && !helpers.some(h => h.job === d.item)) addHelper(d);
  G.cozy = DEFS.reduce((s, d) => s + (d.kind === 'decor' && built(d.id) ? d.cozy : 0), 0);
  G.fair = built('fair');
  SOLIDS = solids();
}
function addAnimal(p) {
  const [x0, y0, x1, y1] = p.area;
  p.animals.push({ x: rnd(x0, x1), y: rnd(y0, y1), tx: (x0 + x1) / 2, ty: (y0 + y1) / 2, t: 0, face: 1, peck: 0, born: now });
}
const HELPER_SHIRTS = { egg: '#e58b3a', wood: '#7c5bc4', pie: '#d94f6a', wheat: '#d9b23a', flour: '#8a9aa8', milk: '#3c8fd9', cheese: '#e0b020', pumpkin: '#e0702a', cake: '#e06aa8' };
function addHelper(d) {
  const h = mkActor(d.x, d.y, 'helper');
  Object.assign(h, { job: d.item, cap: 5, speed: 2.9, state: 'toSrc', wait: 0, plant: null, shirt: HELPER_SHIRTS[d.item] || '#7c5bc4' });
  helpers.push(h);
}
function buy(p) {
  G.built.add(p.id);
  delete G.padPaid[p.id];
  derive();
  burst(p.x, p.y, .3, ['#ffd84d', '#ff7a59', '#7ed0ff', '#ffffff', '#9be15d'], 30);
  floatText(p.x, p.y, 1.2, p.label + '!', '#fff');
  if (p.kind === 'decor' && p.cozy) floatText(p.x, p.y, 2, '+покупатели', '#ffe46b');
  if (p.kind === 'land') { const [x0, y0, x1, y1] = ZONES[p.zone].rect; burst((x0 + x1) / 2, (y0 + y1) / 2, .5, ['#ffd84d', '#9be15d', '#ffffff'], 40); }
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
  if (G.paused) return;
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
  camX += (clamp(player.x, WORLD.x0 + 4, WORLD.x1 - 4) - camX) * Math.min(1, dt * 5);
  camY += (clamp(player.y, WORLD.y0 + 5, WORLD.y1 - 6) - camY) * Math.min(1, dt * 5);

  updatePens(dt); updatePlants(dt); updateConvs(dt);
  updateStalls(dt); updateCustomers(dt);
  for (const h of helpers) { updateHelper(h, dt); collide(h, .25); }
  playerInteract(dt);
  updatePads(dt);
  G.curHint = hint();
  G.upNear = nearbyUpgrade();

  for (let i = flyers.length - 1; i >= 0; i--) { const f = flyers[i]; f.age += dt; if (f.age >= f.dur) flyers.splice(i, 1); }
  for (let i = floats.length - 1; i >= 0; i--) { floats[i].t += dt; if (floats[i].t > 1.1) floats.splice(i, 1); }
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]; p.life -= dt; p.vz -= 12 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z = Math.max(0, p.z + p.vz * dt);
    if (p.life <= 0) parts.splice(i, 1);
  }
}

function updatePens(dt) {
  for (const p of penList) {
    if (!p.n) continue;
    const period = p.period * Math.pow(.88, lvl(p.id + '.feed'));
    p.t += dt * p.n;
    while (p.t >= period) {
      p.t -= period;
      if (p.stock < p.max) {
        p.stock++;
        const c = p.animals[Math.floor(Math.random() * p.animals.length)];
        if (c) fly(p.item, [c.x, c.y, .3], pilePos(p.pile.x, p.pile.y, p.stock - 1, ITEM[p.item].h), .4);
      }
    }
    const [x0, y0, x1, y1] = p.area, sp = p.animal === 'cow' ? .55 : .8;
    for (const c of p.animals) {
      c.t -= dt;
      if (c.t <= 0) { c.tx = rnd(x0, x1); c.ty = rnd(y0, y1); c.t = rnd(2, p.animal === 'cow' ? 7 : 4); }
      const dx = c.tx - c.x, dy = c.ty - c.y, d = Math.hypot(dx, dy);
      if (d > .1) { c.x += dx / d * sp * dt; c.y += dy / d * sp * dt; c.face = Math.sign(dx) || c.face; c.peck = 0; }
      else c.peck += dt;
    }
  }
}
function updatePlants(dt) {
  for (const t of plants) {
    if (!t.active) continue;
    t.shake = Math.max(0, t.shake - dt * 4);
    if (t.logs <= 0) { t.regrow -= dt; if (t.regrow <= 0) { t.logs = PLANT_GROUPS[t.group].logs(); t.pop = now; } }
  }
}
function updateConvs(dt) {
  for (const c of convList) {
    if (!built(c.id)) continue;
    if (c.cook > 0) {
      c.cook -= dt;
      if (Math.random() < dt * 6) parts.push({ x: c.x + .65 + rnd(-.05, .05), y: c.y - .45, z: 1.9, vx: rnd(-.1, .3), vy: 0, vz: 1.2, life: 1.2, c: 'smoke' });
      if (c.cook <= 0) { c.out_n++; fly(c.out, [c.x, c.y + .8, .4], pilePos(c.OUT.x, c.OUT.y, c.out_n - 1, ITEM[c.out].h), .35); }
    } else if (c.out_n < c.outMax && Object.entries(c.in).every(([k, n]) => c.store[k] >= n)) {
      for (const [k, n] of Object.entries(c.in)) c.store[k] -= n;
      c.cook = convTime(c);
    }
  }
}

function priceOf(st) { return Math.round(ITEM[st.type].price * (1 + .1 * lvl(st.id + '.level'))); }
function updateStalls(dt) {
  for (const st of stallList) {
    if (!isOpen(st)) continue;
    st.t -= dt;
    const c = st.queue[0];
    if (c && c.arrived && c.got < c.want && st.shelf > 0 && st.t <= 0 && isSelling(st)) {
      st.shelf--; c.got++; st.t = .3;
      fly(st.type, shelfPos(st, st.shelf), [c.x, c.y, 1.0], .25);
      if (c.got >= c.want) {
        let pay = c.want * priceOf(st);
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
  const ex = roadEnds()[c.from < 0 ? 0 : 1];
  c.path = [[c.x + (c.from < 0 ? -.8 : .8), ROAD_Y], [ex, ROAD_Y]];
}
const SHIRTS = ['#4f8fe0', '#e05f7a', '#58b368', '#f0a43a', '#9a6ad6', '#3cb7b0', '#e2c84a'];
const HAIR = ['#3b2a1e', '#6b4226', '#d9b26f', '#222', '#a0522d'];
const cozyMul = () => 1 + G.cozy / 100;
// customers come along the road from just beyond the owned land (off screen), not from the far ends of the world
const roadEnds = () => [zoneOpen('field') ? ROAD_X0 : -1.5, zoneOpen('pasture') ? ROAD_X1 : 21.5];
function spawnCustomer() {
  const open = stallList.filter(st => isOpen(st) && st.queue.length < (hasCashier(st) ? 4 : 3));
  if (!open.length) return;
  open.sort((a, b) => a.queue.length - b.queue.length + rnd(-1.2, 1.2));
  const st = open[0];
  const big = ITEM[st.type].price >= 8;
  const want = big ? 1 + Math.floor(Math.random() * 2) : 1 + Math.floor(Math.random() * 3);
  // mostly from the nearer end of the road
  const [e0, e1] = roadEnds(), fromLeft = Math.random() < (st.x - e0 < e1 - st.x ? .8 : .2);
  const patMax = (45 - Math.min(12, G.served * .05)) * (1 + G.cozy / 200);
  const c = { x: fromLeft ? e0 : e1, y: ROAD_Y, vx: 0, vy: 0, face: fromLeft ? 1 : -1, dir: fromLeft ? 0 : Math.PI, walk: 0, sx: 0, sy: 0, svx: 0, svy: 0, stack: [], id: Math.random(),
    speed: 3.2, stall: st.type, want, got: 0, pat: patMax, patMax, state: 'in', arrived: false, from: fromLeft ? -1 : 1,
    shirt: SHIRTS[Math.floor(Math.random() * SHIRTS.length)], hair: HAIR[Math.floor(Math.random() * HAIR.length)], entered: false };
  st.queue.push(c); customers.push(c);
}
function updateCustomers(dt) {
  const openN = stallList.filter(isOpen).length;
  G.spawnT -= dt;
  if (G.spawnT <= 0) {
    spawnCustomer();
    G.spawnT = 5.5 * (3 / G.rep) / Math.pow(openN, .75) / cozyMul() * rnd(.7, 1.3);
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

function nearestPlant(a, group, maxD) {
  let best = null, bd = maxD;
  for (const t of plants) if (t.active && t.logs > 0 && (!group || t.group === group)) {
    const d = Math.hypot(a.x - t.x, a.y - t.y); if (d < bd) { bd = d; best = t; }
  }
  return best;
}
function harvest(a, t) {
  t.logs--; t.shake = 1;
  if (t.logs <= 0) t.regrow = regrowTime(t.group);
  const it = PLANT_GROUPS[t.group].item;
  pushStack(a, it, [t.x, t.y, t.group === 'grove' ? .9 : .3]);
  burst(t.x, t.y + .1, .6, t.group === 'grove' ? ['#5fae3e', '#7cc44f'] : t.group === 'field' ? ['#f0d264', '#d9b23a'] : ['#f08a2a', '#5fae3e'], 5);
}

function feedConv(a, c) {
  let best = null;
  for (const t of Object.keys(c.in)) if (countIn(a, t) > 0 && c.store[t] < c.max && (!best || c.store[t] < c.store[best])) best = t;
  if (!best) return false;
  popStack(a, best, convInPos(c, best, c.store[best])); c.store[best]++;
  return true;
}
function stockStall(a, st) {
  if (st.shelf >= st.max || !countIn(a, st.type)) return false;
  popStack(a, st.type, shelfPos(st, st.shelf)); st.shelf++;
  return true;
}
function takeFromPen(a, p) {
  if (p.stock <= 0) return false;
  p.stock--; pushStack(a, p.item, pilePos(p.pile.x, p.pile.y, p.stock, ITEM[p.item].h)); return true;
}
function takeFromConv(a, c) {
  if (c.out_n <= 0) return false;
  c.out_n--; pushStack(a, c.out, pilePos(c.OUT.x, c.OUT.y, c.out_n, ITEM[c.out].h)); return true;
}

function playerInteract(dt) {
  const a = player, full = a.stack.length >= a.cap;
  a.tx -= dt;
  // harvesting: chop trees, pick crops
  const t = full ? null : nearestPlant(a, null, 1.05);
  if (t) {
    a.chopping += dt; a.chopT += dt; a.tool = t.group === 'grove' ? 'axe' : 'none';
    a.face = t.x > a.x ? 1 : -1; turnTo(a, Math.atan2(t.y - a.y, t.x - a.x), dt);
    if (a.chopT >= PLANT_GROUPS[t.group].chop) { a.chopT = 0; harvest(a, t); }
  } else { a.chopT = 0; a.chopping = 0; }

  if (a.tx <= 0) {
    let did = false;
    for (const p of penList) if (!did && p.n && !full && near(a, p.pile.x, p.pile.y, .95)) did = takeFromPen(a, p);
    for (const c of convList) if (!did && built(c.id)) {
      if (!full && near(a, c.OUT.x, c.OUT.y, .95)) did = takeFromConv(a, c);
      else if (near(a, c.IN.x, c.IN.y, .95)) did = feedConv(a, c);
    }
    if (!did) for (const st of stallList) if (isOpen(st) && near(a, st.drop.x, st.drop.y, .95)) did = stockStall(a, st) || did;
    if (did) a.tx = .085;
  }
  // coins: collect quickly in chunks
  for (const st of stallList) if (isOpen(st) && st.coins > 0 && near(a, st.cz.x, st.cz.y, 1)) {
    const chunk = Math.max(1, Math.ceil(st.coins / 6));
    st.coins -= chunk; G.coins += chunk; G.coinsEver += chunk; G.earned += chunk;
    fly('coin', coinPos(st, st.coins), () => [player.x, player.y, 1.2], .3);
  }
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

// ---------- helpers: each one carries one item from where it is made to where it is needed ----------
function consumers(item) {
  const r = [];
  const st = stalls[item];
  if (st && isOpen(st)) r.push({ kind: 'stall', st, x: st.drop.x + .35, y: st.drop.y - .25, fill: st.shelf / st.max });
  for (const c of convList) if (built(c.id) && c.in[item]) r.push({ kind: 'conv', c, x: c.IN.x + .3, y: c.IN.y + .35, fill: c.store[item] / c.max });
  return r;
}
function sourceSpot(h) {
  const [kind, id] = PRODUCER[h.job];
  if (kind === 'pen') return pens[id].n ? { x: pens[id].pile.x + .3, y: pens[id].pile.y + .35 } : null;
  if (kind === 'conv') return built(id) ? { x: convs[id].OUT.x + .3, y: convs[id].OUT.y + .35 } : null;
  if (!h.plant || h.plant.logs <= 0 || !h.plant.active) h.plant = nearestPlant(h, id, 99);
  return h.plant ? { x: h.plant.x, y: h.plant.y + .75, plant: h.plant } : null;
}
function updateHelper(h, dt) {
  h.tx -= dt;
  const full = h.stack.length >= h.cap, [kind, id] = PRODUCER[h.job];
  if (h.state === 'toSrc') {
    const s = sourceSpot(h);
    if (!s) { if (h.stack.length) h.state = 'toDst'; else moveActor(h, 0, 0, h.speed, dt); return; }
    if (walkTo(h, s.x, s.y, dt)) { h.state = 'pick'; h.wait = 0; h.chopT = 0; }
  } else if (h.state === 'pick') {
    moveActor(h, 0, 0, h.speed, dt);
    if (kind === 'plants') {
      const t = h.plant;
      if (!t || t.logs <= 0) { h.plant = null; h.chopping = 0; h.state = full || h.stack.length >= 3 ? 'toDst' : 'toSrc'; return; }
      h.chopping += dt; h.tool = t.group === 'grove' ? 'axe' : 'none';
      turnTo(h, Math.atan2(t.y - h.y, t.x - h.x), dt);
      h.chopT += dt;
      if (h.chopT >= PLANT_GROUPS[id].chop * 1.4) { h.chopT = 0; harvest(h, t); }
      if (h.stack.length >= h.cap) { h.chopping = 0; h.state = 'toDst'; }
    } else {
      const left = kind === 'pen' ? pens[id].stock : convs[id].out_n;
      if (h.tx <= 0 && left > 0 && !full) { kind === 'pen' ? takeFromPen(h, pens[id]) : takeFromConv(h, convs[id]); h.tx = .16; h.wait = 0; }
      if (left === 0 && h.stack.length) h.wait += dt;
      if (full || h.wait > 1.5) h.state = 'toDst';
    }
  } else if (h.state === 'toDst') {
    const opts = consumers(h.job).filter(o => o.fill < 1).sort((a, b) => a.fill - b.fill);
    if (!opts.length) { moveActor(h, 0, 0, h.speed, dt); return; } // everything is full: wait with the load
    h.dst = opts[0];
    if (walkTo(h, h.dst.x, h.dst.y, dt)) h.state = 'drop';
  } else if (h.state === 'drop') {
    moveActor(h, 0, 0, h.speed, dt);
    if (h.tx <= 0) {
      const ok = h.dst.kind === 'stall' ? stockStall(h, h.dst.st) : feedConv(h, h.dst.c);
      if (ok) h.tx = .16;
      else if (h.stack.length) h.state = 'toDst';
    }
    if (!h.stack.length) h.state = 'toSrc';
  }
}

// ---------- hints ----------
// First steps are guided; afterwards the HUD shows what to save up for and an arrow to anything affordable.
function nextGoal() {
  let best = null;
  for (const p of PADS) if (padVisible(p) && (!best || p.cost - padPaid(p) < best.cost - padPaid(best))) best = p;
  return best;
}
function hint() {
  const eggSt = stalls.egg, nest = pens.coop.pile;
  if (G.hint === 0) {
    if (countIn(player, 'egg') >= 3 || (pens.coop.stock === 0 && player.stack.length)) G.hint = 1;
    return { x: nest.x, y: nest.y, text: 'Собери яйца у курятника' };
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
    if (lvl('coop.hens') > 0) { G.hint = 4; G.hintT = now; }
    const c = upgradeCost('coop', 'hens');
    if (G.coins < c) return { text: `Копи монеты: курица стоит ${c}` };
    if (G.upNear === 'coop') return { up: true, text: 'Нажми ⬆ — купишь курицу' };
    return { x: nest.x, y: nest.y, text: 'Подойди к курятнику' };
  }
  if (G.hint === 4) {
    if (now - G.hintT > 6) G.hint = 5;
    return { text: 'Улучшай постройки ⬆ и покупай новое на площадках' };
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
const SAVE_KEY = 'lavka-farm-v1';
function snapshot() {
  return { v: 1, coins: G.coins, coinsEver: G.coinsEver, rep: G.rep, built: [...G.built], up: G.up, padPaid: G.padPaid, time: G.time, hint: G.hint, served: G.served, earned: G.earned,
    stalls: Object.fromEntries(stallList.map(s => [s.type, [s.shelf, s.coins]])), pens: Object.fromEntries(penList.map(p => [p.id, p.stock])),
    convs: Object.fromEntries(convList.map(c => [c.id, [c.store, c.out_n]])), plants: plants.map(t => t.inited ? Math.round(t.logs) : -1),
    stack: player.stack.map(s => s.t), px: player.x, py: player.y };
}
function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot())); } catch (e) {} }
function newFarm() {
  Object.assign(G, { coins: 0, coinsEver: 0, rep: 3, built: new Set(DEFS.filter(d => d.start).map(d => d.id)), up: {}, padPaid: {}, time: 0, hint: 0, hintT: 0, spawnT: 2, served: 0, earned: 0 });
  for (const st of stallList) { st.shelf = 0; st.coins = 0; st.queue.length = 0; st.t = 0; }
  for (const p of penList) { p.stock = p.id === 'coop' ? 4 : 0; p.t = 0; p.animals.length = 0; }
  for (const t of plants) Object.assign(t, { logs: 0, regrow: 0, shake: 0, pop: 0, active: false, inited: false });
  for (const c of convList) { for (const k in c.store) c.store[k] = 0; c.out_n = 0; c.cook = 0; }
  customers.length = 0; helpers.length = 0; flyers.length = 0; floats.length = 0; parts.length = 0;
  for (const p of PADS) { p.stand = 0; p.payT = 0; }
  Object.assign(player, { x: 10, y: 13.5, vx: 0, vy: 0, dir: Math.PI / 2, stack: [], walk: 0, sx: 0, sy: 0, svx: 0, svy: 0, tx: 0, chopT: 0, chopping: 0 });
  camX = player.x; camY = player.y;
  derive();
}
function resetFarm() { newFarm(); save(); }
// Loads the farm (or starts a new one). Old level-mode saves from 0.2 are dropped.
function load() {
  try { for (const k of ['lavka-meta-v1', 'lavka-run-v1', 'lavka-proto-v1']) localStorage.removeItem(k); } catch (e) {}
  newFarm();
  let d; try { d = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) {}
  if (!d || d.v !== 1) return false;
  Object.assign(G, { coins: d.coins || 0, coinsEver: d.coinsEver || 0, rep: d.rep || 3, up: d.up || {}, padPaid: d.padPaid || {}, time: d.time || 0, hint: d.hint || 0, served: d.served || 0, earned: d.earned || 0 });
  G.built = new Set([...G.built, ...(d.built || []).filter(id => DEF[id])]);
  derive();
  for (const s of stallList) if (d.stalls && d.stalls[s.type]) [s.shelf, s.coins] = d.stalls[s.type];
  for (const p of penList) if (d.pens && d.pens[p.id] !== undefined) p.stock = d.pens[p.id];
  for (const c of convList) if (d.convs && d.convs[c.id]) { Object.assign(c.store, d.convs[c.id][0]); c.out_n = d.convs[c.id][1]; }
  if (d.plants) plants.forEach((t, i) => { if (t.active && d.plants[i] >= 0) { t.logs = d.plants[i]; if (t.logs <= 0) t.regrow = regrowTime(t.group) * .5; } t.pop = 0; });
  player.stack = (d.stack || []).filter(t => ITEM[t]).map(t => ({ t, land: 0 }));
  if (typeof d.px === 'number') { player.x = d.px; player.y = d.py; }
  camX = player.x; camY = player.y;
  if (G.hint === 4) G.hint = 5;
  return true;
}
setInterval(save, 2000);
addEventListener('visibilitychange', () => { if (document.hidden) save(); });
addEventListener('pagehide', save);
