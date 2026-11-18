'use strict';
// Menus and cards (DOM): pause, building cards, the build menu, placement controls, the seed bar,
// level-up and "while you were away". Game state and rules live in game.js; view.js draws the world
// and calls uiInit() once the 3D scene is ready. Icons come from view.js (window.iconURL).

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ic = (k, cls = 'ic') => `<img class="${cls}" src="${window.iconURL ? window.iconURL(k) : ''}" alt="">`;
const cash = (n) => `<span class="cash">${ic('coin', 'ic s')}<b>${n}</b></span>`;

const SCREENS = ['pause', 'card', 'shop', 'reset', 'levelup', 'away'];
let screen = null;
function show(name) {
  screen = name;
  for (const s of SCREENS) $(s).hidden = s !== name;
  G.paused = name !== null && name !== 'card'; // the farm keeps working while a card is open
  syncChrome();
  if (name === null) save();
}
// buttons over the game: pause, build, the placement bar
function syncChrome() {
  const free = screen === null || screen === 'card';
  $('pauseBtn').hidden = !free || !!G.placing;
  $('buildBtn').hidden = !free || !!G.placing;
  $('placeBar').hidden = !G.placing;
}

function openPause() {
  $('pauseStats').innerHTML = `Уровень <b>${G.lvl}</b> · построек <b>${B.length}</b> · покупателей обслужено <b>${G.served}</b>`;
  $('pauseFps').textContent = window.__fps ? `${Math.round(window.__fps)} кадров/с` : '';
  $('gfxLite').classList.toggle('on', window.__gfx === 'lite');
  $('gfxFull').classList.toggle('on', window.__gfx !== 'lite');
  show('pause');
}

// ---------- building cards ----------
let cardHit = null;
function openCard(hit) { cardHit = hit; renderCard(); show('card'); }
const btn = (label, onclick, { disabled = false, cls = '' } = {}) => {
  const b = document.createElement('button'); b.className = 'btn small ' + cls; b.innerHTML = label; b.disabled = disabled;
  b.onclick = (e) => { e.stopPropagation(); onclick(); renderCard(); }; return b;
};
const row = (html, ...buttons) => { const li = document.createElement('li'); li.innerHTML = `<div class="u-text">${html}</div>`; for (const b of buttons) li.appendChild(b); return li; };
function renderCard() {
  if (!cardHit) return;
  const list = $('cardList'); list.innerHTML = '';
  const s = wall();
  if (cardHit.stall !== undefined) {
    const i = cardHit.stall;
    $('cardTitle').textContent = `Прилавок ${i + 1}`;
    $('cardSub').textContent = 'Покупатели берут товар из амбара, пока ты стоишь в зоне «Продажа» или работает продавец.';
    const c = cashierCost(i);
    list.appendChild(G.cashiers[i] ? row('<b>Продавец</b><span>торгует сам</span>') : row('<b>Продавец</b><span>торгует, пока ты занята</span>',
      c === null ? btn('с ур. 2', () => {}, { disabled: true }) : btn(cash(c), () => hireCashier(i), { disabled: G.coins < c })));
    $('cardMove').hidden = true; $('cardSell').hidden = true;
    return;
  }
  const b = cardHit.b;
  if (!B.includes(b)) { show(null); return; }
  const C = CATALOG[b.type], k = C.kind;
  $('cardTitle').textContent = C.name;
  $('cardSub').textContent = '';
  $('cardMove').hidden = false; $('cardSell').hidden = k !== 'decor';
  const left = timeLeft(b, s), speed = () => btn('Ускорить ' + cash(speedCost(left)), () => speedUp(b), { disabled: G.coins < speedCost(left), cls: 'alt' });
  if (k === 'field') {
    const st = fieldState(b, s);
    if (st === 'ripe') $('cardSub').textContent = `${ITEM[b.crop].name} созрела — пройди по грядке, чтобы собрать.`;
    else if (st === 'growing') list.appendChild(row(`${ic(b.crop)}<b>${ITEM[b.crop].name}</b><span>созреет через ${fmtTime(left)}</span>`, speed()));
    else {
      $('cardSub').textContent = 'Что посадить?';
      for (const [crop, c] of Object.entries(CROPS)) {
        const locked = G.lvl < c.lvl;
        list.appendChild(row(`${ic(crop)}<b>${ITEM[crop].name}</b><span>${locked ? 'с уровня ' + c.lvl : fmtTime(c.t) + ' · урожай ' + c.yield}</span>`,
          btn(locked ? 'ур. ' + c.lvl : c.seed ? cash(c.seed) : 'Посадить', () => { G.seed = crop; plant(b, crop); }, { disabled: locked || G.coins < c.seed })));
      }
    }
  } else if (k === 'pen') {
    const an = ANIMALS[C.animal], ac = animalCost(b);
    $('cardSub').textContent = `${ITEM[an.item].name}: ${b.stock} из ${penCap(b)} — забери у входа.`;
    list.appendChild(row(`${ic(an.item)}<b>Следующее</b><span>${b.stock >= penCap(b) ? 'места нет — забери' : 'через ' + fmtTime(left)}</span>`, ...(left > 0 && b.stock < penCap(b) ? [speed()] : [])));
    list.appendChild(row(`${ic(C.icon)}<b>${C.animal === 'cow' ? 'Коровы' : 'Куры'}: ${b.n} из ${an.max}</b><span>${ac === null ? 'больше не поместится' : 'ещё одна ' + an.name}</span>`,
      ...(ac === null ? [] : [btn(cash(ac), () => buyAnimal(b), { disabled: G.coins < ac })])));
  } else if (k === 'factory') {
    $('cardSub').textContent = b.out.length ? `Готово: ${b.out.length} — забери у входа.` : `Очередь: ${b.queue.length} из ${b.slots}`;
    RECIPES[b.type].forEach((r, ri) => {
      const locked = G.lvl < (r.lvl || 1), enough = Object.entries(r.in).every(([t, n]) => have(t) >= n);
      const ins = Object.entries(r.in).map(([t, n]) => `<i class="need ${have(t) >= n ? '' : 'miss'}">${ic(t, 'ic s')}${have(t)}/${n}</i>`).join(' ');
      list.appendChild(row(`${ic(r.out)}<b>${ITEM[r.out].name}</b><span>${locked ? 'с уровня ' + r.lvl : ins + ' · ' + fmtTime(r.t)}</span>`,
        btn(locked ? 'ур. ' + r.lvl : 'Сделать', () => enqueue(b, ri), { disabled: locked || !enough || b.queue.length >= b.slots })));
    });
    b.queue.forEach((j, n) => {
      const r = RECIPES[b.type][j.r];
      list.appendChild(row(`${ic(r.out)}<b>${n === 0 ? 'Готовится' : 'В очереди'}: ${ITEM[r.out].name}</b><span>${n === 0 ? 'ещё ' + fmtTime(Math.max(0, j.end - s)) : 'после предыдущего'}</span>`, ...(n === 0 ? [speed()] : [])));
    });
    const sc = slotCost(b);
    if (sc !== null) list.appendChild(row(`<b>Ещё место в очереди</b><span>${b.slots} → ${b.slots + 1}</span>`, btn(cash(sc), () => buySlot(b), { disabled: G.coins < sc })));
  } else if (k === 'barn') {
    $('cardSub').textContent = `Занято ${barnUsed()} из ${G.barnCap}`;
    const li = document.createElement('li'); li.className = 'grid';
    li.innerHTML = Object.keys(ITEM).filter((t) => have(t)).map((t) => `<span>${ic(t)}<b>${have(t)}</b></span>`).join('') || '<em>Пока пусто — принеси урожай.</em>';
    list.appendChild(li);
    for (const [key, u] of Object.entries(UPGRADES)) {
      const c = upgradeCost(key);
      list.appendChild(row(`<b>${u.title}</b><span>${c === null ? 'всё улучшено' : u.text()}</span>`, ...(c === null ? [] : [btn(cash(c), () => buyUpgrade(key), { disabled: G.coins < c })])));
    }
    const wc = workerCost();
    list.appendChild(row(`${ic('person')}<b>Работник: ${G.workers}</b><span>${wc !== null ? 'собирает урожай и носит в амбар' : workerLimit() ? 'больше нельзя' : 'с уровня 6'}</span>`,
      ...(wc === null ? [] : [btn(cash(wc), () => hireWorker(), { disabled: G.coins < wc })])));
  } else if (k === 'decor') {
    $('cardSub').textContent = `Украшение: больше покупателей и они терпеливее (+${C.cozy}).`;
  }
}

// ---------- build menu ----------
let shopTab = 'farm';
function openShop() { renderShop(); show('shop'); }
function renderShop() {
  for (const t of document.querySelectorAll('#shopTabs button')) t.classList.toggle('on', t.dataset.tab === shopTab);
  $('shopBank').innerHTML = cash(G.coins);
  const list = $('shopList'); list.innerHTML = '';
  for (const [type, c] of Object.entries(CATALOG)) {
    if (c.cat !== shopTab || type === 'barn') continue;
    const st = canBuy(type), n = builtCount(type), lim = c.limit(G.lvl), cost = c.cost(n);
    const li = document.createElement('li'); li.className = 'shopItem' + (st === 'lvl' ? ' locked' : '');
    const note = st === 'lvl' ? `с уровня ${c.lvl}` : st === 'limit' ? (lim >= 99 ? '' : `построено ${n} из ${lim}`) : lim < 99 ? `${n} из ${lim}` : '';
    li.innerHTML = `${ic(c.icon, 'ic big')}<b>${esc(c.name)}</b><span>${note}</span><div class="price">${st === 'lvl' ? 'ур. ' + c.lvl : st === 'limit' ? 'есть' : cash(cost)}</div>`;
    if (st === 'ok' || st === 'coins') li.onclick = () => {
      if (canBuy(type) !== 'ok') { li.classList.add('shake'); setTimeout(() => li.classList.remove('shake'), 400); return; }
      if (type === 'stall') { build('stall'); show(null); return; }
      startPlacing(type, null);
    };
    list.appendChild(li);
  }
}
// placement: the building follows the finger (or a tap) on the grid; ✓ builds or moves it
function startPlacing(type, b) {
  const c = CATALOG[type];
  const spot = b ? { x: b.x, y: b.y } : freeSpot(type, player.x, player.y - 3) || { x: Math.round(player.x - c.w / 2), y: Math.round(player.y - c.h - 2) };
  G.placing = { type, b, x: spot.x, y: spot.y };
  show(null);
}
function confirmPlacing() {
  const P = G.placing; if (!P) return;
  if (!canPlace(P.type, P.x, P.y, P.b)) { $('placeOk').classList.add('shake'); setTimeout(() => $('placeOk').classList.remove('shake'), 400); return; }
  const ok = P.b ? moveBuilding(P.b, P.x, P.y) : build(P.type, P.x, P.y);
  if (!ok) { // e.g. the coins were spent meanwhile
    $('placeOk').classList.add('shake'); setTimeout(() => $('placeOk').classList.remove('shake'), 400);
    if (!P.b && canBuy(P.type) === 'coins') { G.placing = null; openShop(); }
    return;
  }
  G.placing = null; syncChrome();
}

// ---------- seed bar: what to sow when walking over empty fields ----------
let seedKey = '';
function syncSeeds() {
  const b = G.near, show = !!b && !G.placing && screen === null && CATALOG[b.type].kind === 'field' && fieldState(b) === 'empty';
  const key = show ? G.seed + G.lvl + '|' + G.coins : '';
  $('seedBar').hidden = !show;
  if (!show || key === seedKey) return;
  seedKey = key;
  const bar = $('seedBar'); bar.innerHTML = '';
  for (const [crop, c] of Object.entries(CROPS)) {
    if (G.lvl < c.lvl) continue;
    const e = document.createElement('button');
    e.className = 'seed' + (G.seed === crop ? ' on' : '');
    e.innerHTML = `${ic(crop)}<small>${fmtTime(c.t)}</small>`;
    e.disabled = G.coins < c.seed;
    e.onclick = () => { G.seed = crop; if (G.near && fieldState(G.near) === 'empty') plant(G.near, crop); seedKey = ''; };
    bar.appendChild(e);
  }
}

function uiInit() {
  $('pauseBtn').onclick = openPause;
  $('buildBtn').onclick = openShop;
  $('pauseResume').onclick = () => show(null);
  $('pauseReset').onclick = () => show('reset');
  $('resetNo').onclick = openPause;
  $('resetYes').onclick = () => { resetFarm(); show(null); };
  $('cardClose').onclick = () => show(null);
  $('cardMove').onclick = () => { const b = cardHit && cardHit.b; if (b) startPlacing(b.type, b); };
  $('cardSell').onclick = () => { const b = cardHit && cardHit.b; if (b && CATALOG[b.type].kind === 'decor') { G.coins += Math.floor(CATALOG[b.type].cost(0) / 2); B.splice(B.indexOf(b), 1); derive(); save(); show(null); } };
  $('shopClose').onclick = () => show(null);
  for (const t of document.querySelectorAll('#shopTabs button')) t.onclick = () => { shopTab = t.dataset.tab; renderShop(); };
  $('placeOk').onclick = confirmPlacing;
  $('placeNo').onclick = () => { G.placing = null; syncChrome(); };
  $('levelOk').onclick = () => { G.levelUp = null; show(null); };
  $('awayOk').onclick = () => show(null);
  const setGfx = (v) => { if (v === window.__gfx) return; try { localStorage.setItem('lavka-gfx', v); } catch (e) {} save(); location.reload(); };
  $('gfxLite').onclick = () => setGfx('lite');
  $('gfxFull').onclick = () => setGfx('full');
  for (const s of SCREENS) $(s).addEventListener('pointerdown', (e) => { if (e.target === $(s) && s !== 'reset' && s !== 'levelup') show(null); });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (G.placing) { G.placing = null; syncChrome(); } else if (screen === null) openPause(); else show(null); }
    if (e.key === 'Enter' && G.placing) confirmPlacing();
  });
  // a few times a second: cards with timers, the seed bar, level-ups
  let pressed = false, tick = 0;
  addEventListener('pointerdown', () => { pressed = true; }, true);
  addEventListener('pointerup', () => { pressed = false; }, true);
  setInterval(() => {
    if (screen === 'card' && !pressed && ++tick % 4 === 0) renderCard(); // timers; never while a finger is down on a button
    if (screen === 'shop') $('shopBank').innerHTML = cash(G.coins);
    syncSeeds();
    if (G.levelUp && screen !== 'levelup' && !G.placing) {
      $('levelNum').textContent = `Уровень ${G.levelUp.lvl}!`;
      $('levelList').innerHTML = G.levelUp.unlocks.length ? G.levelUp.unlocks.map((u) => `<span>${ic(u.icon, 'ic big')}<b>${esc(u.name)}</b></span>`).join('') : '<em>Новые задания и больше грядок.</em>';
      show('levelup');
    }
  }, 250);
  show(null);
  if (G.restarted) {
    $('awayText').textContent = 'Игра обновилась: теперь ферма живёт по настоящему времени, здания можно ставить где хочешь, а уровни открывают новое. Ферма начинается заново.';
    show('away');
  } else if (G.away > 120) {
    $('awayText').textContent = `Тебя не было ${fmtTime(G.away)}. За это время урожай подрос, куры несли яйца, а фабрики доделали заказы.`;
    show('away');
  }
}
