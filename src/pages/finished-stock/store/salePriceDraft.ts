import { isValidSpecPriceNumber } from '../management/priceValidation';
import type { StoreSkuPrice } from '@/services/storeFinishedStock';

export interface SalePriceDraft {
  skuId: number;
  price: string;
  coefficient: string;
  mode: 'auto' | 'manual';
}
export function calculateSalePrice(base: number | null, coefficient: number | null) {
  if (base == null || coefficient == null) return '';
  const baseCents = Math.round(base * 100);
  const coefficientHundredths = Math.round(coefficient * 100);
  if (!Number.isSafeInteger(baseCents) || !Number.isSafeInteger(coefficientHundredths)) return '';
  const cents = (BigInt(baseCents) * BigInt(coefficientHundredths) + 50n) / 100n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
export const createSalePriceDraft = (sku: StoreSkuPrice): SalePriceDraft => ({
  skuId: sku.skuId,
  price: sku.salePrice == null ? '' : Number(sku.salePrice).toFixed(2),
  coefficient: sku.saleCoefficient == null ? '' : String(sku.saleCoefficient),
  mode: sku.priceMode || 'manual',
});
export function changeDraftCategory(draft: SalePriceDraft, sku: StoreSkuPrice, coefficient: number | null) {
  if (draft.mode !== 'auto') return;
  const calculated = calculateSalePrice(sku.costPrice, coefficient);
  if (calculated) {
    draft.price = calculated;
    draft.coefficient = String(coefficient);
  } else if (sku.priceMode === 'auto') {
    // Only persisted prices were effective. An intermediate unsaved selection is not a snapshot.
    draft.price = sku.salePrice == null ? '' : Number(sku.salePrice).toFixed(2);
    draft.coefficient = sku.saleCoefficient == null ? '' : String(sku.saleCoefficient);
  }
}

export function carriesPrice(draft: SalePriceDraft, sku: StoreSkuPrice) {
  const equal = (value: string, original: number | null | undefined) =>
    original == null ? value === '' : isValidSpecPriceNumber(value) && Number(value) === Number(original);
  return draft.mode === sku.priceMode && equal(draft.price, sku.salePrice) && equal(draft.coefficient, sku.saleCoefficient);
}

export function editDraftPrice(draft: SalePriceDraft, value: string, base: number | null) {
  draft.price = value;
  draft.mode = 'manual';
  if (base != null && base > 0 && isValidSpecPriceNumber(value)) draft.coefficient = (Number(value) / base).toFixed(2);
}
export function editDraftCoefficient(draft: SalePriceDraft, value: string, base: number | null) {
  draft.coefficient = value;
  draft.mode = 'manual';
  if (base != null && isValidSpecPriceNumber(value)) draft.price = calculateSalePrice(base, Number(value));
}
