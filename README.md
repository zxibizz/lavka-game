# Лавочка

A small farm-and-town browser game in real time: the heroine harvests fields, collects eggs and milk and carries
them in a tall stack to the barn; workshops (mill, bakery, dairy, juicer, confectioner's) take their inputs from
the barn and cook by the wall clock; customers at the market stalls buy from the barn. Buildings, fields and
decorations are placed anywhere on a grid and can be moved; levels unlock new crops and buildings; a short chain
of tasks guides the first steps. Everything keeps growing while the game is closed; timers can be sped up for coins.
No ads, works offline (PWA).

- `public/game.js` — simulation (no DOM drawing), runs headless in tests.
- `public/view.js` — three.js view: models, lighting, ambient occlusion, HUD overlay.
- `server/` — Node 22, no dependencies: static files and `/healthz`.
- `node --test test/*.test.js` — server, offline cache list, game rules on a fake clock, and a bot that plays an hour.
- `node test/pacing.mjs [hours] [seed]` — when the bot levels up and what it builds; use it to tune times and prices (`CROPS`, `RECIPES`, `CATALOG` in game.js).

Quality: `?q=low` forces the cheap renderer, `?q=high` keeps ambient occlusion on; by default it is
switched off automatically when the first seconds run slowly.

When anything in `public/` changes, bump `VERSION` in both `public/game.js` and `public/sw.js`.
Release: tag `vX.Y.Z` → GitHub Actions builds `ghcr.io/zxibizz/lavka-game:X.Y.Z`.

See [CREDITS.md](CREDITS.md) for third-party assets.
