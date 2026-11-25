import { describe, expect, it } from 'vitest';
import type { StoreSkuPrice } from '@/services/storeFinishedStock';
import { changeDraftCategory, createSalePriceDraft, editDraftPrice, editDraftCoefficient } from './salePriceDraft';
const sku: StoreSkuPrice = {
  skuId: 1,
  label: '规格',
  stock: 1,
  costPrice: 100,
  guidePrice: 200,
  salePrice: 150,
  priceMode: 'auto',
  saleCoefficient: 1.5,
};
describe('门店商品售价', () => {
  it('跟随价格可编辑，编辑立即转手工，换分类不覆盖手工金额', () => {
    const draft = createSalePriceDraft(sku);
    editDraftPrice(draft, '140', 100);
    changeDraftCategory(draft, sku, 2);
    expect(draft).toEqual({ skuId: 1, price: '140', coefficient: '1.40', mode: 'manual' });
  });
  it('跟随规格经过无系数分类后仍保价，到有系数分类时重新计算', () => {
    const draft = createSalePriceDraft(sku);
    changeDraftCategory(draft, sku, null);
    expect(draft).toEqual({ skuId: 1, price: '150.00', coefficient: '1.5', mode: 'auto' });
    changeDraftCategory(draft, sku, 3);
    expect(draft).toEqual({ skuId: 1, price: '300.00', coefficient: '3', mode: 'auto' });
    changeDraftCategory(draft, { ...sku, costPrice: null }, 2);
    expect(draft).toEqual({ skuId: 1, price: '150.00', coefficient: '1.5', mode: 'auto' });
  });
  it('手动空价即使有完整计算依据也继续留空', () => {
    const empty: StoreSkuPrice = { ...sku, salePrice: null, saleCoefficient: null, priceMode: 'manual' };
    const draft = createSalePriceDraft(empty);
    changeDraftCategory(draft, empty, null);
    changeDraftCategory(draft, empty, 2);
    expect(draft).toEqual({ skuId: 1, price: '', coefficient: '', mode: 'manual' });
  });
  it('分类系数计算与服务端一致，半分向上取整', () => {
    const item = { ...sku, costPrice: 10.95 };
    const draft = createSalePriceDraft(item);
    changeDraftCategory(draft, item, 1.50);
    expect(draft.price).toBe('16.43');
  });
  it('跟随的原价为空时保留空值，具备计算条件时恢复计算', () => {
    const empty = { ...sku, salePrice: null, saleCoefficient: null };
    const draft = createSalePriceDraft(empty);
    changeDraftCategory(draft, empty, null);
    expect(draft).toEqual({ skuId: 1, price: '', coefficient: '', mode: 'auto' });
    changeDraftCategory(draft, empty, 2);
    expect(draft).toEqual({ skuId: 1, price: '200.00', coefficient: '2', mode: 'auto' });
  });
});

describe('手工系数', () => {
  it('修改系数转手工并计算价格，零级别价不反算', () => {
    const draft = createSalePriceDraft(sku);
    editDraftCoefficient(draft, '2', 100);
    expect(draft.price).toBe('200.00');
    expect(draft.mode).toBe('manual');
    editDraftPrice(draft, '50', 0);
    expect(draft.coefficient).toBe('2');
  });
});
