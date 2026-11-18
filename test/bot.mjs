// Headless game loader with a controllable clock, and a simple bot; shared by the tests and test/pacing.mjs.
import fs from 'node:fs';
import vm from 'node:vm';

// The game runs on the wall clock (Date.now). Here the clock is fake: step() advances it together with update().
export function loadGame(seed = 1, store = {}, { autoload = true, start = 1.8e12 } = {}) {
  let r = seed; // deterministic randomness, so a failure can be replayed
  const M = Object.create(Math); M.random = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const clock = { t: start };
  const FakeDate = { now: () => clock.t };
  const el = () => ({ hidden: true, onclick: null, textContent: '' });
  const els = {};
  const ctx = {
    console, Math: M, JSON, Set, Map, Object, Array, Number, String, Uint8Array, Int32Array, Date: FakeDate,
    addEventListener() {}, setInterval() {}, confirm: () => false,
    location: { reload() {} },
    document: { getElementById: (id) => (els[id] ||= el()), hidden: false },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  vm.runInContext(src + `
;globalThis.__g = { G, player, CATALOG, CROPS, RECIPES, ITEM, ANIMALS, TASKS, update, helpers, customers, stallState, load, save, resetFarm,
  build, canBuy, canPlace, freeSpot, moveBuilding, plant, enqueue, speedUp, timeLeft, fieldState, penCap, buyAnimal, buySlot, buyUpgrade, upgradeCost,
  hireCashier, hireWorker, cashierCost, workerCost, curTask, have, barnUsed, front, center, nearestBuilding, tickAll, findPath, xpFor, SAVE_KEY,
  get B() { return B; } };`, ctx);
  const g = ctx.__g;
  // advance the clock and the simulation together
  g.step = (seconds, dt = 1 / 30) => { for (let i = 0; i < seconds / dt; i++) { clock.t += dt * 1000; g.update(dt); } };
  g.skip = (seconds) => { clock.t += seconds * 1000; }; // time passes with the game closed
  g.clock = clock;
  if (autoload) g.load();
  return { g, els, store, ctx, clock };
}

// Plays like a sensible person: sows (the slowest, most valuable crop it can afford), harvests, carries everything to
// the barn, keeps workshops busy, stands at the counter while customers wait, builds in a fixed order and buys
// useful upgrades. Placement takes the first free spot near the barn.
const BUILD_ORDER = ['mill', 'bench', 'stall', 'bakery', 'flowers', 'cowshed', 'dairy', 'lamp', 'stall', 'juicer', 'well', 'sweets', 'fountain'];
export function play(g, seconds, { log = [] } = {}) {
  const p = g.player, G = g.G;
  const barn = () => g.B.find((b) => b.type === 'barn');
  const go = (x, y) => { const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy), st = p.speed / 30; if (d > .25) { p.x += dx / d * Math.min(st, d); p.y += dy / d * Math.min(st, d); return false; } return true; };
  let task = null, path = [];
  const goPath = (x, y) => {
    if (!path.length && !task.routed) { path = g.findPath(p.x, p.y, x, y); task.routed = true; }
    while (path.length && go(...path[0])) path.shift();
    return !path.length && go(x, y);
  };
  // what the barn has least of among the quick crops (workshops need a bit of everything)
  const bestCrop = () => Object.entries(g.CROPS).filter(([, c]) => G.lvl >= c.lvl && c.seed <= G.coins && c.t <= 600).sort((a, b) => g.have(a[0]) - g.have(b[0]))[0]?.[0] || 'wheat';
  for (let i = 0; i < seconds * 30; i++) {
    if (i % 30 === 0) { // decisions that need no walking: build, queue workshops, upgrades
      // the first step of the order that is not built yet (and not locked by level)
      const seen = {};
      const next = BUILD_ORDER.find((t) => { seen[t] = (seen[t] || 0) + 1; const c = g.canBuy(t); return (t === 'stall' ? G.stalls : g.B.filter((b) => b.type === t).length) < seen[t] && c !== 'lvl' && c !== 'limit'; });
      if (next && g.canBuy(next) === 'ok') {
        const b0 = barn(), spot = next === 'stall' ? {} : g.freeSpot(next, b0.x + 2, b0.y - 3);
        if (spot && g.build(next, spot.x, spot.y)) log.push({ t: g.clock.t, id: next, lvl: G.lvl });
      }
      if (g.canBuy('field') === 'ok' && G.coins > g.CATALOG.field.cost(g.B.filter((b) => b.type === 'field').length) * 3) {
        const b0 = barn(), spot = g.freeSpot('field', b0.x + 8, b0.y - 2);
        if (spot && g.build('field', spot.x, spot.y)) log.push({ t: g.clock.t, id: 'field', lvl: G.lvl });
      }
      for (const b of g.B) if (g.RECIPES[b.type]) {
        const order = g.RECIPES[b.type].map((r, k) => k).sort((a, c) => g.RECIPES[b.type][c].t - g.RECIPES[b.type][a].t);
        for (const k of order) while (g.enqueue(b, k));
      }
      for (const b of g.B) if (g.CATALOG[b.type].kind === 'pen' && G.coins > (g.curTask().ev === 'animal' ? 0 : 400)) g.buyAnimal(b);
      for (const key of ['barn', 'bag']) { const c = g.upgradeCost(key); if (c !== null && G.coins > c * 2 && g.barnUsed() > G.barnCap * .6) g.buyUpgrade(key); }
      for (let k = 0; k < G.stalls; k++) { const c = g.cashierCost(k); if (c !== null && G.coins > c * 1.5) g.hireCashier(k); }
      { const c = g.workerCost(); if (c !== null && G.coins > c * 1.3) g.hireWorker(); }
    }
    if (task && i - task.since > 30 * 20) task = null;
    if (!task) {
      const s = g.clock.t / 1000;
      const open = g.stallState.slice(0, G.stalls);
      const waiting = open.find((st, k) => !G.cashiers[k] && st.queue[0] && st.queue[0].arrived && g.have(st.queue[0].item) > 0);
      const rich = open.find((st) => st.coins >= 15);
      const ripe = g.B.filter((b) => b.type === 'field' && g.fieldState(b, s) === 'ripe');
      const empty = g.B.filter((b) => b.type === 'field' && g.fieldState(b, s) === 'empty');
      const ready = g.B.filter((b) => (b.out && b.out.length) || b.stock >= 3);
      if (p.stack.length >= p.cap || (p.stack.length && !ripe.length && !ready.length)) { const f = g.front(barn()); task = { k: 'barn', x: f.x, y: f.y }; }
      else if (waiting) task = { k: 'sell', x: waiting.counter.x, y: waiting.counter.y, st: waiting };
      else if (rich) task = { k: 'coins', x: rich.cz.x, y: rich.cz.y, st: rich };
      else if (ripe.length) { const c = g.center(ripe[0]); task = { k: 'field', x: c.x, y: c.y, b: ripe[0] }; }
      else if (ready.length) { const f = g.front(ready[0]); task = { k: 'pick', x: f.x, y: f.y, b: ready[0] }; }
      else if (empty.length) { G.seed = bestCrop(); const c = g.center(empty[0]); task = { k: 'plant', x: c.x, y: c.y, b: empty[0] }; }
      else { const st = open[0]; task = { k: 'sell', x: st.counter.x, y: st.counter.y, st, idle: true }; }
      task.since = i; path = [];
    }
    if (goPath(task.x, task.y)) {
      task.here = (task.here || 0) + 1 / 30;
      const s = g.clock.t / 1000;
      const done = task.k === 'barn' ? !p.stack.length || task.here > 2
        : task.k === 'sell' ? (task.here > (task.idle ? 3 : 8) || !(task.st.queue[0] && g.have(task.st.queue[0].item) > 0))
        : task.k === 'coins' ? task.st.coins === 0
        : task.k === 'field' ? g.fieldState(task.b, s) !== 'ripe' || p.stack.length >= p.cap
        : task.k === 'plant' ? g.fieldState(task.b, s) !== 'empty' || task.here > 1
        : (task.b.out ? !task.b.out.length : task.b.stock === 0) || p.stack.length >= p.cap || task.here > 2;
      if (done) task = null;
    }
    g.clock.t += 1000 / 30;
    g.update(1 / 30);
  }
  return log;
}
