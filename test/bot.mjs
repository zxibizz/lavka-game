// Headless game loader and a simple bot, shared by the tests and test/calibrate.mjs.
import fs from 'node:fs';
import vm from 'node:vm';

export function loadGame(seed = 1) {
  let r = seed; // deterministic randomness, so a failure can be replayed
  const M = Object.create(Math); M.random = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const el = () => ({ hidden: true, onclick: null, textContent: '' });
  const els = {};
  const store = {};
  const ctx = {
    console, Math: M, JSON, Set, Map, Object, Array, Number, String,
    addEventListener() {}, setInterval() {}, confirm: () => false,
    location: { reload() {} },
    document: { getElementById: (id) => (els[id] ||= el()), hidden: false },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  vm.runInContext(src + '\n;globalThis.__g = { G, META, LEVELS, player, stalls, coop, oven, PADS, update, helpers, customers, trees, NEST, OVEN_IN, OVEN_OUT, padVisible, padPaid, load, save, startLevel, quitLevel, finishLevel, goalDone, goalProgress, buyUpgrade, up, levelUnlocked, starsFor };', ctx);
  ctx.results = []; ctx.onLevelDone = (r) => ctx.results.push(r);
  ctx.__g.load();
  return { g: ctx.__g, els, store, ctx };
}

// Same strategy as the browser check: buy what is affordable, collect money, keep shelves stocked,
// stand at the counter while a customer waits, feed the bakery.
export function play(g, seconds) {
  const p = g.player, log = [];
  const CASH = { egg: 'cashEgg', wood: 'cashWood', pie: 'cashPie' };
  const open = () => Object.values(g.stalls).filter((s) => g.G.bought.has(s.id));
  const go = (x, y) => { const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy), st = p.speed / 30; if (d > .3) { p.x += dx / d * Math.min(st, d); p.y += dy / d * Math.min(st, d); return false; } return true; };
  let skip = 0; // rotates which tree to use after a timeout
  const tree = () => { const ok = g.trees.filter((t) => t.logs > 0); return ok[skip % Math.max(1, ok.length)]; };
  let task = null, forOven = false;
  const seen = new Set(g.G.bought);
  for (let i = 0; i < seconds * 30 && !g.G.done; i++) {
    if (task && i - task.since > 30 * 12) { task = null; skip++; } // target unreachable (e.g. blocked by trees): pick another
    if (!task) {
      const pad = g.PADS.find((q) => g.padVisible(q) && g.G.coins + g.padPaid(q) >= q.cost);
      const waiting = open().find((s) => !g.G.bought.has(CASH[s.type]) && s.shelf > 0 && s.queue[0] && s.queue[0].arrived && s.queue[0].pat < s.queue[0].patMax * .6);
      const rich = open().find((s) => s.coins >= 8);
      if (pad) task = { k: 'pad', x: pad.x, y: pad.y, id: pad.id };
      else if (waiting) task = { k: 'drop', x: waiting.drop.x, y: waiting.drop.y, s: waiting };
      else if (rich) task = { k: 'coins', x: rich.cz.x, y: rich.cz.y, s: rich };
      else if (p.stack.length && forOven && !(p.stack.length < p.cap && p.stack.every((q) => q.t === 'egg'))) { task = { k: 'oven', x: g.OVEN_IN.x, y: g.OVEN_IN.y }; forOven = false; }
      else if (p.stack.length && forOven) { const t = tree(); task = { k: 'gather', x: t.x, y: t.y + .6 }; }
      else if (p.stack.length) {
        const types = new Set(p.stack.map((s) => s.t));
        const st = open().find((s) => types.has(s.type) && s.shelf < s.max);
        if (st) task = { k: 'drop', x: st.drop.x, y: st.drop.y, s: st };
        else if (g.G.bought.has('oven') && (types.has('wood') ? g.oven.wood < g.oven.max : g.oven.egg < g.oven.max)) task = { k: 'oven', x: g.OVEN_IN.x, y: g.OVEN_IN.y };
        else if (g.G.bought.has('grove') && p.stack.length < p.cap) { const t = tree(); task = { k: 'gather', x: t.x, y: t.y + .6 }; forOven = true; }
        else p.stack.length = 0;
      } else if (g.G.bought.has('oven') && g.oven.pies < 4 && g.LEVELS[g.G.level].goals.some((q) => q.k === 'bake' && !g.goalDone(q))) {
        task = { k: 'gather', x: g.NEST.x, y: g.NEST.y, half: true }; forOven = true;
      } else {
        const st = open().sort((a, b) => (a.shelf - a.queue.length * 2) - (b.shelf - b.queue.length * 2))[0];
        if (st.type === 'egg') task = { k: 'gather', x: g.NEST.x, y: g.NEST.y };
        else if (st.type === 'wood') { const t = tree(); task = t ? { k: 'gather', x: t.x, y: t.y + .6 } : { k: 'gather', x: g.NEST.x, y: g.NEST.y }; }
        else if (g.oven.pies > 0) task = { k: 'gather', x: g.OVEN_OUT.x, y: g.OVEN_OUT.y };
        else if (p.stack.length < p.cap / 2) { task = { k: 'gather', x: g.NEST.x, y: g.NEST.y, half: true }; forOven = true; }
      }
    }
    if (task && task.since === undefined) task.since = i;
    if (task && task.k === 'gather' && p.stack.length >= (task.half ? p.cap / 2 : p.cap)) task = null;
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

