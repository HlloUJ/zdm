import { describe, expect, it } from 'vitest';
import { storeSalePriceLines } from './storeSalePriceLines';

describe('门店列表商品价格', () => {
  it('区分无售价、零售价和有效价格区间', () => {
    const lines = (...prices: (number | null)[]) => storeSalePriceLines(prices.map(salePrice => ({ salePrice })));
    expect(lines()).toEqual(['-']);
    expect(lines(null, null)).toEqual(['-']);
    expect(lines(0, null, 0)).toEqual(['¥0.00']);
    expect(lines(199.9, null, 0, 85)).toEqual(['¥0.00～', '¥199.90']);
  });
});
