import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const timing = join(project, 'dev/task-timing.mjs');

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'zdm-design-guard-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  function write(path, value, options) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), value, options);
  }
  function commit(message) {
    git('add', '.');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  }
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Design preview fixture');
  git('config', 'user.email', 'design@example.invalid');
  for (const path of ['dev/quality-entry.mjs', 'dev/quality.mjs', 'dev/quality', 'package.json'])
    cpSync(join(project, path), join(cwd, path), { recursive: true });
  write('.git/bin/docker', '#!/bin/sh\necho invoked >> .git/docker-started\nexit 91\n', { mode: 0o755 });
  write('tests/quality-contract.test.mjs',
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('.git/contract-started', 'yes');\n");
  write('docs/notes/example.md', '# Example\n');
  const base = commit('published rules');
  git('update-ref', 'refs/remotes/origin/main', base);
  git('switch', '-qc', 'task');

  // The outer test can itself run in a real PR or a timed task. Each fixture owns its event and ledger.
  const env = { ...process.env, PATH: join(cwd, '.git/bin') + delimiter + process.env.PATH };
  for (const key of ['NODE_TEST_CONTEXT', 'GITHUB_ACTIONS', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH',
    'GITHUB_REF', 'GITHUB_SHA', 'ZDM_QUALITY_TIMING_CONTEXT']) delete env[key];
  function call(program, args, extraEnv = {}) {
    const r = spawnSync(program, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8' });
    if (r.error) throw r.error;
    assert.equal(r.signal, null, r.stderr);
    return r;
  }
  const entry = (args, extraEnv) => call(process.execPath, ['dev/quality-entry.mjs', ...args], extraEnv);
  const npm = (name, ...args) => call('npm', ['run', '--silent', name, '--', ...args]);
  function blocked(result) {
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /纯 UI 设计阶段已拦截工程验证/);
    for (const path of ['.git/zdm-quality/v1.1', '.git/docker-started', '.git/contract-started'])
      assert.equal(existsSync(join(cwd, path)), false, path);
  }
  return { cwd, git, write, commit, base, call, entry, npm, blocked };
}

function success(r) {
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout);
}

test('an empty marked design branch stops native, verification and timed commands before any check', t => {
  const f = repository(t);
  assert.deepEqual(success(f.entry(['stage', 'design-preview'])), { branch: 'task', stage: 'design-preview' });
  assert.equal(f.git('status', '--porcelain'), '');
  for (const name of ['verify:plan', 'verify:dev', 'verify:delivery', 'verify:main', 'verify:assert-delivery',
    'build', 'test:unit', 'test:e2e', 'test:ledger', 'backend:test']) f.blocked(f.npm(name));
  f.blocked(f.npm('backend:test', '--help'));
  f.blocked(f.npm('verify:merge', '1'));

  const at = Date.now() - 60000;
  f.write('.git/zdm-tasks/activation.json', JSON.stringify({ version: 1, at, commit: f.base, lastNumber: 0 }));
  const task = success(f.call(process.execPath, [timing, 'start', JSON.stringify({
    name: '设计预览样例', type: 'engineering',
    original: { kind: 'assignment', thread: 'fixture', turn: 'first', message: 'request', item: '1', at: at + 1 },
  })])).task;
  f.blocked(f.call(process.execPath, [timing, 'exec', task.id, '--', 'npm', 'run', '--silent', 'verify:dev']));
  const report = success(f.call(process.execPath, [timing, 'report', task.id, '--json']));
  assert.ok(!report.readyAt);
  assert.equal(report.operations.length, 0);

  f.write('src/page.ts', 'export const count = 1;\n');
  f.blocked(f.npm('verify:dev'));
  f.git('switch', '-q', 'main');
  assert.notEqual(f.entry(['stage', 'design-preview']).status, 0);
  assert.ok(success(f.entry(['plan'])).changed.includes('src/page.ts'));
  f.git('switch', '--detach', '-q');
  assert.notEqual(f.entry(['stage', 'design-preview']).status, 0);
});

test('an unmarked design is protected before staging, after staging and after committing on an older branch', t => {
  const f = repository(t);
  f.git('switch', '-q', 'main');
  const verifier = 'dev/quality.mjs';
  f.write(verifier, readFileSync(join(f.cwd, verifier), 'utf8') + '\n// Later upstream release.\n');
  f.git('update-ref', 'refs/remotes/origin/main', f.commit('publish a new validator'));
  f.git('switch', '-q', 'task');
  const file = 'design-previews/列表 方案/preview.vue';
  f.write(file, '<template><p>预览</p></template>\n');
  f.blocked(f.npm('verify:dev'));
  f.git('add', file);
  f.blocked(f.npm('backend:test'));
  f.commit('save the design');
  assert.equal(f.git('status', '--porcelain'), '');
  f.blocked(f.npm('verify:dev'));
  f.blocked(f.npm('backend:test'));
  f.blocked(f.npm('verify:delivery'));

  assert.equal(success(f.entry(['stage', 'development'])).stage, 'development');
  assert.ok(success(f.npm('verify:plan')).delivery.includes('backend'));
});

test('ordinary development executes its checks and mixed branches keep their full change scope', t => {
  const f = repository(t);
  f.write('docs/notes/example.md', '# Updated example\n');
  const report = success(f.npm('verify:dev'));
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.results.map(row => [row.id, row.status]), [['diff', 'passed'], ['docs', 'passed']]);
  f.commit('ordinary development');
  f.write('design-previews/example/index.html', '<p>Preview</p>\n');
  const plan = success(f.npm('verify:plan'));
  assert.deepEqual(plan.changed, ['design-previews/example/index.html', 'docs/notes/example.md']);
  assert.ok(plan.delivery.includes('backend'));
  assert.equal(f.npm('backend:test', '--help').status, 91);
  assert.equal(existsSync(join(f.cwd, '.git/docker-started')), true);
});

test('published PR and main CI plan the actual design candidate and reject a failing required check', t => {
  const f = repository(t);
  success(f.entry(['stage', 'design-preview']));
  f.write('design-previews/example/preview.md', '[图稿](missing.png)\n');
  const candidate = f.commit('design with a broken link');
  const event = join(f.cwd, '.git/pr-event.json');
  f.write('.git/pr-event.json', JSON.stringify({ pull_request: { head: { sha: candidate }, body: '' } }));
  for (const [phase, name, ref] of [['delivery', 'pull_request', 'refs/pull/1/merge'], ['main', 'push', 'refs/heads/main']]) {
    const ci = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: name, GITHUB_REF: ref, GITHUB_SHA: candidate, GITHUB_EVENT_PATH: event };
    const published = (command) => f.entry(['--authority', f.base, command, '--base', f.base], ci);
    const plan = success(published('plan'));
    assert.deepEqual(plan.changed, ['design-previews/example/preview.md']);
    assert.deepEqual(plan.delivery, ['diff', 'docs', 'quality', 'acceptance', 'ledger', 'build', 'unit', 'e2e', 'backend']);
    const r = published(phase);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /引用了不存在的文件 design-previews\/example\/missing.png/);
    assert.notEqual(published('assert-delivery').status, 0);
    f.git('switch', '--detach', '-q', candidate);
  }
});
