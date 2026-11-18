// How fast the bot levels up and what it builds, to tune times and prices: node test/pacing.mjs [hours of active play] [seed]
import { loadGame, play } from './bot.mjs';
const hours = Number(process.argv[2] || 2), seed = Number(process.argv[3] || 1);
const { g } = loadGame(seed);
const t0 = g.clock.t, log = [];
const fmt = (ms) => { const m = Math.round((ms - t0) / 60000); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
let lastLvl = 1;
for (let m = 0; m < hours * 60; m++) {
  play(g, 60, { log });
  if (g.G.lvl !== lastLvl) { console.log(fmt(g.clock.t).padStart(6), `level ${g.G.lvl}`.padEnd(10), `coins ${g.G.coins}`, `task ${g.G.task}`); lastLvl = g.G.lvl; }
}
for (const e of log) console.log(fmt(e.t).padStart(6), 'built', e.id, 'at level', e.lvl);
console.log('end: level', g.G.lvl, 'xp', g.G.xp, 'coins', g.G.coins, 'served', g.G.served, 'rep', g.G.rep.toFixed(2), 'barn', g.barnUsed(), '/', g.G.barnCap, JSON.stringify(g.G.barn));
console.log('task', g.G.task, g.curTask().text, g.G.taskN + '/' + g.curTask().n);
