// Runs the simulation (public/game.js) headless; the bot lives in test/bot.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadGame, play } from './bot.mjs';

const step = (g, s) => { for (let i = 0; i < s * 30; i++) g.update(1 / 30); };

test('a new farm starts small: an egg stall, a coop with one hen and the shed', () => {
  const { g } = loadGame(1);
  assert.deepEqual([...g.G.built].sort(), ['coop', 'eggStall', 'shed']);
  assert.equal(g.G.coins, 0);
  assert.equal(g.pens.coop.n, 1);
  assert.equal(g.pens.coop.animals.length, 1);
  assert.ok(g.PADS.some((p) => p.id === 'grove') && !g.padVisible(g.DEF.grove), 'the grove waits for the first upgrade');
});

test('the bot grows the whole farm, every plot and building, in under 100 minutes', () => {
  for (const seed of [1, 2]) {
    const { g } = loadGame(seed);
    const log = [];
    for (let m = 0; m < 100 && g.DEFS.some((d) => d.id !== 'fair' && !g.built(d.id)); m++) play(g, 60, { log });
    const missing = g.DEFS.filter((d) => d.id !== 'fair' && !g.built(d.id)).map((d) => d.id).join(' ');
    assert.equal(missing, '', `seed ${seed}: not built after ${Math.round(g.G.time / 60)} min`);
    // no long dry spells: something new (a pad or an upgrade) at least every 20 minutes
    const times = [0, ...log.map((e) => e.t)];
    const gap = Math.max(...times.slice(1).map((t, i) => t - times[i]));
    assert.ok(gap < 20 * 60, `seed ${seed}: ${Math.round(gap / 60)} min without a purchase`);
    assert.ok(g.G.rep >= 4, `seed ${seed}: rating ${g.G.rep}`);
  }
});

test('the fair is reachable once everything else is built', () => {
  const { g } = loadGame(3);
  for (let m = 0; m < 100 && g.DEFS.some((d) => d.id !== 'fair' && !g.built(d.id)); m++) play(g, 60);
  for (let m = 0; m < 60 && !g.built('fair'); m++) play(g, 60, { upgrades: false });
  assert.ok(g.built('fair'), `fair not built after ${Math.round(g.G.time / 60)} min`);
  assert.ok(g.G.fair);
});

test('upgrades cost coins, stay bought and change the game', () => {
  const { g } = loadGame(1);
  g.G.coins = 100000;
  const cap = g.player.cap, speed = g.player.speed;
  assert.ok(g.buyUpgrade('coop', 'hens'));
  assert.equal(g.pens.coop.n, 2); assert.equal(g.pens.coop.animals.length, 2);
  assert.ok(g.buyUpgrade('shed', 'bag')); assert.equal(g.player.cap, cap + 2);
  assert.ok(g.buyUpgrade('shed', 'boots')); assert.ok(g.player.speed > speed);
  const price = g.priceOf(g.stalls.egg), max = g.stalls.egg.max;
  for (let i = 0; i < 3; i++) assert.ok(g.buyUpgrade('eggStall', 'level'));
  assert.ok(g.priceOf(g.stalls.egg) > price); assert.equal(g.stalls.egg.max, max + 12);
  assert.equal(g.buyUpgrade('oven', 'speed'), false, 'only built buildings can be upgraded');
  while (g.upgradeCost('coop', 'hens') !== null) assert.ok(g.buyUpgrade('coop', 'hens'));
  assert.equal(g.buyUpgrade('coop', 'hens'), false, 'a track ends');
  assert.equal(g.pens.coop.n, 8);
  const { g: poor } = loadGame(1);
  assert.equal(poor.buyUpgrade('coop', 'hens'), false, 'not without money');
});

test('the upgrade button shows for the building the player stands next to', () => {
  const { g } = loadGame(1);
  const nest = g.pens.coop.pile;
  g.player.x = nest.x; g.player.y = nest.y + .3; step(g, .1);
  assert.equal(g.G.upNear, 'coop');
  g.player.x = g.stalls.egg.x - .9; g.player.y = 17.2; step(g, .1);
  assert.equal(g.G.upNear, 'eggStall');
  g.player.x = 10; g.player.y = 12; step(g, .1);
  assert.equal(g.G.upNear, null);
});

test('locked land cannot be entered until it is bought', () => {
  const { g } = loadGame(1);
  const p = g.player;
  p.x = .5; p.y = 10;
  for (let i = 0; i < 60; i++) { p.x -= .2; g.update(1 / 30); }
  assert.ok(p.x > -.6, `walked into the field: x ${p.x}`);
  // buy it on its pad
  const { g: k } = loadGame(1);
  for (const id of ['grove', 'woodStall', 'oven', 'pieStall']) k.G.built.add(id);
  k.G.up['coop.hens'] = 1;
  const pad = k.DEF.landField;
  assert.ok(k.padVisible(pad));
  k.G.coins = pad.cost; k.player.x = pad.x; k.player.y = pad.y;
  step(k, 6);
  assert.ok(k.built('landField'));
  k.player.x = -3; k.player.y = 10; step(k, .5);
  assert.ok(k.player.x < -2, 'the field is open now');
});

test('selling needs someone at the counter until a cashier is hired', () => {
  const { g } = loadGame(1);
  const st = g.stalls.egg;
  st.shelf = 5; g.player.x = 4; g.player.y = 12;
  step(g, 40);
  assert.equal(st.shelf, 5, 'nothing sold while the player is away');
  g.player.x = st.drop.x; g.player.y = st.drop.y;
  step(g, 5);
  assert.ok(st.shelf < 5, 'sold while the player stands in the sell zone');
});

test('workshops turn inputs into products and helpers carry them', () => {
  const { g } = loadGame(1);
  for (const id of ['grove', 'woodStall', 'oven', 'pieStall', 'helperEgg', 'helperWood', 'helperPie']) g.G.built.add(id);
  g.G.up['coop.hens'] = 3;
  g.G.coins = 200; assert.ok(g.buyUpgrade('coop', 'hens')); // a purchase applies what is built
  assert.equal(g.helpers.length, 3);
  g.player.x = 10; g.player.y = 13;
  step(g, 120);
  assert.ok(g.stalls.pie.shelf > 0 || g.stalls.pie.coins > 0 || g.convs.oven.out_n > 0, 'pies were baked and carried');
  assert.ok(g.stalls.egg.shelf > 0, 'the egg helper stocks the egg stall');
  assert.ok(g.stalls.wood.shelf > 0 || g.convs.oven.store.wood > 0, 'the wood helper chops and delivers');
});

test('the farm survives a reload: buildings, upgrades, money and shelves', () => {
  const a = loadGame(1);
  play(a.g, 400);
  a.g.save();
  const snap = JSON.parse(a.store[a.g.SAVE_KEY]);
  const b = loadGame(1, { ...a.store });
  assert.deepEqual([...b.g.G.built].sort(), [...a.g.G.built].sort());
  assert.equal(JSON.stringify(b.g.G.up), JSON.stringify(a.g.G.up));
  assert.equal(b.g.G.coins, a.g.G.coins);
  assert.equal(b.g.stalls.egg.shelf, a.g.stalls.egg.shelf);
  assert.equal(b.g.pens.coop.n, a.g.pens.coop.n);
  assert.equal(b.g.helpers.length, a.g.helpers.length);
  assert.equal(snap.v, 1);
  // keeps working after the reload
  const coins = b.g.G.coinsEver; play(b.g, 120);
  assert.ok(b.g.G.coinsEver > coins);
});

test('starting over clears the farm; saves from the old level mode are dropped', () => {
  const a = loadGame(1);
  play(a.g, 300);
  a.g.resetFarm();
  assert.deepEqual([...a.g.G.built].sort(), ['coop', 'eggStall', 'shed']);
  assert.equal(a.g.G.coins, 0);
  const old = { 'lavka-meta-v1': JSON.stringify({ bank: 50, stars: { 0: 3 } }), 'lavka-run-v1': JSON.stringify({ level: 2, coins: 9 }) };
  const b = loadGame(1, old);
  assert.equal(b.g.G.coins, 0);
  assert.equal(old['lavka-meta-v1'], undefined); assert.equal(old['lavka-run-v1'], undefined);
  const c = loadGame(1, { [b.g.SAVE_KEY]: '{broken' });
  assert.deepEqual([...c.g.G.built].sort(), ['coop', 'eggStall', 'shed'], 'a broken save starts a new farm');
});

test('the joystick sets direction only: a short drag moves as fast as a long one', () => {
  const run = (dy) => {
    const { g, ctx } = loadGame();
    vm.runInContext(`joy = { id: 1, ox: 100, oy: 300, x: 100, y: ${300 - dy} }`, ctx);
    const y0 = g.player.y; for (let i = 0; i < 15; i++) g.update(1 / 30);
    return y0 - g.player.y;
  };
  const short = run(20), long = run(120);
  assert.ok(short > 1, 'a short drag moves');
  assert.ok(Math.abs(short - long) < 1e-9, `same distance: ${short} vs ${long}`);
});

test('the touch joystick moves the player', () => {
  const { g, ctx } = loadGame();
  const p = g.player, x0 = p.x, y0 = p.y;
  vm.runInContext('joy = { id: 1, ox: 100, oy: 100, x: 100, y: 40 }', ctx); // drag up
  for (let i = 0; i < 30; i++) g.update(1 / 30);
  assert.ok(p.y < y0 - 2, `moved north: y ${y0} -> ${p.y}`);
  assert.ok(Math.abs(p.x - x0) < .3, 'no sideways drift');
  vm.runInContext('joy = { id: 1, ox: 100, oy: 100, x: 160, y: 100 }', ctx); // drag right
  for (let i = 0; i < 15; i++) g.update(1 / 30);
  assert.ok(p.x > x0 + 1, `moved east: x ${x0} -> ${p.x}`);
});
