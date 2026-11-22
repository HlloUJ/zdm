import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planChanges } from './policy.mjs';

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
export function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}
function entries(value) {
  return value.split('\0').filter(Boolean);
}
export const implementation = dirname(fileURLToPath(import.meta.url));
export function rulesIdentity() {
  const files = [
    join(implementation, '../quality.mjs'),
    join(implementation, '../quality-entry.mjs'),
    ...readdirSync(implementation)
      .filter((p) => p.endsWith('.mjs'))
      .sort()
      .map((p) => join(implementation, p)),
  ];
  return digest(JSON.stringify(files.map((file) => digest(readFileSync(file)))));
}
function worktree(cwd, head) {
  const status = entries(
    git(cwd, ['status', '--porcelain=v1', '--no-renames', '--untracked-files=all', '-z']),
  );
  if (!status.length) return { tree: git(cwd, ['rev-parse', head + '^{tree}']).trim(), dirty: false };
  if (status.some((row) => /^(?:DD|AU|UD|UA|DU|AA|UU)/.test(row)))
    throw Error('工作区有未解决的 Git 冲突。');
  const temp = mkdtempSync(join(tmpdir(), 'zdm-quality-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'snapshot') };
    git(cwd, ['read-tree', head], { env });
    // Only the inspected paths are added to this temporary index; the real index is untouched.
    const tracked = new Set(entries(git(cwd, ['ls-tree', '-r', '--name-only', '-z', head])));
    const paths = [...new Set(status.map((row) => row.slice(3)))].filter(
      (path) =>
        tracked.has(path) ||
        existsSync(join(cwd, path)) ||
        status.some((row) => row.slice(3) === path && row.startsWith('??')),
    );
    if (paths.length)
      git(cwd, ['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        env,
        input: paths.join('\0') + '\0',
      });
    return { tree: git(cwd, ['write-tree'], { env }).trim(), dirty: true };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
function blobList(cwd, tree) {
  return entries(git(cwd, ['ls-tree', '-rz', tree])).map((row) => {
    const tab = row.indexOf('\t');
    return [row.slice(tab + 1), row.slice(0, tab)];
  });
}
const previousScripts = {
  build: 'vue-tsc --noEmit && vite build --configLoader runner',
  'test:unit': 'vitest run',
  'test:e2e': 'playwright test',
  'test:ledger': 'node --test tests/store-exit-ledger.test.mjs',
  'backend:test': 'docker compose run --rm --no-deps backend-tools mvn -B --no-transfer-progress test',
};
const nativeChecks = {
  build: 'build',
  'test:unit': 'unit',
  'test:e2e': 'e2e',
  'test:ledger': 'ledger',
  'backend:test': 'backend',
};
function manifest(cwd, tree, adapters = false) {
  const value = JSON.parse(git(cwd, ['show', tree + ':package.json']));
  for (const key of Object.keys(value.scripts || {}))
    if (key.startsWith('verify:')) delete value.scripts[key];
  if (adapters)
    for (const [name, id] of Object.entries(nativeChecks)) {
      if (value.scripts?.[name] === 'node dev/quality-entry.mjs run ' + id)
        value.scripts[name] = previousScripts[name];
    }
  return JSON.stringify(value);
}
function changeSet(cwd, base, tree, blobs) {
  const paths = entries(
    git(cwd, ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base, tree]),
  );
  const old = new Map(blobList(cwd, base));
  const current = new Map(blobs);
  return paths.map((path) => {
    const needsPatch = /(?:\.md$|^src\/|^backend\/src\/)/.test(path);
    const diff = needsPatch
      ? git(cwd, [
          '--literal-pathspecs',
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '-U0',
          base,
          tree,
          '--',
          path,
        ])
      : '';
    const lines = diff
      .split('\n')
      .filter((line) => /^[+-](?![+-]{2})/.test(line))
      .map((line) => line.slice(1));
    const unsafeType = [old.get(path), current.get(path)].some(
      (type) => type && !type.startsWith('100644 blob') && !type.startsWith('100755 blob'),
    );
    const packageChange = path === 'package.json' && old.has(path) && current.has(path);
    return {
      path,
      patch: lines.join('\n'),
      unsafeType,
      onlyQualityAliases: packageChange && manifest(cwd, base) === manifest(cwd, tree),
      onlyTestAdapters: packageChange && manifest(cwd, base, true) === manifest(cwd, tree, true),
    };
  });
}
export function inspect(cwd, baseRef, phase) {
  cwd = realpathSync(cwd);
  if (realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).trim()) !== cwd)
    throw Error('请从任务仓库根目录运行验证。');
  const common = realpathSync(
    git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(),
  );
  const head = git(cwd, ['rev-parse', 'HEAD']).trim();
  const { tree, dirty } = worktree(cwd, head);
  const formal = ['delivery', 'assert-delivery', 'main'].includes(phase);
  if (formal && dirty) throw Error('正式验证须使用已保存的准确候选，工作区仍有未保存内容。');
  let base,
    from,
    fallback = false;
  try {
    base = git(cwd, ['rev-parse', '--verify', '--end-of-options', baseRef + '^{commit}']).trim();
    from = git(cwd, ['merge-base', base, head]).trim();
  } catch {
    if (formal) throw Error('目标主线或共同历史无法核对，不能合并。请先取得准确目标 main。');
    from = git(cwd, ['hash-object', '-w', '-t', 'tree', '--stdin'], { input: '' }).trim();
    base = null;
    fallback = true;
  }
  if (formal && from !== base) throw Error('目标主线已更新，请验证包含最新主线的实际合并候选。');
  return { cwd, common, head, tree, dirty, base, from, ...planTree(cwd, base, from, tree, fallback) };
}

export function planTree(cwd, base, from, tree, fallback = false) {
  const blobs = blobList(cwd, tree);
  let changes = [];
  try {
    changes = changeSet(cwd, from, tree, blobs);
  } catch {
    fallback = true;
  }
  const plan = planChanges(changes, fallback);
  const policy = rulesIdentity();
  const files = changes.map((row) => row.path);
  const planId = digest(JSON.stringify([plan, policy, files, base, tree]));
  return { plan, policy, files, blobs, planId };
}

export function checkedCommand(cwd, command, args) {
  const r = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });
  return !r.error && r.status === 0 ? r.stdout.trim() : null;
}
