import { createFacebookPurchases } from '@playbridge/facebook';
import { expect, test, vi } from 'vitest';
import { RemoveAds } from './removeAds';

const sku = 'reborn_test_remove_ads';
const product = { productID: sku, price: '2,99 €' };
const receipt = { productID: sku, purchaseToken: 'fixture-token', isConsumed: false };

function fixture(productId = sku, automaticAdsEnabled = () => true, canOpenCheckout = () => true) {
  const payments = {
    onReady: (ready: () => void) => ready(),
    getCatalogAsync: vi.fn<() => Promise<unknown>>(async () => [product]),
    getPurchasesAsync: vi.fn<() => Promise<unknown>>(async () => []),
    purchaseAsync: vi.fn<(config: { productID: string }) => Promise<unknown>>(async () => receipt),
  };
  const purchase = new RemoveAds({
    sku: productId, purchases: createFacebookPurchases(() => payments), automaticAdsEnabled, canOpenCheckout,
  });
  return { payments, purchase };
}

test('a missing SKU never calls payments and keeps ownership unknown', async () => {
  const { purchase, payments } = fixture(' ');
  await purchase.refresh();
  await purchase.buy(() => true);
  expect(purchase.ownership).toBe('unknown');
  expect(purchase.view).toEqual({ state: 'unavailable', message: undefined, canRecheck: false });
  expect(payments.getPurchasesAsync).not.toHaveBeenCalled();
  expect(payments.getCatalogAsync).not.toHaveBeenCalled();
  expect(payments.purchaseAsync).not.toHaveBeenCalled();
});

test('restores only from exact-SKU inventory even when automatic ads are disabled', async () => {
  const { purchase, payments } = fixture(sku, () => false);
  payments.getPurchasesAsync.mockResolvedValueOnce([{ ...receipt, productID: 'other' }]);
  await purchase.refresh();
  expect(purchase.ownership).toBe('inactive');
  expect(purchase.view.state).toBe('unavailable');
  await purchase.buy(() => true);
  expect(payments.getCatalogAsync).not.toHaveBeenCalled();
  expect(payments.purchaseAsync).not.toHaveBeenCalled();

  payments.getPurchasesAsync.mockResolvedValueOnce([receipt]).mockRejectedValueOnce(new Error('offline'));
  await purchase.refresh();
  await purchase.refresh();
  expect(purchase.ownership).toBe('active');
  expect(purchase.view.state).toBe('owned');

  await purchase.refresh();
  expect(purchase.ownership).toBe('inactive');
});

test.each([null, [null], [{ productID: sku }], [{ ...receipt, isConsumed: true }]])(
  'fails closed on malformed or unverified inventory %j', async inventory => {
    const { purchase, payments } = fixture();
    await purchase.refresh();
    payments.getPurchasesAsync.mockResolvedValue(inventory);
    await purchase.buy(() => true);
    expect(purchase.ownership).toBe('unknown');
    expect(purchase.view.state).toBe('unavailable');
    expect(payments.purchaseAsync).not.toHaveBeenCalled();
  },
);

test.each([null, [], [{ ...product, productID: 'other' }], [{ ...product, price: ' ' }], [product, product]])(
  'requires one exact catalog product with a display price %j', async catalog => {
    const { purchase, payments } = fixture();
    payments.getCatalogAsync.mockResolvedValue(catalog);
    await purchase.refresh();
    await purchase.buy(() => true);
    expect(purchase.ownership).toBe('inactive');
    expect(purchase.view.state).toBe('unavailable');
    expect(payments.purchaseAsync).not.toHaveBeenCalled();
  },
);

test('uses the host price and requires another click after a price change', async () => {
  const { purchase, payments } = fixture(` ${sku} `);
  await purchase.refresh();
  expect(purchase.view).toMatchObject({ state: 'available', price: '2,99 €' });
  payments.getCatalogAsync.mockResolvedValue([{ ...product, price: '3,99 €' }]);
  await purchase.buy(() => true);
  expect(payments.purchaseAsync).not.toHaveBeenCalled();
  expect(purchase.view).toMatchObject({ state: 'available', price: '3,99 €', message: expect.stringContaining('price changed') });
});

test('cancels checkout if automatic ads or the original UI stop being current during preflight', async () => {
  let enabled = true;
  let current = true;
  const { purchase, payments } = fixture(sku, () => enabled);
  await purchase.refresh();
  payments.getPurchasesAsync.mockImplementationOnce(async () => { current = false; return []; });
  await purchase.buy(() => current);
  expect(payments.purchaseAsync).not.toHaveBeenCalled();

  payments.getPurchasesAsync.mockImplementationOnce(async () => { enabled = false; return []; });
  await purchase.buy(() => true);
  expect(purchase.view.state).toBe('unavailable');
  expect(payments.purchaseAsync).not.toHaveBeenCalled();
});

test('rechecks ownership before checkout and does not show checkout over a fullscreen ad', async () => {
  let adShowing = true;
  const { purchase, payments } = fixture(sku, () => true, () => !adShowing);
  await purchase.refresh();
  await purchase.buy(() => true);
  expect(payments.getPurchasesAsync).toHaveBeenCalledOnce();
  adShowing = false;
  payments.getPurchasesAsync.mockResolvedValue([receipt]);
  await purchase.buy(() => true);
  expect(purchase.ownership).toBe('active');
  expect(payments.purchaseAsync).not.toHaveBeenCalled();
});

test('blocks duplicate checkout and waits for inventory to confirm an apparent success', async () => {
  const { purchase, payments } = fixture();
  await purchase.refresh();
  let complete!: (result: unknown) => void;
  payments.purchaseAsync.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const checkout = purchase.buy(() => true);
  await vi.waitFor(() => expect(payments.purchaseAsync).toHaveBeenCalledExactlyOnceWith({ productID: sku }));
  expect(purchase.checkoutActive).toBe(true);
  expect(purchase.ownership).toBe('unknown');
  await purchase.buy(() => true);
  complete(receipt);
  await checkout;

  expect(purchase.checkoutActive).toBe(false);
  expect(purchase.view.state).toBe('pending');
  await purchase.refresh();
  await purchase.buy(() => true);
  expect(payments.purchaseAsync).toHaveBeenCalledOnce();
  expect(purchase.ownership).toBe('unknown');
  payments.getPurchasesAsync.mockResolvedValue([receipt]);
  await purchase.refresh();
  expect(purchase.ownership).toBe('active');
  expect(purchase.view.state).toBe('owned');
});

test('handles explicit cancellation and holds an ambiguous rejection for recheck', async () => {
  const { purchase, payments } = fixture();
  await purchase.refresh();
  payments.purchaseAsync.mockRejectedValueOnce({ code: 'PAYMENTS_USER_CANCELLED' });
  await purchase.buy(() => true);
  expect(purchase.view).toMatchObject({ state: 'available', message: 'Purchase canceled.' });
  payments.purchaseAsync.mockRejectedValueOnce({ code: 'NETWORK_FAILURE' });
  await purchase.buy(() => true);
  await purchase.refresh();
  await purchase.buy(() => true);
  expect(purchase.view.state).toBe('pending');
  expect(payments.purchaseAsync).toHaveBeenCalledTimes(2);
});

test('offers an inventory-only recheck after a stalled checkout and reconciles a late reply', async () => {
  vi.useFakeTimers();
  try {
    const { purchase, payments } = fixture();
    let complete!: (result: unknown) => void;
    payments.purchaseAsync.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await purchase.refresh();
    const states: string[] = [];
    purchase.onChange(() => states.push(purchase.view.state));

    const checkout = purchase.buy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(payments.purchaseAsync).toHaveBeenCalledOnce();
    expect(purchase.view.state).toBe('checkout');
    await vi.advanceTimersByTimeAsync(12_000);
    await checkout;
    expect(purchase.view).toMatchObject({ state: 'pending', canRecheck: true });
    expect(purchase.checkoutActive).toBe(true);

    const catalogCalls = payments.getCatalogAsync.mock.calls.length;
    const inventoryCalls = payments.getPurchasesAsync.mock.calls.length;
    await purchase.refresh();
    await purchase.buy(() => true);
    expect(payments.getPurchasesAsync).toHaveBeenCalledTimes(inventoryCalls + 1);
    expect(payments.getCatalogAsync).toHaveBeenCalledTimes(catalogCalls);
    expect(payments.purchaseAsync).toHaveBeenCalledOnce();
    expect(purchase.ownership).toBe('unknown');

    payments.getPurchasesAsync.mockResolvedValue([receipt]);
    complete(receipt);
    await vi.advanceTimersByTimeAsync(0);
    expect(payments.getPurchasesAsync).toHaveBeenCalledTimes(inventoryCalls + 2);
    expect(payments.purchaseAsync).toHaveBeenCalledOnce();
    expect(purchase.checkoutActive).toBe(false);
    expect(purchase.ownership).toBe('active');
    expect(states.at(-1)).toBe('owned');
  } finally {
    vi.useRealTimers();
  }
});
