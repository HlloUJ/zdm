import { stateFor, view } from '../quality/assessment-store.mjs';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { activated, read, rootFor, taskRecord } from '../quality/timing-events.mjs';
import { fullName, numbered, phases } from './registry.mjs';

function files(directory, gaps) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      result.push(read(join(directory, name)));
    } catch {
      gaps.push('记录不可读 ' + name);
    }
  }
  return result.filter(Boolean);
}
export function union(intervals) {
  const result = [];
  for (const [start, end] of intervals.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const previous = result.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else result.push([start, end]);
  }
  return result;
}
const length = (intervals) => union(intervals).reduce((sum, [a, b]) => sum + b - a, 0);
function intersections(a, b) {
  const left = union(a),
    right = union(b),
    result = [];
  let i = 0,
    j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i][0], right[j][0]),
      end = Math.min(left[i][1], right[j][1]);
    if (end > start) result.push([start, end]);
    if (left[i][1] < right[j][1]) i++;
    else j++;
  }
  return result;
}
function subtract(source, other) {
  const remaining = [];
  const gaps = union(other);
  for (const [start, end] of union(source)) {
    let cursor = start;
    for (const [a, b] of gaps) {
      if (a >= end) break;
      if (b <= cursor) continue;
      if (a > cursor) remaining.push([cursor, Math.min(a, end)]);
      cursor = Math.max(cursor, b);
      if (cursor >= end) break;
    }
    if (cursor < end) remaining.push([cursor, end]);
  }
  return remaining;
}
function userWaits(marks, issues) {
  const open = new Map(),
    spans = [];
  for (const mark of marks) {
    if (mark.stage === 'notified' && !open.has(mark.revision)) open.set(mark.revision, mark);
    if (!['feedback', 'delivery-request'].includes(mark.stage)) continue;
    const version = mark.revision ?? (open.size === 1 ? open.keys().next().value : null);
    const start = open.get(version);
    if (!start) {
      if (mark.stage === 'feedback' || open.size)
        issues.push('反馈或交付指令缺少匹配的验收通知 ' + mark.ref);
      continue;
    }
    spans.push({
      id: start.id,
      stage: 'wait:user',
      at: start.at,
      end: mark.at,
      status: 'passed',
      revision: version,
      ref: start.ref,
    });
    open.delete(version);
  }
  return { spans, open: [...open.values()] };
}
function indexEvents(task, events, now, issues) {
  const byKey = new Map();
  for (const row of events) {
    if (
      !['start', 'end', 'mark'].includes(row.kind) ||
      !Number.isSafeInteger(row.at) ||
      row.at < task.originalAt ||
      row.at > now ||
      !row.id ||
      !row.stage
    ) {
      issues.push('计时记录缺少有效身份或时刻');
      continue;
    }
    const key = row.kind + '/' + row.id;
    const prev = byKey.get(key);
    if (prev && (prev.at !== row.at || prev.stage !== row.stage || prev.status !== row.status)) {
      issues.push('同一事件来源冲突 ' + row.id);
      continue;
    }
    byKey.set(key, row);
  }
  const rows = [...byKey.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const marks = rows.filter((r) => r.kind === 'mark');
  const waits = userWaits(marks, issues);
  const interrupted = [];
  const spans = [...waits.spans],
    open = waits.open.map((r) => ({ ...r, stage: 'wait:user' }));
  for (const start of rows.filter((r) => r.kind === 'start')) {
    const end = byKey.get('end/' + start.id);
    if (!end) {
      open.push(start);
      continue;
    }
    if (end.at < start.at || end.stage !== start.stage) {
      issues.push('起止不一致 ' + start.id);
      continue;
    }
    if (end.status === 'interrupted') {
      interrupted.push({ ...start, interruptionObservedAt: end.at, interruptionRef: end.ref });
      issues.push('中断，结束时间未知 ' + start.id);
      continue;
    }
    spans.push({ ...start, end: end.at, status: end.status, sourceRun: end.sourceRun, endRef: end.ref });
  }
  for (const end of rows.filter((r) => r.kind === 'end'))
    if (!byKey.has('start/' + end.id)) issues.push('缺少开始事件 ' + end.id);
  return { spans: spans.sort((a, b) => a.at - b.at), open, interrupted, marks, rows };
}
export function unresolved(root, activation, issues) {
  return files(join(root, 'unassigned'), issues).filter(
    (r) =>
      r.original?.at > activation.at &&
      !existsSync(join(root, 'unassigned', 'resolved', r.keyHash + '.json')),
  );
}
export function report(common, id, options = {}) {
  const root = rootFor(common),
    activation = activated(root);
  const task = taskRecord(root, id, activation),
    now = options.now ?? Date.now(),
    issues = [...(options.gaps || [])];
  const shared = options.shared ?? files(join(root, 'shared'), issues);
  const belongs = (r) =>
    r.tasks?.includes(id) || task.pullRequests.some((p) => p.number === r.pr && p.head === r.head);
  const events = [
    ...files(join(root, id, 'events'), issues),
    ...shared.filter(belongs),
    ...(options.remote || []).filter(belongs),
  ];
  const { spans, open, interrupted, marks, rows } = indexEvents(task, events, now, issues);
  const first = (stage) => marks.find((m) => m.stage === stage);
  const start = first('started')?.at ?? null,
    close = first('closed')?.at ?? null;
  const ready = first(task.type === 'business' ? 'ready' : 'verified')?.at ?? null;
  const until = close ?? first('cancelled')?.at ?? now;
  const window = start != null && until >= start ? [[start, until]] : [];
  const within = (range) => (window.length ? intersections(range, window) : union(range));
  const ranges = (values) => values.map((s) => [s.at, s.end]);
  const work = spans.filter((s) => phases.includes(s.stage));
  const waits = spans.filter((s) => s.stage.startsWith('wait:'));
  const workTime = within(ranges(work)),
    waitTime = within(ranges(waits));
  const local = within(ranges(work.filter((s) => s.stage !== 'ci')));
  const blocked = [];
  for (const s of spans.filter((s) => s.stage.startsWith('blocked:'))) {
    const waiting = waits.find(
      (w) => w.id === s.wait && w.stage === s.stage.replace('blocked:', 'wait:'),
    );
    if (!waiting) {
      issues.push('实际受阻缺少已结束的对应等待 ' + s.id);
      continue;
    }
    const overlaps = intersections([[s.at, s.end]], [[waiting.at, waiting.end]]);
    blocked.push({ id: s.id, reason: s.stage.slice(8), intervals: subtract(within(overlaps), local) });
  }
  const blockIntervals = union(blocked.flatMap((b) => b.intervals));
  const coverage = union([...workTime, ...waitTime]);
  const wall = start != null && until >= start ? until - start : null;
  const elapsed = (end) => (start != null && end != null && end >= start ? end - start : null);
  const stageMs = {};
  for (const stage of new Set([...work, ...waits].map((s) => s.stage)))
    stageMs[stage] = length(within(ranges(spans.filter((s) => s.stage === stage))));
  const rounds = [...spans, ...open, ...interrupted]
    .filter((s) => s.stage.startsWith('rework:'))
    .map((s) => {
      const actions = spans.filter((a) => a.round === s.id && phases.includes(a.stage));
      const checks = actions.filter((a) => a.check && a.status !== 'reused');
      const attemptIds = actions.filter((a) => a.stage === 'validation').map((a) => a.ref || a.id);
      const feedback =
        s.stage === 'rework:feedback' &&
        marks.find(
          (m) =>
            m.stage === 'feedback' &&
            m.ref === s.ref &&
            m.at <= s.at &&
            (!s.revision || m.revision === s.revision),
        );
      return {
        id: s.id,
        reason: s.stage,
        ref: s.ref,
        revision: s.revision ?? (feedback ? feedback.revision : null),
        feedbackToStartMs: feedback ? s.at - feedback.at : null,
        wallMs: s.end == null ? null : s.end - s.at,
        measuredMs: length(ranges(actions)),
        validationAttempts: new Set(attemptIds).size,
        checks: checks.length,
        stageMs: Object.fromEntries(
          [...new Set(actions.map((a) => a.stage))].map((stage) => [
            stage,
            length(ranges(actions.filter((a) => a.stage === stage))),
          ]),
        ),
      };
    });
  const attempts = spans.filter((s) => s.stage === 'validation' && !s.check && s.phase);
  const failed = new Map(),
    retries = [];
  for (const attempt of attempts) {
    const key = JSON.stringify([attempt.revision, attempt.tree, attempt.phase, attempt.scope]);
    const previous = failed.get(key);
    if (previous && previous.end <= attempt.at) {
      const cause = marks.find(
        (m) => m.stage === 'retry-cause' && m.previous === previous.id && m.attempt === attempt.id,
      );
      retries.push({
        previous: previous.id,
        attempt: attempt.id,
        cause: cause?.cause ?? 'unknown',
        ref: cause?.ref ?? null,
      });
    }
    if (attempt.status === 'failed') failed.set(key, attempt);
    else failed.delete(key);
  }
  const firstDev = attempts.find((s) => s.phase === 'dev');
  for (const gap of marks.filter((m) => m.stage === 'collection-gap'))
    issues.push('采集未完成 ' + gap.ref + ' ' + gap.code);
  if (!rows.length) issues.push('已登记但无计时');
  if (start == null && rows.length) issues.push('缺少实际开工时刻');
  if (close != null && start != null && close < start) issues.push('结项早于开工');
  if (open.some((r) => r.kind === 'start')) issues.push('部分执行缺少结束事件');
  const pending = options.unassigned ?? unresolved(root, activation, issues);
  const unknown = pending.filter((r) => r.sourceKey === task.sourceKey);
  if (unknown.length) issues.push('有执行记录待归属');
  const notices = marks
    .filter((m) => m.stage === 'notified')
    .map((m) => {
      const published = marks
        .filter((p) => p.stage === 'ready' && p.revision === m.revision && p.at <= m.at)
        .at(-1);
      return {
        ref: m.ref,
        revision: m.revision,
        readyToNoticeMs: published ? m.at - published.at : null,
      };
    });
  if (notices.some((n) => n.readyToNoticeMs == null)) issues.push('验收通知缺少该版本的健康发布记录');
  const publishes = rows.filter(
    (r) => r.kind === 'start' && r.stage === 'publish' && r.branch && r.revision,
  );
  if (publishes.length) {
    try {
      const preview = read(join(common, 'zdm-acceptance.json'));
      for (const p of publishes) {
        if (
          preview?.tasks?.some((t) => t.branch === p.branch && t.revision === p.revision) &&
          !marks.some((m) => m.stage === 'ready' && m.revision === p.revision)
        )
          issues.push('5274 已登记版本但缺少可验收时刻 ' + p.revision);
      }
    } catch {
      issues.push('5274 核对记录不可读');
    }
  }
  const since = (at) => (at != null && start != null && start >= at ? start - at : null);
  const assigned =
    'assignedAt' in task.original
      ? task.original.assignedAt
      : task.original.kind === 'assignment'
        ? task.originalAt
        : null;
  const todo = task.original.todoAt ?? (task.original.kind === 'todo' ? task.originalAt : null);
  return {
    id,
    fullName: fullName(task),
    assessment: view(stateFor(common,id)),
    type: task.type,
    status: task.status,
    batch: task.batch,
    relatedTask: task.relatedTask ?? null,
    notApplicable: task.type === 'engineering' ? ['业务提验', '等待业务验收反馈'] : [],
    registeredAt: task.registeredAt,
    asOf: now,
    originalAt: task.originalAt,
    startedAt: start,
    readyAt: ready,
    closedAt: close,
    firstReadyMs: elapsed(ready),
    deliveryMs: elapsed(close),
    observationMs: wall,
    assignedToStartMs: since(assigned),
    todoToStartMs: since(todo),
    registeredToStartMs: since(task.registeredAt),
    observedWorkMs: length(workTime),
    waitingMs: length(waitTime),
    blockedMs: length(blockIntervals),
    longestBlockMs: Math.max(0, ...blockIntervals.map(([a, b]) => b - a)),
    blocked,
    stageMs,
    unknownMs: wall == null ? null : Math.max(0, wall - length(coverage)),
    coverageRatio: wall > 0 ? length(coverage) / wall : null,
    rounds,
    retries,
    notices,
    firstDevPassed: firstDev ? firstDev.status === 'passed' : null,
    risks: [...new Set(attempts.map((a) => a.risk).filter(Boolean))],
    scopes: [...new Set(attempts.map((a) => a.scope?.join(',')).filter(Boolean))],
    marks,
    scopeChanges: marks.filter((m) => m.stage === 'scope-added'),
    operations: spans,
    interrupted,
    pending: open.map((item) => ({ ...item, observedMs: Math.max(0, until - item.at) })),
    unassigned: unknown,
    issues: [...new Set(issues)],
    workIntervals: workTime,
  };
}
function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const index = Math.floor(v.length / 2);
  return v.length % 2 ? v[index] : (v[index - 1] + v[index]) / 2;
}
export function summary(common, filters = {}) {
  const root = rootFor(common),
    activation = activated(root),
    issues = [];
  if (!activation) return { active: false, count: 0, tasks: [] };
  const shared = files(join(root, 'shared'), issues),
    pending = unresolved(root, activation, issues);
  const registered = [];
  for (const id of numbered(root)) {
    try {
      registered.push(taskRecord(root, id, activation));
    } catch {
      issues.push('任务 ' + id + ' 的登记不完整或不可读');
    }
  }
  const included = registered.filter(
    (t) =>
      (!filters.type || t.type === filters.type) &&
      (!filters.batch || t.batch === filters.batch) &&
      (!filters.from || t.originalAt >= filters.from) &&
      (!filters.to || t.originalAt <= filters.to),
  );
  const results = included
    .map((t) => report(common, t.id, { shared, unassigned: pending, now: filters.now }))
    .filter(
      (r) =>
        (!filters.risk || r.risks.includes(filters.risk)) &&
        (!filters.scope || r.scopes.includes(filters.scope)),
    );
  const outcomes = results.filter((r) => r.firstDevPassed != null);
  return {
    active: true,
    cutoff: activation.at,
    count: results.length,
    readySamples: results.filter((r) => r.firstReadyMs != null).length,
    deliverySamples: results.filter((r) => r.deliveryMs != null).length,
    firstReadyMedianMs: median(results.map((r) => r.firstReadyMs)),
    deliveryMedianMs: median(results.map((r) => r.deliveryMs)),
    firstDevPassRate: outcomes.length
      ? outcomes.filter((r) => r.firstDevPassed).length / outcomes.length
      : null,
    reworkRounds: results.reduce((n, r) => n + r.rounds.length, 0),
    medianCoverage: median(results.map((r) => r.coverageRatio)),
    sumTaskWorkMs: results.reduce((n, r) => n + r.observedWorkMs, 0),
    observedWallMs: length(results.flatMap((r) => r.workIntervals)),
    unassigned: pending.map((r) => ({ ref: r.ref, sourceKey: r.sourceKey })),
    issues,
    tasks: results.map((r) => ({
      id: r.id,
      fullName: r.fullName,
      type: r.type,
      status: r.status,
      risks: r.risks,
      scopes: r.scopes,
      firstReadyMs: r.firstReadyMs,
      deliveryMs: r.deliveryMs,
      blockedMs: r.blockedMs,
      rounds: r.rounds.length,
      unknownMs: r.unknownMs,
      coverageRatio: r.coverageRatio,
      issues: r.issues,
    })),
  };
}
