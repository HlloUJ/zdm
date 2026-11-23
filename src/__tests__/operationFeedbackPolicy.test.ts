// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The project guard is also a standalone Node entry point.
import { inspectPage, verifyPage, policyChecks } from '../../dev/operation-feedback-policy.mjs';

const file = 'src/pages/example.vue';
const source = '<template><button @click="submit">保存</button></template><script setup lang="ts">const submit = () => save()</script>';
const inspected = inspectPage(source, file);
const entry = { script: inspected.script, actions: { 'click → submit': 'form' } };

describe('operation feedback source registrations', () => {
  const checks = policyChecks(process.cwd());
  it.each(checks.files as string[])('checks the bindings, script and approved changes of %s', (file) => {
    checks.verifyComponent(file);
  });
  it('checks complete runtime coverage and shared inputs', () => {
    checks.verifyCoverage();
    const registry = JSON.parse(readFileSync(resolve('docs/ui/operation-feedback-registry.json'), 'utf8'));
    expect(registry.pages['src/pages/selection-center/index.vue'].actions['click → submit']).toBe('@perItem');
  });
  it('rejects a missing action and a changed handler implementation', () => {
    expect(() => verifyPage(file, inspected, { ...entry, actions: {} })).toThrow('绑定');
    expect(() => verifyPage(file, inspectPage(source.replace('save()', 'submitAgain()'), file), entry)).toThrow('指纹');
  });
  it('rejects blocked dialogs, empty checks, and per-item admission of a partial batch', () => {
    expect(() => inspectPage('<template><AdminConfirmDialog mode="blocked" /></template>', file)).toThrow('阻断');
    expect(() => inspectPage(source.replace('save()', "operations.check('a', () => true, save)"), file)).toThrow('真实预检');
    expect(() => inspectPage(source.replace('save()', "operations.check('a', () => Promise.resolve(true), save)"), file)).toThrow('真实预检');
    expect(() => verifyPage(file, inspected, { ...entry, actions: {
      'click → submit': { type: 'batch-partial', preflight: 'all-items', strategy: '逐项结果' },
    } })).toThrow('部分成功批量');
  });
});
