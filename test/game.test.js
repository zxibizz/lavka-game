// Runs the simulation (public/game.js) headless; the bot lives in test/bot.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadGame, play } from './bot.mjs';

test('every level can be finished within its silver time', () => {
  const { g: probe } = loadGame(1);
  for (let i = 0; i < probe.LEVELS.length; i++) {
    for (const seed of [1, 2, 3]) {
      const { g } = loadGame(seed);
      g.startLevel(i);
      play(g, 2400);
      const L = g.LEVELS[i];
      assert.ok(g.G.done, `level ${i + 1} seed ${seed}: not finished`);
      assert.ok(g.G.time <= L.silver, `level ${i + 1} seed ${seed}: ${Math.round(g.G.time)} s > silver ${L.silver}`);
      assert.ok(L.gold < L.silver, `level ${i + 1}: gold < silver`);
    }
  }
});

test('finishing a level pays savings, records stars and unlocks the next one', () => {
  const { g, ctx } = loadGame(1);
  assert.equal(g.levelUnlocked(1), false);
  g.startLevel(0);
  play(g, 600);
  const r = ctx.results.at(-1);
  assert.ok(r && r.level === 0 && r.first);
  assert.equal(r.stars, g.starsFor(0, r.time));
  assert.equal(g.META.stars[0], r.stars);
  assert.equal(g.META.bank, r.reward);
  assert.equal(g.levelUnlocked(1), true);
  g.startLevel(0); play(g, 600);
  const again = ctx.results.at(-1);
  assert.equal(again.first, false);
  assert.equal(again.reward, Math.round(g.LEVELS[0].reward * again.stars * .5), 'replays pay half');
});

test('stars follow the medal times', () => {
  const { g } = loadGame(1);
  const L = g.LEVELS[2];
  assert.equal(g.starsFor(2, L.gold), 3);
  assert.equal(g.starsFor(2, L.gold + 1), 2);
  assert.equal(g.starsFor(2, L.silver), 2);
  assert.equal(g.starsFor(2, L.silver + 1), 1);
});

test('workshop upgrades cost savings and change the game', () => {
  const { g } = loadGame(1);
  g.META.bank = 1000;
  g.startLevel(0);
  const cap = g.player.cap, speed = g.player.speed, coins = g.G.coins;
  assert.ok(g.buyUpgrade('bag')); assert.ok(g.buyUpgrade('speed')); assert.ok(g.buyUpgrade('start'));
  assert.equal(g.META.bank, 1000 - 3 * 15);
  g.startLevel(0);
  assert.equal(g.player.cap, cap + 1);
  assert.ok(g.player.speed > speed);
  assert.equal(g.G.coins, coins + 10);
  for (let i = 1; i < 5; i++) g.buyUpgrade('bag');
  assert.equal(g.up('bag'), 5);
  assert.equal(g.buyUpgrade('bag'), false, 'capped at 5');
});

test('a new level starts from a clean farm', () => {
  const { g } = loadGame(1);
  g.startLevel(14); play(g, 200);
  assert.ok(g.G.bought.size > 1);
  g.startLevel(0);
  assert.deepEqual([...g.G.bought], ['eggStall']);
  assert.equal(g.G.coins, 0); assert.equal(g.G.time, 0);
  assert.equal(g.customers.length, 0); assert.equal(g.player.stack.length, 0);
  assert.equal(g.stalls.egg.shelf, 0);
  assert.ok(!g.padVisible(g.PADS.find((p) => p.id === 'grove')), 'pads outside the level are hidden');
});

test('selling needs someone at the counter until a cashier is hired', () => {
  const { g } = loadGame(1);
  g.startLevel(0);
  const st = g.stalls.egg;
  st.shelf = 5; g.player.x = 4; g.player.y = 12;
  for (let i = 0; i < 30 * 40; i++) g.update(1 / 30);
  assert.equal(st.shelf, 5, 'nothing sold while the player is away');
  g.player.x = st.drop.x; g.player.y = st.drop.y;
  for (let i = 0; i < 30 * 5; i++) g.update(1 / 30);
  assert.ok(st.shelf < 5, 'sold while the player stands in the sell zone');
});

test('a level in progress survives a reload', () => {
  const a = loadGame(1);
  a.g.startLevel(3);
  for (let i = 0; i < 30 * 20; i++) a.g.update(1 / 30);
  a.g.G.coins = 42; a.g.save();
  const b = loadGame(1);
  Object.assign(b.store, a.store);
  assert.equal(b.g.load(), true);
  assert.equal(b.g.G.level, 3);
  assert.equal(b.g.G.coins, 42);
  assert.ok(Math.abs(b.g.G.time - a.g.G.time) < 1e-9);
  b.g.quitLevel();
  const c = loadGame(1);
  Object.assign(c.store, b.store);
  assert.equal(c.g.load(), false, 'quitting forgets the run');
});

test('the touch joystick moves the player', () => {
  const { g, ctx } = loadGame();
  g.startLevel(0);
  const p = g.player, x0 = p.x, y0 = p.y;
  vm.runInContext('joy = { id: 1, ox: 100, oy: 100, x: 100, y: 40 }', ctx); // drag up
  for (let i = 0; i < 30; i++) g.update(1 / 30);
  assert.ok(p.y < y0 - 2, `moved north: y ${y0} -> ${p.y}`);
  assert.ok(Math.abs(p.x - x0) < .3, 'no sideways drift');
  vm.runInContext('joy = { id: 1, ox: 100, oy: 100, x: 160, y: 100 }', ctx); // drag right
  for (let i = 0; i < 15; i++) g.update(1 / 30);
  assert.ok(p.x > x0 + 1, `moved east: x ${x0} -> ${p.x}`);
});
