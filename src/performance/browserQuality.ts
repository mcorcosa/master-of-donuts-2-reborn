import { FrameQuality, normalizeNativeDpr } from './frameQuality';
import { QualityPreference } from './qualityPreference';

const QUALITY_KEY = 'master-of-donuts-2-reborn.render-quality.v1';

export class BrowserQuality {
  readonly frames: FrameQuality;
  private dpr: number;
  private readonly preference: QualityPreference;

  constructor(private readonly window: Window) {
    this.dpr = normalizeNativeDpr(window.devicePixelRatio);
    this.preference = new QualityPreference(QUALITY_KEY, () => window.localStorage, Date.now);
    this.frames = new FrameQuality(this.dpr, this.preference.read(this.dpr));
  }

  get nativeDpr(): number {
    return this.dpr;
  }

  syncDisplay(): void {
    this.dpr = normalizeNativeDpr(this.window.devicePixelRatio);
    this.frames.setNativeDpr(this.dpr);
  }

  applyPending(): void {
    const tier = this.frames.applyPending();
    if (tier !== undefined) this.preference.write(this.dpr, tier);
  }
}
