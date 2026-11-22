import type { OutcomeStatus, Purchases } from '@playbridge/core';

const CHECKOUT_WAIT_MS = 12_000;

export type RemoveAdsOwnership = 'active' | 'inactive' | 'unknown';

export interface RemoveAdsView {
  state: 'checking' | 'available' | 'unavailable' | 'owned' | 'pending' | 'checkout';
  price?: string;
  message?: string;
  canRecheck: boolean;
}

interface RemoveAdsOptions {
  purchases: Purchases & { canCheckout(): boolean };
  sku?: string;
  automaticAdsEnabled(): boolean;
  canOpenCheckout(): boolean;
  ownershipChanged?(): void;
}

export class RemoveAds {
  private readonly sku: string;
  private readonly listeners = new Set<() => void>();
  private confirmed: RemoveAdsOwnership = 'unknown';
  private price?: string;
  private message?: string;
  private restoring?: Promise<void>;
  private buying = false;
  private openingCheckout = false;
  private pending = false;

  constructor(private readonly options: RemoveAdsOptions) {
    this.sku = options.sku?.trim() ?? '';
  }

  get ownership(): RemoveAdsOwnership { return this.confirmed; }
  get checkoutActive(): boolean { return this.openingCheckout; }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get view(): RemoveAdsView {
    const canRecheck = !!this.sku;
    if (this.buying) return { state: 'checkout', canRecheck };
    if (this.confirmed === 'active') return { state: 'owned', canRecheck };
    if (this.restoring) return { state: 'checking', canRecheck };
    if (this.pending || this.openingCheckout) return { state: 'pending', canRecheck };
    const message = this.message;
    if (this.confirmed === 'inactive' && this.price && this.canSell()) {
      return { state: 'available', price: this.price, message, canRecheck };
    }
    return { state: 'unavailable', message, canRecheck };
  }

  private setOwnership(ownership: RemoveAdsOwnership): void {
    if (this.confirmed === ownership) return;
    this.confirmed = ownership;
    this.options.ownershipChanged?.();
  }

  private canSell(): boolean {
    try {
      return !!this.sku && this.options.automaticAdsEnabled() && this.options.purchases.canCheckout();
    } catch {
      return false;
    }
  }

  private async readPrice(): Promise<string | undefined> {
    if (!this.canSell()) return;
    try {
      const catalog = await this.options.purchases.catalog();
      if (catalog.status !== 'completed') return;
      const products = catalog.value.filter(product => product.productId === this.sku);
      if (products.length !== 1) return;
      return products[0].displayPrice?.trim() || undefined;
    } catch { /* An unavailable catalog cannot authorize checkout. */ }
  }

  private async reconcile(acceptAbsence = true): Promise<RemoveAdsOwnership> {
    try {
      const inventory = await this.options.purchases.inventory();
      if (inventory.status !== 'completed') return 'unknown';
      const matches = inventory.value.filter(record => record.productId === this.sku);
      if (matches.some(record => record.state !== 'active' || !record.receiptToken.trim())) return 'unknown';
      if (matches.length) {
        this.pending = false;
        this.message = undefined;
        this.setOwnership('active');
        return 'active';
      }
      if (acceptAbsence) this.setOwnership(this.pending || this.openingCheckout ? 'unknown' : 'inactive');
      return 'inactive';
    } catch {
      return 'unknown';
    }
  }

  refresh(): Promise<void> {
    if (!this.sku || this.buying) return Promise.resolve();
    return this.startRestore();
  }

  private startRestore(): Promise<void> {
    if (this.restoring) return this.restoring;
    this.restoring = this.restore().finally(() => {
      this.restoring = undefined;
      this.notify();
    });
    this.notify();
    return this.restoring;
  }

  private async restore(): Promise<void> {
    this.price = undefined;
    if (this.confirmed !== 'active') this.setOwnership('unknown');
    if (await this.reconcile() === 'inactive' && this.confirmed === 'inactive') this.price = await this.readPrice();
  }

  private async settleCheckout(current: () => boolean): Promise<void> {
    let status: OutcomeStatus;
    try {
      ({ status } = await this.options.purchases.checkout(this.sku, current));
    } catch {
      status = 'pending';
    }

    // Let any ongoing recheck finish, then read again after the native reply.
    await this.restoring;
    this.openingCheckout = false;
    if (this.confirmed !== 'active') {
      // The checkout reply can indicate a possible charge. Only inventory can grant the entitlement.
      this.pending = status === 'completed' || status === 'pending';
      if (status === 'cancelled') this.message = 'Purchase canceled.';
      if (!this.pending && status !== 'cancelled') this.message = 'Checkout is temporarily unavailable.';
    }
    await this.startRestore();
  }

  async buy(isCurrent: () => boolean): Promise<void> {
    const view = this.view;
    const current = () => isCurrent() && this.options.canOpenCheckout() && this.canSell();
    if (view.state !== 'available' || this.openingCheckout || !current()) return;

    this.buying = true;
    this.message = undefined;
    this.setOwnership('unknown');
    this.notify();
    try {
      this.price = await this.readPrice();
      if (await this.reconcile(false) !== 'inactive') return;
      if (!this.price || !current() || this.price !== view.price) {
        if (this.price && this.price !== view.price) this.message = 'The price changed. Check the new price before buying.';
        this.setOwnership('inactive');
        return;
      }

      this.openingCheckout = true;
      this.pending = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, CHECKOUT_WAIT_MS); });
        await Promise.race([this.settleCheckout(current), deadline]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.buying = false;
      this.notify();
    }
  }
}
