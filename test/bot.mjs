// Headless game loader and a simple bot, shared by the tests and test/pacing.mjs.
import fs from 'node:fs';
import vm from 'node:vm';

export function loadGame(seed = 1, store = {}, { autoload = true } = {}) {
  let r = seed; // deterministic randomness, so a failure can be replayed
  const M = Object.create(Math); M.random = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const el = () => ({ hidden: true, onclick: null, textContent: '' });
  const els = {};
  const ctx = {
    console, Math: M, JSON, Set, Map, Object, Array, Number, String,
    addEventListener() {}, setInterval() {}, confirm: () => false,
    location: { reload() {} },
    document: { getElementById: (id) => (els[id] ||= el()), hidden: false },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  vm.runInContext(src + `
;globalThis.__g = { G, player, stalls, stallList, pens, penList, convs, convList, plants, PLANT_GROUPS, PRODUCER, DEFS, DEF, PADS, TRACKS, ZONES, update, helpers, customers,
  padVisible, padPaid, load, save, resetFarm, built, lvl, upgradeCost, buyUpgrade, consumers, nearbyUpgrade, upgradeAnchor, priceOf, hasCashier, SAVE_KEY };`, ctx);
  if (autoload) ctx.__g.load();
  return { g: ctx.__g, els, store, ctx };
}

// Plays like a sensible person: buys what is affordable, keeps every shelf stocked (fetching inputs for the
// workshops when a product runs out), stands at a counter while a customer waits, collects the money.
// Upgrades are bought from the menu without walking to the building (the only shortcut it takes).
export function play(g, seconds, { log = [], upgrades = true } = {}) {
  const p = g.player, G = g.G;
  const open = () => g.stallList.filter((s) => g.built(s.id));
  // walks straight, through the lane in front of the stalls when crossing the market; sidesteps when stuck
  let detour = null, best = 1e9, still = 0;
  const go = (x, y) => {
    if (Math.hypot(x - p.x, y - p.y) < .3) { detour = null; best = 1e9; still = 0; return true; }
    let tx = x, ty = y;
    if (Math.abs(x - p.x) > .8 && (p.y > 18.1 || y > 18.1)) { tx = p.y > 17.3 ? p.x : x; ty = 17; }
    if (detour) { tx = detour.x; ty = detour.y; if (--detour.n <= 0) detour = null; }
    const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy), st = p.speed / 30;
    if (d > 1e-6) { p.x += dx / d * Math.min(st, d); p.y += dy / d * Math.min(st, d); }
    const left = Math.hypot(x - p.x, y - p.y);
    if (left < best - .05) { best = left; still = 0; } else if (++still > 45 && !detour) {
      const s = Math.random() < .5 ? 1 : -1; detour = { x: p.x - dy / (d || 1) * 3 * s, y: p.y + dx / (d || 1) * 3 * s, n: 30 }; still = 0;
    }
    return false;
  };
  const nearestPlant = (group) => {
    let best = null, bd = 1e9;
    for (const t of g.plants) if (t.active && t.logs > 0 && t.group === group && !(skip.has(t))) { const d = Math.hypot(t.x - p.x, t.y - p.y); if (d < bd) { bd = d; best = t; } }
    return best;
  };
  const skip = new Set();
  function fetchPlan(item, depth = 0) {
    const [kind, id] = g.PRODUCER[item];
    if (!g.built(id)) return null;
    if (kind === 'pen') { const pen = g.pens[id]; return pen.stock > 0 ? { k: 'gather', x: pen.pile.x, y: pen.pile.y, item } : null; }
    if (kind === 'plants') { const t = nearestPlant(id); return t ? { k: 'gather', x: t.x, y: t.y + .6, item, plant: t } : null; }
    const c = g.convs[id];
    if (c.out_n > 0) return { k: 'gather', x: c.OUT.x, y: c.OUT.y, item };
    if (depth > 2) return null;
    for (const k of Object.keys(c.in).sort((a, b) => c.store[a] - c.store[b])) {
      if (c.store[k] >= c.max) continue;
      const q = fetchPlan(k, depth + 1); if (q) return q;
    }
    return null;
  }
  let task = null;
  const seen = new Set(G.built);
  const t0 = G.time;
  for (let i = 0; i < seconds * 30; i++) {
    if (task && i - task.since > 30 * 15) { if (task.plant) skip.add(task.plant); task = null; } // stuck: try something else
    if (i % 300 === 0) skip.clear();
    if (upgrades && i % 15 === 0) { // cheapest upgrade, while it is small next to the savings
      let best = null;
      for (const id of Object.keys(g.TRACKS)) if (g.built(id)) for (const t of g.TRACKS[id]) {
        const c = g.upgradeCost(id, t.key); if (c !== null && (!best || c < best.c)) best = { id, key: t.key, c };
      }
      if (best && best.c <= G.coins * .35 && g.buyUpgrade(best.id, best.key)) log.push({ t: G.time, id: best.id + '.' + best.key, cost: best.c });
    }
    if (!task) {
      const pad = g.PADS.filter((q) => g.padVisible(q) && G.coins + g.padPaid(q) >= q.cost).sort((a, b) => a.cost - b.cost)[0];
      const waiting = open().find((s) => !g.hasCashier(s) && s.shelf > 0 && s.queue[0] && s.queue[0].arrived && s.queue[0].pat < s.queue[0].patMax * .6);
      const rich = open().find((s) => s.coins >= 8 + G.time / 60);
      if (pad) task = { k: 'pad', x: pad.x, y: pad.y, id: pad.id };
      else if (waiting) task = { k: 'drop', x: waiting.drop.x, y: waiting.drop.y, s: waiting };
      else if (rich) task = { k: 'coins', x: rich.cz.x, y: rich.cz.y, s: rich };
      else if (p.stack.length) {
        const types = [...new Set(p.stack.map((s) => s.t))];
        const opts = types.flatMap((t) => g.consumers(t).filter((o) => o.fill < 1)).sort((a, b) => a.fill - b.fill);
        if (opts.length) {
          const o = opts[0];
          task = o.kind === 'stall' ? { k: 'drop', x: o.st.drop.x, y: o.st.drop.y, s: o.st } : { k: 'feed', x: o.c.IN.x, y: o.c.IN.y, c: o.c };
        } else p.stack.length = 0; // nothing takes it: drop it
      } else {
        const needs = open().sort((a, b) => a.shelf / a.max - b.shelf / b.max);
        for (const st of needs) { const q = fetchPlan(st.type); if (q) { task = q; break; } }
      }
    }
    if (task && task.since === undefined) { task.since = i; best = 1e9; still = 0; detour = null; }
    if (task && task.k === 'gather' && p.stack.length >= p.cap) task = null;
    if (task && go(task.x, task.y)) {
      task.here = (task.here || 0) + 1 / 30;
      const done = task.k === 'pad' ? (g.built(task.id) || G.coins === 0)
        : task.k === 'coins' ? task.s.coins === 0
        : task.k === 'drop' ? ((!p.stack.some((s) => s.t === task.s.type) || task.s.shelf >= task.s.max)
            && (g.hasCashier(task.s) || task.here > 10 || !(task.s.shelf > 0 && task.s.queue[0] && task.s.queue[0].entered)))
        : task.k === 'feed' ? task.here > .8
        : (p.stack.length >= p.cap || task.here > 3 || (task.plant && task.plant.logs <= 0));
      if (done) task = null;
    }
    g.update(1 / 30);
    for (const id of G.built) if (!seen.has(id)) { seen.add(id); log.push({ t: G.time, id, cost: g.DEF[id].cost }); }
  }
  return log;
}
