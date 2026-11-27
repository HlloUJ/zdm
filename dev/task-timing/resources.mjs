import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { locked, numberId, read, rootFor, taskRecord, writeJson } from '../quality/timing-events.mjs';
import {
  command,
  currentReaders,
  freeKiB,
  identity,
  inside,
  managedRepository,
  worktrees,
} from './resource-host.mjs';
import { collectCompose, engineIdentity, createTestVolume, retireTestVolume } from './resource-docker.mjs';

const file = 'resources-v1.json';
const permit = '.zdm-temporary-owner';
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const git = (cwd, ...args) => command('git', ['-C', cwd, ...args]);
const ledger = (common, id) => join(rootFor(common), numberId(id));
const receipt = (common, id) => join(ledger(common, id), file);
const preview = (common) => read(join(common, 'zdm-acceptance.json'));
const absent = (path) => !lstatSync(path, { throwIfNoEntry: false });
export const resourceStatus = (common, id) => read(receipt(common, id));
function store(common, id, state) {
  return writeJson(ledger(common, id), file, state, { replace: true });
}
export function otherOwner(common, id, path) {
  return readdirSync(rootFor(common)).some((peer) => {
    if (peer === id || !/^\d{3,15}$/.test(peer)) return false;
    const task = read(join(rootFor(common), peer, 'task.json'));
    return (
      task && !['closed', 'cancelled'].includes(task.status) && task.workspaces?.some((w) => w.path === path)
    );
  });
}
function owner(common, id, cwd) {
  if (!managedRepository(cwd)) throw Error('只允许装点猫管理后台仓库');
  const task = taskRecord(rootFor(common), id);
  const path = realpathSync(cwd);
  const branch = git(path, 'branch', '--show-current');
  if (
    !branch ||
    branch === 'main' ||
    path === dirname(common) ||
    path === preview(common)?.directory ||
    !worktrees(common).includes(path) ||
    otherOwner(common, id, path) ||
    !task.workspaces?.some((w) => w.path === path && w.branch === branch)
  ) {
    throw Error('资源必须绑定本任务已经登记的独立工作目录');
  }
  if (['closed', 'cancelled'].includes(task.status)) throw Error('任务已经结项');
  return { path, branch };
}
function edit(common, id, cwd, change) {
  const workspace = owner(common, id, cwd);
  return locked(ledger(common, id), () => {
    const state = resourceStatus(common, id) ?? { version: 1, workspace, files: [] };
    if (
      state.workspace.path !== workspace.path ||
      state.workspace.branch !== workspace.branch ||
      state.requested
    )
      throw Error('资源所属工作目录已变化或已开始退役');
    const result = change(state);
    store(common, id, state);
    return result;
  });
}
export function scratch(common, id, cwd) {
  return edit(common, id, cwd, (state) => {
    if (state.scratch) {
      if (
        identity(state.scratch.path) !== state.scratch.identity ||
        readFileSync(join(state.scratch.path, permit), 'utf8') !== state.scratch.token
      )
        throw Error('临时目录身份已变化');
      return state.scratch.path;
    }
    const path = mkdtempSync(join(realpathSync(tmpdir()), 'zdm-task-' + id + '-'));
    const token = randomUUID();
    writeFileSync(join(path, permit), token, { flag: 'wx', mode: 0o600 });
    state.scratch = { path, root: dirname(path), identity: identity(path), token };
    return path;
  });
}
export function temporaryFile(common, id, cwd, destination) {
  return edit(common, id, cwd, (state) => {
    const path = resolve(destination),
      parent = dirname(path);
    if (
      !destination ||
      !destination.startsWith('/') ||
      realpathSync(parent) !== parent ||
      inside(common, path) ||
      worktrees(common).some((d) => inside(d, path))
    )
      throw Error('需要工作区以外的真实绝对路径');
    let repository;
    try {
      repository = git(parent, 'rev-parse', '--show-toplevel');
    } catch (e) {
      if (e.status !== 128) throw e;
    }
    if (repository) throw Error('外部临时文件不能分配在其他 Git 工作区内');
    state.temporaryFiles ??= [];
    const previous = state.temporaryFiles.find((f) => f.path === path);
    if (previous && identity(path) === previous.identity) return path;
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    state.temporaryFiles.push({ path, identity: identity(path) });
    return path;
  });
}
export function temporaryVolume(common, id, cwd, key) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(key)) throw Error('临时卷用途须为短名称');
  return edit(common, id, cwd, (state) => {
    state.testVolumes ??= [];
    let v = state.testVolumes.find((i) => i.key === key);
    if (!v) {
      const token = randomUUID();
      v = { key, token, name: 'zdm-test-' + id + '-' + token, engine: engineIdentity() };
      state.testVolumes.push(v);
      store(common, id, state); // Persist intent before allocating on the engine.
    }
    createTestVolume(v);
    return v.name;
  });
}
// External files need an independent content-identical copy in this task's retained ledger.
export function registerCopy(common, id, cwd, input) {
  return edit(common, id, cwd, (state) => {
    const path = resolve(input.path),
      backup = resolve(input.backup);
    const allowed = [state.workspace.path, ...(state.scratch ? [state.scratch.path] : [])];
    if (state.temporaryFiles?.some((f) => f.path === path && f.identity === identity(path)))
      allowed.push(dirname(path));
    if (
      !allowed.some((dir) => inside(dir, path) && dir !== path) ||
      !inside(ledger(common, id), backup) ||
      !lstatSync(path).isFile() ||
      !lstatSync(backup).isFile() ||
      identity(path) === identity(backup)
    )
      throw Error('只接收临时文件或本任务文件，以及任务记录中独立的常规文件副本');
    if (worktrees(common).some((w) => w !== state.workspace.path && inside(w, path)))
      throw Error('其他工作区受保护');
    const digest = hash(backup);
    if (hash(path) !== digest) throw Error('保全副本内容不同');
    const item = { path, backup, identity: identity(path), digest };
    const existing = state.files.find((f) => f.path === path);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) throw Error('该路径已登记为不同对象');
    if (!existing) state.files.push(item);
    return item;
  });
}
// Called only for the freshly generated random Compose name, never for a pre-existing .env.
export function bindEnvironment(common, id, cwd, project, at) {
  if (!/^zdm-dev-[a-f0-9]{16}$/.test(project)) throw Error('无效的任务 Compose 身份');
  return edit(common, id, cwd, (state) => {
    if (state.environment && state.environment.project !== project) throw Error('任务已有独立 Compose 环境');
    if (!state.environment || !state.environment.engine) {
      let engine = null;
      try {
        engine = engineIdentity();
      } catch {
        /* Frontend-only tasks can run without a Docker daemon. */
      }
      const previous = state.environment;
      if (previous && engine) {
        // Never adopt existing resources from an engine that was unavailable at creation.
        const filter = 'label=com.docker.compose.project=' + project;
        if (
          ['volume', 'image', 'network', 'container'].some((type) =>
            command('docker', [
              type,
              'ls',
              ...(type === 'container' ? ['-a'] : []),
              '-q',
              '--filter',
              filter,
            ]),
          )
        )
          return previous;
      }
      state.environment = { project, at, engine };
    }
    return state.environment;
  });
}
function noNestedStorage(path, dev) {
  if (existsSync(join(path, '.git'))) throw Error('临时目录中存在 Git 资料');
  for (const e of readdirSync(path, { withFileTypes: true })) {
    if (!e.isDirectory()) continue; // rm does not follow symlinks.
    const p = join(path, e.name);
    if (lstatSync(p).dev !== dev) throw Error('临时目录包含其他文件系统');
    noNestedStorage(p, dev);
  }
}
function releaseProof(common, state, id) {
  const main = dirname(common),
    acceptance = preview(common);
  if (!managedRepository(main)) throw Error('仓库来源变化，保留资源');
  const head = git(main, 'rev-parse', 'HEAD');
  if (
    git(main, 'branch', '--show-current') !== 'main' ||
    head !== git(main, 'rev-parse', 'origin/main') ||
    !acceptance ||
    acceptance.pending ||
    acceptance.main !== head ||
    git(acceptance.directory, 'rev-parse', 'HEAD') !== acceptance.revision ||
    acceptance.tasks.some((t) => t.branch === state.workspace.branch)
  )
    throw Error('主线或 5274 交接尚未完成');
  const trees = worktrees(common);
  if (
    trees.includes(state.workspace.path) ||
    !absent(state.workspace.path) ||
    otherOwner(common, id, state.workspace.path)
  )
    throw Error('所属工作区仍在使用');
  const task = taskRecord(rootFor(common), id);
  const candidate = task.pullRequests?.filter((p) => p.branch === state.workspace.branch).at(-1)?.head;
  const localRef = 'refs/heads/' + state.workspace.branch;
  let local;
  try {
    local = git(main, 'show-ref', '--verify', '--hash', localRef);
  } catch (e) {
    if (e.status !== 128 && e.status !== 1) throw e;
  }
  if (!local && !candidate) throw Error('未找到任务交付版本，保留资源');
  for (const revision of new Set([candidate, local].filter(Boolean)))
    git(main, 'merge-base', '--is-ancestor', revision, head);
  return trees;
}
export function collectResources(
  common,
  id,
  { readers = currentReaders, verify = releaseProof, compose = collectCompose } = {},
) {
  if (!resourceStatus(common, id)) return null; // Older tasks have no authority-bearing resource records.
  return locked(ledger(common, id), () => {
    const s = resourceStatus(common, id);
    const queue = join(rootFor(common), 'pending-cleanup');
    const queueFile = join(queue, numberId(id) + '.json');
    if (s.complete) {
      rmSync(queueFile, { force: true });
      return s.last;
    }
    const trees = verify(common, s, id);
    mkdirSync(queue, { recursive: true, mode: 0o700 });
    writeJson(queue, numberId(id) + '.json', { id });
    s.requested = true;
    store(common, id, s);
    const before = freeKiB(common),
      pending = [],
      removed = [],
      retained = [],
      missing = [];
    const attempt = (key, fn) => {
      try {
        if (fn() === false) missing.push(key);
        else removed.push(key);
      } catch (e) {
        pending.push({ object: key, reason: e.message });
      }
    };
    let inUse;
    const busy = (p) => (inUse ??= readers())(p);
    const guard = (path) => {
      if (trees.some((w) => inside(w, path) || inside(path, w)) || inside(common, path) || busy(path))
        throw Error('路径仍被工作区、进程或 Docker 挂载引用');
    };
    for (const f of [
      ...s.files,
      ...(s.temporaryFiles ?? []).filter((x) => !s.files.some((f) => f.path === x.path)),
    ])
      attempt(f.path, () => {
        if (absent(f.path)) return false;
        guard(f.path);
        if (
          identity(f.path) !== f.identity ||
          (f.backup &&
            (realpathSync(f.backup) !== f.backup || hash(f.path) !== f.digest || hash(f.backup) !== f.digest))
        )
          throw Error('文件身份或保全摘要已变化');
        unlinkSync(f.path);
      });
    if (s.scratch)
      attempt(s.scratch.path, () => {
        const x = s.scratch;
        if (absent(x.path)) return false;
        guard(x.path);
        if (pending.some((p) => inside(x.path, p.object))) throw Error('目录内仍有待核文件');
        if (
          !basename(x.path).startsWith('zdm-task-' + id + '-') ||
          dirname(x.path) !== (x.root ?? realpathSync(tmpdir())) ||
          identity(x.path) !== x.identity ||
          readFileSync(join(x.path, permit), 'utf8') !== x.token
        )
          throw Error('临时目录身份变化');
        noNestedStorage(x.path, lstatSync(x.path).dev);
        rmSync(x.path, { recursive: true });
      });
    for (const v of s.testVolumes ?? []) attempt(v.name, () => retireTestVolume(v));
    if (s.environment) {
      try {
        const result = compose(common, id, s, trees);
        removed.push(...result.removed);
        retained.push(...result.retained);
        pending.push(...result.pending);
      } catch (e) {
        pending.push({ object: s.environment.project, reason: e.message });
      }
    }
    s.last = {
      at: new Date().toISOString(),
      beforeKiB: before,
      afterKiB: freeKiB(common),
      removed,
      retained,
      pending,
      missing,
    };
    (s.attempts ??= []).push(s.last);
    s.complete = !pending.length;
    store(common, id, s);
    if (s.complete) unlinkSync(join(queue, id + '.json'));
    return s.last;
  });
}
export function retryReleased(common, except) {
  const queue = join(rootFor(common), 'pending-cleanup');
  if (!existsSync(queue)) return;
  for (const filename of readdirSync(queue)) {
    const id = filename.replace(/\.json$/, '');
    if (id === except || !/^\d{3,15}\.json$/.test(filename)) continue;
    try {
      collectResources(common, id);
    } catch (e) {
      console.error('任务 ' + id + ' 仍待回收：' + e.message);
    }
  }
}
