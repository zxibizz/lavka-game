'use strict';
// Menus and dialogs (DOM): level map, level intro, pause, results, workshop.
// Game state and rules live in game.js; view.js calls uiInit() once the 3D scene is ready.

const $ = (id) => document.getElementById(id);
const SVG = {
  star: (on) => `<svg viewBox="0 0 24 24" class="star ${on ? 'on' : ''}"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z"/></svg>`,
  egg: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="13" rx="7" ry="8.5" fill="#fff8ec" stroke="#d8c3a0" stroke-width="1.5"/></svg>',
  wood: '<svg viewBox="0 0 24 24"><rect x="2" y="13" width="17" height="7" rx="3.5" fill="#b06d32"/><ellipse cx="19" cy="16.5" rx="2.5" ry="3.5" fill="#f1c98e"/><rect x="5" y="5" width="15" height="7" rx="3.5" fill="#a8622c"/><ellipse cx="20" cy="8.5" rx="2.5" ry="3.5" fill="#f1c98e"/></svg>',
  pie: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="15" rx="10" ry="5" fill="#c27b33"/><ellipse cx="12" cy="12.5" rx="9.5" ry="4.5" fill="#f2bb5c"/><path d="M7 11l5 3M11 10l5 3" stroke="#c27b33" stroke-width="1.4"/></svg>',
  coin: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2" fill="#3fae3a"/><rect x="4" y="8" width="16" height="8" rx="1.5" fill="none" stroke="#9be887" stroke-width="1.4"/><circle cx="12" cy="12" r="2.6" fill="#9be887"/></svg>',
  person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="#5b8def"/><path d="M4 21c0-5 3.6-8 8-8s8 3 8 8z" fill="#5b8def"/></svg>',
  build: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9H3z" fill="#e0393f"/><rect x="9.5" y="13" width="5" height="7" fill="#7a2a20"/></svg>',
  rep: '<svg viewBox="0 0 24 24"><path fill="#ffc928" d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" fill="#8d9a86"/><path d="M8 11V8a4 4 0 018 0v3" stroke="#8d9a86" stroke-width="2.4" fill="none"/></svg>',
};
const goalIcon = (g) => SVG[g.k === 'sell' ? g.t : g.k === 'earn' ? 'coin' : g.k === 'bake' ? 'pie' : g.k === 'serve' ? 'person' : g.k === 'build' ? 'build' : 'rep'];
const starsHtml = (n, size = '') => `<span class="stars ${size}">${[0, 1, 2].map((i) => SVG.star(i < n)).join('')}</span>`;
const cashHtml = (n) => `<span class="cash">${SVG.coin}<b>${n}</b></span>`;

const SCREENS = ['menu', 'intro', 'pause', 'result', 'shop'];
let screen = null;
function show(name) {
  screen = name;
  for (const s of SCREENS) $(s).hidden = s !== name;
  const playing = name === null && G.level >= 0;
  $('pauseBtn').hidden = !playing;
  G.paused = !playing;
}

function renderMenu() {
  $('menuBank').innerHTML = cashHtml(META.bank);
  $('menuStars').innerHTML = `${SVG.rep}<b>${totalStars()}</b>&thinsp;/&thinsp;${LEVELS.length * 3}`;
  const grid = $('levels'); grid.innerHTML = '';
  LEVELS.forEach((L, i) => {
    const b = document.createElement('button');
    const open = levelUnlocked(i);
    b.className = 'lvl' + (open ? '' : ' locked') + (META.stars[i] ? ' done' : '');
    b.innerHTML = open ? `<span class="num">${i + 1}</span>${starsHtml(META.stars[i] || 0, 'small')}` : SVG.lock;
    b.title = L.title;
    if (open) b.onclick = () => openIntro(i);
    grid.appendChild(b);
  });
  const cont = $('continue');
  cont.hidden = !(G.level >= 0 && !G.done);
  if (!cont.hidden) cont.textContent = `Продолжить: уровень ${G.level + 1}`;
}
function openMenu() { renderMenu(); show('menu'); }

let introLevel = 0;
function openIntro(i) {
  introLevel = i;
  const L = LEVELS[i];
  $('introTitle').textContent = `Уровень ${i + 1}`;
  $('introName').textContent = L.title;
  $('introGoals').innerHTML = L.goals.map((g) => `<li>${goalIcon(g)}<span>${goalText(g)}</span></li>`).join('');
  const extra = [];
  if ((L.rate || 1) > 1) extra.push('покупателей больше');
  if ((L.pat || 1) < 1) extra.push('они менее терпеливы');
  $('introNote').textContent = extra.length ? 'Сегодня ' + extra.join(', а ') + '.' : '';
  $('introTimes').innerHTML = `<span class="medal gold"></span>до ${fmtClock(L.gold)} <span class="medal silver"></span>до ${fmtClock(L.silver)}`
    + (META.best[i] !== undefined ? ` <span class="best">рекорд ${fmtClock(META.best[i])}</span>` : '');
  show('intro');
}

function openPause() {
  const L = LV();
  $('pauseName').textContent = `Уровень ${G.level + 1} · ${L.title}`;
  $('pauseGoals').innerHTML = L.goals.map((g) => {
    const [c, n] = goalProgress(g);
    return `<li class="${c >= n ? 'ok' : ''}">${goalIcon(g)}<span>${goalText(g)}</span><b>${g.k === 'build' ? (c ? '✓' : '') : g.k === 'rep' ? String(c).replace('.', ',') : Math.min(c, n) + '/' + n}</b></li>`;
  }).join('');
  $('pauseFps').textContent = window.__fps ? `${Math.round(window.__fps)} кадров/с` : '';
  $('gfxLite').classList.toggle('on', window.__gfx === 'lite');
  $('gfxFull').classList.toggle('on', window.__gfx !== 'lite');
  show('pause');
}

function onLevelDone(r) {
  const L = LEVELS[r.level];
  $('resultName').textContent = `Уровень ${r.level + 1} · ${L.title}`;
  $('resultStars').innerHTML = starsHtml(r.stars, 'big');
  $('resultTime').innerHTML = `Время ${fmtClock(r.time)}` + (r.best < Math.round(r.time) ? ` · рекорд ${fmtClock(r.best)}` : r.first ? '' : ' · новый рекорд!');
  $('resultHint').textContent = r.stars < 3 ? `3 звезды — быстрее ${fmtClock(L.gold)}` : 'Отлично!';
  $('resultReward').innerHTML = `+${r.reward} в копилку` + (r.first ? '' : ' <small>(повтор — половина)</small>');
  $('resultNext').hidden = !r.hasNext;
  $('resultMenu').textContent = r.hasNext ? 'Меню' : 'Все уровни';
  // let the confetti fly for a moment before the card appears
  setTimeout(() => show('result'), 900);
}

function renderShop() {
  $('shopBank').innerHTML = cashHtml(META.bank);
  const list = $('upgrades'); list.innerHTML = '';
  for (const u of UPGRADES) {
    const cost = upgradeCost(u.id), lvl = up(u.id);
    const li = document.createElement('li');
    li.innerHTML = `<div class="u-text"><b>${u.title}</b><span>${u.text}</span>
      <span class="pips">${Array.from({ length: UPGRADE_MAX }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('')}</span></div>`;
    const b = document.createElement('button');
    b.className = 'btn small';
    if (cost === null) { b.textContent = 'макс.'; b.disabled = true; } else {
      b.innerHTML = cashHtml(cost); b.disabled = META.bank < cost;
      b.onclick = () => { if (buyUpgrade(u.id)) renderShop(); };
    }
    li.appendChild(b); list.appendChild(li);
  }
}

function uiInit(resumed) {
  $('continue').onclick = () => show(null);
  $('shopBtn').onclick = () => { renderShop(); show('shop'); };
  $('shopClose').onclick = openMenu;
  $('introStart').onclick = () => { startLevel(introLevel); show(null); };
  $('introBack').onclick = openMenu;
  $('pauseBtn').onclick = openPause;
  $('pauseResume').onclick = () => show(null);
  $('pauseRestart').onclick = () => { startLevel(G.level); show(null); };
  $('pauseMenu').onclick = () => { save(); openMenu(); };
  const setGfx = (v) => { if (v === window.__gfx) return; try { localStorage.setItem('lavka-gfx', v); } catch (e) {} save(); location.reload(); };
  $('gfxLite').onclick = () => setGfx('lite');
  $('gfxFull').onclick = () => setGfx('full');
  $('resultNext').onclick = () => openIntro(G.level + 1);
  $('resultAgain').onclick = () => openIntro(G.level);
  $('resultMenu').onclick = () => { quitLevel(); openMenu(); };
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && screen === null && G.level >= 0) openPause(); });
  if (resumed) openPause();
  else if (!META.stars[0]) openIntro(0); // first launch: straight to level 1
  else openMenu();
}
