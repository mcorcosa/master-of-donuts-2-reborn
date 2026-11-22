import { createFacebookPurchases } from '@playbridge/facebook';
import { RemoveAds } from './removeAds';

export function createRemoveAdsDemo(): RemoveAds {
  const sku = 'demo_remove_ads';
  const receipt = { productID: sku, purchaseToken: 'demo-receipt', isConsumed: false };
  let owned = false;
  const payments = {
    onReady: (ready: () => void) => ready(),
    getCatalogAsync: async () => [{ productID: sku, price: 'Demo price' }],
    getPurchasesAsync: async () => owned ? [receipt] : [],
    async purchaseAsync() { owned = true; return receipt; },
  };
  return new RemoveAds({
    sku,
    purchases: createFacebookPurchases(() => payments),
    automaticAdsEnabled: () => true,
    canOpenCheckout: () => true,
  });
}
