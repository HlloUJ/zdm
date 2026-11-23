import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { git, inspect, planTree, summarizeChanges, digest } from './repository.mjs';
import {
  branchStates,
  identity,
  reviewed,
  stateFor,
  updateAssessment,
  view,
} from './assessment-store.mjs';
import { blockFor, summaryFor } from './assessment-summary.mjs';
import { behaviors } from './behaviors.mjs';
import { reviewPullRequest } from './remote.mjs';
import { EvidenceStore } from './store.mjs';
import { inputReader } from './inputs.mjs';
import { contextVariable, observer, rootFor, taskRecord } from './timing-events.mjs';

function location(cwd) {
  return {
    common: realpathSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()),
    workspace: realpathSync(cwd),
    branch: git(cwd, ['branch', '--show-current']).trim(),
  };
}
export function localTasks(snap) {
  if (process.env.GITHUB_ACTIONS === 'true') return [];
  const loc = location(snap.cwd);
  if (process.env[contextVariable]) {
    const ctx = observer(loc.common, loc.workspace);
    if (ctx) {
      const explicit = ctx.ids.map((id) => stateFor(loc.common, id)).filter(Boolean);
      if (explicit.some((s) => s.workspace !== loc.workspace || s.branch !== loc.branch))
        throw Error('初判属于其他工作树，请在本轮真实接手时绑定');
      return explicit;
    }
  }
  return branchStates(loc.common, loc.workspace, loc.branch);
}
export function assessMissing(snap, phase) {
  if (!['dev', 'plan'].includes(phase) || process.env.GITHUB_ACTIONS === 'true') return [];
  const loc = location(snap.cwd);
  const ctx = process.env[contextVariable] ? observer(loc.common, loc.workspace) : null;
  const root = rootFor(loc.common);
  const tasks =
    ctx?.tasks ||
    (existsSync(root)
      ? readdirSync(root)
          .filter((id) => /^\d{3,15}$/.test(id))
          .map((id) => taskRecord(root, id))
          .filter(
            (t) =>
              !['closed', 'cancelled'].includes(t.status) &&
              t.workspaces?.some((w) => w.path === loc.workspace && w.branch === loc.branch),
          )
      : []);
  const missing = tasks.filter((t) => !stateFor(loc.common, t.id));
  const thread = process.env.CODEX_THREAD_ID;
  for (const t of missing) {
    if (!thread) continue;
    const scoped = snap.plan.behaviors.length ? snap.plan.behaviors : ['unknown'];
    const rev = updateAssessment(loc, t.id, 'start', {
      event: 'late-' + t.sourceKey,
      expected: 0,
      kind: 'late',
      thread,
      name: t.id + ' ' + t.name,
      source: t.original.message,
      references: [(snap.base || '基线待核') + '，交办资料待执行者补核'],
      before: '开工判级缺失，改前行为待核',
      after: t.name,
      consumers: ['实际差异所涉及的使用方，交办范围待核'],
      data: '数据后果待核',
      unknown: '初判晚于开工，请核对原交办并补发说明',
      behaviors: scoped,
      reason: '开发中补评，根据当前差异暂判，保留开工通知缺口',
    });
    for (const n of rev.pending) process.stderr.write('待在执行对话发送 ' + n.text + '\n');
  }
  return missing.filter((t) => !stateFor(loc.common, t.id)).map((t) => t.id);
}
export function previousEvidence(snap, state) {
  const store = new EvidenceStore(snap.common);
  const saved = store.read(join(store.root, 'assessment-baselines', digest(state.id) + '.json'));
  if (
    !saved ||
    saved.policy !== snap.policy ||
    saved.base !== snap.base ||
    saved.branch !== state.branch ||
    !/^\d{13}-[a-f0-9-]+$/.test(saved.run)
  )
    return null;
  const latest = store.read(join(store.root, 'runs', saved.run + '.json'));
  if (
    !latest ||
    latest.phase !== 'dev' ||
    latest.status !== 'passed' ||
    latest.run !== saved.run ||
    latest.tree !== saved.tree || latest.base !== saved.base || latest.policy !== saved.policy ||
    !latest.assessments?.some((t) => t.id === state.id)
  )
    return null;
  try {
    git(snap.cwd, ['cat-file', '-e', saved.tree + '^{tree}']);
  } catch {
    return null;
  }
  return { ...saved, report: latest };
}
export function saveBaselines(snap, report) {
  if (!snap.tasks?.length || report.phase !== 'dev' || report.status !== 'passed') return;
  const store = new EvidenceStore(snap.common);
  for (const state of snap.tasks)
    store.write(join(store.root, 'assessment-baselines', digest(state.id) + '.json'), {
      tree: snap.tree,
      base: snap.base,
      policy: snap.policy,
      run: report.run,
      branch: state.branch,
    });
}
function taskSlice(snap, state) {
  const paths = state.history.at(-1)?.intent.paths;
  if (!paths?.length) return snap;
  const selected = snap.changes.filter((c) => paths.includes(c.path));
  return { ...snap, ...summarizeChanges(selected, snap.fallback, snap.blobs, snap.base, snap.tree) };
}
function comparison(snap, state) {
  const prior = previousEvidence(snap, state);
  // Rechecking the same tree keeps its original scope. A baseline is advanced only by passed development evidence.
  const from =
    prior?.tree === snap.tree ? state.history.at(-1)?.from || snap.from : prior?.tree || snap.from;
  const round = taskSlice(
    from === snap.from ? snap : { ...snap, ...planTree(snap.cwd, snap.base, from, snap.tree) },
    state,
  );
  return { round, from };
}
function review(cwd, id, input, snap, state) {
  const { round, from } = comparison(snap, state);
  return updateAssessment(
    { ...location(cwd), base: snap.base },
    id,
    'review',
    input,
    (intent, current) =>
      reviewed(intent, current, taskSlice(snap, state), round, from, input.disposition),
  );
}
export function automaticReview(snap, state) {
  const current = state.history.at(-1);
  if (
    current.kind === 'review' &&
    current.tree === snap.tree &&
    current.base === snap.base &&
    current.policy === snap.policy
  )
    return state;
  return review(
    snap.cwd,
    state.id,
    {
      event: 'review-' + digest(JSON.stringify([current.revision, snap.tree, snap.base, snap.policy])),
      thread: current.thread,
      expected: current.revision,
      reason: '实际累计差异和上次成功验证以来的本轮改动已复核',
    },
    snap,
    state,
  );
}
// The previous source tree describes the round. Invalid original results extend its checks individually.
function carryEvidence(snap, tasks, plan) {
  const originals = new Map();
  for (const state of tasks) {
    const report = previousEvidence(snap, state)?.report;
    if (!report) continue;
    for (const row of [...(report.inherited || []), ...report.results]) {
      if (['diff', 'docs'].includes(row.id) || !plan.delivery.includes(row.id)) continue;
      originals.set(JSON.stringify([row.id, row.args || []]), row);
    }
  }
  if (!originals.size) return [];
  const store = new EvidenceStore(snap.common);
  const input = inputReader(snap);
  const covered = row => {
    if (!plan.dev.includes(row.id)) return false;
    const scope = plan.scopes[row.id];
    return !scope?.length || (row.args?.length && row.args.every(path => scope.includes(path)));
  };
  const retained = [];
  for (const row of originals.values()) {
    if (covered(row)) continue;
    if (store.intact(row) && row.identity === input(row.id).identity) {
      retained.push(row);
      continue;
    }
    const scheduled = plan.dev.includes(row.id);
    if (!scheduled) plan.dev.push(row.id);
    if (!['e2e', 'unit'].includes(row.id)) continue;
    if (row.args?.length && (!scheduled || plan.scopes[row.id]?.length))
      plan.scopes[row.id] = [...new Set([...(plan.scopes[row.id] || []), ...row.args])].sort();
    else delete plan.scopes[row.id];
  }
  return retained.filter(row => !covered(row));
}
export function development(snap, states) {
  const tasks = states.map((s) => automaticReview(snap, s));
  if (!tasks.length) return snap;
  const paths = new Set(tasks.flatMap((t) => t.history.at(-1).intent.paths || []));
  const unclaimed = paths.size ? snap.changes.filter((c) => !paths.has(c.path)) : [];
  const remaining = summarizeChanges(unclaimed, snap.fallback, snap.blobs, snap.base, snap.tree).plan;
  const rows = tasks.map((s) => s.history.at(-1));
  const rounds = [...tasks.map((s) => comparison(snap, s).round.plan), remaining];
  const plan = structuredClone(snap.plan);
  plan.dev = [...new Set([...rows.flatMap((r) => r.dev), ...remaining.dev])];
  plan.wholeRisk =
    'R' + Math.max(Number(snap.plan.risk.slice(1)), ...rows.map((r) => Number(r.whole.slice(1))));
  plan.risk =
    'R' + Math.max(Number(remaining.risk.slice(1)), ...rows.map((r) => Number(r.round.slice(1))));
  plan.delivery = [...new Set([...snap.plan.delivery, ...rows.flatMap((r) => r.delivery)])];
  for (const id of ['unit', 'e2e']) {
    const required = rounds.filter((p) => p.dev.includes(id));
    if (required.length && required.every((p) => p.scopes[id]?.length))
      plan.scopes[id] = [...new Set(required.flatMap((p) => p.scopes[id]))].sort();
    else delete plan.scopes[id];
  }
  const inherited = carryEvidence(snap, tasks, plan);
  const refs = tasks.map((s) => ({ id: s.id, revision: s.history.at(-1).revision }));
  return {
    ...snap,
    tasks,
    plan,
    assessments: refs,
    inherited,
    planId: digest(JSON.stringify([snap.planId, refs, plan.dev, plan.scopes])),
  };
}
export function assess(args, cwd) {
  const [command, ident, raw] = args;
  if (command === 'catalog') return behaviors;
  const loc = location(cwd);
  const ids = String(ident || '')
    .split(',')
    .map(identity);
  const id = ids[0],
    state = stateFor(loc.common, id);
  if (command === 'show') return view(state);
  if (command === 'ci') {
    if (!state || !/^\d+$/.test(raw)) throw Error('需要本任务登记和真实 PR 编号');
    const remote = reviewPullRequest(cwd, raw);
    const last = state.history.at(-1);
    const event =
      'ci-' +
      digest(
        JSON.stringify([
          remote.number,
          remote.snap.base,
          remote.snap.tree,
          remote.snap.planId,
          last.intent,
        ]),
      );
    const existing = state.history.find((h) => h.event === event);
    if (existing) return view(state);
    const scoped = taskSlice(remote.snap, state);
    return updateAssessment(
      { ...loc, base: remote.snap.base },
      id,
      'review',
      {
        event,
        thread: last.thread,
        expected: last.revision,
        reason: '已对照 PR ' + raw + ' 的目标主线、公开摘要与实际合并树',
      },
      (intent, current) => {
        const facts = reviewed(intent, current, scoped, scoped, scoped.base);
        return {
          ...facts,
          whole: last.intent.paths?.length
            ? facts.whole
            : remote.snap.plan.risk > facts.whole
              ? remote.snap.plan.risk
              : facts.whole,
          round: last.round,
          dev: last.dev,
          delivery: [
            ...new Set([
              ...facts.delivery,
              ...(last.intent.paths?.length ? [] : remote.snap.plan.delivery),
            ]),
          ],
          remote: {
            pr: remote.number,
            head: remote.head,
            tree: remote.snap.tree,
            verification: remote.verification,
          },
        };
      },
    );
  }
  if (command === 'summary') {
    const snap = inspect(cwd, 'refs/remotes/origin/main', 'delivery');
    const tasks = ids.map((n) => stateFor(loc.common, n));
    if (
      tasks.some(
        (s) =>
          !s ||
          s.workspace !== loc.workspace ||
          s.history.at(-1).tree !== snap.tree ||
          s.history.at(-1).base !== snap.base ||
          s.history.at(-1).policy !== snap.policy,
      )
    )
      throw Error('需要先复核本候选上各任务的整项差异');
    return { block: blockFor(summaryFor(snap, tasks, snap.head)) };
  }
  if (ids.length !== 1 || !['start', 'review', 'ack'].includes(command))
    throw Error('使用 assess start|review|show|ack|summary');
  const input = JSON.parse(raw === '-' ? readFileSync(0, 'utf8') : raw);
  if (command === 'review') {
    if (!state) throw Error('缺少开工判级，请以 late 补评并说明通知缺口');
    return review(cwd, id, input, inspect(cwd, 'refs/remotes/origin/main', 'plan'), state);
  }
  let base = null;
  try {
    base = git(cwd, ['rev-parse', 'refs/remotes/origin/main']).trim();
  } catch {
    /* disclose missing baseline */
  }
  return updateAssessment({ ...loc, base }, id, command, input);
}
