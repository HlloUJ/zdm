import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './acceptance-runtime.mjs';
import { published } from './quality-entry.mjs';
import { contextVariable, measured, observe, observer, ready } from './quality/timing-events.mjs';

const mainRef = 'refs/remotes/origin/main';

function run(directory, program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: directory, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || program + ' exited ' + result.status).trim());
  }
  return result.stdout?.trim() ?? '';
}

export function acceptance(cwd, command, argument, ...adapters) {
  const execute = () => runAcceptance(cwd, command, argument, ...adapters);
  if (!process.env[contextVariable] || !['publish', 'sync', 'verify', 'recover'].includes(command)) return execute();
  const ctx = observe(() => observer(realpathSync(run(cwd, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])), cwd));
  const source = ctx && command === 'publish' ? observe(() => ({
    branch: run(cwd, 'git', ['branch', '--show-current']),
    revision: run(cwd, 'git', ['rev-parse', 'HEAD']),
  }), ctx, '5274 publish') : {};
  return measured(ctx, command === 'publish' ? 'publish' : 'handoff', execute, (state, id) => {
    if (command !== 'publish') return;
    const branch = run(cwd, 'git', ['branch', '--show-current']);
    const task = state.tasks.find(item => item.branch === branch);
    if (task) ready(ctx, 'ready', task.revision, id);
  }, source || {});
}

function runAcceptance(cwd, command, argument, runtimeFactory = createRuntime, checkDevelopment = directory => published(directory, ['dev'])) {
  const git = (...args) => run(cwd, 'git', args);
  const commonDir = realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
  const statePath = join(commonDir, 'zdm-acceptance.json');
  const lockPath = join(commonDir, 'zdm-acceptance.lock');
  const resolve = (ref) => git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}');
  const ancestor = (older, newer) => {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd, encoding: 'utf8' });
    if (result.status === 0 || result.status === 1) return result.status === 0;
    throw result.error ?? new Error(result.stderr || '无法核对 Git 提交关系。');
  };
  const inRepo = (directory, runtime = false) => {
    const taskGit = (...args) => run(directory, 'git', args);
    if (realpathSync(taskGit('rev-parse', '--path-format=absolute', '--git-common-dir')) !== commonDir) {
      throw new Error('工作目录属于其他仓库。');
    }
    const status = taskGit('status', '--porcelain');
    const deps = join(directory, 'node_modules');
    const managedLink = runtime && status === '?? node_modules' && lstatSync(deps).isSymbolicLink() &&
      realpathSync(deps).startsWith(join(directory, '.private', 'frontend-dependencies') + '/');
    if (status && !managedLink) throw new Error('工作目录存在未保存改动：' + directory);
    return taskGit;
  };
  const current = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const save = (state) => {
    const next = statePath + '.next';
    writeFileSync(next, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(next, statePath);
  };

  if (!['init', 'publish', 'verify', 'sync', 'status', 'recover'].includes(command)) {
    throw new Error('用法：node dev/acceptance.mjs init <运行目录> [当前验收分支] | publish | verify | sync | status | recover');
  }
  if (command === 'status') return current();
  let validated;
  if (command === 'publish') {
    const taskGit = inRepo(cwd);
    validated = taskGit('rev-parse', 'HEAD');
    if (!taskGit('branch','--show-current') || taskGit('branch','--show-current') === 'main') throw Error('请在任务分支发布。');
    checkDevelopment(cwd);
  }
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('5274 正在更新。如上一次进程意外退出，先检查现场再恢复。');
    throw error;
  }

  try {
    let state;
    if (command === 'init') {
      if (existsSync(statePath)) throw new Error('5274 已初始化。');
      const [runtimePath, seed] = argument;
      const directory = realpathSync(runtimePath);
      const runtimeGit = inRepo(directory, true);
      if (runtimeGit('branch', '--show-current')) throw new Error('5274 运行目录必须采用分离 HEAD。');
      const revision = runtimeGit('rev-parse', 'HEAD');
      const main = resolve(mainRef);
      if (seed ? revision !== resolve('refs/heads/' + seed) : revision !== main) {
        throw new Error('运行目录必须对应现有验收分支的准确版本，或当前 origin/main。');
      }
      state = { directory, main: git('merge-base', main, revision), revision, tasks: seed ? [{ branch: seed, revision }] : [] };
      const runtime = runtimeFactory(directory, run);
      runtime.check();
      save(state);
      return state;
    }

    if (!existsSync(statePath)) throw new Error('5274 尚未初始化。');
    state = current();
    const runtimeGit = inRepo(state.directory, true);
    if (runtimeGit('branch', '--show-current')) throw new Error('5274 运行目录意外切换到了开发分支。');
    const changedPaths = (from, to) => git('diff', '--no-renames', '--name-only', '-z', from, to).split('\0').filter(Boolean);
    const active = runtimeGit('rev-parse', 'HEAD');
    if (command === 'recover' && state.pending && [state.revision, state.pending].includes(active)) {
      const runtime = runtimeFactory(state.directory, run);
      runtimeGit('switch', '--detach', state.revision);
      runtime.reload(changedPaths(state.revision, state.pending));
      runtime.check();
      delete state.pending;
      save(state);
      return state;
    }
    if (command === 'recover' && !state.pending && active === state.revision) {
      runtimeFactory(state.directory, run).check();
      return state;
    }
    if (state.pending || active !== state.revision) {
      throw new Error('运行目录与最后一次成功的验收记录不同。请先核对现场并执行 recover。');
    }

    const branch = ['publish', 'verify'].includes(command) ? inRepo(cwd)('branch', '--show-current') : null;
    const revision = branch ? resolve('refs/heads/' + branch) : null;
    if (['publish', 'verify'].includes(command) && (!branch || branch === 'main')) {
      throw new Error('请在对应任务的独立分支工作目录中执行。');
    }
    if (command === 'publish' && revision !== validated) throw Error('开发验证后任务版本发生变化。');
    if (command === 'verify') {
      if (!state.tasks.some((task) => task.branch === branch && task.revision === revision)) {
        throw new Error('当前任务提交与 5274 的待验收版本不同。');
      }
      runtimeFactory(state.directory, run).check();
      return { branch, revision, preview: state.revision };
    }

    const main = resolve(mainRef);
    if (!ancestor(state.main, main)) throw new Error('origin/main 已分叉，请保留当前验收版本并核对主线。');
    let tasks = state.tasks.filter((task) => !ancestor(task.revision, main));
    if (command === 'publish') {
      if (ancestor(revision, main)) throw new Error('该提交已进入主线。');
      const previous = tasks.find((task) => task.branch === branch);
      if (previous && !ancestor(previous.revision, revision)) {
        throw new Error('修订版本需要保留这项任务原有的验收提交。');
      }
      for (const task of tasks) {
        if (task.branch !== branch && !ancestor(git('merge-base', revision, task.revision), main)) {
          throw new Error('任务分支包含与 ' + task.branch + ' 共用的未合并历史，请先隔离。');
        }
      }
      const update = { branch, revision };
      tasks = previous ? tasks.map((task) => task.branch === branch ? update : task) : [...tasks, update];
    }

    if (main === state.main && JSON.stringify(tasks) === JSON.stringify(state.tasks)) {
      runtimeFactory(state.directory, run).check();
      return state;
    }
    let combined = main;
    for (const task of tasks) {
      const args = ['merge-tree', '--write-tree', combined, task.revision];
      let tree;
      try {
        tree = git(...args);
      } catch (error) {
        throw new Error(task.branch + ' 无法合入 5274，保留上一个验收版本。\n' + error.message);
      }
      combined = git('commit-tree', tree, '-p', combined, '-p', task.revision, '-m', '5274: ' + task.branch);
    }

    const next = { ...state, main, revision: combined, tasks };
    const runtime = runtimeFactory(state.directory, run);
    const changed = changedPaths(state.revision, combined);
    runtime.prepare(state.revision, combined, changed);
    save({ ...state, pending: combined });
    try {
      runtimeGit('switch', '--detach', combined);
      runtime.reload(changed);
      runtime.check();
      save(next);
    } catch (error) {
      try {
        runtimeGit('switch', '--detach', state.revision);
        runtime.reload(changed);
        runtime.check();
        save(state);
      } catch (recovery) {
        throw new Error(error.message + '\n恢复上一个验收版本时失败：' + recovery.message);
      }
      throw new Error(error.message + '\n已恢复上一个验收版本。');
    }
    return next;
  } finally {
    rmdirSync(lockPath);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    console.log(JSON.stringify(acceptance(process.cwd(), command, args), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
