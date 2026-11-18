'use strict';
// Menus and dialogs (DOM): pause and the upgrade card of a building.
// Game state and rules live in game.js; view.js calls uiInit() once the 3D scene is ready.

const $ = (id) => document.getElementById(id);
const SVG = {
  coin: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2" fill="#3fae3a"/><rect x="4" y="8" width="16" height="8" rx="1.5" fill="none" stroke="#9be887" stroke-width="1.4"/><circle cx="12" cy="12" r="2.6" fill="#9be887"/></svg>',
};
const cashHtml = (n) => `<span class="cash">${SVG.coin}<b>${n}</b></span>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const SCREENS = ['pause', 'upgrades', 'reset'];
let screen = null;
function show(name) {
  screen = name;
  for (const s of SCREENS) $(s).hidden = s !== name;
  $('pauseBtn').hidden = name !== null;
  G.paused = name !== null;
  if (name === null) save();
}

function openPause() {
  const built = G.built.size, total = DEFS.length;
  $('pauseStats').innerHTML = `Построено: <b>${built}</b> из ${total} · покупателей обслужено: <b>${G.served}</b>`;
  $('pauseFps').textContent = window.__fps ? `${Math.round(window.__fps)} кадров/с` : '';
  $('gfxLite').classList.toggle('on', window.__gfx === 'lite');
  $('gfxFull').classList.toggle('on', window.__gfx !== 'lite');
  show('pause');
}

// upgrade card: one row per track of the building
let upId = null;
function openUpgrades(id) {
  if (!TRACKS[id] || !built(id)) return;
  upId = id; renderUpgrades(); show('upgrades');
}
function renderUpgrades() {
  const id = upId;
  $('upTitle').textContent = BUILDING_TITLE(id);
  $('upBank').innerHTML = cashHtml(G.coins);
  const list = $('upList'); list.innerHTML = '';
  for (const t of TRACKS[id]) {
    const l = lvl(id + '.' + t.key), cost = upgradeCost(id, t.key), max = t.costs.length;
    const li = document.createElement('li');
    li.innerHTML = `<div class="u-text"><b>${esc(t.title)}</b><span>${esc(cost === null ? 'всё улучшено' : t.text(l))}</span>
      <span class="pips">${Array.from({ length: max }, (_, i) => `<i class="${i < l ? 'on' : ''}"></i>`).join('')}</span></div>`;
    const b = document.createElement('button');
    b.className = 'btn small';
    if (cost === null) { b.textContent = 'макс.'; b.disabled = true; } else {
      b.innerHTML = cashHtml(cost); b.disabled = G.coins < cost;
      b.onclick = () => { if (buyUpgrade(id, t.key)) renderUpgrades(); };
    }
    li.appendChild(b); list.appendChild(li);
  }
}

function uiInit(resumed) {
  $('pauseBtn').onclick = openPause;
  $('pauseResume').onclick = () => show(null);
  $('upClose').onclick = () => show(null);
  $('pauseReset').onclick = () => show('reset');
  $('resetNo').onclick = openPause;
  $('resetYes').onclick = () => { resetFarm(); show(null); };
  const setGfx = (v) => { if (v === window.__gfx) return; try { localStorage.setItem('lavka-gfx', v); } catch (e) {} save(); location.reload(); };
  $('gfxLite').onclick = () => setGfx('lite');
  $('gfxFull').onclick = () => setGfx('full');
  for (const s of SCREENS) $(s).addEventListener('pointerdown', (e) => { if (e.target === $(s) && s !== 'reset') show(null); }); // tap outside the card closes it
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (screen === null) openPause(); else show(null); } });
  show(null);
}
