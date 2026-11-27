import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync, statfsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export function command(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  }).trim();
}
export const docker = (...args) => command('docker', args);
export const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
export function identity(path) {
  if (resolve(path) !== realpathSync(path)) throw Error('路径或父目录是链接：' + path);
  const st = lstatSync(path, { bigint: true });
  return [String(st.dev), String(st.ino), String(st.birthtimeNs)].join('/');
}
export function freeKiB(path) {
  const s = statfsSync(path, { bigint: true });
  return Number((s.bavail * s.bsize) / 1024n);
}
export function worktrees(common) {
  return command('git', ['--git-dir', common, 'worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .filter((s) => s.startsWith('worktree '))
    .map((s) => realpathSync(s.slice(9)));
}
export function containers(run = docker) {
  const ids = run('ps', '-aq').split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  const format =
    '{"id":{{json .Id}},"name":{{json .Name}},"state":{{json .State.Status}},"image":{{json .Image}},' +
    '"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}}}';
  return run('inspect', '--format', format, ...ids)
    .split('\n')
    .map((s) => JSON.parse(s));
}
export function currentReaders() {
  const files = command('lsof', ['-nP', '-Fn'])
    .split('\n')
    .filter((s) => s.startsWith('n/'))
    .map((s) => s.slice(1));
  if (!files.length) throw Error('无法确认宿主进程引用');
  const binds = containers().flatMap((c) =>
    c.mounts.filter((m) => m.Type === 'bind').map((m) => m.Source.replace(/^\/host_mnt(?=\/)/, '')),
  );
  return (path) =>
    files.some((f) => inside(path, f)) || binds.some((b) => inside(path, b) || inside(b, path));
}

export function managedRepository(cwd) {
  try {
    const remote = command('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
    return /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)HlloUJ\/zdm(?:\.git)?$/i.test(
      remote,
    );
  } catch {
    return false;
  }
}
