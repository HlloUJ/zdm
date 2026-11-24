import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { acceptance } from '../dev/acceptance.mjs';
import { main as cli } from '../dev/task-timing.mjs';
import {
  activated,
  bound,
  contextVariable,
  event,
  finish,
  observe,
  rootFor,
  writeJson,
} from '../dev/quality/timing-events.mjs';
import {
  activate,
  commonFor,
  git,
  manualEnd,
  manualStart,
  mark,
  register,
  rename,
  resolveEvent,
  retryCause,
  unassigned,
} from '../dev/task-timing/registry.mjs';
import { bindPr, collect, releaseProof, syncPr } from '../dev/task-timing/github.mjs';
import { report, summary } from '../dev/task-timing/report.mjs';

const program = resolve('dev/task-timing.mjs'),
  minute = 60000,
  head = 'a'.repeat(40);
const runAsync = promisify(execFile);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'zdm-timer-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'repo');
  mkdirSync(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Timer fixture');
  git(cwd, 'config', 'user.email', 'timer@example.invalid');
  git(cwd, 'commit', '--allow-empty', '-qm', 'baseline');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const common = commonFor(cwd),
    root = rootFor(common),
    cutoff = Date.now() - 180 * minute;
  function open() {
    writeJson(root, 'activation.json', { version: 1, at: cutoff, commit: head, lastNumber: 0 });
  }
  function request(message = 'new', offset = 1, type = 'business') {
    return {
      name: '原任务名称',
      type,
      original: {
        kind: 'assignment',
        thread: 'same-chat',
        turn: 'original-turn',
        message,
        item: '1',
        at: cutoff + offset * minute,
      },
    };
  }
  function add(message = 'new', offset = 1, type = 'business') {
    return register(common, request(message, offset, type)).task;
  }
  function point(id, stage, offset, ref = stage, revision) {
    return mark(common, id, { stage, ref, at: cutoff + offset * minute, revision });
  }
  return { cwd, common, root, cutoff, directory, open, request, add, point };
}
function isolatedContext(t, ctx, cwd) {
  const previous = process.env[contextVariable];
  process.env[contextVariable] = JSON.stringify({
    common: ctx.common,
    workspace: cwd,
    ids: ctx.ids,
    round: ctx.round,
  });
  t.after(() => {
    if (previous == null) delete process.env[contextVariable];
    else process.env[contextVariable] = previous;
  });
}

test('delivery cutoff applies to original assignment or earlier todo, even when an old chat gets new work', (t) => {
  const f = fixture(t);
  assert.equal(register(f.common, f.request()).eligible, false);
  assert.equal(summary(f.common).count, 0);
  assert.equal(existsSync(f.root), false);
  f.open();
  for (const offset of [-20, 0])
    assert.equal(register(f.common, f.request('old', offset)).eligible, false);
  const old = f.request('resumed', 10);
  old.original.todoAt = f.cutoff - minute;
  assert.equal(register(f.common, old).eligible, false);
  assert.equal(unassigned(f.common, { original: old.original }).eligible, false);
  const missing = f.request();
  delete missing.original.at;
  assert.throws(() => register(f.common, missing), /时间/);
  const prefix = (f.cutoff - 1000).toString(16).padStart(12, '0');
  const native = f.request(prefix.slice(0, 8) + '-' + prefix.slice(8) + '-7000-8000-000000000001', 10);
  assert.equal(register(f.common, native).eligible, false);
  assert.equal(register(f.common, f.request('new', 2)).fullName, '001 原任务名称');
  assert.equal(register(f.common, f.request('new', 2)).task.id, '001');
  const submitted = f.request('new', 2);
  submitted.original.item = '2';
  assert.equal(register(f.common, submitted).task.id, '002');
  assert.equal(summary(f.common).count, 2);
  assert.equal(existsSync(join(f.root, 'unassigned')), false);
});

test('todo, formal assignment, additional scope and the original feedback have independent timestamps', (t) => {
  const f = fixture(t);
  f.open();
  const todo = f.request('todo', 2, 'engineering');
  todo.original.kind = 'todo';
  const first = register(f.common, todo).task;
  f.point(first.id, 'started', 5);
  const a = report(f.common, first.id);
  assert.equal(a.assignedToStartMs, null);
  assert.equal(a.todoToStartMs, 3 * minute);
  assert.ok(a.notApplicable.includes('业务提验'));
  const after = f.request('followup', 6);
  after.original.todoAt = f.cutoff + 4 * minute;
  after.relatedTask = first.id;
  const second = register(f.common, after).task;
  f.point(second.id, 'started', 7);
  f.point(second.id, 'feedback', 12, 'review-message', head);
  f.point(second.id, 'scope-added', 13, 'new-requirement');
  manualStart(f.common, [second.id], {
    key: 'round',
    stage: 'rework:feedback',
    revision: head,
    ref: 'review-message',
    at: f.cutoff + 15 * minute,
  });
  const b = report(f.common, second.id);
  assert.equal(b.status, 'feedback');
  assert.equal(b.assignedToStartMs, minute);
  assert.equal(b.todoToStartMs, 3 * minute);
  assert.equal(b.relatedTask, first.id);
  assert.equal(b.rounds[0].feedbackToStartMs, 3 * minute);
  assert.deepEqual(
    b.scopeChanges.map((m) => m.ref),
    ['new-requirement'],
  );
});

test('parallel workers allocate once per source, preserve numbers after restart, rename, cancellation and worktree removal', async (t) => {
  const f = fixture(t);
  f.open();
  const requests = ['one', 'two', 'one', 'three', 'two', 'one'].map((name) => f.request(name));
  const rows = await Promise.all(
    requests.map((r) =>
      runAsync(process.execPath, [program, 'register', JSON.stringify(r)], { cwd: f.cwd }).then((v) =>
        JSON.parse(v.stdout),
      ),
    ),
  );
  assert.equal(new Set(rows.map((r) => r.task.id)).size, 3);
  assert.equal(rows[0].task.id, rows[2].task.id);
  const id = rows[0].task.id;
  assert.equal(rename(f.common, id, '新名称').fullName, id + ' 新名称');
  f.point(id, 'cancelled', 4);
  const work = join(f.directory, 'linked');
  git(f.cwd, 'worktree', 'add', '-q', '-b', 'work', work);
  assert.equal(cli(['register', JSON.stringify(requests[0])], work).task.id, id);
  git(f.cwd, 'worktree', 'remove', work);
  assert.equal(report(f.common, id).status, 'cancelled');
  assert.equal(f.add('next').id, '004');
});

test('counts blocked time, parallel work, version-specific user waiting and shared execution once', (t) => {
  const f = fixture(t);
  f.open();
  const a = f.add('a'),
    b = f.add('b');
  const ctx = bound(f.common, [a.id]),
    shared = bound(f.common, [a.id, b.id]);
  const at = (n) => f.cutoff + n * minute;
  for (const task of [a, b]) f.point(task.id, 'started', 2);
  event(ctx, 'start', 'prepare', 'prepare', { at: at(3) });
  finish(ctx, 'prepare', 'passed', { at: at(8) });
  manualStart(f.common, [a.id], { key: 'queue', stage: 'wait:ci', ref: 'CI 17', at: at(3) });
  manualStart(f.common, [a.id], {
    key: 'block',
    stage: 'blocked:ci',
    wait: 'queue',
    ref: 'blocked',
    at: at(3),
  });
  for (const key of ['block', 'queue'])
    manualEnd(f.common, [a.id], { key, ref: 'run', status: 'passed', at: at(15) });
  event(shared, 'start', 'sync', 'handoff', { at: at(16) });
  finish(shared, 'sync', 'passed', { at: at(20) });
  event(ctx, 'mark', 'ready0', 'ready', { revision: head, at: at(20) });
  f.point(a.id, 'notified', 22, 'notice', head);
  f.point(a.id, 'notified', 23, 'reminder', head);
  f.point(a.id, 'feedback', 26, 'feedback', head);
  f.point(a.id, 'closed', 30);
  const result = report(f.common, a.id);
  assert.equal(result.stageMs['wait:ci'], 12 * minute);
  assert.equal(result.blockedMs, 7 * minute);
  assert.equal(result.stageMs['wait:user'], 4 * minute);
  assert.equal(result.notices[0].readyToNoticeMs, 2 * minute);
  assert.equal(result.firstReadyMs, 18 * minute);
  assert.equal(result.deliveryMs, 28 * minute);
  assert.equal(result.unknownMs, 8 * minute);
  const overall = summary(f.common);
  assert.equal(overall.observedWallMs, 9 * minute);
  assert.equal(overall.sumTaskWorkMs, 13 * minute);
  assert.equal(readdirSync(join(f.root, 'shared')).length, 2);
});

test('one feedback round groups all three verification attempts and preserves original failure/unknown durations', (t) => {
  const f = fixture(t);
  f.open();
  const task = f.add('r'),
    id = task.id,
    at = (n) => f.cutoff + n * minute;
  f.point(id, 'started', 3);
  manualStart(f.common, [id], { key: 'round1', stage: 'rework:feedback', ref: 'feedback', at: at(4) });
  const ctx = bound(f.common, [id], 'round1');
  for (let i = 0; i < 3; i++) {
    const run = 'quality:' + i,
      ref = 'run' + i;
    const fields = {
      at: at(5 + 2 * i),
      revision: head,
      tree: head,
      scope: ['unit'],
      risk: 'R2',
      phase: 'dev',
      ref,
    };
    event(ctx, 'start', run, 'validation', fields);
    event(ctx, 'start', run + ':unit', 'validation', { ...fields, check: 'unit' });
    finish(ctx, run + ':unit', i === 2 ? 'passed' : 'failed', { at: fields.at + minute });
    finish(ctx, run, i === 2 ? 'passed' : 'failed', { at: fields.at + minute });
  }
  retryCause(f.common, id, {
    previous: 'quality:0',
    attempt: 'quality:1',
    cause: 'environment',
    ref: 'environment log',
    at: at(11),
  });
  manualEnd(f.common, [id], { key: 'round1', ref: 'ready', status: 'passed', at: at(12) });
  const single = bound(f.common, [id]);
  event(single, 'start', 'crashed', 'development', { at: at(13) });
  event(single, 'start', 'known-interrupt', 'prepare', { at: at(14) });
  finish(single, 'known-interrupt', 'interrupted', { at: at(16) });
  assert.throws(() => finish(single, 'quality:0', 'passed', { at: at(6) }), /冲突/);
  const result = report(f.common, id);
  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].validationAttempts, 3);
  assert.equal(result.rounds[0].measuredMs, 3 * minute);
  assert.deepEqual(
    result.retries.map((r) => r.cause),
    ['environment', 'unknown'],
  );
  assert.equal(result.firstDevPassed, false);
  assert.equal(result.deliveryMs, null);
  assert.ok(result.pending.some((r) => r.id === 'crashed'));
  assert.ok(result.issues.some((x) => x.includes('中断')));
  assert.equal(result.interrupted[0].interruptionObservedAt, at(16));
  observe(() => finish(single, 'missing-attempt', 'passed'), single, 'missing-attempt');
  assert.ok(report(f.common, id).issues.some((x) => x.includes('采集未完成 missing-attempt')));
});

test('5274 hook follows explicit worktree and successful published version; failures and unbound old calls are excluded from readiness', (t) => {
  const f = fixture(t);
  f.open();
  const a = f.add('a'),
    b = f.add('b');
  const preview = join(f.directory, 'preview'),
    work = join(f.directory, 'task');
  git(f.cwd, 'worktree', 'add', '-q', '--detach', preview, 'HEAD');
  git(f.cwd, 'worktree', 'add', '-qb', 'task', work);
  let fail = false;
  const factory = () => ({
    check() {
      if (fail) {
        fail = false;
        throw Error('probe failed');
      }
    },
    prepare() {},
    reload() {},
  });
  const go = (cwd, cmd, args = []) => acceptance(cwd, cmd, args, factory, () => {});
  go(f.cwd, 'init', [preview]);
  writeFileSync(join(work, 'change'), '1');
  git(work, 'add', 'change');
  git(work, 'commit', '-qm', 'one');
  const ctx = bound(f.common, [a.id]);
  isolatedContext(t, ctx, work);
  fail = true;
  assert.throws(() => go(work, 'publish'), /probe failed/);
  assert.equal(report(f.common, a.id).readyAt, null);
  go(work, 'publish');
  assert.equal(
    report(f.common, a.id).marks.filter((m) => m.stage === 'ready')[0].revision,
    git(work, 'rev-parse', 'HEAD'),
  );
  assert.equal(report(f.common, b.id).marks.length, 0);
  const previous = report(f.common, a.id).operations.length;
  go(f.cwd, 'sync');
  assert.equal(report(f.common, a.id).operations.length, previous);
  delete process.env[contextVariable];
  go(work, 'verify');
  assert.equal(report(f.common, a.id).operations.length, previous);
});

test('unassigned events need post-cutoff evidence and can only be reconciled with the original item', (t) => {
  const f = fixture(t);
  f.open();
  const a = f.add('a'),
    b = f.add('b');
  const data = {
    key: 'evt',
    ref: 'original evidence',
    stage: 'prepare',
    at: f.cutoff + 2 * minute,
    original: a.original,
  };
  unassigned(f.common, data);
  unassigned(f.common, data);
  assert.equal(summary(f.common).unassigned.length, 1);
  assert.throws(() => resolveEvent(f.common, b.id, 'evt'), /唯一/);
  resolveEvent(f.common, a.id, 'evt');
  resolveEvent(f.common, a.id, 'evt');
  assert.equal(summary(f.common).unassigned.length, 0);
  assert.equal(report(f.common, a.id).marks.filter((m) => m.stage === 'observation').length, 1);
});

test('ordinary published V1.1 entry automatically measures actual checks, cache lookups and engineering readiness', (t) => {
  const f = fixture(t);
  f.open();
  const task = f.add('eng', 1, 'engineering');
  mkdirSync(join(f.cwd, 'dev'));
  mkdirSync(join(f.cwd, 'docs/notes'), { recursive: true });
  for (const file of ['quality-entry.mjs', 'quality.mjs', 'quality'])
    cpSync(resolve('dev', file), join(f.cwd, 'dev', file), { recursive: true });
  writeFileSync(join(f.cwd, 'docs/notes/work.md'), '# Project notes\n');
  // This standalone repository models the activated release and has no project V1.1 history.
  writeFileSync(join(f.cwd,'dev/quality/release.mjs'),'export const active = true;\n');
  git(f.cwd, 'add', '.');
  git(f.cwd, 'commit', '-qm', 'published quality');
  git(f.cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(f.cwd, 'docs/notes/work.md'), '# Revised project notes\n');
  const call = () =>
    spawnSync(
      process.execPath,
      [program, 'exec', task.id, '--', process.execPath, 'dev/quality-entry.mjs', 'dev'],
      { cwd: f.cwd, encoding: 'utf8' },
    );
  const initial = call();
  assert.equal(initial.status, 0, initial.stderr + initial.stdout);
  const second = call();
  assert.equal(second.status, 0, second.stderr);
  const result = report(f.common, task.id);
  assert.ok(result.readyAt);
  assert.deepEqual(result.risks, ['R0']);
  assert.equal(result.firstDevPassed, true);
  const reused = result.operations.filter((o) => o.status === 'reused');
  assert.ok(reused.length);
  assert.ok(reused.every((o) => o.at >= task.registeredAt && o.sourceRun));
  assert.equal(result.operations.filter((o) => o.phase === 'dev' && !o.check).length, 2);
});

test('normal command result survives missing binding or a timing write failure; CLI recording excludes args and output', (t) => {
  const f = fixture(t);
  f.open();
  const task = f.add('a');
  const wrapped = (...args) =>
    spawnSync(process.execPath, [program, ...args], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(
    wrapped(
      'measure',
      task.id,
      'prepare',
      '--',
      process.execPath,
      '-e',
      'console.log("PRIVATE_SENTINEL")',
    ).status,
    0,
  );
  assert.equal(report(f.common, task.id).operations.length, 1);
  assert.ok(!JSON.stringify(report(f.common, task.id)).includes('PRIVATE_SENTINEL'));
  assert.equal(wrapped('exec', '999', '--', process.execPath, '-e', 'process.exit(17)').status, 17);
  const events = join(f.root, task.id, 'events');
  rmSync(events, { recursive: true });
  writeFileSync(events, 'fixture failure');
  const broken = wrapped(
    'measure',
    task.id,
    'prepare',
    '--',
    process.execPath,
    '-e',
    'process.exit(19)',
  );
  assert.equal(broken.status, 19);
  assert.match(broken.stderr, /计时记录未完成/);
});

test('activation is only issued after the first published version, confirmed CI and synchronized acceptance; retries preserve the cutoff', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.cwd, 'dev'));
  writeFileSync(join(f.cwd, 'dev/task-timing.mjs'), '// fixture');
  git(f.cwd, 'add', 'dev');
  git(f.cwd, 'commit', '-qm', 'first released timer');
  const commit = git(f.cwd, 'rev-parse', 'HEAD'),
    receipt = { commit, pr: 7, ciRun: 21 };
  const api = (endpoint) =>
    endpoint.startsWith('pulls/')
      ? {
          merged_at: new Date(Date.now() - minute).toISOString(),
          merge_commit_sha: commit,
          number: 7,
          base: { ref: 'main', repo: { full_name: 'HlloUJ/zdm' } },
        }
      : {
          id: 21,
          head_sha: commit,
          event: 'push',
          head_branch: 'main',
          status: 'completed',
          conclusion: 'success',
          repository: { full_name: 'HlloUJ/zdm' },
          path: '.github/workflows/verification.yml',
        };
  assert.throws(() => activate(f.cwd, receipt, () => {}), /主线/);
  git(f.cwd, 'update-ref', 'refs/remotes/origin/main', commit);
  assert.throws(() => activate(f.cwd, receipt, () => {}), /5274/);
  writeJson(f.common, 'zdm-acceptance.json', { main: commit, revision: commit, directory: f.cwd });
  assert.throws(
    () =>
      activate(f.cwd, receipt, () => {
        throw Error('CI incomplete');
      }),
    /CI incomplete/,
  );
  assert.equal(activated(f.root), null);
  const active = activate(f.cwd, receipt, (c, r) => releaseProof(api, c, r));
  assert.equal(active.commit, commit);
  assert.equal(active.ciRun, 21);
  assert.deepEqual(
    activate(f.cwd, receipt, () => {
      throw Error('duplicate');
    }),
    active,
  );
  assert.equal(
    register(f.common, { ...f.request(), original: { ...f.request().original, at: active.at } })
      .eligible,
    false,
  );
});

test('CI source binds the exact PR/head and each remote job attempt, fetches only that task and replays idempotently', (t) => {
  const f = fixture(t);
  f.open();
  const a = f.add('a'),
    b = f.add('b');
  const ts = (n) => new Date(f.cutoff + n * minute).toISOString(),
    name = 'HlloUJ/zdm';
  const pr = {
    number: 12,
    created_at: ts(3),
    merged_at: null,
    html_url: 'pr',
    head: { sha: head, ref: 'task', repo: { full_name: name } },
    base: { ref: 'main', repo: { full_name: name } },
  };
  const run = {
    id: 7,
    event: 'pull_request',
    head_sha: head,
    head_branch: 'task',
    pull_requests: [{ number: 12 }],
    repository: { full_name: name },
    run_attempt: 2,
    created_at: ts(4),
    html_url: 'run',
  };
  const api = (path) => {
    if (path === 'pulls/12') return pr;
    if (path.startsWith('actions/runs?'))
      return [{ workflow_runs: [run, { ...run, id: 88, pull_requests: [{ number: 15 }] }] }];
    const attempt = Number(path.match(/attempts\/(\d+)\/jobs/)[1]);
    return [
      {
        jobs: [
          {
            id: 42 + attempt,
            run_id: 7,
            run_attempt: attempt,
            started_at: ts(5 + attempt),
            completed_at: ts(6 + attempt),
            status: 'completed',
            conclusion: attempt === 1 ? 'failure' : 'success',
            name: 'gate',
            html_url: 'job',
          },
        ],
      },
    ];
  };
  assert.throws(() => bindPr(f.cwd, a.id, 12, 'b'.repeat(40), api), /不匹配/);
  bindPr(f.cwd, a.id, 12, head, api);
  syncPr(f.cwd, a.id, api);
  syncPr(f.cwd, a.id, api);
  const stats = report(f.common, a.id);
  assert.deepEqual(
    stats.operations.filter((o) => o.stage === 'ci').map((o) => [o.attempt, o.status]),
    [
      [1, 'failed'],
      [2, 'passed'],
    ],
  );
  assert.equal(stats.stageMs['wait:ci'], 2 * minute);
  assert.equal(report(f.common, b.id).operations.length, 0);
  pr.head.sha = 'b'.repeat(40);
  assert.ok(
    collect(cli(['register', JSON.stringify(f.request('a'))], f.cwd).task, api).gaps.some((g) =>
      g.includes('尚未关联'),
    ),
  );
});
