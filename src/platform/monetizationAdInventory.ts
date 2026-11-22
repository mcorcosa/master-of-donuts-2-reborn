import type { RewardedVideo } from '@playbridge/facebook';

const MAX_NATIVE_ADS = 3;

/** Keeps native instances accounted for even if the adapter times out while preparing one. */
export class MonetizationAdInventory {
  private readonly held = new Map<string, Promise<RewardedVideo>>();

  canAcquire(key: string): boolean { return this.held.has(key) || this.held.size < MAX_NATIVE_ADS; }

  acquire(key: string, create: () => Promise<RewardedVideo>, canLoad: () => boolean): Promise<RewardedVideo> {
    const existing = this.held.get(key);
    if (existing) return existing;
    if (this.held.size >= MAX_NATIVE_ADS) return Promise.reject(new Error('Facebook ad inventory is full.'));

    const release = () => { this.held.delete(key); };
    const acquired = Promise.resolve().then(() => {
      if (!canLoad()) throw new Error('Facebook ad preparation is unavailable.');
      return create();
    }).then(ad => {
      if (typeof ad?.loadAsync !== 'function' || typeof ad.showAsync !== 'function') {
        throw new Error('Invalid Facebook ad instance.');
      }
      let loaded: Promise<void> | undefined;
      return {
        loadAsync() {
          if (!canLoad()) return Promise.reject(new Error('Facebook ad preparation is unavailable.'));
          return loaded ??= (async () => {
            try { await ad.loadAsync(); }
            catch (error) {
              release();
              throw error;
            }
          })();
        },
        async showAsync() {
          try { await ad.showAsync(); }
          finally { release(); }
        },
      };
    }).catch(error => {
      release();
      throw error;
    });
    this.held.set(key, acquired);
    return acquired;
  }
}
