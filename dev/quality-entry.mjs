import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bootstrapBase = '6323b344be7bf77683ef7a79985588e894139871';
const contractCommit = '4fa0bf56ff4dcfe16d569a314d47a110a30d7b0e';
const contractHash = 'c9fe13845d8ac5325a9424100d4006e10560090167d3e70969a38730874500e6';
const self = fileURLToPath(import.meta.url);
const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
function node(cwd, file, args, env = process.env) {
  const child = spawnSync(process.execPath, [file, ...args], { cwd, env, stdio: 'inherit' });
  if (child.error || child.status !== 0) {
    const error = Error('验证入口执行失败：' + (child.error?.message || child.signal || child.status));
    error.exitCode = child.status || 1;
    throw error;
  }
}
// Dispatch using committed upstream objects. It also works with a detached CI merge candidate.
export function published(cwd, args, authority) {
  let target;
  try {
    target = git(cwd, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      (authority || 'refs/remotes/origin/main') + '^{commit}',
    ])
      .toString()
      .trim();
  } catch {
    if (args[0] === 'run' || args[0] === 'plan' || args[0] === 'dev')
      return node(cwd, join(dirname(self), 'quality.mjs'), args);
    throw Error('无法读取已发布的验证规则，请取得目标 main 后再交付。');
  }
  const path = mkdtempSync(join(tmpdir(), 'zdm-published-quality-'));
  try {
    const files = git(cwd, [
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      target,
      '--',
      'dev/quality.mjs',
      'dev/quality-entry.mjs',
      'dev/quality',
      'tests/quality-contract.test.mjs',
    ])
      .toString()
      .split('\0')
      .filter(Boolean);
    if (!files.includes('dev/quality.mjs')) {
      if (target !== bootstrapBase) throw Error('目标主线未包含已发布的 V1.1 执行器。');
      if (['delivery', 'main'].includes(args[0])) {
        const source = git(cwd, ['show', contractCommit + ':tests/quality-contract.test.mjs']);
        if (createHash('sha256').update(source).digest('hex') !== contractHash)
          throw Error('首次接入的独立验收契约不符。');
        const reference = join(path, 'reference.test.mjs');
        writeFileSync(reference, source);
        const env = { ...process.env, ZDM_QUALITY_SUBJECT: join(cwd, 'dev/quality.mjs') };
        delete env.NODE_TEST_CONTEXT;
        // Keep stdout machine-readable for the subsequent command.
        const tested = spawnSync(process.execPath, ['--test', reference], {
          cwd,
          env,
          stdio: ['ignore', 2, 2],
        });
        if (tested.error || tested.status !== 0) throw Error('首次接入的独立验收契约未通过。');
      }
      return node(cwd, join(cwd, 'dev/quality.mjs'), args);
    }
    for (const file of files) {
      if (
        !/^(dev\/quality(?:-entry)?\.mjs|dev\/quality\/[\w-]+\.mjs|tests\/quality-contract\.test\.mjs)$/.test(
          file,
        )
      )
        throw Error('无法确认已发布验证器的文件范围。');
      const dest = join(path, file);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, git(cwd, ['show', target + ':' + file]));
    }
    // Candidate policy changes are separately checked against a contract obtained from the base.
    const changes = git(cwd, [
      'diff',
      '--name-only',
      target,
      '--',
      'dev/quality.mjs',
      'dev/quality-entry.mjs',
      'dev/quality',
      'tests/quality-contract.test.mjs',
      '.github/workflows/verification.yml',
    ])
      .toString()
      .trim();
    if (['delivery', 'main', 'merge'].includes(args[0]) && changes) {
      const env = { ...process.env, ZDM_QUALITY_SUBJECT: join(cwd, 'dev/quality.mjs') };
      delete env.NODE_TEST_CONTEXT;
      const tested = spawnSync(
        process.execPath,
        ['--test', join(path, 'tests/quality-contract.test.mjs')],
        { cwd, env, stdio: ['ignore', 2, 2] },
      );
      if (tested.error || tested.status !== 0) throw Error('已发布基准拒绝新的验证器。');
    }
    return node(cwd, join(path, 'dev/quality.mjs'), args);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === self) {
  try {
    const args = process.argv.slice(2);
    // CI supplies the event's immutable target to the published entry, independently of candidate package scripts.
    let authority;
    if (args[0] === '--authority') {
      args.shift();
      authority = args.shift();
    }
    published(process.cwd(), args, authority);
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  }
}
