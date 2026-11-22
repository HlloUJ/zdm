import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { digest, rootFor, taskRecord, time, writeJson } from '../quality/timing-events.mjs';
import { commonFor, git, revision, update } from './registry.mjs';

const project = 'HlloUJ/zdm';
export function github(cwd) {
  const origin = git(cwd, 'remote', 'get-url', 'origin');
  if (
    !/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)HlloUJ\/zdm(?:\.git)?$/i.test(
      origin,
    )
  )
    throw Error('GitHub 来源不是当前装点猫项目');
  return (endpoint, pages = false) => {
    const path = 'repos/' + project + '/' + endpoint;
    const args = pages ? ['api', '--paginate', '--slurp', path] : ['api', path];
    return JSON.parse(
      execFileSync('gh', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  };
}
function positive(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw Error('需要有效的 GitHub 编号');
  return n;
}
function sameProject(value) {
  return typeof value === 'string' && value.toLowerCase() === project.toLowerCase();
}
export function releaseProof(api, commit, receipt) {
  const pr = api('pulls/' + positive(receipt.pr));
  const run = api('actions/runs/' + positive(receipt.ciRun));
  if (
    !pr.merged_at ||
    pr.merge_commit_sha !== commit ||
    !sameProject(pr.base?.repo?.full_name) ||
    pr.base.ref !== 'main' ||
    run.head_sha !== commit ||
    run.event !== 'push' ||
    run.head_branch !== 'main' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !sameProject(run.repository?.full_name) ||
    run.path !== '.github/workflows/verification.yml'
  )
    throw Error('正式交付的 PR、主线提交与主线验证不匹配');
  return { pr: pr.number, ciRun: run.id, mergedAt: time(pr.merged_at) };
}
export function bindPr(cwd, id, number, expectedHead, api = github(cwd)) {
  const common = commonFor(cwd);
  const task = taskRecord(rootFor(common), id);
  const pr = api('pulls/' + positive(number));
  if (
    pr.number !== Number(number) ||
    !sameProject(pr.head?.repo?.full_name) ||
    !sameProject(pr.base?.repo?.full_name) ||
    pr.base.ref !== 'main' ||
    pr.head.sha !== revision(expectedHead) ||
    time(pr.created_at) < task.originalAt
  )
    throw Error('任务版本、时间与本仓 PR 不匹配');
  const link = { number: pr.number, head: expectedHead, branch: pr.head.ref };
  return update(common, id, (t) =>
    t.pullRequests.some((p) => p.number === link.number && p.head === link.head)
      ? t
      : { ...t, pullRequests: [...t.pullRequests, link] },
  );
}
// CI facts are keyed by remote run/attempt/job, so a shared PR generates one observation.
// The task's explicit PR and head association determines who may see that observation.
export function collect(task, api) {
  const events = [],
    gaps = [];
  const pulls = new Map();
  for (const link of task.pullRequests) {
    try {
      const pr = pulls.get(link.number) ?? api('pulls/' + link.number);
      pulls.set(link.number, pr);
      if (pr.number !== link.number || !sameProject(pr.base?.repo?.full_name) || pr.base.ref !== 'main')
        throw Error('PR 身份变化');
      const entry = (kind, id, stage, at, fields = {}) => {
        const stamp = time(at);
        if (stamp < task.originalAt) throw Error('远端事件早于原始交办');
        events.push({
          kind,
          id,
          stage,
          at: stamp,
          ref: pr.html_url,
          pr: link.number,
          head: link.head,
          ...fields,
        });
      };
      entry('mark', 'pr:' + link.number + ':' + link.head, 'pr-created', pr.created_at);
      const current = pr.head.sha === link.head && sameProject(pr.head.repo?.full_name);
      const targets = [{ head: link.head, type: 'pull_request' }];
      if (current && pr.merged_at) {
        entry('mark', 'pr-merge:' + link.number, 'merged', pr.merged_at, {
          revision: revision(pr.merge_commit_sha),
        });
        targets.push({ head: pr.merge_commit_sha, type: 'push' });
      } else if (
        !current &&
        !task.pullRequests.some((p) => p.number === link.number && p.head === pr.head.sha)
      ) {
        gaps.push('PR #' + link.number + ' 的新版本尚未关联');
      }
      for (const target of targets) {
        const pages = api(
          'actions/runs?event=' + target.type + '&per_page=100&head_sha=' + target.head,
          true,
        );
        for (const run of pages.flatMap((p) => p.workflow_runs)) {
          if (
            run.event !== target.type ||
            run.head_sha !== target.head ||
            !sameProject(run.repository?.full_name)
          )
            continue;
          if (target.type === 'push' && run.head_branch !== 'main') continue;
          if (target.type === 'pull_request') {
            if (run.pull_requests?.length) {
              if (!run.pull_requests.some((p) => p.number === link.number)) continue;
            } else {
              const associated = api('commits/' + target.head + '/pulls?per_page=100', true).flat();
              if (
                associated.length !== 1 ||
                associated[0].number !== link.number ||
                run.head_branch !== link.branch ||
                !sameProject(run.head_repository?.full_name)
              ) {
                gaps.push('CI ' + run.id + ' 无法唯一归属 PR');
                continue;
              }
            }
          }
          for (let attempt = 1; attempt <= positive(run.run_attempt); attempt++) {
            const prefix = 'ci:' + run.id + ':' + attempt;
            const jobPages = api(
              'actions/runs/' + run.id + '/attempts/' + attempt + '/jobs?per_page=100',
              true,
            );
            const jobs = jobPages
              .flatMap((p) => p.jobs)
              .filter(
                (j) =>
                  Number(j.run_id) === Number(run.id) &&
                  (j.run_attempt == null || Number(j.run_attempt) === attempt),
              );
            const started = jobs.filter(
              (j) => j.started_at && ['in_progress', 'completed'].includes(j.status),
            );
            const fields = { ref: run.html_url, remoteRun: run.id, attempt, event: target.type };
            if (attempt === 1 && run.created_at) {
              const waiting = prefix + ':startup';
              entry('start', waiting, 'wait:ci', run.created_at, { ...fields, detail: 'CI 启动前等待' });
              if (started.length)
                entry('end', waiting, 'wait:ci', Math.min(...started.map((j) => time(j.started_at))), {
                  ...fields,
                  status: 'passed',
                });
            }
            for (const job of started) {
              const id = prefix + ':' + job.id;
              const metadata = { ...fields, check: job.name, ref: job.html_url };
              entry('start', id, 'ci', job.started_at, metadata);
              if (job.status === 'completed' && job.completed_at) {
                const status =
                  job.conclusion === 'success'
                    ? 'passed'
                    : job.conclusion === 'cancelled'
                      ? 'cancelled'
                      : ['failure', 'timed_out', 'action_required'].includes(job.conclusion)
                        ? 'failed'
                        : 'incomplete';
                entry('end', id, 'ci', job.completed_at, { ...metadata, status });
              }
            }
          }
        }
      }
    } catch (error) {
      gaps.push('PR #' + link.number + '：' + error.message.split('\n')[0]);
    }
  }
  return { events, gaps: [...new Set(gaps)] };
}
export function syncPr(cwd, id, api = github(cwd)) {
  const root = rootFor(commonFor(cwd));
  const task = taskRecord(root, id);
  const { events, gaps } = collect(task, api);
  for (const row of events) {
    // Each version has its own link for PR milestones and the same remote event is read once in reports.
    const key = digest(JSON.stringify([row.pr, row.head, row.id, row.kind]));
    writeJson(join(root, 'shared'), key + '.json', row);
  }
  return { observations: events.length, gaps };
}
