import { retryReleased } from './task-timing/resources.mjs';
import { EvidenceStore } from './quality/store.mjs';
import { stateFor } from './quality/assessment-store.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './acceptance-runtime.mjs';
import { published } from './quality-entry.mjs';
import { contextVariable, locked, measured, observe, observer, ready, rootFor } from './quality/timing-events.mjs';

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

function runAcceptance(cwd, command, argument, runtimeFactory = createRuntime, checkDevelopment = directory => {
  published(directory, ['dev']);
  const head=run(directory,'git',['rev-parse','HEAD']);
  const base=run(directory,'git',['rev-parse','refs/remotes/origin/main']);
  const common=realpathSync(run(directory,'git',['rev-parse','--path-format=absolute','--git-common-dir']));
  const report=new EvidenceStore(common).report('dev',{head,base});
  if (report?.status!=='passed' || report.tree!==run(directory,'git',['rev-parse','HEAD^{tree}']))
    throw Error('5274 缺少当前源码树的开发验证回执');
  if (report.standard!=='V1.2') return;
  const ctx=observer(common,directory);
  if (!report.assessments?.length || (ctx && ctx.ids.some(id=>!report.assessments.some(t=>t.id===id))))
    throw Error('5274 缺少当前任务的判级，请按实际时点补评并通知');
  return { tree: report.tree, base, planId: report.planId, run: report.run, assessments: report.assessments };
}) {
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
  let validated, evidence;
  if (command === 'publish') {
    const taskGit = inRepo(cwd);
    validated = taskGit('rev-parse', 'HEAD');
    if (!taskGit('branch','--show-current') || taskGit('branch','--show-current') === 'main') throw Error('请在任务分支发布。');
    evidence=checkDevelopment(cwd);
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
    const checkPublishedEvidence = () => {
      if (
        evidence.base !== resolve(mainRef) ||
        resolve('refs/heads/' + branch) !== revision ||
        evidence.tree !== git('rev-parse', revision + '^{tree}') ||
        evidence.assessments.some(task => stateFor(commonDir, task.id)?.history.at(-1)?.revision !== task.revision)
      ) throw Error('5274 的目标主线、源码树或任务复核版本已变化，请重新验证');
    };
    const verifyReceipt = receipt => {
      const store = new EvidenceStore(commonDir);
      const proof = /^\d{13}-[\da-f-]+$/.test(receipt.run || '') &&
        store.read(join(store.root, 'runs', receipt.run + '.json'));
      if (
        !proof || proof.run !== receipt.run || proof.status !== 'passed' || proof.phase !== 'dev' ||
        proof.standard !== 'V1.2' || proof.head !== revision || proof.tree !== receipt.tree ||
        proof.tree !== git('rev-parse', revision + '^{tree}') || proof.base !== receipt.base ||
        proof.planId !== receipt.planId || JSON.stringify(proof.assessments) !== JSON.stringify(receipt.assessments) ||
        !proof.planned?.length || proof.pending?.length ||
        JSON.stringify(proof.results.map(row => row.id)) !== JSON.stringify(proof.planned) ||
        ![...proof.results, ...(proof.inherited || [])].every(row => store.intact(row))
      ) throw Error('5274 已登记的源码树与原始开发证据不符');
    };
    const commitPublication = action => {
      if (!evidence) return action();
      verifyReceipt(evidence);
      return locked(rootFor(commonDir), () => {
        checkPublishedEvidence();
        return action();
      });
    };
    if (evidence) checkPublishedEvidence();
    if (command === 'verify') {
      const recorded = state.tasks.find(task => task.branch === branch && task.revision === revision);
      if (!recorded) {
        throw new Error('当前任务提交与 5274 的待验收版本不同。');
      }
      runtimeFactory(state.directory, run).check();
      if (recorded.evidence) verifyReceipt(recorded.evidence);
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
      const update = evidence ? {branch,revision,evidence} : {branch,revision};
      tasks = previous ? tasks.map((task) => task.branch === branch ? update : task) : [...tasks, update];
    }

    const collectAfterHandoff = (runtime, active, previous) => {
      // Runtime and publication have already succeeded. A failed eviction is retried on the next handoff.
      try { runtime.collectDependencies?.(active,previous); }
      catch (error) { console.error('5274 依赖回收待重试：'+error.message); }
      try { retryReleased(commonDir); }
      catch (error) { console.error('退役任务资源回收待重试：'+error.message); }
    };
    if (main === state.main && JSON.stringify(tasks) === JSON.stringify(state.tasks)) {
      const runtime=runtimeFactory(state.directory, run);
      runtime.check();
      const result=commitPublication(() => state);
      collectAfterHandoff(runtime,state);
      return result;
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
      commitPublication(() => save(next));
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
    collectAfterHandoff(runtime,next,state.revision);
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
