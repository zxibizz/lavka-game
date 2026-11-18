// Runs the simulation (public/game.js) headless on a fake clock; the bot lives in test/bot.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadGame, play } from './bot.mjs';

const ids = (g) => g.B.map((b) => b.type).sort().join(' ');

test('a new farm: barn, coop, four ripe wheat fields, one stall', () => {
  const { g } = loadGame(1);
  assert.equal(ids(g), 'barn coop field field field field');
  assert.equal(g.G.stalls, 1);
  assert.equal(g.G.lvl, 1);
  assert.ok(g.B.filter((b) => b.type === 'field').every((b) => g.fieldState(b) === 'ripe'));
});

test('harvest goes into the basket, then into the barn; customers buy from the barn at the counter', () => {
  const { g } = loadGame(1);
  const f = g.B.find((b) => b.type === 'field'), c = g.center(f), p = g.player;
  p.x = c.x; p.y = c.y; g.step(1);
  assert.equal(p.stack.length, 2, 'two wheat from one field');
  assert.equal(g.fieldState(f), 'empty');
  const barn = g.B.find((b) => b.type === 'barn'), fr = g.front(barn);
  p.x = fr.x; p.y = fr.y; g.step(1);
  assert.equal(p.stack.length, 0); assert.equal(g.have('wheat'), 2);
  const st = g.stallState[0];
  p.x = st.counter.x; p.y = st.counter.y;
  g.step(40);
  assert.ok(g.have('wheat') < 2, 'sold from the barn');
  assert.ok(st.coins > 0 || g.G.coins > 30, 'paid');
});

test('nobody comes to buy while the barn is empty', () => {
  const { g } = loadGame(1);
  g.player.x = 2; g.player.y = 14;
  g.step(60);
  assert.equal(g.customers.length, 0);
});

test('crops grow by the clock, also while the game is closed', () => {
  const a = loadGame(1);
  const f = a.g.B.find((b) => b.type === 'field');
  f.crop = null;
  a.g.G.coins = 100;
  assert.ok(a.g.plant(f, 'wheat'));
  assert.equal(a.g.fieldState(f), 'growing');
  a.g.save();
  const b = loadGame(1, { ...a.store }, { start: a.clock.t + 3 * 60 * 1000 }); // reopened 3 minutes later
  const f2 = b.g.B.find((x) => x.id === f.id);
  assert.equal(b.g.fieldState(f2), 'ripe');
  assert.ok(b.g.G.away >= 179);
});

test('hens lay while the game is closed, up to what the nest holds', () => {
  const a = loadGame(1);
  const coop = a.g.B.find((b) => b.type === 'coop');
  coop.stock = 0; coop.t = a.clock.t / 1000; a.g.save();
  const b = loadGame(1, { ...a.store }, { start: a.clock.t + 10 * 60 * 1000 });
  const c2 = b.g.B.find((x) => x.type === 'coop');
  assert.equal(c2.stock, 2, '10 minutes, one hen laying every 4 minutes');
  const c = loadGame(1, { ...a.store }, { start: a.clock.t + 24 * 3600 * 1000 });
  const c3 = c.g.B.find((x) => x.type === 'coop');
  assert.equal(c3.stock, c.g.penCap(c3), 'a day later the nest is full, not more');
});

test('workshops queue jobs, take inputs from the barn and finish by the clock', () => {
  const { g } = loadGame(1);
  g.G.lvl = 3; g.G.coins = 1000;
  const spot = g.freeSpot('mill', 8, 2);
  const mill = g.build('mill', spot.x, spot.y);
  assert.ok(mill);
  assert.equal(g.enqueue(mill, 0), false, 'no wheat yet');
  g.G.barn.wheat = 6;
  assert.ok(g.enqueue(mill, 0)); assert.ok(g.enqueue(mill, 0));
  assert.equal(g.enqueue(mill, 0), false, 'two slots');
  assert.equal(g.have('wheat'), 2);
  g.skip(130); g.tickAll();
  assert.equal(mill.out.length, 1); assert.equal(mill.queue.length, 1);
  g.skip(130); g.tickAll();
  assert.equal(mill.out.length, 2);
  const fr = g.front(mill); g.player.x = fr.x; g.player.y = fr.y; g.step(1);
  assert.equal(mill.out.length, 0); assert.equal(g.player.stack.filter((s) => s.t === 'flour').length, 2);
});

test('speeding up costs coins and finishes the timer', () => {
  const { g } = loadGame(1);
  const f = g.B.find((b) => b.type === 'field'); f.crop = null; g.G.coins = 100;
  g.plant(f, 'wheat');
  const coins = g.G.coins, left = g.timeLeft(f);
  assert.ok(left > 100);
  assert.ok(g.speedUp(f));
  assert.equal(g.fieldState(f), 'ripe');
  assert.equal(g.G.coins, coins - Math.ceil(left / 30));
});

test('buildings go only on free cells, keep the space in front of doors free, and can be moved', () => {
  const { g } = loadGame(1);
  g.G.lvl = 10; g.G.coins = 100000;
  const barn = g.B.find((b) => b.type === 'barn');
  assert.equal(g.canPlace('mill', barn.x, barn.y), false, 'on top of the barn');
  assert.equal(g.canPlace('field', barn.x + 1, barn.y + 3), false, 'in front of the barn door');
  assert.equal(g.canPlace('mill', -1, 0), false, 'outside the land');
  assert.equal(g.canPlace('mill', 0, 14), false, 'door would face the market');
  const s = g.freeSpot('bakery', 5, -4);
  const bk = g.build('bakery', s.x, s.y);
  assert.ok(bk);
  const t = g.freeSpot('bakery', 25, -5, bk);
  assert.ok(g.moveBuilding(bk, t.x, t.y));
  assert.equal(bk.x, t.x);
  assert.equal(g.canBuy('bakery'), 'limit');
  g.G.lvl = 1; assert.equal(g.canBuy('mill'), 'lvl');
});

test('levels come with experience and open new things', () => {
  const { g } = loadGame(1);
  assert.equal(g.canBuy('mill'), 'lvl');
  play(g, 300);
  assert.ok(g.G.lvl >= 2, `level ${g.G.lvl}`);
  assert.notEqual(g.canBuy('mill'), 'lvl');
});

test('the story tasks guide the first steps and pay out', () => {
  const { g } = loadGame(1);
  assert.equal(g.curTask().ev, 'harvest');
  play(g, 240);
  assert.ok(g.G.task >= 3, `task ${g.G.task}`);
});

test('a worker harvests, sows the same crop again and carries everything to the barn', () => {
  const { g } = loadGame(1);
  g.G.lvl = 6; g.G.coins = 1000;
  assert.ok(g.hireWorker());
  g.player.x = 2; g.player.y = 14;
  g.step(60);
  assert.ok(g.have('wheat') >= 6, `barn has ${g.have('wheat')} wheat`);
  assert.ok(g.B.filter((b) => b.type === 'field').every((b) => b.crop === 'wheat'), 'fields sown again');
});

test('the bot levels up steadily and builds workshops (an hour of play)', () => {
  const { g } = loadGame(2);
  const log = play(g, 3600);
  assert.ok(g.G.lvl >= 6, `level ${g.G.lvl}`);
  assert.ok(log.some((e) => e.id === 'mill') && log.some((e) => e.id === 'bakery'), log.map((e) => e.id).join(' '));
  assert.ok(g.G.rep >= 3, `rating ${g.G.rep}`);
});

test('the farm survives a reload', () => {
  const a = loadGame(1);
  play(a.g, 600); a.g.save();
  const b = loadGame(1, { ...a.store }, { start: a.clock.t });
  assert.equal(ids(b.g), ids(a.g));
  assert.equal(b.g.G.coins, a.g.G.coins);
  assert.equal(b.g.G.lvl, a.g.G.lvl);
  assert.equal(JSON.stringify(b.g.G.barn), JSON.stringify(a.g.G.barn));
});

test('nothing is saved before the farm has loaded', () => {
  const a = loadGame(1);
  play(a.g, 200); a.g.save();
  const before = a.store[a.g.SAVE_KEY];
  const b = loadGame(1, a.store, { autoload: false });
  b.g.save();
  assert.equal(a.store[a.g.SAVE_KEY], before);
});

test('starting over and old saves', () => {
  const a = loadGame(1);
  play(a.g, 200); a.g.resetFarm();
  assert.equal(ids(a.g), 'barn coop field field field field');
  const old = { 'lavka-farm-v1': '{"v":1}', 'lavka-meta-v1': '{}' };
  const b = loadGame(1, old);
  assert.equal(old['lavka-farm-v1'], undefined);
  assert.equal(b.g.G.lvl, 1);
  const c = loadGame(1, { [b.g.SAVE_KEY]: '{broken' });
  assert.equal(ids(c.g), 'barn coop field field field field');
});

test('the joystick sets direction only', () => {
  const run = (dy) => {
    const { g, ctx } = loadGame();
    g.player.x = 10; g.player.y = 4;
    vm.runInContext(`joy = { id: 1, ox: 100, oy: 300, x: 100, y: ${300 + dy} }`, ctx);
    const y0 = g.player.y; g.step(.5);
    return g.player.y - y0;
  };
  const short = run(20), long = run(120);
  assert.ok(short > 1);
  assert.ok(Math.abs(short - long) < 1e-9);
});
