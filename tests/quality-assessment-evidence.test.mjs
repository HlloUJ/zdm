import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { bindSummary, blockFor, readSummary } from '../dev/quality/assessment-summary.mjs';
import { stateFor, updateAssessment } from '../dev/quality/assessment-store.mjs';
import { update } from '../dev/task-timing/registry.mjs';
import { writeJson } from '../dev/quality/timing-events.mjs';

test('摘要、候选、主线、规则及定向用例相互绑定，申请者无法缩小最低覆盖', () => {
  const context = { base: 'base', candidate: 'candidate', policy: 'policy' };
  const snap = {
    policy: 'policy',
    planId: 'plan',
    plan: {
      risk: 'R4',
      behaviors: ['access'],
      facts: [{ kind: 'access' }],
      reasons: [],
      dev: ['backend'],
      delivery: ['backend', 'e2e'],
      scopes: { e2e: ['tests/e2e/access.spec.ts'] },
      specialties: {},
    },
  };
  const row = { id: '006', revision: 2, behaviors: ['copy'], risk: 'R0', checks: ['diff'] };
  const body = blockFor({ version: 1, ...context, tasks: [row] });
  const low = bindSummary(snap, readSummary(body, context));
  assert.equal(low.plan.risk, 'R4');
  assert.ok(low.plan.delivery.includes('backend') && low.plan.delivery.includes('e2e'));
  assert.notEqual(
    low.planId,
    bindSummary(snap, readSummary(body.replace('"revision":2', '"revision":3'), context)).planId,
  );
  for (const key of Object.keys(context)) {
    const stale = readSummary(body, { ...context, [key]: 'changed' });
    assert.equal(stale.status, 'stale');
    assert.deepEqual(bindSummary(snap, stale).plan.scopes, {});
  }
  assert.equal(readSummary(body + '\n' + body, context).status, 'stale');
  assert.equal(readSummary('ordinary PR body', context).status, 'absent');
});

test('旧版计时器与两个判级写入者共享锁，首条开工、改级、回执均可恢复', async (t) => {
  const common = mkdtempSync(join(tmpdir(), 'zdm-assessment-race-'));
  t.after(() => rmSync(common, { recursive: true, force: true }));
  const root = join(common, 'zdm-tasks'),
    stamp = Date.now() - 10000;
  const activation = { version: 1, commit: '1'.repeat(40), at: stamp };
  writeJson(root, 'activation.json', activation);
  writeJson(join(root, '006'), 'task.json', {
    id: '006',
    name: '验收',
    activation: activation.commit,
    originalAt: stamp + 1,
  });
  const loc = { common, workspace: common, branch: 'feature', base: 'base' };
  const input = {
    thread: 'chat',
    kind: 'start',
    expected: 0,
    name: '006 验收',
    source: 'assignment',
    references: ['effective v1'],
    before: 'old',
    after: 'new',
    consumers: ['reader'],
    data: 'display',
    behaviors: ['layout'],
    reason: '布局',
  };
  const module = resolve('dev/quality/assessment-store.mjs');
  const code =
    'import {updateAssessment} from ' +
    JSON.stringify(module) +
    ";const [loc,data]=process.argv.slice(1).map(JSON.parse);updateAssessment(loc,'006','start',data)";
  const writer = (event) =>
    new Promise((ok) =>
      spawn(
        process.execPath,
        ['--input-type=module', '-e', code, JSON.stringify(loc), JSON.stringify({ ...input, event })],
        { stdio: 'ignore' },
      ).once('exit', ok),
    );
  const race = await Promise.all([writer('A'), writer('B')]);
  assert.deepEqual(race.sort(), [0, 1]);
  // Simulate a legacy process that still owns only the numbered task record.
  update(common, '006', (t) => ({ ...t, status: 'active' }));
  let first = stateFor(common, '006');
  assert.equal(first.history.length, 1);
  const notice = first.notifications[0];
  const receipt = { thread: 'chat', event: notice.key, message: 'visible-message', at: Date.now() };
  updateAssessment(loc, '006', 'ack', receipt);
  updateAssessment(loc, '006', 'ack', receipt);
  const next = updateAssessment(loc, '006', 'start', {
    ...input,
    kind: 'rework',
    event: 'feedback',
    expected: 1,
    behaviors: ['access'],
    roundBehaviors: ['layout'],
    reason: '整项含隔离，本轮只改背景',
  });
  assert.equal(next.current.whole, 'R4');
  assert.equal(next.current.round, 'R1');
  assert.equal(next.pending.length, 1);
  assert.equal(next.receipts[notice.key].message, 'visible-message');
  assert.equal(JSON.parse(readFileSync(join(root, '006', 'task.json'))).status, 'active');
});

test('同批分别复核，R4 整项在 R1 背景返工中沿用已验证版本', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'zdm-assessment-round-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (p, v) => {
    mkdirSync(dirname(join(cwd, p)), { recursive: true });
    writeFileSync(join(cwd, p), v + '\n');
  };
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.ZDM_QUALITY_TIMING_CONTEXT;
  const call = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, [resolve('dev/quality.mjs'), ...args], {
        cwd,
        env,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    );
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Assessment');
  git('config', 'user.email', 'quality@example.invalid');
  write('dev/acceptance.mjs', 'export const check = 1;');
  write('src/pages/report/grid.css', '.main { min-height: 50vh }');
  write('tests/acceptance.test.mjs', "import test from 'node:test'; test('fixture',()=>{});");
  write('tests/e2e/report.spec.ts', "test('viewport',()=>{});");
  git('add', '.');
  git('commit', '-qm', 'baseline');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('switch', '-qc', 'batch');
  const first = {
    thread: 'direct',
    kind: 'start',
    event: 'A',
    expected: 0,
    name: 'acceptance',
    source: 'assignment',
    references: ['v1'],
    before: 'old',
    after: 'new',
    consumers: ['publisher'],
    data: 'proof',
    behaviors: ['control'],
    reason: '保护',
    paths: ['dev/acceptance.mjs', 'src/pages/report/grid.css'],
  };
  call('assess', 'start', 'ref:controls', JSON.stringify(first));
  write('dev/acceptance.mjs', 'export const check = 2;');
  const passed = call('dev');
  assert.equal(passed.status, 'passed');
  assert.equal(passed.risk, 'R4');
  const saved = call('assess', 'show', 'ref:controls');
  call(
    'assess',
    'start',
    'ref:controls',
    JSON.stringify({
      ...first,
      kind: 'rework',
      event: 'A-2',
      expected: saved.revision,
      roundBehaviors: ['layout'],
    }),
  );
  write('src/pages/report/grid.css', '.main { min-height: 100vh }');
  const next = call('plan');
  assert.equal(next.risk, 'R1');
  assert.equal(next.wholeRisk, 'R4');
  assert.ok(
    next.dev.includes('e2e') && !next.dev.includes('backend') && next.delivery.includes('acceptance'),
  );
  call(
    'assess',
    'start',
    'ref:notes',
    JSON.stringify({
      ...first,
      kind: 'handoff',
      event: 'B',
      expected: 0,
      thread: 'second',
      name: 'release notes',
      source: 'coordinator',
      behaviors: ['note'],
      paths: ['docs/notes/history.md'],
    }),
  );
  write('docs/notes/history.md', '# Release history');
  call('plan');
  const notes = call('assess', 'show', 'ref:notes');
  assert.equal(notes.current.whole, 'R0');
  assert.equal(notes.pending[0].thread, 'second');
  assert.ok(!notes.current.facts.some((f) => f.path === 'dev/acceptance.mjs'));
});
