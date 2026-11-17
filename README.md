# Лавочка

A small farm-and-shop browser game: gather eggs and firewood, carry them on your back in a tall stack,
sell them at the counter, bake pies, hire helpers and build the village up to the fair.
No ads, works offline (PWA).

- `public/game.js` — simulation (no DOM drawing), runs headless in tests.
- `public/view.js` — three.js view: models, lighting, ambient occlusion, HUD overlay.
- `server/` — Node 22, no dependencies: static files and `/healthz`.
- `node --test test/*.test.js` — server, offline cache list, and a bot that plays the whole game.

Quality: `?q=low` forces the cheap renderer, `?q=high` keeps ambient occlusion on; by default it is
switched off automatically when the first seconds run slowly.

When anything in `public/` changes, bump `VERSION` in both `public/game.js` and `public/sw.js`.
Release: tag `vX.Y.Z` → GitHub Actions builds `ghcr.io/zxibizz/lavka-game:X.Y.Z`.

See [CREDITS.md](CREDITS.md) for third-party assets.
