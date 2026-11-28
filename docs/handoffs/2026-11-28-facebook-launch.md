# Master of Donuts 2 Facebook launch handoff

28 November 2026 · Europe/Bucharest

Continue in [mcorcosa/master-of-donuts-2-reborn](https://github.com/mcorcosa/master-of-donuts-2-reborn). This handoff covers the Facebook launch for **Master of Donuts 2** by **Briola Games**, Meta app `1069785026073546`. Follow the [project startup instructions](../../AGENTS.md) and [role routing](../ai-setup.md#delegation-and-reporting). The Facebook Launch Manager owns dashboard verification and release coordination. The shared Project Librarian maintains the handoff.

## Transfer revisions

- **Hosted V1 source.** Reborn base `8b4c8f0e98f543c9ff2e807ec6a6ebc240405470` plus the [index.html](../../index.html) change that sets both the page title and game canvas `aria-label` to `Master of Donuts 2`. At handoff preparation, that title change is in the working tree. The PlayBridge gitlink at `vendor/playbridge` is `4b6fcbe2832577c4574fb55927988ca34b549e22`. The transfer commit may include this handoff and the listing assets.
- **Exact hosted ZIP.** Production Web Hosting **V1**, bundle `40191818840461255`, **4,073,107 bytes**, SHA-256 `1658D264CA95A1C9197972D1E92D4A7B786621A91BF7CADE187F24437B80B681`. Download the original ZIP from its [Web Hosting row](https://developers.facebook.com/apps/1069785026073546/use_cases/customize/hosting/?use_case_enum=INSTANT_GAMES) if needed.

## Set up a fresh machine

Use Git, Node.js 24, npm, and access to the Reborn and PlayBridge GitHub repositories. After the transfer reaches `main`, clone recursively and use the [README bootstrap](../../README.md#local-development). The recorded gitlink and the submodule checkout should both show the PlayBridge revision above.

~~~sh
git clone --recurse-submodules --branch main https://github.com/mcorcosa/master-of-donuts-2-reborn.git
cd master-of-donuts-2-reborn
git submodule update --init --recursive
git rev-parse HEAD
git ls-tree HEAD -- vendor/playbridge
git -C vendor/playbridge rev-parse HEAD
npm --prefix vendor/playbridge ci --include=dev
npm --prefix vendor/playbridge run build
npm ci
npm test
npm run typecheck
npm run build
npm run build:facebook
~~~

The outputs are `dist/` for the browser and `dist-facebook/` for Facebook. The [game entry point](../../src/main.ts) and [Vite config](../../vite.config.ts) show the Facebook runtime selection and output. Use the Web Hosting download when you need the exact V1 bytes.

For a future candidate, ZIP the contents of `dist-facebook/` so `index.html` and `fbapp-config.json` sit at the archive root. Confirm that the packaged HTML loads Facebook Instant Games SDK 8.0 and check the current Web Hosting upload limits in the dashboard. Use a new ZIP filename and record its SHA-256 and exact size in bytes.

## Verification and release state

**Hosted runtime.** The Launch Manager uploaded V1 on 27 November for private testing and explicitly assigned it to Production while the app remained **Unpublished**, with access limited to developers and testers. The first Play attempt from Standby was blocked because no Production version was assigned. Open the [canonical play page](https://www.facebook.com/gaming/play/1069785026073546/) or use Play on the [Web Hosting row](https://developers.facebook.com/apps/1069785026073546/use_cases/customize/hosting/?use_case_enum=INSTANT_GAMES).

On exact hosted V1, the Launch Manager verified board startup, the first-match guide, the title and canvas accessibility label, keyboard Menu and Resume, mute, and mute persistence after reload. The owner subsequently reported completing gameplay testing. Device and move details were unspecified. Physical iOS and Android, real ads and checkout, and leaderboard acceptance remain unverified.

**28 November dashboard recheck.** The Launch Manager confirmed that Publish showed **Unpublished** and Web Hosting still showed **Version 1** / `40191818840461255` in **Production** at 4.07 MB. Instant Games Review showed **Verified** for Business Verification and **Approved** for Approved Partner Program. Policy and Quality each showed **Not Submitted**. With the combined tab selected, **Create submission** and **Submit Review** were both disabled. Audience Details still asked for under-13 confirmation. The IARC country and email fields were blank, and the manager found no certificate.

**28 November local verification.** The Launch Manager reported that a fresh TypeScript check, all 460 tests, and an isolated Facebook build passed.

**Basic settings.** The Launch Manager completed [Basic](https://developers.facebook.com/apps/1069785026073546/settings/basic/) and verified the saved settings after reload. The owner confirmed the same controller for the [privacy policy](https://briolagames.com/privacy) and [data deletion instructions](https://briolagames.com/data-deletion). The active icon last verified in Meta was the older burgundy face. The revised local [1024 × 1024 main icon](../../art/meta-app-icon/master-of-donuts-2-meta-icon.png) uses the cover’s cream background and both waving hands. SHA-256 is `B0C7B2E2FD8AF575C89B5E5296AE051F021D78196483ECE7B73C025C7C08F5D9`. Once the owner authorizes the asset update, upload it, crop to the full safe square, and choose **Save changes** to start icon review. After approval, select the approved thumbnail, choose **Update**, and reload to verify the active icon.

**Game Details.** The package is prepared locally for [Game Details](https://developers.facebook.com/apps/1069785026073546/use_cases/customize/details/?use_case_enum=INSTANT_GAMES). On 28 November, the Launch Manager confirmed that English (US) was primary, orientation was Portrait, and Tagline, Publisher, and Short Description were blank. The 1024 × 1024 icon slot inherits from Basic. Wait for owner direction before uploading media or saving the copy.

- [Paste-ready listing copy](../../art/meta-game-details/listing-copy.md) uses **Puzzle**, **Briola Games**, and **Stack donuts. Match three.**
- [16 × 16 small app icon](../../art/meta-game-details/small-app-icon-16x16.png) is the prepared burgundy reduced mark.
- [1600 × 300 cover](../../art/meta-game-details/cover-1600x300.png) and [1200 × 627 banner](../../art/meta-game-details/banner-1200x627.png) are the prepared listing images.
- [1920 × 1080 landscape preview](../../art/meta-game-details/preview-landscape-1920x1080.mp4) is a silent 20.5-second H.264 clip at 30 fps. The Launch Manager recorded authentic local production web gameplay from V1 source, showing five matches and Level 2 at 520 points. Extra ratios are optional and handled separately.

**Feature scope on V1.** The configured ad lanes are the Play Again interstitial and rewarded Joker, Stack Sweep, and Extra Chance. The four placement IDs match the Donuts dashboard according to the Launch Manager. Placements were **Idle** and the property offered **Send for review** at the last observation. The catalog has the `remove_interstitials_forever` non-consumable at $2.99. Payout, product approval, checkout, and actual restore remain unverified. The friends board is unset, personal scores are browser-local, and the game is English-only. Game-level analytics are absent.

## Manage the next launch gates

1. With owner direction, apply the prepared Game Details listing and advance the revised Basic icon through review and activation. Reload both settings pages to confirm what saved.
2. Have the owner make the [Audience Details](https://developers.facebook.com/apps/1069785026073546/use_cases/customize/audience-details/?use_case_enum=INSTANT_GAMES) under-13 declaration and complete IARC accurately for the exact review build and its feature scope.
3. Agree on review scope with the owner, including rewarded ads, the automatic Play Again interstitial, and Remove Interstitials. If speed matters, consider core gameplay first. V1 is already configured for monetization. A scope change requires explicit owner approval, a new build, and retesting. Update the Basic testing instructions for the exact candidate. Describe opening the game, following the first-match guide, moving a top donut to clear a match, using Menu and Resume, and checking mute after reload. Include monetization test steps only for features in the approved scope that are ready for review.
4. Obtain separate owner approvals for review submission and public publishing. On [Review](https://developers.facebook.com/apps/1069785026073546/use_cases/customize/review/?use_case_enum=INSTANT_GAMES), the first submission route is **Policy Review + Quality Review**. Quality follows Policy approval. If [Publish](https://developers.facebook.com/apps/1069785026073546/go_live/) still reports an approval block after required fields are complete, inspect the current Review and Publish UI to identify the exact blocker.
