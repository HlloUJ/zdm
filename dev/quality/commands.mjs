import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { checkDocuments } from './documents.mjs';
import { checks } from './policy.mjs';

export function nativeCommands(id, args = []) {
  const spec = checks[id];
  if (!spec?.command) throw Error('未知测试命令 ' + id);
  return [...(spec.before ? [spec.before] : []), [...spec.command, ...args]];
}
export function launch(cwd, commands, stdio) {
  const env = { ...process.env, FORCE_COLOR: '0' };
  for (const name of [
    'NODE_TEST_CONTEXT',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
    'GITHUB_ENV',
    'GITHUB_OUTPUT',
    'GITHUB_PATH',
    'GITHUB_STEP_SUMMARY',
  ])
    delete env[name];
  for (const [program, ...args] of commands) {
    const result = spawnSync(program, args, { cwd, stdio, env });
    if (result.error || result.signal || result.status !== 0) {
      const error = Error(
        result.error?.message ||
          program + ' ' + args.join(' ') + ' exited ' + (result.signal || result.status),
      );
      error.exitCode = result.status || 1;
      throw error;
    }
  }
}
function completed(id, raw) {
  const output = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  if (['quality', 'acceptance', 'ledger'].includes(id))
    return (
      /(?:#|ℹ) tests [1-9]\d*\b/.test(output) &&
      !/(?:#|ℹ) (?:fail|skipped|cancelled|todo) [1-9]/.test(output)
    );
  if (id === 'unit')
    return /Tests\s+[1-9][\d,]* passed/.test(output) && !/\d+ (?:skipped|todo|failed)/.test(output);
  if (id === 'e2e' || id === 'selection')
    return (
      /\b[1-9]\d* passed\b/.test(output) &&
      !/[1-9]\d* (?:skipped|flaky|failed|did not run|interrupted)/.test(output)
    );
  if (id === 'backend')
    return (
      /Tests run: [1-9]\d*, Failures: 0, Errors: 0, Skipped: 0/.test(output) &&
      !/(?:Failures|Errors|Skipped): [1-9]/.test(output) &&
      output.includes('BUILD SUCCESS')
    );
  return true;
}
export function runCheck(snapshot, id, args, log, partial = false) {
  if (id === 'docs') {
    writeFileSync(log, checkDocuments(snapshot), { mode: 0o600, flag: 'wx' });
    return true;
  }
  const commands =
    id === 'diff'
      ? [['git', 'diff', '--check', '--no-ext-diff', snapshot.from, snapshot.tree]]
      : nativeCommands(id, args);
  const fd = openSync(log, 'wx', 0o600);
  try {
    launch(snapshot.cwd, commands, ['ignore', fd, fd]);
  } finally {
    closeSync(fd);
  }
  const output = readFileSync(log, 'utf8');
  const complete = completed(id, output);
  if (!complete && !partial) throw Error(id + ' 未能证明用例完整执行，请核对跳过项和原始报告。');
  return complete;
}
