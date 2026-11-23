import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const subject = resolve(process.env.ZDM_QUALITY_SUBJECT || 'dev/quality.mjs');
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'zdm-assessment-contract-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const write = (path, body) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), body + '\n');
  };
  const call = (...args) => JSON.parse(execFileSync(process.execPath, [subject, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Assessment');
  git('config', 'user.email', 'assessment@example.invalid');
  write('src/pages/report/index.vue', '<template><table><caption>库存数量</caption></table></template>');
  write('src/pages/report/grid.css', '.rows { min-height: 50vh; }');
  write('tests/e2e/report.spec.ts', "test('report viewport', async () => { await expect(table).toBeVisible(); });");
  write('tests/e2e/access.spec.ts', "test('foreign store denied', async () => { expect(response.status()).toBe(403); });");
  write('src/lib/replenish.ts', 'export function apply(stock, amount) { return stock + amount; }');
  git('add', '.'); git('commit', '-qm', 'baseline');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  return { git, write, call, cwd };
}

test('陌生报表只换展示字与布局时选取实际作用域，数据写入和拒绝断言有独立最低保护', t => {
  const f = fixture(t);
  f.write('src/pages/report/index.vue', '<template><table><caption>库存数量 </caption></table></template>');
  assert.equal(f.call('plan').risk, 'R0');
  f.write('src/pages/report/grid.css', '.rows { min-height: 100vh; }');
  let plan = f.call('plan');
  assert.equal(plan.risk, 'R1');
  assert.ok(!plan.delivery.includes('backend'));
  f.write('tests/e2e/access.spec.ts', "test('foreign store denied', async () => { await request(); });");
  plan = f.call('plan');
  assert.equal(plan.risk, 'R4');
  assert.ok(plan.delivery.includes('e2e'));
  f.git('restore', 'tests/e2e/access.spec.ts');
  f.write('src/lib/replenish.ts', 'export function apply(stock, amount) { return stock - amount; }');
  assert.equal(f.call('plan').risk, 'R4');
});

test('无差异开工与同级接手留下分别可送达的真实事件；重试、变级和冲突保留修订', t => {
  const f = fixture(t);
  const id = 'ref:original-request';
  const intent = { event: 'direct-1', thread: 'direct-chat', kind: 'start', expected: 0,
    name: '门店库存回补', source: '原交办 7', references: ['库存条款 3 版本 2'],
    before: '重复通知再次加库存', after: '同一通知只加一次', consumers: ['库存服务'],
    data: '库存余额', unknown: '', behaviors: ['inventory'], reason: '重复处理会错增库存' };
  const start = f.call('assess', 'start', id, JSON.stringify(intent));
  assert.equal(start.current.whole, 'R4');
  assert.equal(start.pending.length, 1);
  assert.equal(f.call('assess', 'start', id, JSON.stringify(intent)).revision, 1);
  assert.throws(() => f.call('assess', 'start', id, JSON.stringify({ ...intent, event: 'other' })));
  const resume = { ...intent, kind: 'resume', event: 'resume-2', thread: 'next-chat', expected: 1 };
  const next = f.call('assess', 'start', id, JSON.stringify(resume));
  assert.equal(next.revision, 2);
  assert.equal(next.pending.length, 2);
  assert.equal(next.pending[1].thread, 'next-chat');
  assert.equal(f.call('assess', 'show', id).history.length, 2);
  assert.throws(() => f.call('assess', 'ack', id, JSON.stringify({
    event: next.pending[0].key, thread: 'next-chat', message: 'wrong-chat-message', at: Date.now(),
  })));
  const reviewed = f.call('assess', 'review', id, JSON.stringify({
    event: 'after-development', thread: 'next-chat', expected: 2, reason: '候选只有已有内容',
  }));
  assert.ok(reviewed.current.gaps.length);
  assert.equal(reviewed.current.whole, 'R4');
  assert.ok(readFileSync(join(f.cwd, 'src/lib/replenish.ts'), 'utf8').includes('stock + amount'));
});
