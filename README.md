# Trackpoly

Trackpoly is a browser driving game. The playable build is the static site in this repository: `index.html`, `main.bundle.js`, the simulation worker, audio, models, and tracks.

## Play

GitHub Pages serves this repo from the site root:

https://rrocketmann.github.io/Trackpoly/

## Local

Run a static server at the repo root and open the page it prints. Node is only needed for the checks.

```bash
npx http-server .
npm test
```

There is no separate build step.

## Tracks

New `.track` files go in `tracks/official/` or `tracks/community/`. GitHub Pages does not list directories, so refresh the fallback lists before deploying a new track:

```bash
npm run update-fallbacks
```

See `tracks/README.md`.
