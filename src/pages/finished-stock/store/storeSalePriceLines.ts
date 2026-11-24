import type { StoreSkuPrice } from '@/services/storeFinishedStock';

export function storeSalePriceLines(skus: Pick<StoreSkuPrice, 'salePrice'>[] = []): string[] {
  const prices = skus.map(sku => sku.salePrice).filter((price): price is number => price != null);
  if (prices.length === 0) return ['-'];
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return low === high ? [`¥${low.toFixed(2)}`] : [`¥${low.toFixed(2)}～`, `¥${high.toFixed(2)}`];
}
