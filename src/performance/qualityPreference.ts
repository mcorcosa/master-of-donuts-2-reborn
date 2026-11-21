import type { QualityTier } from './frameQuality';

const EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class QualityPreference {
  constructor(
    private readonly key: string,
    private readonly getStorage: () => PreferenceStorage,
    private readonly now: () => number,
  ) {}

  read(nativeDpr: number): QualityTier {
    try {
      const raw = this.getStorage().getItem(this.key);
      if (raw === null) return 2;
      const { tier, dpr, savedAt } = JSON.parse(raw);
      const age = this.now() - savedAt;
      if (dpr === nativeDpr && (tier === 1 || tier === 1.5) && tier < nativeDpr &&
          Number.isFinite(savedAt) && age >= 0 && age < EXPIRY_MS) return tier;
    } catch {
      // A denied origin or corrupt preference falls back to the native-capped default.
    }
    return 2;
  }

  write(nativeDpr: number, tier: QualityTier): void {
    try {
      this.getStorage().setItem(this.key, JSON.stringify({ dpr: nativeDpr, tier, savedAt: this.now() }));
    } catch {
      // Keep the decision for the current session even if this origin cannot persist it.
    }
  }
}
