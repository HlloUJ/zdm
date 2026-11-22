import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checks } from './quality/policy.mjs';
import { git, inspect } from './quality/repository.mjs';
import { inputReader, fileDigest } from './quality/inputs.mjs';
import { EvidenceStore, runId } from './quality/store.mjs';
import { nativeCommands, launch, runCheck } from './quality/commands.mjs';
import { exportEvidence, loadPriorEvidence, mergeVerified } from './quality/remote.mjs';
import { event, finish, observe, observer, ready } from './quality/timing-events.mjs';

function verifyReport(store, snap, phase) {
  const report = store.report(phase, snap);
  if (
    report?.status !== 'passed' ||
    report.planId !== snap.planId ||
    report.tree !== snap.tree ||
    report.policy !== snap.policy
  )
    throw Error('缺少当前候选和目标主线的完整验证记录。');
  const input = inputReader(snap);
  const expected = phase === 'dev' ? snap.plan.dev : snap.plan.delivery;
  if (report.results.length !== expected.length) throw Error('必测项数量与记录不一致。');
  for (const id of expected) {
    const proof = report.results.find((row) => row.id === id);
    const now = input(id);
    if (
      !proof ||
      proof.fingerprint !== now.fingerprint ||
      !store.intact(proof) ||
      !store.intact(store.cached(now))
    )
      throw Error('缺少有效证据或相关输入已变化：' + id);
  }
  return report;
}
function validate(snap, phase, options, rawId, args = []) {
  const store = new EvidenceStore(snap.common);
  if (phase.startsWith('assert-')) return verifyReport(store, snap, phase.slice(7));
  const selected = rawId ? [rawId] : phase === 'dev' ? snap.plan.dev : snap.plan.delivery;
  const readInput = inputReader(snap);
  const run = runId();
  const report = {
    run,
    phase,
    standard: snap.plan.standard,
    risk: snap.plan.risk,
    head: snap.head,
    tree: snap.tree,
    base: snap.base,
    policy: snap.policy,
    planId: snap.planId,
    planned: selected,
    reasons: snap.plan.reasons,
    specialties: snap.plan.specialties,
    changed: snap.files,
    status: 'running',
    startedAt: Date.now(),
    results: [],
    notApplicable: Object.keys(checks).filter((id) => !snap.plan.delivery.includes(id)),
    pending: [...selected],
  };
  store.save(report);
  const timing = observer(snap.common, snap.cwd);
  const timingRun = 'quality:' + run;
  const timingFields = { ref: run, revision: snap.head, tree: snap.tree, risk: report.risk, scope: selected, phase };
  function record(operation) {
    if (timing) observe(operation, timing, run);
  }
  record(() => event(timing, 'start', timingRun, 'validation', { ...timingFields, at: report.startedAt }));
  let activeCheck;
  const prior = phase === 'main' ? loadPriorEvidence(snap) : null;
  try {
    for (const id of selected) {
      activeCheck = timingRun + ':' + id;
      record(() => event(timing, 'start', activeCheck, 'validation', { ...timingFields, check: id }));
      const checkArgs = rawId ? args : [];
      const input = readInput(id, checkArgs);
      const cached = input.reusable && !rawId ? store.cached(input) : null;
      let row;
      if (cached && store.intact(cached)) {
        row = { ...cached, status: 'reused', previousPhase: cached.phase };
      } else if (input.reusable && prior?.canReuse(id, input)) {
        row = prior.copy(id, input, store, run);
        store.attempt(run, row);
      } else {
        const log = store.log(run, id);
        row = {
          id,
          args: checkArgs,
          ...input,
          log,
          sourceRun: run,
          phase,
          sourceHead: snap.head,
          sourceBase: snap.base,
          sourcePlan: snap.planId,
          status: 'running',
          startedAt: Date.now(),
        };
        store.attempt(run, row);
        try {
          process.stderr.write(snap.plan.risk + ' ' + phase + ' · ' + id + '\n');
          const complete = runCheck(snap, id, checkArgs, log, Boolean(rawId && checkArgs.length));
          const after = inspect(snap.cwd, options.baseRef, phase);
          if (
            after.tree !== snap.tree ||
            after.head !== snap.head ||
            after.base !== snap.base ||
            after.policy !== snap.policy
          )
            throw Error('验证期间候选、目标主线或标准发生变化。');
          const observed = inputReader(after)(id, checkArgs);
          // Provisioning an uncached external toolchain can change its identity on first use.
          if (input.reusable && observed.fingerprint !== input.fingerprint)
            throw Error('验证期间相关依赖或环境发生变化，请使用稳定输入验证。');
          Object.assign(row, observed, { status: complete ? 'passed' : 'incomplete' });
        } catch (error) {
          row.status = 'failed';
          row.error = error.message;
          throw error;
        } finally {
          row.durationMs = Date.now() - row.startedAt;
          row.logDigest = existsSync(log) ? fileDigest(log) : null;
          store.attempt(run, row);
          if (row.status === 'failed') {
            report.results.push(row);
            report.pending.shift();
            if (existsSync(log))
              process.stderr.write(readFileSync(log, 'utf8').split('\n').slice(-35).join('\n') + '\n');
          }
        }
      }
      if (rawId) process.stdout.write(readFileSync(row.log));
      record(() => finish(timing, activeCheck, row.status, { ref: run, check: id, sourceRun: row.sourceRun }));
      activeCheck = null;
      report.results.push(row);
      report.pending.shift();
      store.save(report);
    }
    const final = inspect(snap.cwd, options.baseRef, phase);
    if (final.planId !== snap.planId || final.head !== snap.head)
      throw Error('最终候选或验证计划已变化。');
    report.status = report.results.every((row) => ['passed', 'reused'].includes(row.status))
      ? 'passed'
      : 'incomplete';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    throw error;
  } finally {
    prior?.close();
    report.durationMs = Date.now() - report.startedAt;
    store.save(report);
    if (activeCheck) record(() => finish(timing, activeCheck, 'failed', { ref: run }));
    record(() => finish(timing, timingRun, report.status, { ref: run }));
    if (phase === 'dev' && report.status === 'passed') record(() => ready(timing, 'verified', snap.head, run));
    if (options.exportDir) exportEvidence(snap, store, report, options.exportDir);
  }
  return report;
}
function optionsFor(args, phase) {
  const options = { baseRef: phase === 'main' ? 'HEAD^1' : 'refs/remotes/origin/main' };
  while (args.length) {
    const name = args.shift();
    const value = args.shift();
    if (!value || !['--base', '--export'].includes(name)) throw Error('验证参数无效：' + name);
    if (name === '--base') options.baseRef = value;
    else options.exportDir = resolve(value);
  }
  return options;
}
export function main(argv, cwd = process.cwd()) {
  let [phase, ...args] = argv;
  if (phase === 'merge')
    return mergeVerified(cwd, args, (snap) =>
      verifyReport(new EvidenceStore(snap.common), snap, 'delivery'),
    );
  if (phase === 'run') {
    let id = args.shift();
    if (!['build', 'unit', 'e2e', 'backend', 'ledger'].includes(id)) throw Error('未知项目测试命令');
    if (id === 'e2e' && args.length === 1 && args[0] === 'tests/e2e/selection-center.spec.ts') {
      id = 'selection';
      args = [];
    }
    let root;
    try {
      root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
    } catch {
      /* An exported source tree can still build and test. */
    }
    if (
      !root ||
      realpathSync(root) !== realpathSync(cwd) ||
      args.some((arg) => /^--(?:help|version|watch|ui|list)(?:=|$)/.test(arg))
    ) {
      launch(cwd, nativeCommands(id, args), 'inherit');
      return;
    }
    const options = optionsFor([], phase);
    validate(inspect(cwd, options.baseRef, phase), phase, options, id, args);
    return;
  }
  if (!['plan', 'dev', 'delivery', 'main', 'assert-dev', 'assert-delivery'].includes(phase))
    throw Error('用法：node dev/quality.mjs plan|dev|delivery|assert-delivery|main|merge|run');
  const options = optionsFor(args, phase);
  const snap = inspect(cwd, options.baseRef, phase);
  if (phase === 'plan')
    return {
      ...snap.plan,
      head: snap.head,
      tree: snap.tree,
      base: snap.base,
      planId: snap.planId,
      changed: snap.files,
    };
  return validate(snap, phase, options);
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = main(process.argv.slice(2));
    if (result) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  }
}
