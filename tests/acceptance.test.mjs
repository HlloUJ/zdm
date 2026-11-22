import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acceptance } from '../dev/acceptance.mjs';

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
