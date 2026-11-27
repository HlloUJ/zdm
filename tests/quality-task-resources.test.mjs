import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { main } from '../dev/task-timing.mjs';
import { commonFor, git, register, update } from '../dev/task-timing/registry.mjs';
import { rootFor, writeJson } from '../dev/quality/timing-events.mjs';
import { collectResources, resourceStatus } from '../dev/task-timing/resources.mjs';
import { collectCompose, createTestVolume, retireTestVolume } from '../dev/task-timing/resource-docker.mjs';

function repo(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'zdm-resource-test-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'main'),
    tree = join(base, 'task'),
    acceptance = join(base, '5274');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'remote', 'add', 'origin', 'https://github.com/HlloUJ/zdm.git');
  git(dir, 'commit', '--allow-empty', '-qm', 'fixture');
  const head = git(dir, 'rev-parse', 'HEAD'),
    common = commonFor(dir),
    root = rootFor(common);
  git(dir, 'update-ref', 'refs/remotes/origin/main', head);
  git(dir, 'worktree', 'add', '-q', '--detach', acceptance, head);
  git(dir, 'worktree', 'add', '-q', '-b', 'task', tree, head);
  writeJson(common, 'zdm-acceptance.json', { directory: acceptance, main: head, revision: head, tasks: [] });
  writeJson(root, 'activation.json', { version: 1, at: Date.now() - 10000, commit: head, lastNumber: 0 });
  const add = (message) =>
    register(common, {
      name: message,
      type: 'engineering',
      original: {
        kind: 'assignment',
        thread: 'fixture',
        turn: 'turn',
        message,
        item: '1',
        at: Date.now() - 1000,
      },
    }).task.id;
  const id = add('cleanup');
  update(common, id, (r) => ({ ...r, workspaces: [{ path: tree, branch: 'task' }] }));
  return { base, dir, tree, common, root, id, head, add, retire: () => git(dir, 'worktree', 'remove', tree) };
}
test('completion proves delivery, preserves open and changed copies, retries independently and is idempotent', (t) => {
  const f = repo(t),
    { dir, common, id, tree, root } = f;
  const scratch = main(['scratch', id], tree);
  t.after(() => rmSync(scratch, { force: true, recursive: true }));
  const external = join(f.base, 'temporary.log'),
    backup = join(root, id, 'evidence.log');
  main(['temp-file', id, external], tree);
  writeFileSync(external, 'unique');
  writeFileSync(backup, 'unique');
  main(['resource-copy', id, JSON.stringify({ path: external, backup })], tree);
  writeFileSync(backup, 'changed');
  assert.throws(() => main(['temp-file', id, join(dir, 'unsafe')], tree), /工作区/);
  assert.throws(
    () => main(['mark', id, JSON.stringify({ stage: 'closed', ref: 'release', at: Date.now() })], dir),
    /工作区/,
  );
  const state = resourceStatus(common, id);
  assert.ok(!state.requested);
  f.retire();
  const early = collectResources(common, id, { readers: () => (p) => p === scratch });
  assert.equal(early.pending.length, 2);
  assert.ok(existsSync(external));
  assert.ok(existsSync(scratch));
  writeFileSync(backup, 'unique');
  const late = collectResources(common, id, { readers: () => () => false });
  assert.deepEqual(new Set(late.removed), new Set([scratch, external]));
  assert.equal(late.pending.length, 0);
  assert.equal(readFileSync(backup, 'utf8'), 'unique');
  const row = main(['mark', id, JSON.stringify({ stage: 'closed', ref: 'release', at: Date.now() })], dir);
  assert.deepEqual(row.cleanup, late);
  assert.deepEqual(collectResources(common, id), late);
  assert.ok(!existsSync(join(root, 'pending-cleanup', id + '.json')));
});
test('a missing original cannot hide the loss of its independent backup', (t) => {
  const f = repo(t),
    path = join(f.base, 'log'),
    copy = join(f.root, f.id, 'log.copy');
  main(['temp-file', f.id, path], f.tree);
  writeFileSync(path, 'result');
  writeFileSync(copy, 'result');
  main(['resource-copy', f.id, JSON.stringify({ path, backup: copy })], f.tree);
  rmSync(path);
  writeFileSync(copy, 'unexpected');
  f.retire();
  const result = collectResources(f.common, f.id, { readers: () => () => false });
  assert.equal(result.pending.length, 1);
  assert.deepEqual(result.missing, []);
});
test('a replacement symlink, an active peer and an unmerged task tip each retain the original allocation', (t) => {
  const f = repo(t),
    path = join(f.base, 'allocated');
  main(['temp-file', f.id, path], f.tree);
  const peer = f.add('peer');
  update(f.common, peer, (r) => ({ ...r, workspaces: [{ path: f.tree, branch: 'task' }] }));
  assert.throws(() => main(['temp-file', f.id, join(f.base, 'second')], f.tree), /独立/);
  update(f.common, peer, (r) => ({ ...r, status: 'closed' }));
  git(f.tree, 'commit', '--allow-empty', '-qm', 'new changes');
  const tip = git(f.tree, 'rev-parse', 'HEAD');
  f.retire();
  assert.throws(() => collectResources(f.common, f.id, { readers: () => () => false }));
  assert.ok(existsSync(path));
  git(f.dir, 'merge', '--ff-only', tip);
  git(f.dir, 'update-ref', 'refs/remotes/origin/main', tip);
  const active = JSON.parse(readFileSync(join(f.common, 'zdm-acceptance.json')));
  git(active.directory, 'checkout', '--detach', tip);
  writeJson(f.common, 'zdm-acceptance.json', { ...active, main: tip, revision: tip }, { replace: true });
  const keep = join(f.base, 'owner-data');
  writeFileSync(keep, 'preserve');
  rmSync(path);
  symlinkSync(keep, path);
  const result = collectResources(f.common, f.id, { readers: () => () => false });
  assert.equal(result.pending.length, 1);
  assert.equal(readFileSync(keep, 'utf8'), 'preserve');
});
function stubDocker(project) {
  const key = 'com.docker.compose.project';
  const resources = new Map();
  let mounts = [],
    diff = '',
    engine = 'engine-id';
  const run = (type, op, ...args) => {
    if (type === 'context') return 'local';
    if (type === 'info') return engine;
    if (type === 'ps') return mounts.join('\n');
    if (type === 'diff') return diff;
    if (op === 'ls')
      return [...resources]
        .filter(([, o]) => o.type === type)
        .map(([k]) => k)
        .join('\n');
    if (op === 'inspect') return JSON.stringify([resources.get(args.at(-1))]);
    if (op === 'create') {
      const name = args.at(-1);
      resources.set(name, {
        type,
        CreatedAt: '2026-01-01',
        Labels: { 'com.zdm.temporary-test': args[1].split('=')[1] },
      });
      return name;
    }
    if (op === 'rm') {
      assert.ok(resources.delete(args.at(-1)));
      return '';
    }
    throw Error('unexpected ' + [type, op, ...args].join(' '));
  };
  function volume(role) {
    const name = project + '_' + role;
    resources.set(name, {
      Name: name,
      type: 'volume',
      Labels: { [key]: project, 'com.docker.compose.volume': role },
      Driver: 'local',
      CreatedAt: '2026-01-01',
    });
    return name;
  }
  return {
    run,
    resources,
    volume,
    setMounts: (x) => {
      mounts = x;
    },
    setEngine: (x) => {
      engine = x;
    },
  };
}
test('Docker collects just proven objects, retains persistent data and resumes after a Maven preservation failure', (t) => {
  const f = repo(t),
    project = 'zdm-dev-123456789abcdef0',
    d = stubDocker(project);
  const maven = d.volume('maven'),
    database = d.volume('database');
  d.resources.set('net', {
    Id: 'net',
    Name: project + '_default',
    type: 'network',
    Labels: { 'com.docker.compose.project': project, 'com.docker.compose.network': 'default' },
    Containers: {},
  });
  const s = { workspace: { path: f.tree }, environment: { project, engine: 'local/engine-id', at: 1 } };
  let archived = false;
  const deps = {
    run: d.run,
    scan: () => [],
    preserve: () => {
      if (!archived) throw Error('archive unavailable');
    },
  };
  const result = collectCompose(f.common, f.id, s, [f.dir], deps);
  assert.deepEqual(result.removed, ['network net']);
  assert.equal(result.pending.length, 1);
  assert.ok(d.resources.has(database));
  assert.ok(d.resources.has(maven));
  assert.equal(result.retained[0].object, database);
  const current = d.resources.get(maven);
  current.CreatedAt = '2026-01-02';
  archived = true;
  assert.match(collectCompose(f.common, f.id, s, [f.dir], deps).pending[0].reason, /替换/);
  current.CreatedAt = '2026-01-01';
  assert.deepEqual(collectCompose(f.common, f.id, s, [f.dir], deps).removed, ['volume ' + maven]);
  assert.ok(d.resources.has(database));
  writeFileSync(join(f.dir, '.env'), "export COMPOSE_PROJECT_NAME = '" + project + "' # shared\n");
  assert.throws(() => collectCompose(f.common, f.id, s, [f.dir], deps), /仍由工作区/);
});
test('declared test volumes reject wrong engines, other consumers and replacement labels', () => {
  const token = '11111111-1111-4111-8111-111111111111',
    name = 'zdm-test-001-' + token;
  const v = { token, name, engine: 'local/engine-id' },
    d = stubDocker();
  createTestVolume(v, d.run);
  assert.ok(v.created);
  d.setMounts(['active']);
  assert.throws(() => retireTestVolume(v, d.run), /引用/);
  d.setMounts([]);
  d.setEngine('another');
  assert.throws(() => retireTestVolume(v, d.run), /身份/);
  d.setEngine('engine-id');
  d.resources.get(name).Labels['com.zdm.retained-data'] = 'database';
  assert.throws(() => retireTestVolume(v, d.run), /标记保留/);
  delete d.resources.get(name).Labels['com.zdm.retained-data'];
  assert.equal(retireTestVolume(v, d.run), true);
  assert.equal(retireTestVolume(v, d.run), false);
});
