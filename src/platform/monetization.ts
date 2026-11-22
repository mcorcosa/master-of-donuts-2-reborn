import type { AdOutcome, AdRequest } from '@playbridge/core';
import { MonetizationHistory } from './monetizationHistory';

export type AdPlacement = 'play-again' | 'joker' | 'sweep' | 'extra-chance';

export interface AdRequestOptions {
  isCurrent(): boolean;
  canShow(): boolean;
  onAttempt(): void;
  onRecovery(resume?: () => void): void;
}

export interface GameMonetization {
  available(placement: AdPlacement): boolean;
  setPlaying(playing: boolean): void;
  runCompleted(): void;
  request(placement: AdPlacement, options: AdRequestOptions): Promise<AdOutcome>;
}

interface MonetizationOptions {
  history: MonetizationHistory;
  supported(placement: AdPlacement): boolean;
  interstitialAllowed(): boolean;
  checkoutActive(): boolean;
  isForeground(): boolean;
  interstitialReady(): boolean;
  requestAd(request: AdRequest): Promise<AdOutcome>;
  clock?: () => number;
}

const WATCHDOG_MS = 45_000;
const CHECKPOINT_MS = 15_000;
const skipped = (status: AdOutcome['status'] = 'unavailable'): AdOutcome => ({ status, attempted: false });

export class Monetization implements GameMonetization {
  private started = false;
  private playing = false;
  private modalOpen = false;
  private restartOpportunity = false;
  private busy = false;
  private showing = false;
  private checkpoint?: ReturnType<typeof setInterval>;
  private lastTick?: number;
  private readonly clock: () => number;

  constructor(private readonly options: MonetizationOptions) {
    this.clock = options.clock ?? (() => performance.now());
  }

  get adBusy(): boolean { return this.busy; }

  start(playerId: string | null): void {
    if (this.started) return;
    this.options.history.initialize(playerId);
    this.started = true;
    this.syncClock();
  }

  available(placement: AdPlacement): boolean {
    return this.started && this.options.supported(placement) &&
      (placement !== 'play-again' || this.options.interstitialAllowed());
  }

  get canPreloadInterstitial(): boolean {
    return this.available('play-again') && this.options.history.canPreload && !this.options.checkoutActive();
  }

  prepareInterstitial(): void {
    if (this.canPreloadInterstitial) this.options.interstitialReady();
  }

  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this.syncClock();
  }

  setModalOpen(open: boolean): void {
    if (this.modalOpen === open) return;
    this.modalOpen = open;
    this.syncClock();
  }

  checkoutChanged(): void { this.syncClock(); }

  destroy(): void {
    this.started = false;
    this.restartOpportunity = false;
    this.syncClock();
  }

  private credit(): void {
    if (this.lastTick === undefined) return;
    const now = this.clock();
    // A suspended or throttled page may miss a checkpoint without a lifecycle event.
    const elapsed = now - this.lastTick;
    if (elapsed <= CHECKPOINT_MS * 2) this.options.history.credit(elapsed);
    this.lastTick = now;
  }

  private syncClock(): void {
    const active = this.started && this.playing && !this.showing && !this.modalOpen &&
      !this.options.checkoutActive() && this.options.isForeground();
    if (active === (this.lastTick !== undefined)) return;
    this.credit();
    this.options.history.save();
    if (active) {
      this.lastTick = this.clock();
      this.checkpoint = setInterval(() => {
        if (!this.options.isForeground()) {
          this.lastTick = this.clock();
          this.syncClock();
          return;
        }
        this.credit();
        this.options.history.save();
      }, CHECKPOINT_MS);
    } else {
      this.lastTick = undefined;
      clearInterval(this.checkpoint);
      this.checkpoint = undefined;
    }
  }

  runCompleted(): void {
    if (!this.started) return;
    this.credit();
    this.options.history.runCompleted();
    this.restartOpportunity = true;
    this.prepareInterstitial();
  }

  async request(placement: AdPlacement, options: AdRequestOptions): Promise<AdOutcome> {
    const automatic = placement === 'play-again';
    if (automatic) {
      const opportunity = this.restartOpportunity;
      this.restartOpportunity = false;
      if (!opportunity) return skipped();
    }
    if (this.busy || this.options.checkoutActive() || this.modalOpen) return skipped('pending');
    if (!this.available(placement)) return skipped();
    const current = () => this.available(placement) && options.isCurrent() && options.canShow() && this.options.isForeground() &&
      !this.modalOpen && !this.options.checkoutActive();
    if (!current()) return skipped('failed');
    this.credit();
    if (automatic && (!this.options.history.eligible || !this.options.interstitialReady())) return skipped();

    this.busy = true;
    let attempted = false;
    let expired = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unresolved: AdOutcome = { status: 'failed', attempted: true };
    let returnToGame!: () => void;
    const recovery = new Promise<AdOutcome>(resolve => {
      returnToGame = () => {
        if (!settled && expired && options.isCurrent() && options.canShow() && this.options.isForeground()) resolve(unresolved);
      };
    });
    const native = (async (): Promise<AdOutcome> => {
      try {
        const result = await this.options.requestAd({
          placement,
          kind: automatic ? 'interstitial' : 'rewarded',
          isCurrent: current,
          onAttempt: () => {
            this.credit();
            if (!this.options.history.beginExposure(automatic)) throw new Error('Unable to record interstitial attempt.');
            attempted = true;
            this.showing = true;
            this.syncClock();
            options.onAttempt();
            timer = setTimeout(() => {
              expired = true;
              if (options.isCurrent()) options.onRecovery(returnToGame);
            }, WATCHDOG_MS);
          },
        });
        if (!attempted) return skipped(result.attempted ? 'failed' : result.status);
        return expired || !options.isCurrent() ? unresolved : result;
      } catch {
        return attempted ? unresolved : skipped('failed');
      } finally {
        settled = true;
        clearTimeout(timer);
        if (attempted) this.options.history.endExposure();
        this.showing = false;
        this.busy = false;
        this.syncClock();
      }
    })();
    try { return await Promise.race([native, recovery]); }
    finally { options.onRecovery(); }
  }
}
