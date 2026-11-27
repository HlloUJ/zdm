import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { dependencyCache, installationKey } from '../dev/acceptance-dependencies.mjs';

test('the install key follows dependencies, lifecycle scripts, toolchain and lockfile', () => {
  const pkg = { scripts: { test: 'old' }, dependencies: { x: '1' } };
  const key = (p, lock = 'lock', options = ['npm11']) => installationKey(JSON.stringify(p), lock, options);
  assert.equal(key(pkg), key({ ...pkg, scripts: { test: 'new' } }));
  assert.notEqual(key(pkg), key({ ...pkg, dependencies: { x: '2' } }));
  assert.notEqual(key(pkg), key(pkg, 'updated'));
  assert.notEqual(key(pkg), key(pkg, 'lock', ['npm12']));
  const hooks = { ...pkg, scripts: { prepare: 'npm run test', test: 'old' } };
  assert.notEqual(key(hooks), key({ ...hooks, scripts: { ...hooks.scripts, test: 'new' } }));
});
test('eviction preserves active, rollback, alias, busy and legacy installations', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zdm-install-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  let installs = 0,
    busy;
  const run = (path, program, args) => {
    if (program === 'git') {
      if (args[0] === 'show')
        return args[1].endsWith(':package.json') ? '{"name":"fixture"}' : args[1].split(':')[0];
      if (args[0] === 'ls-tree') return '';
      return git(...args);
    }
    if (args[0] === '--version') return '11';
    if (args[0] === 'config') return '{}';
    if (args[0] === 'ci') {
      installs++;
      const vite = join(path, 'node_modules/vite/bin');
      mkdirSync(vite, { recursive: true });
      writeFileSync(join(vite, 'vite.js'), 'fixture');
      return '';
    }
    throw Error('unexpected command');
  };
  const c = dependencyCache(dir, run, () => (p) => p === busy);
  const active = c.ensure('a'),
    rollback = c.ensure('b'),
    remove = c.ensure('c'),
    aliased = c.ensure('d'),
    held = c.ensure('e'),
    other = c.ensure('f');
  assert.equal(c.ensure('a'), active);
  assert.equal(installs, 6);
  const root = dirname(dirname(active)),
    legacy = join(root, '9'.repeat(64));
  mkdirSync(legacy);
  symlinkSync(aliased, join(legacy, 'node_modules'));
  symlinkSync(active, join(dir, 'node_modules'));
  busy = dirname(held);
  writeFileSync(join(dirname(other), 'unique.json'), 'keep');
  const state = { main: 'a', revision: 'a', tasks: [] };
  c.sweep({ ...state, pending: true }, 'b');
  assert.ok(existsSync(remove));
  c.sweep(state, 'different-toolchain', rollback);
  assert.ok(!existsSync(remove));
  assert.ok(existsSync(rollback));
  for (const entry of [active, aliased, held, legacy, other]) assert.ok(existsSync(entry));
  busy = null;
  c.sweep(state);
  assert.ok(!existsSync(held));
  assert.ok(existsSync(rollback));
  assert.equal(basename(realpathSync(aliased)), 'node_modules');
});
