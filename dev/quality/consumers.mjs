import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';

function matchingFiles(cwd, ref, args) {
  const r = spawnSync('git', ['grep', '-l', '-z', ...args, ref, '--', 'src', 'tests'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error || ![0, 1].includes(r.status)) throw Error('无法核对源码树中的实际使用方');
  return r.stdout
    .split('\0')
    .filter(Boolean)
    .map((p) => p.slice(p.indexOf(':') + 1));
}
export function consumers(cwd, ref, path, readSource) {
  const stem = path.replace(/\.(?:vue|[cm]?[jt]sx?)$/, '');
  const leaf =
    posix.basename(stem) === 'index' ? posix.basename(posix.dirname(stem)) : posix.basename(stem);
  if (!/^[\w-]+$/.test(leaf)) return [];
  const candidates = matchingFiles(cwd, ref, ['-F', '-e', leaf]);
  return candidates.filter((file) => {
    if (file === path || !/\.(?:vue|[cm]?[jt]sx?)$/.test(file)) return false;
    const src = readSource(ref, file);
    return [
      ...src.matchAll(/(?:\bfrom\s*|\bimport\s*|\b(?:require|import)\s*\(\s*)['"]([^'"]+)['"]/g),
    ].some(([, spec]) => {
      const resolved = spec.startsWith('@/')
        ? 'src/' + spec.slice(2)
        : spec.startsWith('.')
          ? posix.join(posix.dirname(file), spec)
          : '';
      return !resolved
        ? false
        : [stem, path, stem.endsWith('/index') ? posix.dirname(stem) : null].includes(resolved);
    });
  });
}
export function displayTests(cwd, ref, texts) {
  const tokens = [...new Set(texts)].filter((t) => t && t.length >= 2 && t.length <= 140);
  if (!tokens.length) return [];
  return matchingFiles(cwd, ref, ['-F', ...tokens.flatMap((t) => ['-e', t])]).filter((p) =>
    /\.(?:spec|test)\.[jt]sx?$/.test(p),
  );
}
