# Master of Donuts 2 Reborn

A PixiJS rewrite of Master of Donuts 2 for Facebook Instant Games.

Use [mcorcosa/master-of-donuts-2-reborn](https://github.com/mcorcosa/master-of-donuts-2-reborn) as the sole push destination.

## Local development

Use Node.js 24 to match CI. Reborn pins PlayBridge through the committed Git submodule at `vendor/playbridge`. From the game root, `git ls-tree HEAD -- vendor/playbridge` prints the recorded commit.

On a clean checkout, run these commands in order from the Reborn game root. Build PlayBridge before installing the game dependencies.

```sh
git submodule update --init --recursive
git -C vendor/playbridge rev-parse HEAD
npm --prefix vendor/playbridge ci --include=dev
npm --prefix vendor/playbridge run build
npm ci
npm test
npm run typecheck
npm run build
npm run build:facebook
```

- `npm run dev` starts the local Vite server.
- `npm run test` runs the Vitest suite once.
- `npm run build` checks types and writes the browser build to `dist/`.
- `npm run build:facebook` checks types and writes the Facebook Instant Games build to `dist-facebook/`.

See the [project brief](docs/project-brief.md#pixi-gameplay-menu) for the Pixi menu integration.

## Legacy personal scores

On ordinary browser origins, the web build keeps the legacy `localStorage` key `master-of-donuts-2-reborn.personal-scores.v1`. On recognized legacy Facebook origins, the web build uses its own `web.` scope.

The Facebook build uses its own `facebook.` browser storage scope. On recognized Facebook-hosted HTTPS origins, including subdomains of `facebook.com`, `fbcdn.net`, and `fbsbx.com`, it reads the legacy scores on demand when its scoped score key is absent. When a run completes, it saves the resulting top scores in the Facebook scope and leaves the legacy key intact.

If Reborn previously used a dedicated custom origin for Facebook, set `VITE_DONUTS_LEGACY_FACEBOOK_ORIGIN` to the exact `window.location.origin` before building. Set it only when the old records on that origin belong to the Facebook target, since legacy records carry no target marker.

## GitHub Pages

Select **GitHub Actions** as the publishing source in **Settings → Pages**. [GitHub Pages setup](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

The workflow runs on pushes to `main` or by manual dispatch. It initializes and builds the pinned PlayBridge submodule before installing the game dependencies, runs the tests, and builds both targets. It uploads the browser build from `dist/` and deploys it when Pages is configured. [Pages workflow](.github/workflows/pages.yml)
