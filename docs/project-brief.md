# Master of Donuts 2 Reborn project brief

## Owner decisions

- Build a full rewrite in the separate `master-of-donuts-2-reborn` repository for Facebook Instant Games.
- Keep the original Master of Donuts 2 mechanics and progression broadly the same. Use the legacy game source in `C:\FB Instant Games\master-of-donuts-2` as the behavioral reference.
- Use Penguin Pop Party in `C:\FB Instant Games\rowshift` as the technical and Facebook integration reference. Align PixiJS and other relevant dependencies with that project.
- Rework the controls for smoother play, including swiping. Overhaul the graphics throughout the game.
- Use PlayBridge for shared platform integrations through the submodule at `vendor/playbridge`.
- Render gameplay Menu and Sound buttons and the menu popup in Pixi across Pixi games. Games can adopt the optional PlayBridge package or use their own Pixi controls. Each game owns sound settings and the gameplay effects of menu and host pauses.

## Pixi gameplay menu

Reborn is the first adopter of the optional `@playbridge/pixi` gameplay menu. The [game view](../src/view/index.ts) mounts the Menu and Sound buttons and popup in Pixi. Opening cancels unfinished gestures and queued taps while accepted moves can finish. Reborn owns host pauses and overlays. [GameSound](../src/audio/GameSound.ts) keeps the existing `master-of-donuts-2-reborn.sound.v1` preference.

Reborn resolves the module from `file:vendor/playbridge/packages/pixi`. Use the [PlayBridge adoption guide](../vendor/playbridge/docs/pixi-menu.md) from a menu-capable framework checkout for the dependency setup, hooks, and verification steps.

The local browser check confirmed that Menu opens, sound toggles and Resume returns to the same board. Reborn exposes keyboard instructions and sound state on the canvas. Individual controls lack native screen-reader button semantics. Facebook-hosted behavior remains unverified.

## Open scope

Additional features are open.
