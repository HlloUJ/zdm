import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { currentReaders, identity, worktrees } from './task-timing/resource-host.mjs';

const marker = '.zdm-install.json';
const lifecycle = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'dependencies',
];
const installSettings = [
  'registry',
  'omit',
  'include',
  'ignore-scripts',
  'install-strategy',
  'legacy-bundling',
  'legacy-peer-deps',
  'strict-peer-deps',
  'install-links',
  'bin-links',
  'prefer-dedupe',
  'global-style',
  'cpu',
  'os',
  'libc',
  'node-options',
  'allow-scripts',
  'script-shell',
  'engine-strict',
  'node-env',
];
const hash = (value) => createHash('sha256').update(value).digest('hex');
export function installationKey(manifest, lock, options) {
  const pkg = JSON.parse(manifest);
  // Lifecycle hooks may delegate to any other package script.
  if (!lifecycle.some((k) => pkg.scripts?.[k])) delete pkg.scripts;
  return hash(JSON.stringify([pkg, lock, options]));
}
export function dependencyCache(directory, run, readers = currentReaders) {
  const root = join(directory, '.private', 'frontend-dependencies');
  const git = (...args) => run(directory, 'git', args);
  function input(revision) {
    const manifest = git('show', revision + ':package.json'),
      lock = git('show', revision + ':package-lock.json');
    const npmrc = git('ls-tree', '--name-only', revision, '--', '.npmrc')
      ? git('show', revision + ':.npmrc')
      : '';
    const config = JSON.parse(run(directory, 'npm', ['config', 'list', '--json']));
    // Scoped registries may affect resolution; never store the effective npm config or credentials.
    const keys = [
      ...installSettings,
      ...Object.keys(config)
        .filter((k) => k.endsWith(':registry'))
        .sort(),
    ];
    const options = [
      process.version,
      run(directory, 'npm', ['--version']),
      process.platform,
      process.arch,
      npmrc,
      keys.map((k) => [k, config[k] ?? null]),
    ];
    return { manifest, lock, npmrc, key: installationKey(manifest, lock, options) };
  }
  function ensure(revision) {
    const { manifest, lock, npmrc, key } = input(revision),
      cache = join(root, key);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (realpathSync(root) !== root) throw Error('验收依赖根目录不可为链接');
    if (!existsSync(cache)) {
      const tmp = mkdtempSync(join(root, '.install-'));
      try {
        writeFileSync(join(tmp, 'package.json'), manifest + '\n');
        writeFileSync(join(tmp, 'package-lock.json'), lock + '\n');
        if (npmrc) writeFileSync(join(tmp, '.npmrc'), npmrc + '\n', { mode: 0o600 });
        run(tmp, 'npm', ['ci', '--prefer-offline', '--no-audit'], { stdio: 'inherit' });
        if (npmrc) rmSync(join(tmp, '.npmrc'));
        writeFileSync(join(tmp, marker), JSON.stringify({ key, identity: identity(tmp) }), { mode: 0o600 });
        renameSync(tmp, cache);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    const owner = JSON.parse(readFileSync(join(cache, marker), 'utf8'));
    if (
      owner.key !== key ||
      owner.identity !== identity(cache) ||
      !existsSync(join(cache, 'node_modules/vite/bin/vite.js'))
    )
      throw Error('验收依赖缓存身份或安装结果异常');
    return join(cache, 'node_modules');
  }
  function sweep(state, previous, oldPath) {
    if (!existsSync(root) || realpathSync(root) !== root || state.pending) return;
    // Unmarked legacy directories and compatibility links stay available for offline recovery.
    const owned = readdirSync(root, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && /^[a-f0-9]{64}$/.test(e.name) && existsSync(join(root, e.name, marker)),
    );
    if (!owned.length) return;
    const pinnedFile = join(root, '.rollback.json');
    const activeKey = basename(dirname(realpathSync(join(directory, 'node_modules'))));
    const oldKey = oldPath && dirname(dirname(oldPath)) === root ? basename(dirname(oldPath)) : undefined;
    const key = oldKey ?? (previous && previous !== state.revision ? input(previous).key : undefined);
    if (key && key !== activeKey) {
      writeFileSync(pinnedFile + '.next', JSON.stringify({ key }), { mode: 0o600 });
      renameSync(pinnedFile + '.next', pinnedFile);
    }
    const pinned = new Set([activeKey]);
    if (existsSync(pinnedFile)) pinned.add(JSON.parse(readFileSync(pinnedFile, 'utf8')).key);
    for (const rev of new Set([state.main, state.revision, ...state.tasks.map((t) => t.revision)]))
      pinned.add(input(rev).key);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const deps = join(root, entry.name, 'node_modules');
      if (existsSync(deps) && lstatSync(deps).isSymbolicLink())
        pinned.add(basename(dirname(realpathSync(deps))));
    }
    const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
    for (const checkout of worktrees(common)) {
      const deps = join(checkout, 'node_modules');
      if (existsSync(deps)) pinned.add(basename(dirname(realpathSync(deps))));
    }
    const candidates = owned.filter((e) => !pinned.has(e.name));
    if (!candidates.length) return;
    const busy = readers();
    for (const e of candidates) {
      const path = join(root, e.name),
        owner = JSON.parse(readFileSync(join(path, marker), 'utf8'));
      if (
        readdirSync(path).every((name) =>
          [marker, 'package.json', 'package-lock.json', 'node_modules'].includes(name),
        ) &&
        owner.key === e.name &&
        owner.identity === identity(path) &&
        !busy(path)
      )
        rmSync(path, { recursive: true });
    }
  }
  return { ensure, sweep };
}
