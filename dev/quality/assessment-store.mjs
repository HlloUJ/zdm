import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  digest,
  label,
  locked,
  numberId,
  read,
  rootFor,
  taskRecord,
  time,
  writeJson,
} from './timing-events.mjs';
import { intentChecks, highest, kinds, riskOf } from './behaviors.mjs';

export const identity = (id) => (id?.startsWith('ref:') ? label(id, '原交办标识') : numberId(id));
const directory = (common) => join(rootFor(common), 'assessments');
const filename = (id) => digest(identity(id)) + '.json';
export function stateFor(common, id) {
  return read(join(directory(common), filename(id)));
}
export function branchStates(common, workspace, branch) {
  if (!existsSync(directory(common)) || !branch) return [];
  return readdirSync(directory(common))
    .filter((p) => /^[a-f0-9]{64}\.json$/.test(p))
    .map((p) => read(join(directory(common), p)))
    .filter((s) => s.workspace === workspace && s.branch === branch);
}
export function view(s) {
  if (!s) return null;
  return {
    ...s,
    revision: s.history.length,
    current: s.history.at(-1),
    pending: s.notifications.filter((n) => !s.receipts[n.key]),
    initial: s.history[0],
  };
}
function nonempty(values, name) {
  if (!Array.isArray(values) || !values.length) throw Error('请登记' + name);
  return values.map((v) => label(v, name));
}
function pathsFor(values) {
  if (
    !Array.isArray(values) ||
    values.length > 1000 ||
    values.some(
      (p) =>
        typeof p !== 'string' ||
        !p ||
        p.startsWith('/') ||
        /[\x00-\x1f]/.test(p) ||
        p.split('/').some((x) => x === '..' || x === '.' || !x),
    )
  )
    throw Error('同批归属须用仓库中的准确相对文件路径');
  return [...new Set(values)].sort();
}
function intentFor(input) {
  const behaviors = kinds(input.behaviors);
  return {
    name: label(input.name, '任务全名'),
    source: label(input.source, '原交办'),
    references: nonempty(input.references, '文档版本、条款或基线入口'),
    before: label(input.before, '改前行为'),
    after: label(input.after, '改后行为'),
    consumers: nonempty(input.consumers, '实际使用方或待核范围'),
    data: label(input.data, '数据影响'),
    unknown: input.unknown ? label(input.unknown, '待核事实') : '',
    behaviors,
    roundBehaviors: kinds(input.roundBehaviors || behaviors),
    reason: label(input.reason, '判级依据'),
    domain: input.domain || null,
    paths: pathsFor(input.paths || []),
  };
}
function rendered(name, kind, previous, current) {
  const levels =
    current.whole === current.round
      ? current.whole
      : '整项 ' + current.whole + '，本轮 ' + current.round;
  const transitions = [];
  if (previous && previous.whole !== current.whole)
    transitions.push('整项 ' + previous.whole + ' → ' + current.whole);
  if (previous && previous.round !== current.round)
    transitions.push('本轮 ' + previous.round + ' → ' + current.round);
  const action = {
    start: '开工',
    resume: '恢复开工',
    handoff: '接手开工',
    rework: '返工开工',
    adopt: '接入时评估',
    late: '开发中补评',
    review: '复核',
  }[kind];
  return (
    name +
    ' ' +
    action +
    '，' +
    levels +
    '。' +
    (transitions.length ? transitions.join('，') + '。' : '') +
    current.reason +
    '。本轮验证 ' +
    current.dev.join('、') +
    '，交付验证 ' +
    current.delivery.join('、') +
    '。'
  );
}
export function updateAssessment({ common, workspace, branch, base }, id, command, input, reviewFacts) {
  identity(id);
  const root = rootFor(common);
  if (!id.startsWith('ref:')) taskRecord(root, id);
  const file = filename(id);
  return locked(root, () => {
    const s = stateFor(common, id) || {
      id,
      history: [],
      notifications: [],
      receipts: {},
      workspace,
      branch,
    };
    if (command === 'ack') {
      const n = s.notifications.find((x) => x.key === input.event);
      if (!n || n.thread !== input.thread) throw Error('通知与目标对话不符');
      const message = label(input.message, '对话内实际可见的消息引用');
      const at = time(input.at);
      if (at < n.at) throw Error('送达早于事件，请核对真实消息时间');
      if (
        Object.entries(s.receipts).some(
          ([key, r]) => key !== n.key && r.thread === n.thread && r.message === message,
        )
      )
        throw Error('同一条可见消息已关联其他通知');
      const already = s.receipts[n.key];
      if (already && already.message !== message) throw Error('已有其他实际消息回执');
      if (!already) s.receipts[n.key] = { thread: n.thread, message, at, recordedAt: Date.now() };
    } else {
      const event = label(input.event, '真实轮次或复核事件');
      const thread = label(input.thread, '执行对话');
      const replay = s.history.find((h) => h.event === event);
      const fingerprint = digest(
        JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))),
      );
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw Error('相同事件的内容发生冲突');
        return view(s);
      }
      if (s.history.length !== input.expected) throw Error('前一修订已变化，请读回任务后复核');
      const previous = s.history.at(-1);
      const kind = command === 'review' ? 'review' : input.kind;
      if (!['start', 'resume', 'handoff', 'rework', 'late', 'adopt', 'review'].includes(kind))
        throw Error('开工轮次类型无效');
      if (command === 'review' && !previous) throw Error('缺少初判，按真实时间用 late 补评并发送通知');
      if (
        previous &&
        previous.thread !== thread &&
        !['resume', 'handoff', 'rework', 'adopt', 'late'].includes(kind)
      )
        throw Error('跨对话接手请用真实开工轮次登记并发送通知');
      const intent =
        command === 'start'
          ? intentFor(input)
          : input.intent
            ? intentFor(input.intent)
            : previous.intent;
      if (!id.startsWith('ref:') && intent.name !== id + ' ' + taskRecord(root, id).name)
        throw Error('任务全名与计时台账不符');
      const current = {
        event,
        thread,
        kind,
        fingerprint,
        revision: s.history.length + 1,
        at: Date.now(),
        intent,
        base,
        whole: riskOf(intent.behaviors),
        round: riskOf(intent.roundBehaviors),
        dev: intentChecks(intent.roundBehaviors, intent.domain),
        delivery: intentChecks(intent.behaviors, intent.domain),
        reason: label(input.reason, '本轮依据'),
        gaps: [],
      };
      if (reviewFacts) Object.assign(current, reviewFacts(intent, current, previous));
      if (
        previous &&
        command === 'start' &&
        ['resume', 'handoff', 'rework'].includes(kind) &&
        previous.whole > current.whole
      ) {
        current.whole = previous.whole;
        current.delivery = [...new Set([...current.delivery, ...previous.delivery])];
      }
      if (kind === 'late') current.gaps.push('实质开工时未初判和通知，按开发中真实时点补评');
      if (current.gaps.length) current.reason += '。' + current.gaps.join('，');
      const changed = previous && (previous.whole !== current.whole || previous.round !== current.round);
      if (command === 'start' || changed) {
        const key = id + '/' + kind + '/' + current.revision;
        s.notifications.push({
          key,
          event,
          thread,
          at: current.at,
          revision: current.revision,
          text: rendered(intent.name, kind, previous, current),
        });
      }
      s.history.push(current);
      s.workspace = realpathSync(workspace);
      s.branch = branch;
    }
    writeJson(directory(common), file, s, { replace: true });
    return view(s);
  });
}
export function reviewed(intent, current, whole, round, from, disposition) {
  const gaps = intent.behaviors.filter((k) => !whole.plan.behaviors.includes(k));
  const resolved =
    disposition &&
    ['scope-changed', 'already-satisfied'].includes(disposition.kind) &&
    typeof disposition.ref === 'string' &&
    disposition.ref.trim() &&
    typeof disposition.basis === 'string' &&
    disposition.basis.trim();
  const missed = gaps.filter(
    (k) => !resolved && k !== 'note' && (k !== 'unknown' || !whole.plan.facts.length),
  );
  // A smaller diff alone cannot remove an obligation. A scope correction carries its source into history.
  const wholeRisk = missed.length ? highest(whole.plan.risk, riskOf(missed)) : whole.plan.risk;
  const empty = !round.plan.facts.length && missed.length > 0;
  const incomplete = missed.length ? ['需求尚未实现或缺少可核实证据：' + missed.join('、')] : [];
  return {
    whole: wholeRisk,
    round: empty ? riskOf(intent.roundBehaviors) : round.plan.risk,
    dev: empty
      ? [...new Set([...round.plan.dev, ...intentChecks(intent.roundBehaviors, intent.domain)])]
      : round.plan.dev,
    delivery: [
      ...new Set([
        ...whole.plan.delivery,
        ...(missed.length ? intentChecks(missed, intent.domain) : []),
      ]),
    ],
    gaps: incomplete,
    base: whole.base,
    tree: whole.tree,
    head: whole.head,
    policy: whole.policy,
    from,
    planId: whole.planId,
    roundPlanId: round.planId,
    behaviors: [...new Set([...whole.plan.behaviors, ...missed])].sort(),
    scopes: whole.plan.scopes,
    facts: whole.plan.facts,
    roundFacts: round.plan.facts,
    disposition: resolved ? disposition : null,
  };
}
