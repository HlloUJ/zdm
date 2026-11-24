import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { previousEvidence } from '../dev/quality/assessment-baseline.mjs';
import { reviewed, updateAssessment } from '../dev/quality/assessment-store.mjs';
import { nativeCommands } from '../dev/quality/commands.mjs';
import { measuresSelector } from '../dev/quality/layout-impact.mjs';
import { planTree } from '../dev/quality/repository.mjs';
import { EvidenceStore, runId } from '../dev/quality/store.mjs';
import { digest, event, finish, rootFor, writeJson } from '../dev/quality/timing-events.mjs';

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'zdm-incremental-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  function write(path, content) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content + '\n');
  }
  function commit(message) {
    git('add', '.');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  }
  return { cwd, common: join(cwd, '.git'), git, write, commit };
}

test('陌生共享样式的原始和当前用例都实际定位并测量控件，未覆盖的选择器扩大范围', t => {
  const f = repository(t);
  const suite = 'tests/e2e/weekly-capacity.spec.ts';
  const css = 'src/styles/booking.css';
  f.write(css, '.seat-chip { width: 20px }');
  f.write(suite, "test('seat geometry', async () => { expect((await page.locator('.seat-chip').boundingBox()).width).toBe(20); });");
  f.write('tests/e2e/other.spec.ts', "test('unrelated', async () => { expect(true).toBeTruthy(); });");
  f.write('docs/ui/booking.md', '图标宽度 20px');
  const base = f.commit('verified');
  f.write(css, '.seat-chip { width: 28px }');
  f.write('docs/ui/booking.md', '图标宽度 28px');
  let result = planTree(f.cwd, base, base, f.commit('resize')).plan;
  assert.equal(result.risk, 'R1');
  assert.deepEqual(result.scopes.e2e, [suite]);
  assert.deepEqual(nativeCommands('e2e', result.scopes.e2e).at(-1).slice(2), ['test', suite]);
  f.write(css, '.seat-chip { width: 28px }\n.untested-surface { height: 4px }');
  result = planTree(f.cwd, base, base, f.commit('another consumer')).plan;
  assert.equal(result.scopes.e2e, undefined);
  assert.match(result.reasons.join(' '), /缺少覆盖/);
  assert.equal(measuresSelector("test('locator only', () => page.locator('.seat-chip'));\n" +
    "test('different control', () => expect(other.boundingBox()).toBeTruthy());", '.seat-chip'), false);
  f.write('docs/ui/booking.md', '所有人都能读取其他门店的预约');
  result = planTree(f.cwd, base, base, f.commit('independent shared rule')).plan;
  assert.ok(result.risk >= 'R3');
});

test('可回收的界面计时器与真实数据删除按调用对象分别判级', t => {
  const f = repository(t), path = 'src/pages/booking/timer.ts';
  f.write(path, 'export const bookingTimer = 0;');
  const base = f.commit('booking');
  f.write(path, [
    'const timers = new Map<string, ReturnType<typeof setTimeout>>();',
    'export function hide(key) {',
    '  timers.set(key, setTimeout(() => timers.delete(key), 200));',
    '  onScopeDispose(() => clearTimeout(timers.get(key)));',
    '}',
  ].join('\n'));
  const timers = f.commit('timers');
  assert.equal(planTree(f.cwd, base, base, timers).plan.risk, 'R2');
  f.write(path, 'export function revoke(key) { return bookings.delete(key); }');
  const result = planTree(f.cwd, base, timers, f.commit('record removal')).plan;
  assert.equal(result.risk, 'R4');
  assert.ok(result.behaviors.includes('deletion'));
  assert.ok(result.delivery.includes('backend'));
});

test('实际修改的调用关系把两个局部行为合成跨模块义务', t => {
  const f = repository(t);
  const provider = 'src/lib/calendarCapacity.ts', caller = 'src/pages/booking/useCalendar.ts';
  f.write(provider, 'export function seats(count) { return count; }');
  f.write(caller, "import { seats } from '@/lib/calendarCapacity';\nexport const render = n => seats(n);");
  const base = f.commit('calendar');
  f.write(provider, 'export function seats(count) { return count + 1; }');
  const single = f.commit('single consumer');
  assert.equal(planTree(f.cwd, base, base, single).plan.risk, 'R2');
  f.write(caller, "import { seats } from '@/lib/calendarCapacity';\nexport const render = n => seats(n + 2);");
  const plan = planTree(f.cwd, base, base, f.commit('coupled change')).plan;
  assert.equal(plan.risk, 'R3');
  assert.ok(plan.facts.find(f => f.path === provider).other.includes('shared'));
  assert.ok(plan.dev.includes('e2e'));
});

test('同一任务逐项保存依据，相互独立不累加，组合风险及其检查不被其他事项的说明消除', t => {
  const f = repository(t), initial = {
    expected: 0, kind: 'start', event: 'assignment', thread: 'test', name: '预约', source: 'assignment',
    references: ['需求'], before: '两个独立视图', after: '调整两个视图', consumers: ['预约页面'],
    data: '显示', reason: '按事项和组合核对',
    items: ['日历', '容量'].map((name, i) => ({ name, before: '原布局', after: '新布局',
      consumers: ['使用方' + i], behaviors: ['layout'], paths: ['src/pages/calendar/' + i + '.css'] })),
  };
  const location = { common: f.common, workspace: f.cwd, branch: 'test', base: 'main' };
  const simple = updateAssessment(location, 'ref:simple', 'start', initial).current;
  assert.equal(simple.whole, 'R1');
  const complex = updateAssessment(location, 'ref:combined', 'start', { ...initial,
    interactions: [{ items: ['日历', '容量'], behaviors: ['access'], reason: '两项共同改变跨组织可见范围' }],
  }).current;
  assert.equal(complex.whole, 'R4');
  assert.ok(complex.delivery.includes('backend'));
  const plan = { risk: 'R1', behaviors: ['layout'], facts: [{ path: initial.items[0].paths[0], kind: 'layout', other: [] }],
    dev: ['e2e'], delivery: ['build', 'e2e'], scopes: {} };
  const proof = reviewed(complex.intent, complex, { plan }, { plan }, 'prior', {
    kind: 'already-satisfied', ref: 'test', basis: '只核对日历', items: ['日历'],
  });
  assert.equal(proof.whole, 'R4');
  assert.equal(proof.round, 'R4');
  assert.ok(proof.delivery.includes('backend') && proof.dev.includes('backend'));
  assert.equal(proof.items[1].status, 'needs-evidence');
  assert.equal(proof.interactions[0].status, 'needs-evidence');
  assert.throws(() => reviewed(complex.intent, complex, { plan }, { plan }, 'prior', {
    kind: 'already-satisfied', ref: 'test', basis: '无关事项', items: ['未登记事项'],
  }));
  const payout = updateAssessment(location, 'ref:external', 'start', { ...initial, items: [
    { ...initial.items[0], behaviors: ['irreversible'], consequence: '寄出兑换凭证后无法撤回' },
  ] }).current;
  assert.equal(payout.whole, 'R4');
  assert.ok(payout.delivery.includes('backend'));
});

test('旧规则的成功回执与单任务计时事件共同定位返工版本，异任务、失败和分叉回执无效', t => {
  const f = repository(t);
  f.write('src/plan.ts', 'export const size = 1;');
  const head = f.commit('previously verified');
  const tree = f.git('rev-parse', head + '^{tree}');
  f.write('src/plan.ts', 'export const size = 2;');
  const candidate = f.commit('rework');
  const root = rootFor(f.common), id = '021', now = Date.now(), ctx = { root, ids: [id], tasks: [{ originalAt: now - 100 }] };
  writeJson(root, 'activation.json', { version: 1, at: now - 200, commit: head });
  writeJson(join(root, id), 'task.json', { id, activation: head, originalAt: now - 100,
    workspaces: [{ branch: 'task', path: f.cwd }] });
  const run = runId(), store = new EvidenceStore(f.common);
  const report = { run, phase: 'dev', status: 'passed', standard: 'V1.1', tree, head, base: head, policy: 'old' };
  store.save(report);
  const start = 'quality:' + run;
  event(ctx, 'start', start, 'validation', { phase: 'dev', revision: head, tree, ref: run });
  finish(ctx, start, 'passed');
  const snap = { cwd: f.cwd, common: f.common, base: candidate, head: candidate, tree: f.git('rev-parse', 'HEAD^{tree}'), policy: 'new' };
  const state = { id, branch: 'task', workspace: f.cwd, history: [{ at: Date.now(), revision: 1 }] };
  assert.equal(previousEvidence(snap, state).origin, 'timing');
  assert.equal(previousEvidence(snap, { ...state, branch: 'other' }), null);
  store.save({ ...report, status: 'failed' });
  assert.equal(previousEvidence(snap, state), null);
  store.save({ ...report, standard: 'V1.2', assessments: [{ id, revision: 1 }] });
  const pointer = { task: id, branch: 'task', run, head, tree, base: head, policy: 'old', checks: [{ id: 'quality', args: [] }] };
  store.write(join(store.root, 'assessment-baselines', digest(id) + '.json'), pointer);
  assert.equal(previousEvidence(snap, state).origin, 'assessment');
  rmSync(join(store.root, 'runs', run + '.json'));
  assert.equal(previousEvidence(snap, state).origin, 'checkpoint');
  f.git('checkout', '--orphan', 'unrelated');
  f.write('src/different.ts', 'export const other = 1;');
  assert.equal(previousEvidence({ ...snap, head: f.commit('independent history') }, state), null);
});
