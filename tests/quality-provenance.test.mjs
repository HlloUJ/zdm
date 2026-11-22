import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nativeCommands } from '../dev/quality/commands.mjs';
import { digest } from '../dev/quality/repository.mjs';
import { verifyArchivedReport } from '../dev/quality/remote.mjs';

test('CI reuse binds the exact PR, parents, rule version, complete check list and raw output', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zdm-ci-proof-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const expected = {
    planId: 'plan',
    policy: 'policy',
    plan: { risk: 'R0', delivery: ['diff', 'docs'] },
  };
  const context = {
    run: { id: 91, run_attempt: 1 },
    repo: 'owner/project',
    number: 5,
    head: 'feature',
    base: 'base',
    tree: 'tree',
    expected,
    dir,
  };
  const report = {
    githubRun: '91',
    attempt: '1',
    repo: context.repo,
    pr: 5,
    phase: 'delivery',
    status: 'passed',
    tree: 'tree',
    base: 'base',
    parents: ['base', 'feature'],
    risk: 'R0',
    planId: 'plan',
    policy: 'policy',
    planned: ['diff', 'docs'],
    results: [],
  };
  for (const id of report.planned) {
    writeFileSync(join(dir, id + '.log'), id);
    report.results.push({ id, status: 'passed', logDigest: digest(id) });
  }
  verifyArchivedReport(report, context);
  for (const change of [
    { parents: ['other', 'feature'] },
    { tree: 'other' },
    { githubRun: '90' },
    { pr: 6 },
    { policy: 'new' },
    { planned: ['diff'] },
    { results: [report.results[0], report.results[0]] },
    { status: 'failed' },
  ])
    assert.throws(() => verifyArchivedReport({ ...report, ...change }, context));
  writeFileSync(join(dir, 'docs.log'), 'changed');
  assert.throws(() => verifyArchivedReport(report, context));
});

test('existing command arguments and build sequence survive evidence recording', () => {
  const args = ['--configLoader', 'runner', '--mode', 'test'];
  assert.deepEqual(nativeCommands('build', ['--mode', 'test']), [
    [process.execPath, 'node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit'],
    [process.execPath, 'node_modules/vite/bin/vite.js', 'build', ...args],
  ]);
  assert.deepEqual(nativeCommands('unit', ['src/example.test.ts'])[0].slice(-2), [
    'run',
    'src/example.test.ts',
  ]);
  assert.deepEqual(nativeCommands('backend', ['-Dtest=OneTest'])[0].slice(-2), [
    'test',
    '-Dtest=OneTest',
  ]);
});
