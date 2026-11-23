import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acceptance } from '../dev/acceptance.mjs';
import { updateAssessment } from '../dev/quality/assessment-store.mjs';
import { fileDigest } from '../dev/quality/inputs.mjs';
import { EvidenceStore, runId } from '../dev/quality/store.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'zdm-acceptance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const main = join(directory, 'main');
  git(directory, 'init', '-b', 'main', main);
  git(main, 'config', 'user.name', 'Acceptance Tests');
  git(main, 'config', 'user.email', 'acceptance@example.invalid');
  function commit(path, name, content) {
    writeFileSync(join(path, name), content);
    git(path, 'add', name);
    git(path, 'commit', '-m', name);
    return git(path, 'rev-parse', 'HEAD');
  }
  commit(main, 'common.txt', 'main');
  const updateMain = () => git(main, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  updateMain();

  const preview = join(directory, 'preview');
  git(main, 'worktree', 'add', '--detach', preview, 'HEAD');
  let rejectNextVersion = false;
  const runtimeFactory = () => ({
    prepare() {},
    reload() {},
    check() {
      if (rejectNextVersion) {
        rejectNextVersion = false;
        throw new Error('simulated unhealthy deployment');
      }
    },
  });
  const command = (path, operation, ...args) => acceptance(path, operation, args, runtimeFactory, () => {});
  command(main, 'init', preview);
  function task(branch, base = 'refs/remotes/origin/main') {
    const path = join(directory, branch);
    git(main, 'worktree', 'add', '-b', branch, path, base);
    return path;
  }
  return {
    main, preview, command, git, commit, updateMain, task, runtimeFactory, rejectNext() { rejectNextVersion = true; },
  };
}

test('5274 keeps the other accepted preview when a single task enters main', (t) => {
  const f = fixture(t);
  const a = f.task('task-a');
  const b = f.task('task-b');
  const firstA = f.commit(a, 'a.txt', 'first A');
  f.command(a, 'publish');
  const bRevision = f.commit(b, 'b.txt', 'B');
  f.command(b, 'publish');
  assert.equal(f.command(a, 'verify').revision, firstA);
  assert.equal(readFileSync(join(f.preview, 'b.txt'), 'utf8'), 'B');

  const revision = f.commit(a, 'a.txt', 'revised A');
  assert.throws(() => f.command(a, 'verify'), /待验收版本不同/);
  f.command(a, 'publish');
  assert.equal(f.command(a, 'verify').revision, revision);
  f.git(f.main, 'merge', '--no-ff', 'task-a', '-m', 'Deliver task A');
  f.updateMain();
  const result = f.command(f.main, 'sync');
  assert.deepEqual(result.tasks, [{ branch: 'task-b', revision: bRevision }]);
  assert.equal(readFileSync(join(f.preview, 'a.txt'), 'utf8'), 'revised A');
  assert.equal(readFileSync(join(f.preview, 'b.txt'), 'utf8'), 'B');
  assert.throws(() => f.git(f.main, 'show', 'HEAD:b.txt'));
  assert.equal(f.git(b, 'rev-parse', 'HEAD'), bRevision);
});

test('conflicts, shared task history, dirty snapshots and failed deploy retain the current 5274', (t) => {
  const f = fixture(t);
  const a = f.task('task-a');
  f.commit(a, 'common.txt', 'A');
  const lastGood = f.command(a, 'publish');

  const dependent = f.task('dependent', 'task-a');
  f.commit(dependent, 'dependent.txt', 'dependent');
  assert.throws(() => f.command(dependent, 'publish'), /共用的未合并历史/);

  const conflict = f.task('conflict');
  f.commit(conflict, 'common.txt', 'conflicts with A');
  assert.throws(() => f.command(conflict, 'publish'), /无法合入 5274/);

  const b = f.task('task-b');
  f.commit(b, 'b.txt', 'B');
  writeFileSync(join(b, 'new-file.txt'), 'unfinished');
  assert.throws(() => f.command(b, 'publish'), /未保存改动/);
  rmSync(join(b, 'new-file.txt'));
  f.rejectNext();
  assert.throws(() => f.command(b, 'publish'), /已恢复上一个验收版本/);
  assert.deepEqual(f.command(f.main, 'status'), lastGood);
  assert.equal(f.git(f.preview, 'rev-parse', 'HEAD'), lastGood.revision);
});


test('a failed development gate keeps the published revision and does not acquire the preview lock', t => {
  const f = fixture(t);
  const a = f.task('business-check');
  f.commit(a, 'feature.txt', 'candidate');
  const previous = f.command(f.main, 'status');
  assert.throws(() => acceptance(a, 'publish', [], f.runtimeFactory, () => { throw Error('development evidence missing'); }), /evidence missing/);
  assert.deepEqual(f.command(f.main, 'status'), previous);
  assert.equal(f.git(f.preview,'rev-parse','HEAD'), previous.revision);
  assert.equal(f.command(a,'publish').tasks.length, 1);
});

// Run a second publisher in its own process so it competes for the real Git-common lock.
function publishInChild(directory, interrupt = false) {
  const entry = new URL('../dev/acceptance.mjs', import.meta.url).href;
  const script = [
    'import { acceptance } from ' + JSON.stringify(entry) + ';',
    'const runtime = () => ({prepare() {}, check() {}, reload() {' +
      (interrupt ? 'process.exit(73);' : '') + '}});',
    "try { acceptance(process.cwd(), 'publish', [], runtime, () => {}); }",
    'catch (error) { console.error(error.message); process.exitCode = 1; }',
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8' });
}

test('competing publishers retry in order and repeated publication keeps the exact revision', t => {
  const f = fixture(t);
  const a = f.task('task-a');
  const b = f.task('task-b');
  const aHead = f.commit(a, 'a.txt', 'A');
  const bHead = f.commit(b, 'b.txt', 'B');
  const previous = f.command(f.main, 'status');
  const first = acceptance(b, 'publish', [], () => ({
    ...f.runtimeFactory(),
    prepare() {
      const attempt = publishInChild(a);
      assert.equal(attempt.status, 1);
      assert.match(attempt.stderr, /5274 正在更新/);
      assert.deepEqual(f.command(f.main, 'status'), previous);
    },
  }), () => {});
  assert.deepEqual(first.tasks, [{ branch: 'task-b', revision: bHead }]);
  const both = f.command(a, 'publish');
  assert.deepEqual(both.tasks, [...first.tasks, { branch: 'task-a', revision: aHead }]);
  assert.deepEqual(f.command(b, 'publish'), both);
  assert.equal(readFileSync(join(f.preview, 'b.txt'), 'utf8'), 'B');
  assert.equal(readFileSync(join(f.preview, 'a.txt'), 'utf8'), 'A');
});

test('changing a validated head requires fresh development evidence', t => {
  const f = fixture(t);
  const a = f.task('task-a');
  f.commit(a, 'a.txt', 'validated');
  const previous = f.command(f.main, 'status');
  assert.throws(() => acceptance(a, 'publish', [], f.runtimeFactory,
    () => f.commit(a, 'a.txt', 'new revision')), /开发验证后任务版本发生变化/);
  assert.deepEqual(f.command(f.main, 'status'), previous);
  assert.equal(f.git(f.preview, 'rev-parse', 'HEAD'), previous.revision);
  assert.equal(f.command(a, 'publish').tasks[0].revision, f.git(a, 'rev-parse', 'HEAD'));
});

test('an interrupted switch can only recover a known head and preserves earlier tasks', t => {
  const f = fixture(t);
  const a = f.task('task-a');
  const b = f.task('task-b');
  f.commit(a, 'a.txt', 'A');
  const lastGood = f.command(a, 'publish');
  f.commit(b, 'b.txt', 'B');
  const interrupted = publishInChild(b, true);
  assert.equal(interrupted.status, 73, interrupted.stderr);
  const journal = f.command(f.main, 'status');
  assert.deepEqual(journal, { ...lastGood, pending: f.git(f.preview, 'rev-parse', 'HEAD') });
  assert.notEqual(journal.pending, lastGood.revision);
  assert.throws(() => f.command(f.main, 'recover'), /正在更新/);
  // The child has exited. Release only this fixture's documented stale lock.
  rmdirSync(join(f.main, '.git', 'zdm-acceptance.lock'));
  assert.throws(() => f.command(b, 'publish'), /先核对现场/);
  f.git(f.preview, 'switch', '--detach', 'main');
  assert.throws(() => f.command(f.main, 'recover'), /先核对现场/);
  assert.deepEqual(f.command(f.main, 'status'), journal);
  f.git(f.preview, 'switch', '--detach', journal.pending);
  assert.deepEqual(f.command(f.main, 'recover'), lastGood);
  assert.deepEqual(f.command(f.main, 'recover'), lastGood);
  assert.equal(f.command(a, 'verify').preview, lastGood.revision);
  assert.throws(() => f.command(b, 'verify'), /待验收版本不同/);
  assert.equal(f.command(b, 'publish').tasks.length, 2);
});


function reviewedPreview(f, workspace) {
  const common = f.git(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const base = f.git(workspace, 'rev-parse', 'refs/remotes/origin/main');
  const branch = f.git(workspace, 'branch', '--show-current');
  const id = 'ref:preview-test';
  const update = (kind, expected) => updateAssessment({ common, workspace, branch, base }, id, 'start', {
    kind, expected, event: kind, thread: 'test-thread', name: '验收版本并发复核', source: '用户交办',
    references: ['统一标准第七节'], before: '原验收版本', after: '已验证的新修订', consumers: ['5274'],
    data: '无业务写入', behaviors: ['control'], reason: '发布过程中仍需绑定原始验证',
  });
  const revision = update('start', 0).revision;
  const assessments = [{ id, revision }];
  const tree = f.git(workspace, 'rev-parse', 'HEAD^{tree}');
  const head = f.git(workspace, 'rev-parse', 'HEAD');
  const store = new EvidenceStore(common);
  const run = runId();
  const log = store.log(run, 'diff');
  writeFileSync(log, 'verified source tree');
  const results = [{ id: 'diff', sourceRun: run, log, logDigest: fileDigest(log), status: 'passed' }];
  const evidence = { tree, base, planId: 'preview-test-plan', assessments, run };
  store.save({ ...evidence, head, phase: 'dev', standard: 'V1.2', status: 'passed', planned: ['diff'], pending: [], results });
  return { evidence, log, update };
}

test('a revision change during the 5274 reload restores the previous healthy publication', t => {
  const f = fixture(t);
  const task = f.task('task-publish');
  f.commit(task, 'interface.txt', 'old');
  const lastGood = f.command(task, 'publish');
  f.commit(task, 'interface.txt', 'new');
  const reviewed = reviewedPreview(f, task);
  let reloads = 0;
  const runtime = () => ({
    prepare() {},
    reload() {
      if (++reloads === 1) reviewed.update('resume', 1);
    },
    check() {},
  });
  assert.throws(() => acceptance(task, 'publish', [], runtime, () => reviewed.evidence), /复核版本已变化[\s\S]*已恢复上一个验收版本/);
  assert.equal(reloads, 2);
  assert.deepEqual(f.command(f.main, 'status'), lastGood);
  assert.equal(f.git(f.preview, 'rev-parse', 'HEAD'), lastGood.revision);
});

test('a 5274 publication is verifiable against the exact signed development report and original check log', t => {
  const f = fixture(t);
  const task = f.task('task-evidence');
  const head = f.commit(task, 'interface.txt', 'new');
  const reviewed = reviewedPreview(f, task);
  const result = acceptance(task, 'publish', [], f.runtimeFactory, () => reviewed.evidence);
  assert.deepEqual(result.tasks[0].evidence, reviewed.evidence);
  assert.equal(f.command(task, 'verify').revision, head);
  writeFileSync(reviewed.log, 'different source tree');
  assert.throws(() => f.command(task, 'verify'), /原始开发证据不符/);
  assert.throws(() => acceptance(task, 'publish', [], f.runtimeFactory, () => reviewed.evidence), /原始开发证据不符/);
  assert.deepEqual(f.command(f.main, 'status'), result);
});
