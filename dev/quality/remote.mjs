import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileDigest } from './inputs.mjs';
import { git, inspect, planTree } from './repository.mjs';
import { checks } from './policy.mjs';

const workflow = 'verification.yml';
const gate = 'V1.1 quality gate';
function gh(cwd, ...args) {
  return execFileSync('gh', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}
function origin(cwd) {
  const url = git(cwd, ['remote', 'get-url', 'origin']).trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
  if (!match) throw Error('无法核对 origin 的 GitHub 仓库身份。');
  return match[1];
}
export function exportEvidence(snap, store, report, dir) {
  mkdirSync(dir, { recursive: true });
  const rows = report.results.map((row) => {
    if (report.status === 'passed' && !store.intact(row)) throw Error('导出时缺少原始证据：' + row.id);
    if (row.logDigest) copyFileSync(row.log, join(dir, row.id + '.log'));
    const { log, ...portable } = row;
    return portable;
  });
  const pr =
    process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).number
      : null;
  const parents = git(snap.cwd, ['show', '-s', '--format=%P', snap.head]).trim().split(' ');
  writeFileSync(
    join(dir, 'report.json'),
    JSON.stringify({
      ...report,
      results: rows,
      parents,
      pr,
      repo: origin(snap.cwd),
      githubRun: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
    }) + '\n',
  );
}
// Results are obtained from the GitHub Actions API for this repo and specific run.
// Never consume an artifact path or run id supplied by the feature branch.
function prEvidence(cwd, repo, number, head, base, tree, expected) {
  const data = JSON.parse(
    gh(
      cwd,
      'api',
      'repos/' +
        repo +
        '/actions/workflows/' +
        workflow +
        '/runs?event=pull_request&per_page=30&head_sha=' +
        head,
    ),
  );
  const run = data.workflow_runs.find(
    (item) =>
      item.event === 'pull_request' &&
      item.head_sha === head &&
      item.path === '.github/workflows/' + workflow &&
      item.head_repository?.full_name === repo &&
      item.repository?.full_name === repo &&
      (!item.pull_requests?.length || item.pull_requests.some((pr) => pr.number === number)),
  );
  if (!run || run.conclusion !== 'success' || run.status !== 'completed') return null;
  const dir = mkdtempSync(join(tmpdir(), 'zdm-verified-pr-'));
  try {
    gh(
      cwd,
      'run',
      'download',
      String(run.id),
      '--repo',
      repo,
      '--name',
      'verification-evidence-' + run.id + '-' + run.run_attempt,
      '--dir',
      dir,
    );
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    verifyArchivedReport(report, { run, repo, number, head, base, tree, expected, dir });
    return { dir, report, close: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
export function verifyArchivedReport(report, { run, repo, number, head, base, tree, expected, dir }) {
  if (
    String(report.githubRun) !== String(run.id) ||
    Number(report.attempt) !== run.run_attempt ||
    report.repo !== repo ||
    report.pr !== number ||
    report.phase !== 'delivery' ||
    report.status !== 'passed' ||
    report.base !== base ||
    report.tree !== tree ||
    report.parents?.length !== 2 ||
    report.parents[0] !== base ||
    report.parents[1] !== head
  )
    throw Error('PR 证据的仓库、候选、主线或合并树不一致。');
  if (
    report.planId !== expected.planId ||
    report.policy !== expected.policy ||
    report.risk !== expected.plan.risk ||
    JSON.stringify(report.planned) !== JSON.stringify(expected.plan.delivery) ||
    report.results?.length !== report.planned.length ||
    new Set(report.results.map((row) => row.id)).size !== report.planned.length
  )
    throw Error('PR 证据缺少验证清单。');
  for (const id of report.planned) {
    const row = report.results.find((item) => item.id === id);
    if (
      !Object.hasOwn(checks, id) ||
      !row ||
      !['passed', 'reused'].includes(row.status) ||
      fileDigest(join(dir, id + '.log')) !== row.logDigest
    )
      throw Error('PR 检查缺少有效原始结果。');
  }
}

export function loadPriorEvidence(snap) {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_EVENT_NAME !== 'push' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_SHA !== snap.head
  )
    return null;
  if (snap.files.some((path) => /^(\.github\/workflows\/|dev\/quality|tests\/quality)/.test(path)))
    return null;
  try {
    const repo = origin(snap.cwd);
    if (repo !== process.env.GITHUB_REPOSITORY) return null;
    const parents = git(snap.cwd, ['show', '-s', '--format=%P', snap.head]).trim().split(' ');
    if (parents.length !== 2 || parents[0] !== snap.base) return null;
    const prs = JSON.parse(gh(snap.cwd, 'api', 'repos/' + repo + '/commits/' + snap.head + '/pulls'));
    const pr = prs.find(
      (item) =>
        item.merged_at &&
        item.merge_commit_sha === snap.head &&
        item.head.sha === parents[1] &&
        item.base.ref === 'main' &&
        item.head.repo?.full_name === repo,
    );
    if (!pr) return null;
    const prior = prEvidence(snap.cwd, repo, pr.number, parents[1], snap.base, snap.tree, snap);
    if (!prior) return null;
    if (prior.report.planId !== snap.planId || prior.report.policy !== snap.policy) {
      prior.close();
      return null;
    }
    const rows = new Map(prior.report.results.map((row) => [row.id, row]));
    return {
      close: prior.close,
      canReuse(id, input) {
        const row = rows.get(id);
        return row?.reusable && row.fingerprint === input.fingerprint && row.status === 'passed';
      },
      copy(id, input, store, run) {
        const row = rows.get(id);
        const log = store.log(run, id);
        copyFileSync(join(prior.dir, id + '.log'), log);
        return {
          ...row,
          ...input,
          status: 'reused',
          previousPhase: 'PR CI',
          githubRun: prior.report.githubRun,
          sourceRun: run,
          log,
        };
      },
    };
  } catch (error) {
    console.error(
      '无法证明 PR 证据等价，主线重新执行适用检查。' + (error.stderr ? '' : ' ' + error.message),
    );
    return null;
  }
}
export function mergeVerified(cwd, args, verifyLocal) {
  if (args.length !== 1 || !/^\d+$/.test(args[0]))
    throw Error('用法：npm run verify:merge -- <PR 编号>');
  const repo = origin(cwd);
  const number = Number(args[0]);
  const pr = JSON.parse(
    gh(
      cwd,
      'pr',
      'view',
      args[0],
      '--repo',
      repo,
      '--json',
      'baseRefName,headRefOid,isCrossRepository,state,isDraft,statusCheckRollup',
    ),
  );
  if (
    pr.state !== 'OPEN' ||
    pr.isDraft ||
    pr.isCrossRepository ||
    pr.baseRefName !== 'main' ||
    git(cwd, ['rev-parse', 'HEAD']).trim() !== pr.headRefOid ||
    git(cwd, ['status', '--porcelain']).trim()
  )
    throw Error('须从该仓库干净的准确 PR 候选交付到 main。');
  const remote = git(cwd, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  if (git(cwd, ['rev-parse', 'refs/remotes/origin/main']).trim() !== remote)
    throw Error('远端 main 已变化，请获取并验证新的实际合并组合。');
  const tree = git(cwd, ['merge-tree', '--write-tree', remote, pr.headRefOid]).trim();
  const checksList = pr.statusCheckRollup || [];
  if (
    checksList.some((item) =>
      item.status
        ? item.status !== 'COMPLETED' || !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(item.conclusion)
        : item.state !== 'SUCCESS',
    )
  )
    throw Error('远端检查失败或仍在进行，不能合并。');
  const remoteGate = checksList.some(
    (item) => item.name === gate && item.status === 'COMPLETED' && item.conclusion === 'SUCCESS',
  );
  let evidence;
  if (remoteGate)
    evidence = prEvidence(
      cwd,
      repo,
      number,
      pr.headRefOid,
      remote,
      tree,
      planTree(cwd, remote, remote, tree),
    );
  if (evidence) evidence.close();
  else verifyLocal(inspect(cwd, 'refs/remotes/origin/main', 'assert-delivery'));
  gh(cwd, 'pr', 'merge', args[0], '--repo', repo, '--merge', '--match-head-commit', pr.headRefOid);
  return { pr: number, head: pr.headRefOid, base: remote, verification: evidence ? 'PR CI' : 'local' };
}
