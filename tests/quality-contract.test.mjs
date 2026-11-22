import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

// The published copy is also run against proposed changes to the verifier.
const subject = resolve(process.env.ZDM_QUALITY_SUBJECT || 'dev/quality.mjs');
const pass = "import test from 'node:test';\ntest('fixture', () => {});\n";
function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'zdm-quality-contract-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  function write(file, data) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), data);
  }
  function commit(message) { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); }
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Verification'); git('config', 'user.email', 'verification@example.invalid');
  write('docs/notes/overview.md', '# Project overview\n');
  write('dev/acceptance.mjs', 'export const revision = 0;\n');
  write('tests/acceptance.test.mjs', pass);
  write('tests/quality-contract.test.mjs', pass);
  const base = commit('baseline');
  git('update-ref', 'refs/remotes/origin/main', base); git('switch', '-qc', 'feature');
  function call(stage, ...args) {
    const result = spawnSync(process.execPath, [subject, stage, ...args], { cwd, encoding: 'utf8', env: process.env });
    if (result.error) throw result.error;
    return { code: result.status, output: result.stdout, error: result.stderr };
  }
  function success(stage, ...args) {
    const result = call(stage, ...args);
    assert.equal(result.code, 0, result.error + result.output);
    return JSON.parse(result.output);
  }
  return { cwd, git, write, commit, call, success, base };
}

test('both stages use the same risk rules, including unstaged, deleted and untracked inputs', (t) => {
  const f = repository(t);
  f.write('docs/notes/overview.md', '# Background and history\n');
  assert.equal(f.success('plan').risk, 'R0');
  f.write('src/pages/selection-center/selection-center.css', '.selection-center { margin: 2px }\n');
  assert.equal(f.success('plan').risk, 'R1');
  f.write('src/pages/customer/list.vue', '<template><p>Customer list</p></template>\n');
  assert.equal(f.success('plan').risk, 'R2');
  f.write('src/components/foundation/Shared.vue', '<template><p>Shared</p></template>\n');
  assert.equal(f.success('plan').risk, 'R3');
  rmSync(join(f.cwd, 'dev/acceptance.mjs'));
  const a = f.success('plan');
  assert.equal(a.risk, 'R4');
  assert.deepEqual(f.success('plan'), a);
  assert.ok(a.delivery.includes('acceptance') && a.delivery.includes('build'));
  assert.deepEqual(f.git('diff', '--cached', '--name-only'), '');
  f.write('unknown-executable.py', 'print(1)\n');
  const full = f.success('plan');
  for (const id of ['unit','build','e2e','backend','ledger','acceptance','quality']) assert.ok(full.delivery.includes(id), id);
});

test('development evidence is bound to actual inputs, reused after unrelated notes, and required before merge', (t) => {
  const f = repository(t);
  f.write('dev/acceptance.mjs', 'export const revision = 1;\n');
  const dev = f.success('dev');
  assert.equal(dev.risk, 'R4');
  assert.equal(dev.results.find(row => row.id === 'acceptance').status, 'passed');
  assert.notEqual(f.call('assert-delivery').code, 0);
  f.write('docs/notes/overview.md', '# Revised historical note\n'); f.commit('candidate');
  const delivery = f.success('delivery');
  assert.equal(delivery.results.find(row => row.id === 'acceptance').status, 'reused');
  assert.equal(f.success('assert-delivery').head, f.git('rev-parse', 'HEAD'));
  const result = delivery.results.find(row => row.id === 'acceptance');
  assert.ok(existsSync(result.log));
  writeFileSync(result.log, 'different output');
  assert.notEqual(f.call('assert-delivery').code, 0);
  const refreshed = f.success('delivery');
  assert.equal(refreshed.results.find(row => row.id === 'acceptance').status, 'passed');
  f.write('tests/acceptance.test.mjs', "import test from 'node:test';\ntest('changed', () => { throw Error('fixture fails'); });\n");
  f.commit('changed input');
  assert.notEqual(f.call('delivery').code, 0);
  assert.notEqual(f.call('assert-delivery').code, 0);
  f.write('tests/acceptance.test.mjs', pass + '// corrected\n'); f.commit('fix input');
  const recovered = f.success('delivery');
  assert.equal(recovered.results.find(row => row.id === 'acceptance').status, 'passed');
  const runs = readdirSync(join(f.cwd, '.git/zdm-quality/v1.1/runs'));
  assert.ok(runs.some(file => readFileSync(join(f.cwd, '.git/zdm-quality/v1.1/runs', file), 'utf8').includes('failed')));
});

test('stale target, dirty candidate, missing proof and unresolvable base cannot authorize a merge', (t) => {
  const f = repository(t);
  f.write('docs/notes/overview.md', '# Background\n'); const candidate = f.commit('docs');
  f.success('delivery');
  assert.notEqual(f.call('assert-delivery', '--base', 'not-a-real-ref').code, 0);
  f.write('new.txt', 'pending\n'); assert.notEqual(f.call('assert-delivery').code, 0); rmSync(join(f.cwd, 'new.txt'));
  f.git('switch', '-q', 'main'); f.write('main-only.txt', 'new main\n');
  f.git('update-ref', 'refs/remotes/origin/main', f.commit('new main'));
  f.git('switch', '-q', 'feature'); assert.equal(f.git('rev-parse','HEAD'), candidate);
  assert.notEqual(f.call('assert-delivery').code, 0);
  assert.notEqual(f.call('delivery').code, 0);
});
