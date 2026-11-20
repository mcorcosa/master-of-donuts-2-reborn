# Master of Donuts 2 Reborn

A PixiJS rewrite of Master of Donuts 2 for Facebook Instant Games.

Use [mcorcosa/master-of-donuts-2-reborn](https://github.com/mcorcosa/master-of-donuts-2-reborn) as the sole push destination.

## Local development

Use Node.js 24 to match CI. Install dependencies with `npm ci`.

- `npm run dev` starts the local Vite server.
- `npm run test` runs the Vitest suite once.
- `npm run build` checks types and writes the browser build to `dist/`.
- `npm run build:facebook` checks types and writes the Facebook Instant Games build to `dist-facebook/`.

## GitHub Pages

Select **GitHub Actions** as the publishing source in **Settings → Pages**. [GitHub Pages setup](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

The workflow runs on pushes to `main` or by manual dispatch. It runs the tests, builds the browser version, and deploys `dist/` when Pages is configured. [Pages workflow](.github/workflows/pages.yml)
