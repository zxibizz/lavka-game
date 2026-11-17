// Runs the simulation (public/game.js) headless and lets a simple bot play it to the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadGame() {
  const el = () => ({ hidden: true, onclick: null, textContent: '' });
  const els = {};
  const store = {};
  const ctx = {
    console, Math, JSON, Set, Map, Object, Array, Number, String,
    addEventListener() {}, setInterval() {}, confirm: () => false,
    location: { reload() {} },
    document: { getElementById: (id) => (els[id] ||= el()), hidden: false },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  vm.runInContext(src + '\n;globalThis.__g = { G, player, stalls, coop, oven, PADS, update, helpers, customers, trees, NEST, OVEN_IN, OVEN_OUT, padVisible, padPaid, load, save };', ctx);
  ctx.__g.load();
  return { g: ctx.__g, els, store };
}

// Same strategy as the browser check: buy what is affordable, collect money, keep shelves stocked,
// stand at the counter while a customer waits, feed the bakery.
function play(g, seconds) {
  const p = g.player, log = [];
  const CASH = { egg: 'cashEgg', wood: 'cashWood', pie: 'cashPie' };
  const open = () => Object.values(g.stalls).filter((s) => g.G.bought.has(s.id));
  const go = (x, y) => { const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy), st = p.speed / 30; if (d > .3) { p.x += dx / d * Math.min(st, d); p.y += dy / d * Math.min(st, d); return false; } return true; };
  const tree = () => g.trees.find((t) => t.logs > 0);
  let task = null, forOven = false;
  const seen = new Set(g.G.bought);
  for (let i = 0; i < seconds * 30 && !g.G.won; i++) {
    if (!task) {
      const pad = g.PADS.find((q) => g.padVisible(q) && g.G.coins + g.padPaid(q) >= q.cost);
      const waiting = open().find((s) => !g.G.bought.has(CASH[s.type]) && s.shelf > 0 && s.queue[0] && s.queue[0].arrived && s.queue[0].pat < s.queue[0].patMax * .6);
      const rich = open().find((s) => s.coins >= 8);
      if (pad) task = { k: 'pad', x: pad.x, y: pad.y, id: pad.id };
      else if (waiting) task = { k: 'drop', x: waiting.drop.x, y: waiting.drop.y, s: waiting };
      else if (rich) task = { k: 'coins', x: rich.cz.x, y: rich.cz.y, s: rich };
      else if (p.stack.length && forOven && !(p.stack.length < p.cap && p.stack.every((q) => q.t === 'egg'))) { task = { k: 'oven', x: g.OVEN_IN.x, y: g.OVEN_IN.y }; forOven = false; }
      else if (p.stack.length && forOven) { const t = tree(); task = { k: 'gather', x: t.x, y: t.y + .8 }; }
      else if (p.stack.length) {
        const types = new Set(p.stack.map((s) => s.t));
        const st = open().find((s) => types.has(s.type) && s.shelf < s.max);
        if (st) task = { k: 'drop', x: st.drop.x, y: st.drop.y, s: st };
        else if (g.G.bought.has('oven')) task = { k: 'oven', x: g.OVEN_IN.x, y: g.OVEN_IN.y };
        else p.stack.length = 0;
      } else {
        const st = open().sort((a, b) => (a.shelf - a.queue.length * 2) - (b.shelf - b.queue.length * 2))[0];
        if (st.type === 'egg') task = { k: 'gather', x: g.NEST.x, y: g.NEST.y };
        else if (st.type === 'wood') { const t = tree(); task = t ? { k: 'gather', x: t.x, y: t.y + .8 } : { k: 'gather', x: g.NEST.x, y: g.NEST.y }; }
        else if (g.oven.pies > 0) task = { k: 'gather', x: g.OVEN_OUT.x, y: g.OVEN_OUT.y };
        else if (p.stack.length < p.cap / 2) { task = { k: 'gather', x: g.NEST.x, y: g.NEST.y, half: true }; forOven = true; }
      }
    }
    if (task && go(task.x, task.y)) {
      task.here = (task.here || 0) + 1 / 30;
      const done = task.k === 'pad' ? (g.G.bought.has(task.id) || g.G.coins === 0)
        : task.k === 'coins' ? task.s.coins === 0
        : task.k === 'drop' ? ((!p.stack.some((s) => s.t === task.s.type) || task.s.shelf >= task.s.max)
            && (g.G.bought.has(CASH[task.s.type]) || task.here > 10 || !(task.s.shelf > 0 && task.s.queue[0] && task.s.queue[0].entered)))
        : task.k === 'oven' ? task.here > 1.5 && (task.here > 4 || !p.stack.length)
        : (p.stack.length >= (task.half ? p.cap / 2 : p.cap) || task.here > 3);
      if (done) task = null;
    }
    g.update(1 / 30);
    for (const id of g.G.bought) if (!seen.has(id)) { seen.add(id); log.push(id); }
  }
  return log;
}

test('a bot can build the whole village and open the fair', () => {
  const { g, els } = loadGame();
  const log = play(g, 1800);
  assert.ok(g.G.won, `not finished in 30 min of game time; bought: ${log.join(', ')}`);
  assert.equal(els.win.hidden, false, 'the win screen is shown');
  assert.ok(g.G.time < 1500, `took ${Math.round(g.G.time)} s`);
});

test('selling needs someone at the counter until a cashier is hired', () => {
  const { g } = loadGame();
  const st = g.stalls.egg;
  st.shelf = 5; g.player.x = 4; g.player.y = 12;
  for (let i = 0; i < 30 * 40; i++) g.update(1 / 30);
  assert.equal(st.shelf, 5, 'nothing sold while the player is away');
  g.player.x = st.drop.x; g.player.y = st.drop.y;
  for (let i = 0; i < 30 * 5; i++) g.update(1 / 30);
  assert.ok(st.shelf < 5, 'sold while the player stands in the sell zone');
});

test('save and load restore progress', () => {
  const a = loadGame();
  a.g.G.coins = 42; a.g.G.bought.add('chick2'); a.g.save();
  const b = loadGame();
  Object.assign(b.store, a.store);
  b.g.load();
  assert.equal(b.g.G.coins, 42);
  assert.ok(b.g.G.bought.has('chick2'));
  assert.equal(b.g.coop.n, 2);
});
