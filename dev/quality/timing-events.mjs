import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const contextVariable = 'ZDM_QUALITY_TIMING_CONTEXT';
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const rootFor = (common) => join(common, 'zdm-tasks');
export function time(value) {
  const stamp =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value)
        ? Date.parse(value)
        : NaN;
  if (!Number.isSafeInteger(stamp) || stamp <= 0 || stamp > Date.now())
    throw Error('需要真实、已发生的带时区事件时间');
  return stamp;
}
export function label(value, name = '字段') {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\x00-\x1f\x7f]/.test(value))
    throw Error(name + ' 应为一行非空文本');
  return value.trim();
}
export function numberId(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{3,15}$/.test(value) ||
    Number(value) < 1 ||
    String(Number(value)).padStart(3, '0') !== value
  )
    throw Error('任务编号格式无效');
  return value;
}
export function read(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
// Publish a whole record atomically. A replay can never replace the first event.
export function writeJson(directory, name, data, { replace = false, observedNow = false } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  const temporary = join(directory, '.' + randomUUID() + '.tmp');
  writeFileSync(temporary, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    if (replace) {
      renameSync(temporary, path);
      return data;
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = read(path);
      const replay = observedNow && previous ? { ...data, at: previous.at } : data;
      if (!isDeepStrictEqual(previous, JSON.parse(JSON.stringify(replay))))
        throw Error('原始计时记录冲突，已保留首条记录');
      return previous;
    }
    return data;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function activated(root) {
  const activation = read(join(root, 'activation.json'));
  if (!activation) return null;
  time(activation.at);
  if (activation.version !== 1 || !/^[0-9a-f]{40}$/.test(activation.commit))
    throw Error('交付启用记录损坏');
  return activation;
}
export function taskRecord(root, id, activation = activated(root)) {
  const task = read(join(root, numberId(id), 'task.json'));
  if (
    !activation ||
    !task ||
    task.id !== id ||
    task.activation !== activation.commit ||
    time(task.originalAt) <= activation.at
  )
    throw Error('缺少交付后新交办任务的登记 ' + id);
  return task;
}
export function bound(common, ids, round) {
  const root = rootFor(common);
  const activation = activated(root);
  if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw Error('需要明确关联任务');
  const tasks = [...new Set(ids.map(numberId))].sort().map((id) => taskRecord(root, id, activation));
  const ctx = { root, common, ids: tasks.map((t) => t.id), tasks };
  if (round) {
    if (tasks.length !== 1) throw Error('返工轮次只能绑定到一个任务');
    const started = eventById(ctx, label(round), 'start');
    if (!started?.stage.startsWith('rework:') || eventById(ctx, round, 'end'))
      throw Error('返工轮次未开始或已结束');
    ctx.round = round;
  }
  return ctx;
}
function location(ctx, id, kind) {
  const directory =
    ctx.ids.length === 1 ? join(ctx.root, ctx.ids[0], 'events') : join(ctx.root, 'shared');
  return [directory, digest(label(id, '执行号') + '\n' + kind) + '.json'];
}
export function eventById(ctx, id, kind) {
  return read(join(...location(ctx, id, kind)));
}
export function event(ctx, kind, id, stage, fields = {}) {
  const at = time(fields.at ?? Date.now());
  if (ctx.tasks.some((t) => at < t.originalAt)) throw Error('事件早于原任务');
  const [directory, name] = location(ctx, id, kind);
  const row = { ...fields, id, kind, stage, at, tasks: ctx.ids };
  if (ctx.round && !row.round) row.round = ctx.round;
  return writeJson(directory, name, row, { observedNow: fields.at === undefined });
}
export function finish(ctx, id, status, fields = {}) {
  const start = eventById(ctx, id, 'start');
  if (!start || !isDeepStrictEqual(start.tasks, ctx.ids)) throw Error('找不到该任务执行的开始记录');
  if (time(fields.at ?? Date.now()) < start.at) throw Error('结束早于开始');
  return event(ctx, 'end', id, start.stage, {
    ...(start.round ? { round: start.round } : {}),
    ...fields,
    status,
  });
}
export function observe(fn, ctx, source) {
  try {
    return fn();
  } catch (error) {
    process.stderr.write('任务计时记录未完成：' + error.message + '\n');
    if (ctx && source) {
      try {
        event(ctx, 'mark', 'collection:' + randomUUID(), 'collection-gap', {
          ref: source,
          code: error.code || 'UNRECORDED',
        });
      } catch {
        // A failed or read-only store can still be diagnosed from the command's stderr.
      }
    }
    return null;
  }
}
export function observer(common, cwd) {
  const raw = process.env[contextVariable];
  if (!raw) return null;
  return observe(() => {
    const hints = JSON.parse(raw);
    if (
      hints.common !== common ||
      !cwd ||
      !hints.workspace ||
      realpathSync(hints.workspace) !== realpathSync(cwd)
    )
      return null;
    return bound(common, hints.ids, hints.round);
  });
}
export function measured(ctx, stage, work, after, metadata = {}) {
  if (!ctx) return work();
  const id = randomUUID();
  observe(() => event(ctx, 'start', id, stage, metadata), ctx, id);
  try {
    const result = work();
    observe(() => finish(ctx, id, 'passed'), ctx, id);
    if (after) observe(() => after(result, id), ctx, id);
    return result;
  } catch (error) {
    observe(() => finish(ctx, id, 'failed'), ctx, id);
    throw error;
  }
}
export function ready(ctx, stage, revision, ref) {
  if (ctx.tasks.length !== 1) return;
  const type = ctx.tasks[0].type;
  if ((stage === 'ready' && type === 'business') || (stage === 'verified' && type === 'engineering'))
    event(ctx, 'mark', stage + ':' + ref, stage, { revision, ref });
  if (!ctx.round || eventById(ctx, ctx.round, 'end')) return;
  const round = eventById(ctx, ctx.round, 'start');
  if (
    (stage === 'ready' && type === 'business') ||
    (stage === 'verified' && round?.stage === 'rework:validation')
  )
    finish(ctx, ctx.round, 'passed', { revision, ref });
}
