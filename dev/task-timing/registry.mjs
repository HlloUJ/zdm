import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  activated,
  bound,
  digest,
  event,
  eventById,
  finish,
  label,
  numberId,
  read,
  rootFor,
  taskRecord,
  time,
  writeJson,
} from '../quality/timing-events.mjs';

const require = createRequire(import.meta.url);
export const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const commonFor = (cwd) =>
  realpathSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
export const fullName = (task) => task.id + ' ' + task.name;
export const phases = [
  'prepare',
  'dependencies',
  'development',
  'validation',
  'publish',
  'delivery',
  'push',
  'pr',
  'ci',
  'merge',
  'handoff',
  'cleanup',
];
export const reasons = ['user', 'ci', 'resource', 'dependency', 'approval', 'delivery'];
export const results = ['passed', 'failed', 'cancelled', 'interrupted', 'reused', 'incomplete'];
export const marks = [
  'started',
  'paused',
  'resumed',
  'notified',
  'feedback',
  'delivery-request',
  'scope-added',
  'closed',
  'cancelled',
];
export function oneOf(value, values, field) {
  if (!values.includes(value)) throw Error('无效的' + field + '：' + value);
  return value;
}
export function revision(value) {
  if (!/^[a-f0-9]{40}$/.test(value || '')) throw Error('需要完整 Git 提交');
  return value;
}
export function numbered(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{3,15}$/.test(e.name))
    .map((e) => numberId(e.name))
    .sort((a, b) => Number(a) - Number(b));
}
export function tasks(root) {
  const activation = activated(root);
  if (!activation) return [];
  return numbered(root)
    .filter((id) => existsSync(join(root, id, 'task.json')))
    .map((id) => taskRecord(root, id, activation));
}
// SQLite holds only the inter-process write lock. The OS releases it if the writer dies.
// Numbered task files and immutable event files are the portable source of truth.
export function locked(root, work) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(join(root, 'writer.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=15000; BEGIN IMMEDIATE');
    const result = work();
    db.exec('COMMIT');
    return result;
  } finally {
    db.close();
  }
}
export function activate(cwd, receipt, verifyRemote) {
  const common = commonFor(cwd);
  const root = rootFor(common);
  const commit = revision(receipt.commit);
  const previous = activated(root);
  if (previous) {
    if (previous.commit !== commit) throw Error('已有正式交付界线');
    return previous;
  }
  const head = git(cwd, 'rev-parse', 'HEAD');
  if (git(cwd, 'branch', '--show-current') !== 'main' || head !== git(cwd, 'rev-parse', 'origin/main'))
    throw Error('请在已同步的主线完成交接后启用');
  git(cwd, 'merge-base', '--is-ancestor', commit, head);
  git(cwd, 'cat-file', '-e', commit + ':dev/task-timing.mjs');
  if (git(cwd, 'ls-tree', '--name-only', commit + '^1', '--', 'dev/task-timing.mjs'))
    throw Error('需要首次交付计时器的主线提交');
  const state = read(join(common, 'zdm-acceptance.json'));
  if (
    !state ||
    state.pending ||
    state.main !== head ||
    git(state.directory, 'rev-parse', 'HEAD') !== state.revision
  )
    throw Error('5274 尚未完成当前主线交接');
  const lastNumber = receipt.lastNumber ?? 0;
  if (!Number.isSafeInteger(lastNumber) || lastNumber < 0 || lastNumber >= 1e15 - 1)
    throw Error('发号进度无效');
  const proof = verifyRemote(commit, receipt);
  return locked(root, () => {
    const existing = activated(root);
    if (existing) {
      if (existing.commit !== commit) throw Error('启用冲突');
      return existing;
    }
    return writeJson(root, 'activation.json', {
      version: 1,
      at: Date.now(),
      commit,
      ...proof,
      handoff: state.revision,
      lastNumber,
    });
  });
}
function nativeTime(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  return time(parseInt(id.slice(0, 8) + id.slice(9, 13), 16));
}
export function source(original) {
  if (!original || !['assignment', 'todo'].includes(original.kind))
    throw Error('需要最初的新交办或待办来源');
  const thread = label(original.thread, '来源对话');
  const turn = label(original.turn, '交办轮次');
  const message = label(original.message, '原始交办记录');
  const item = label(original.item ?? '1', '原指令中的具体任务项');
  const recorded = original.at == null ? null : time(original.at);
  const messageTime = nativeTime(message);
  const primaryTimes = [recorded, messageTime].filter((v) => v != null);
  const primary = primaryTimes.length ? Math.min(...primaryTimes) : null;
  const assignedAt = original.kind === 'assignment' ? primary : null;
  const todoTimes = [
    original.kind === 'todo' ? primary : null,
    original.todoAt == null ? null : time(original.todoAt),
  ].filter((v) => v != null);
  const todoAt = todoTimes.length ? Math.min(...todoTimes) : null;
  const times = [assignedAt, todoAt].filter((v) => v != null);
  if (!times.length) throw Error('缺少原始交办或建单时间，不能用登记时间代替');
  return {
    thread,
    turn,
    message,
    item,
    kind: original.kind,
    assignedAt,
    todoAt,
    at: Math.min(...times),
  };
}
export const sourceKey = (origin) =>
  digest(JSON.stringify([origin.thread, origin.turn, origin.message, origin.item]));
export function register(common, request) {
  const root = rootFor(common);
  const activation = activated(root);
  if (!activation) return { eligible: false, reason: '尚未正式交付启用' };
  const original = source(request.original);
  if (original.at <= activation.at) return { eligible: false, reason: '正式交付前已存在' };
  const key = sourceKey(original);
  const name = label(request.name, '任务原名');
  const type = oneOf(request.type, ['business', 'engineering'], '任务类型');
  return locked(root, () => {
    const existing = tasks(root).find((t) => t.sourceKey === key);
    if (existing) return { eligible: true, task: existing, fullName: fullName(existing) };
    const related = request.relatedTask
      ? taskRecord(root, numberId(request.relatedTask), activation).id
      : null;
    const last = Math.max(activation.lastNumber, Number(numbered(root).at(-1) || 0));
    const id = numberId(String(last + 1).padStart(3, '0'));
    const task = {
      id,
      name,
      type,
      ...(request.batch ? { batch: label(request.batch) } : {}),
      ...(related ? { relatedTask: related } : {}),
      original,
      originalAt: original.at,
      sourceKey: key,
      activation: activation.commit,
      registeredAt: Date.now(),
      status: 'registered',
      pullRequests: [],
    };
    writeJson(join(root, id), 'task.json', task);
    return { eligible: true, task, fullName: fullName(task) };
  });
}
export function update(common, id, transform) {
  const root = rootFor(common);
  return locked(root, () => {
    const task = taskRecord(root, id);
    const next = transform(task);
    return writeJson(join(root, id), 'task.json', next, { replace: true });
  });
}
export function rename(common, id, name) {
  const task = update(common, id, (t) => ({ ...t, name: label(name, '任务原名') }));
  return { task, fullName: fullName(task) };
}
export function mark(common, id, data) {
  const ctx = bound(common, [id]);
  const stage = oneOf(data.stage, marks, '任务节点');
  const ref = label(data.ref, '原始事件来源');
  const fields = { ref };
  if (stage !== 'started' || data.at != null) fields.at = time(data.at);
  if (data.revision) fields.revision = revision(data.revision);
  if (['feedback', 'notified'].includes(stage) && !fields.revision)
    throw Error('验收通知和反馈需要指定版本');
  const key = stage + ':' + ref;
  const row = event(ctx, 'mark', key, stage, fields);
  if (stage === 'scope-added') return row;
  const state = {
    started: 'active',
    resumed: 'active',
    paused: 'paused',
    notified: 'review',
    feedback: 'feedback',
    'delivery-request': 'delivery',
    closed: 'closed',
    cancelled: 'cancelled',
  }[stage];
  update(common, id, (t) => (t.stateAt > row.at ? t : { ...t, status: state, stateAt: row.at }));
  return row;
}
export function manualStart(common, ids, data) {
  const ctx = bound(common, ids, data.round);
  const id = label(data.key, '来源执行号');
  const stage = label(data.stage);
  const allowed = [
    ...phases,
    ...reasons.map((r) => 'wait:' + r),
    ...reasons.map((r) => 'blocked:' + r),
    'rework:feedback',
    'rework:validation',
  ];
  oneOf(stage, allowed, '执行阶段');
  const fields = { ref: label(data.ref, '来源') };
  if (data.at != null) fields.at = time(data.at);
  if (data.revision) fields.revision = revision(data.revision);
  if (stage.startsWith('blocked:')) {
    const waiting = eventById(ctx, label(data.wait, '关联等待号'), 'start');
    if (
      !waiting ||
      waiting.stage !== stage.replace('blocked:', 'wait:') ||
      waiting.at > (fields.at ?? Date.now())
    )
      throw Error('实际阻塞需要同任务同原因的等待记录');
    fields.wait = waiting.id;
  }
  return event(ctx, 'start', id, stage, fields);
}
export function manualEnd(common, ids, data) {
  const ctx = bound(common, ids);
  return finish(ctx, label(data.key), oneOf(data.status, results, '执行结果'), {
    ref: label(data.ref),
    ...(data.at == null ? {} : { at: time(data.at) }),
  });
}
export function retryCause(common, id, data) {
  const ctx = bound(common, [id]);
  const previous = eventById(ctx, label(data.previous), 'start');
  const current = eventById(ctx, label(data.attempt), 'start');
  const failure = eventById(ctx, label(data.previous), 'end');
  if (
    !previous ||
    !current ||
    failure?.status !== 'failed' ||
    current.at < failure.at ||
    previous.check ||
    current.check ||
    previous.stage !== 'validation' ||
    current.stage !== 'validation' ||
    !previous.tree ||
    previous.tree !== current.tree ||
    previous.revision !== current.revision ||
    previous.phase !== current.phase ||
    JSON.stringify(previous.scope) !== JSON.stringify(current.scope)
  )
    throw Error('重跑需要同一版本与检查范围的失败和后续尝试');
  return event(ctx, 'mark', 'retry-cause:' + current.id, 'retry-cause', {
    previous: previous.id,
    attempt: current.id,
    cause: oneOf(data.cause, ['environment', 'unknown'], '重跑归因'),
    ref: label(data.ref),
    at: time(data.at),
  });
}
export function unassigned(common, data) {
  const root = rootFor(common);
  const active = activated(root);
  if (!active) return { eligible: false };
  const original = source(data.original);
  if (original.at <= active.at) return { eligible: false };
  const key = label(data.key);
  const row = {
    kind: 'unassigned',
    keyHash: digest(key),
    original,
    sourceKey: sourceKey(original),
    ref: label(data.ref),
    stage: label(data.stage),
    at: time(data.at),
  };
  if (row.at < original.at) throw Error('事件早于原始交办');
  return writeJson(join(root, 'unassigned'), digest(key) + '.json', row);
}
export function resolveEvent(common, id, key) {
  const ctx = bound(common, [id]);
  const hash = digest(label(key));
  const evidence = read(join(ctx.root, 'unassigned', hash + '.json'));
  if (
    !evidence ||
    evidence.sourceKey !== ctx.tasks[0].sourceKey ||
    evidence.original.at !== ctx.tasks[0].originalAt
  )
    throw Error('来源不能唯一对应到此任务');
  event(ctx, 'mark', 'recovered:' + hash, 'observation', {
    at: evidence.at,
    ref: evidence.ref,
    detail: evidence.stage,
  });
  return writeJson(join(ctx.root, 'unassigned', 'resolved'), hash + '.json', { id, ref: evidence.ref });
}
