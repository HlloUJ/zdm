import { describe, expect, it } from 'vitest';
import { formatServicePrice } from './storeServices';
import { terminalFunctionTrees } from './functionCatalog';
import { isFunctionAllowedForAudience } from './functionAudience';

describe('门店服务', () => {
  it('preserves exact prices including zero and rejects excess scale', () => {
    expect(formatServicePrice('000')).toBe('0.00');
    expect(formatServicePrice('12345678901234567890.1')).toBe('12345678901234567890.10');
    for (const invalid of ['', '-1', '12.345', '1e2']) expect(formatServicePrice(invalid)).toBeNull();
  });
  it('registers store-only viewing and four separate actions', () => {
    const page = terminalFunctionTrees.store
      .flatMap((m) => m.menus)
      .flatMap((m) => m.pages)
      .find((p) => p.value === 'store.service-management')!;
    expect(page.actions.map((a) => a.label)).toEqual(['查看', '新增', '编辑', '启用/停用', '删除']);
    for (const { value } of page.actions) {
      expect(isFunctionAllowedForAudience(value, 'store')).toBe(true);
      for (const audience of ['supplier', 'supply-chain', 'admin'])
        expect(isFunctionAllowedForAudience(value, audience)).toBe(false);
    }
  });
});
