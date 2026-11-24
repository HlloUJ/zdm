import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { behaviors, highest, kinds } from './behaviors.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const marker = '<!-- zdm-task-assessment';
export function publicTask(s) {
  const r = s.history.findLast((revision) => !revision.remote);
  return {
    id: s.id.startsWith('ref:') ? 'ref-' + hash(s.id).slice(0, 24) : s.id,
    revision: r.revision,
    behaviors: r.behaviors || r.intent.behaviors,
    risk: r.whole,
    facts: (r.facts || []).map((f) => ({ path: f.path, behavior: f.kind })).filter((f) => f.path),
    checks: r.delivery,
  };
}
export function summaryFor(snap, tasks, candidate) {
  return {
    version: 1,
    base: snap.base,
    candidate,
    policy: snap.policy,
    tasks: tasks.map(publicTask).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
export const blockFor = (data) => marker + '\n' + JSON.stringify(data) + '\n-->';
export function eventBody() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || !process.env.GITHUB_EVENT_PATH) return null;
  return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request;
}
const catalogue = new Set(
  Object.values(behaviors)
    .flatMap((row) => row[2])
    .concat('selection'),
);
export function readSummary(body, expected) {
  const raw = typeof body === 'string' ? body : '';
  const start = raw.indexOf(marker);
  if (start < 0) return { status: 'absent', fingerprint: hash('absent'), tasks: [] };
  const end = raw.indexOf('-->', start + marker.length);
  const section = raw.slice(start, end < 0 ? undefined : end + 3);
  const fingerprint = hash(raw.split(marker).length === 2 ? section : raw);
  try {
    if (end < 0 || raw.indexOf(marker, start + 1) >= 0 || section.length > 48000) throw Error();
    const v = JSON.parse(raw.slice(start + marker.length, end));
    if (
      v.version !== 1 ||
      v.base !== expected.base ||
      v.candidate !== expected.candidate ||
      v.policy !== expected.policy ||
      !Array.isArray(v.tasks) ||
      !v.tasks.length ||
      v.tasks.length > 100
    )
      throw Error();
    const seen = new Set();
    for (const t of v.tasks) {
      if (
        !/^(?:\d{3,15}|ref-[a-f0-9]{24})$/.test(t.id) ||
        seen.has(t.id) ||
        !Number.isSafeInteger(t.revision) ||
        t.revision < 1 ||
        !/^R[0-4]$/.test(t.risk) ||
        !Array.isArray(t.checks) ||
        t.checks.some((c) => !catalogue.has(c))
      )
        throw Error();
      kinds(t.behaviors);
      seen.add(t.id);
    }
    return { status: 'bound', fingerprint, tasks: v.tasks };
  } catch {
    return { status: 'stale', fingerprint, tasks: [] };
  }
}
export function bindSummary(snap, summary) {
  const plan = structuredClone(snap.plan);
  const additions = [];
  for (const t of summary.tasks) {
    const missing = t.behaviors.filter((k) => !plan.behaviors.includes(k));
    // The applicant can add obligations. Independent findings, scopes and checks remain a floor.
    additions.push(...t.checks, ...missing.flatMap((k) => behaviors[k][2]));
    plan.risk = highest(plan.risk, t.risk, ...t.behaviors.map((k) => 'R' + behaviors[k][0]));
    for (const k of missing) {
      plan.specialties[k] = [behaviors[k][1]];
      for (const check of behaviors[k][2]) delete plan.scopes[check];
    }
  }
  if (summary.status === 'absent') plan.reasons.push('缺少本机任务资料，按独立核实的行为与适用域验证');
  if (summary.status === 'stale') {
    // Preserve the complete identified domain when a recorded statement no longer matches this combination.
    plan.reasons.push('任务摘要过期或冲突，按已识别业务域完整复核');
    plan.scopes = {};
    if (!plan.facts.length || plan.behaviors.includes('unknown'))
      additions.push(...behaviors.unknown[2]);
  }
  plan.delivery = [...new Set([...plan.delivery, ...additions])];
  return {
    ...snap,
    plan,
    summary,
    planId: hash(
      JSON.stringify([snap.planId, summary.fingerprint, plan.delivery, plan.scopes, plan.risk]),
    ),
  };
}
