import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  activated,
  bound,
  label,
  contextVariable,
  measured,
  observe,
  rootFor,
  taskRecord,
  time,
} from './quality/timing-events.mjs';
import {
  activate,
  commonFor,
  fullName,
  git,
  manualEnd,
  manualStart,
  mark,
  oneOf,
  phases,
  register,
  rename,
  resolveEvent,
  retryCause,
  unassigned,
  update,
} from './task-timing/registry.mjs';
import { bindEnvironment, collectResources, otherOwner, registerCopy, resourceStatus, retryReleased, scratch, temporaryFile, temporaryVolume } from './task-timing/resources.mjs';
import { managedRepository } from './task-timing/resource-host.mjs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bindPr, collect, github, releaseProof, syncPr } from './task-timing/github.mjs';
import { report, summary } from './task-timing/report.mjs';

function json(input) {
  if (!input) throw Error('需要 JSON 参数，传 - 可从标准输入读取');
  return JSON.parse(input === '-' ? readFileSync(0, 'utf8') : input);
}
function startTask(common, task) {
  const ref = 'start/' + task.sourceKey;
  mark(common, task.id, { stage: 'started', ref });
  const updated = taskRecord(rootFor(common), task.id);
  return { eligible: true, task: updated, fullName: fullName(updated) };
}
function execute(cwd, common, command, args) {
  const [id, ...rest] = args;
  const separator = rest.indexOf('--');
  if (separator < 0 || !rest[separator + 1]) throw Error('用 -- 分隔实际命令与参数');
  const config = rest.slice(0, separator);
  const stage = command === 'measure' ? oneOf(config.shift(), phases, '执行阶段') : null;
  let round;
  if (config.length) {
    if (config.length !== 2 || config[0] !== '--round') throw Error('可选参数为 --round 轮次执行号');
    round = config[1];
  }
  const ctx = observe(() => bound(common, id.split(','), round));
  const env = { ...process.env };
  delete env[contextVariable];
  if (ctx) {
    env[contextVariable] = JSON.stringify({ common, workspace: realpathSync(cwd), ids: ctx.ids, round });
    observe(() => {
      const path = realpathSync(cwd);
      const branch = git(cwd, 'branch', '--show-current');
      for (const t of ctx.tasks) {
        if (t.workspaces?.some((w) => w.path === path && w.branch === branch)) continue;
        update(common, t.id, (current) => {
          const workspaces = current.workspaces || [];
          return workspaces.some((w) => w.path === path && w.branch === branch)
            ? current
            : { ...current, workspaces: [...workspaces, { path, branch }] };
        });
      }
    });
  }
  if (ctx?.ids.length === 1 && realpathSync(cwd) !== dirname(common) && managedRepository(cwd) &&
      !['closed','cancelled'].includes(ctx.tasks[0].status) &&
      !otherOwner(common,ctx.ids[0],realpathSync(cwd)) &&
      realpathSync(cwd) === realpathSync(git(cwd,'rev-parse','--show-toplevel')) &&
      git(cwd,'branch','--show-current') && git(cwd,'branch','--show-current') !== 'main') {
    const taskId = ctx.ids[0];
    env.ZDM_TASK_TMPDIR = scratch(common,taskId,cwd);
    env.TMPDIR = env.TMP = env.TEMP = env.ZDM_TASK_TMPDIR;
    const path=join(cwd,'.private','resource-environment.json');
    if (existsSync(path)) {
      const e=JSON.parse(readFileSync(path,'utf8'));
      if (e.workspace===realpathSync(cwd) && !resourceStatus(common,taskId)?.environment?.engine &&
          readFileSync(join(cwd,'.env'),'utf8').split(/\r?\n/).includes('COMPOSE_PROJECT_NAME='+e.project))
        bindEnvironment(common,taskId,cwd,e.project,e.at,e.engine);
    }
  }
  const run = () => {
    const child = spawnSync(rest[separator + 1], rest.slice(separator + 2), {
      cwd,
      env,
      stdio: 'inherit',
    });
    if (child.error || child.signal || child.status !== 0) {
      const error = Error(child.error?.message || '命令结束：' + (child.signal || child.status));
      error.exitCode =
        child.status ??
        (child.signal
          ? 128 + (constants.signals[child.signal] || 0)
          : child.error?.code === 'ENOENT'
            ? 127
            : 1);
      throw error;
    }
  };
  return stage ? measured(ctx, stage, run) : run();
}
function duration(ms) {
  if (ms == null) return '未知';
  if (ms < 1000) return ms + ' 毫秒';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' 秒';
  return (ms / 60000).toFixed(1) + ' 分钟';
}
function display(result) {
  if (result.fullName) {
    const pieces = [
      result.fullName + '（' + result.status + '）',
      (result.type === 'business' ? '首次可验收 ' : '首次验证就绪 ') + duration(result.firstReadyMs),
      '完整交付 ' + duration(result.deliveryMs),
      result.assignedToStartMs != null
        ? '交办至开工 ' + duration(result.assignedToStartMs)
        : '待办至开工 ' + duration(result.todoToStartMs),
      '观察到的执行 ' + duration(result.observedWorkMs),
      '已结束的等待 ' +
        duration(result.waitingMs) +
        '，实际受阻 ' +
        duration(result.blockedMs) +
        '，最长 ' +
        duration(result.longestBlockMs),
      '返工 ' + result.rounds.length + ' 轮，未归因 ' + duration(result.unknownMs),
    ];
    if (result.assessment) {
      const a=result.assessment;
      pieces.push('开工 '+a.initial.whole+'，整项 '+a.current.whole+'，本轮 '+a.current.round+'，待发 '+a.pending.length+' 项');
      for (const h of a.history) pieces.push('判级修订 '+h.revision+' '+h.kind+' '+h.whole+'/'+h.round+' '+h.reason);
    }
    for (const [stage, ms] of Object.entries(result.stageMs)) pieces.push(stage + ' ' + duration(ms));
    for (const r of result.rounds)
      pieces.push(
        '返工 ' +
          r.id +
          '  ' +
          duration(r.wallMs) +
          '，验证 ' +
          r.validationAttempts +
          ' 次' +
          (r.feedbackToStartMs == null ? '' : '，反馈至开始处理 ' + duration(r.feedbackToStartMs)),
      );
    if (result.scopeChanges.length) pieces.push('新增范围 ' + result.scopeChanges.length + ' 次');
    if (result.notApplicable.length) pieces.push('不适用  ' + result.notApplicable.join('、'));
    for (const r of result.retries)
      pieces.push('重跑 ' + r.attempt + '  ' + (r.cause === 'environment' ? '环境原因' : '原因待核'));
    for (const item of result.pending)
      pieces.push(
        '截至查询仍缺结束记录 ' + item.stage + ' ' + item.id + '，观察窗口 ' + duration(item.observedMs),
      );
    for (const issue of result.issues) pieces.push('记录提示 ' + issue);
    return pieces.join('\n');
  }
  if (!result.active) return '计时器尚未正式启用。';
  return [
    '同类任务 ' + result.count + ' 项',
    '首次就绪中位数 ' + duration(result.firstReadyMedianMs) + '（' + result.readySamples + ' 个样本）',
    '完整交付中位数 ' + duration(result.deliveryMedianMs) + '（' + result.deliverySamples + ' 个样本）',
    '首次开发验证通过率 ' +
      (result.firstDevPassRate == null ? '未知' : (result.firstDevPassRate * 100).toFixed(0) + '%') +
      '，返工 ' +
      result.reworkRounds +
      ' 轮',
    '记录覆盖率中位数 ' +
      (result.medianCoverage == null ? '未知' : (result.medianCoverage * 100).toFixed(0) + '%'),
    ...result.tasks.map(
      (t) =>
        t.fullName +
        '  ' +
        t.status +
        '  ' +
        (t.type === 'engineering' ? '工程' : '业务') +
        (t.risks.length ? ' ' + t.risks.join('/') : '') +
        '  完整交付 ' +
        duration(t.deliveryMs) +
        '，受阻 ' +
        duration(t.blockedMs) +
        '，返工 ' +
        t.rounds +
        ' 轮',
    ),
    ...result.issues,
    ...(result.unassigned.length ? ['待归属 ' + result.unassigned.length + ' 笔'] : []),
  ].join('\n');
}
export function main(argv, cwd = process.cwd()) {
  const [command, ...args] = argv;
  const [id, arg, extra] = args;
  const common = commonFor(cwd),
    root = rootFor(common);
  switch (command) {
    case 'status':
      return { activation: activated(root) };
    case 'activate':
      return activate(cwd, json(id), (commit, receipt) => releaseProof(github(cwd), commit, receipt));
    case 'register':
      return register(common, json(id));
    case 'start': {
      if (/^\d+$/.test(id)) return startTask(common, taskRecord(root, id));
      const result = register(common, json(id));
      return result.eligible ? startTask(common, result.task) : result;
    }
    case 'rename':
      return rename(common, id, arg);
    case 'scratch':
      return scratch(common,id,cwd);
    case 'temp-file':
      return temporaryFile(common,id,cwd,arg);
    case 'test-volume':
      return temporaryVolume(common,id,cwd,arg);
    case 'resource-copy':
      return registerCopy(common,id,cwd,json(arg));
    case 'resources':
      return resourceStatus(common,id);
    case 'retry-cleanup':
      if (!resourceStatus(common,id)?.requested) throw Error('尚无已交付的回收请求');
      return collectResources(common,id);
    case 'mark': {
      const data=json(arg);
      if (data.stage!=='closed') return mark(common,id,data);
      if (!resourceStatus(common,id)) {
        const row=mark(common,id,data);
        if (managedRepository(cwd)) retryReleased(common,id);
        return row;
      }
      const task=taskRecord(root,id);
      label(data.ref,'原始事件来源');
      if(time(data.at)<task.originalAt || time(data.at)<(task.stateAt??0)) throw Error('结项时间早于任务当前状态');
      if (data.revision && !/^[a-f0-9]{40}$/.test(data.revision)) throw Error('需要完整 Git 提交');
      const cleanup=collectResources(common,id);
      const row=mark(common,id,data);
      retryReleased(common,id);
      return cleanup ? {...row,cleanup} : row;
    }
    case 'begin':
      return manualStart(common, id.split(','), json(arg));
    case 'end':
      return manualEnd(common, id.split(','), json(arg));
    case 'unassigned':
      return unassigned(common, json(id));
    case 'resolve':
      return resolveEvent(common, id, arg);
    case 'retry-cause':
      return retryCause(common, id, json(arg));
    case 'exec':
    case 'measure':
      return execute(cwd, common, command, args);
    case 'link-pr':
      return bindPr(cwd, id, arg, extra || git(cwd, 'rev-parse', 'HEAD'));
    case 'sync-pr':
      return syncPr(cwd, id);
    case 'report': {
      const task = taskRecord(root, id);
      let remote;
      if (args.includes('--live') && task.pullRequests.length) {
        try {
          remote = collect(task, github(cwd));
        } catch (error) {
          remote = { gaps: [error.message] };
        }
      }
      const output = report(common, id, { remote: remote?.events, gaps: remote?.gaps });
      return args.includes('--json') ? output : display(output);
    }
    case 'summary': {
      const filters = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--json') continue;
        const key = args[i].slice(2);
        if (
          !['type', 'batch', 'risk', 'scope', 'from', 'to'].includes(key) ||
          !args[i].startsWith('--') ||
          !args[i + 1]
        )
          throw Error('汇总筛选参数无效');
        const value = args[++i];
        filters[key] = ['from', 'to'].includes(key) ? time(value) : value;
      }
      const output = summary(common, filters);
      return args.includes('--json') ? output : display(output);
    }
    default:
      throw Error(
        '命令：status, activate, register, start, rename, exec, measure, mark, begin, end, link-pr, sync-pr, report, summary, unassigned, resolve, scratch, temp-file, resource-copy, test-volume, resources, retry-cleanup',
      );
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = main(process.argv.slice(2));
    if (result !== undefined)
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = error.exitCode || 1;
  }
}
