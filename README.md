# Лавочка

A small farm-and-shop browser game about growing one farm: gather eggs and firewood, carry them on your back
in a tall stack, sell them at the counter, then keep building — new plots (field, pasture, garden), workshops
(bakery, mill, dairy, confectioner's), helpers, cashiers and decorations, and upgrades for every building.
Nothing is ever lost: the farm is saved continuously and waits while the game is closed (no offline progress).
No ads, works offline (PWA).

- `public/game.js` — simulation (no DOM drawing), runs headless in tests.
- `public/view.js` — three.js view: models, lighting, ambient occlusion, HUD overlay.
- `server/` — Node 22, no dependencies: static files and `/healthz`.
- `node --test test/*.test.js` — server, offline cache list, and a bot that grows the whole farm.
- `node test/pacing.mjs [minutes] [seed]` — when the bot buys each thing; use it to tune prices (`DEFS`, `TRACKS` in game.js).

Quality: `?q=low` forces the cheap renderer, `?q=high` keeps ambient occlusion on; by default it is
switched off automatically when the first seconds run slowly.

When anything in `public/` changes, bump `VERSION` in both `public/game.js` and `public/sw.js`.
Release: tag `vX.Y.Z` → GitHub Actions builds `ghcr.io/zxibizz/lavka-game:X.Y.Z`.

See [CREDITS.md](CREDITS.md) for third-party assets.
