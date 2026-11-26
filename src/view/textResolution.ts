import { pixiTextResolution } from '@playbridge/pixi';
import { type Container, Text } from 'pixi.js';

export class SceneTextResolution {
  private readonly labels = new Map<Text, number>();
  private display?: { rendererResolution: number; sceneScale: number };

  track(text: Text, localScale = 1): void {
    if (this.labels.has(text)) return;
    this.labels.set(text, localScale);
    if (this.display) {
      text.resolution = pixiTextResolution(this.display.rendererResolution, this.display.sceneScale * localScale);
    }
    text.once('destroyed', () => this.labels.delete(text));
  }

  trackTree(root: Container): void {
    if (root instanceof Text) this.track(root);
    for (const child of root.children) this.trackTree(child);
  }

  set(rendererResolution: number, sceneScale: number): boolean {
    const previous = this.display;
    if (previous?.rendererResolution === rendererResolution && previous.sceneScale === sceneScale) return false;
    this.display = { rendererResolution, sceneScale };
    const resolution = pixiTextResolution(rendererResolution, sceneScale);
    for (const [label, localScale] of this.labels) {
      const tier = localScale === 1 ? resolution : pixiTextResolution(rendererResolution, sceneScale * localScale);
      if (label.resolution !== tier) label.resolution = tier;
    }
    return !previous || resolution !== pixiTextResolution(previous.rendererResolution, previous.sceneScale);
  }
}
