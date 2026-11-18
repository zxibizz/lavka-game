// Prints when the bot buys each thing, to tune prices: node test/pacing.mjs [minutes] [seed]
import { loadGame, play } from './bot.mjs';
const minutes = Number(process.argv[2] || 120), seed = Number(process.argv[3] || 1);
const { g } = loadGame(seed);
const log = [];
for (let m = 0; m < minutes; m++) play(g, 60, { log });
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
let ups = 0;
for (const e of log) {
  if (e.id.includes('.')) { ups++; continue; }
  console.log(fmt(e.t).padStart(6), e.id.padEnd(14), String(e.cost).padStart(6), ` (+${ups} upgrades)`); ups = 0;
}
console.log('upgrades after the last pad:', ups, '| coins', g.G.coins, '| served', g.G.served, '| rep', g.G.rep.toFixed(2));
console.log('not built:', g.DEFS.filter((d) => !g.built(d.id)).map((d) => d.id).join(' '));
const levels = Object.entries(g.G.up).map(([k, v]) => `${k}=${v}`).join(' ');
console.log('levels:', levels);
