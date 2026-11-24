import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { digest, git } from './repository.mjs';
import { EvidenceStore } from './store.mjs';
import { eventById, read, rootFor, taskRecord } from './timing-events.mjs';

const runId = /^\d{13}-[a-f0-9-]+$/;
const objectId = /^[a-f0-9]{40}$/;

function passedDev(store, run) {
  if (!runId.test(run || '')) return null;
  const report = store.read(join(store.root, 'runs', run + '.json'));
  return report?.run === run && report.phase === 'dev' && report.status === 'passed' ? report : null;
}

function reachable(snap, report, clean) {
  if (!objectId.test(report.tree) || !objectId.test(report.head)) return false;
  try {
    git(snap.cwd, ['merge-base', '--is-ancestor', report.head, snap.head]);
    const commitTree = git(snap.cwd, ['rev-parse', report.head + '^{tree}']).trim();
    if (clean) return commitTree === report.tree;
    return git(snap.cwd, ['cat-file', '-t', report.tree]).trim() === 'tree';
  } catch {
    return false;
  }
}

// Before task assessments existed, the timer bound a signed run to the task and exact checkout.
function legacyBaseline(snap, state, store) {
  if (!/^\d+$/.test(state.id)) return null;
  const root = rootFor(snap.common);
  const dir = join(root, state.id, 'events');
  if (!existsSync(dir)) return null;
  const task = taskRecord(root, state.id);
  if (!task.workspaces?.some(w => w.branch === state.branch && w.path === state.workspace)) return null;
  const firstAssessment = state.history[0].at;
  const candidates = readdirSync(dir).filter(f => /^[a-f0-9]{64}\.json$/.test(f))
    .map(f => read(join(dir, f)))
    .filter(e => e?.kind === 'start' && e.stage === 'validation' && e.phase === 'dev' && !e.check &&
      e.id === 'quality:' + e.ref && e.tasks?.length === 1 && e.tasks[0] === state.id && e.at <= firstAssessment)
    .sort((a, b) => b.at - a.at);
  for (const event of candidates) {
    const report = passedDev(store, event.ref);
    if (!report || report.standard !== 'V1.1' || report.head !== event.revision || report.tree !== event.tree) continue;
    const end = eventById({ root, ids: [state.id] }, event.id, 'end');
    if (end?.status !== 'passed' || end.at > firstAssessment || end.tasks?.length !== 1 || end.tasks[0] !== state.id) continue;
    if (reachable(snap, report, true)) return { tree: report.tree, head: report.head, run: report.run, report, origin: 'timing' };
  }
  return null;
}

export function previousEvidence(snap, state) {
  const store = new EvidenceStore(snap.common);
  const saved = store.read(join(store.root, 'assessment-baselines', digest(state.id) + '.json'));
  if (saved?.branch === state.branch) {
    const report = passedDev(store, saved.run);
    if (report && report.tree === saved.tree && report.base === saved.base && report.policy === saved.policy &&
        report.assessments?.some(t => t.id === state.id && t.revision <= state.history.at(-1).revision) &&
        reachable(snap, report, false))
      return { tree: report.tree, head: report.head, run: report.run, report, origin: 'assessment' };
    if (!report && saved.task === state.id && runId.test(saved.run) && Array.isArray(saved.checks) &&
        !store.read(join(store.root, 'runs', saved.run + '.json')) && reachable(snap, saved, false))
      return { ...saved, report: null, origin: 'checkpoint' };
  }
  return legacyBaseline(snap, state, store);
}
