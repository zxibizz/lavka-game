// Prints how long the bot needs for each level; gold/silver times in game.js are derived from this.
// Usage: node test/calibrate.mjs [seeds]
import { loadGame, play } from './bot.mjs';
const seeds = Number(process.argv[2] || 6);
const { g: probe } = loadGame(1);
for (let i = 0; i < probe.LEVELS.length; i++) {
  const times = [];
  let fails = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const { g } = loadGame(seed);
    g.startLevel(i);
    play(g, 2400);
    if (g.G.done) times.push(g.G.time); else fails++;
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)] ?? NaN;
  console.log(String(i + 1).padStart(2), probe.LEVELS[i].title.padEnd(22), 'median', Math.round(med), 'max', Math.round(times.at(-1) ?? NaN), fails ? `FAILED ${fails}` : '');
}
