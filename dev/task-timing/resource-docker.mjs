import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  openSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { read, rootFor, writeJson } from '../quality/timing-events.mjs';
import { command, containers, docker } from './resource-host.mjs';

const projectLabel = 'com.docker.compose.project',
  labelPrefix = 'com.docker.compose.';
const words = (s) => s.split(/\s+/).filter(Boolean);
export function engineIdentity(run = docker) {
  const context = run('context', 'show'),
    engine = run('info', '--format', '{{.ID}}');
  if (!context || !engine || engine === '<no value>') throw Error('无法确认 Docker 上下文及守护进程');
  return context + '/' + engine;
}
const inspect = (run, type, id) => JSON.parse(run(type, 'inspect', id))[0];
const stamp = (o, type) => (type === 'volume' ? o.CreatedAt : o.Id);
const labels = (o, type) => (type === 'image' ? o.Config?.Labels : o.Labels) ?? {};
const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function testVolume(v, run) {
  if (!/^zdm-test-\d+-[a-f0-9-]{36}$/.test(v.name) || engineIdentity(run) !== v.engine)
    throw Error('临时测试卷的创建身份不同');
  if (!words(run('volume', 'ls', '-q')).includes(v.name)) return null;
  const obj = inspect(run, 'volume', v.name),
    tags = obj.Labels ?? {};
  if (
    tags['com.zdm.temporary-test'] !== v.token ||
    tags['com.zdm.retained-data'] ||
    (v.created && obj.CreatedAt !== v.created)
  )
    throw Error('临时卷已被替换或被标记保留');
  return obj;
}
export function createTestVolume(v, run = docker) {
  let obj = testVolume(v, run);
  if (!obj) {
    if (v.created) throw Error('登记的临时卷已消失');
    run('volume', 'create', '--label', 'com.zdm.temporary-test=' + v.token, v.name);
    obj = testVolume(v, run);
  }
  v.created = obj.CreatedAt;
}
export function retireTestVolume(v, run = docker) {
  if (!testVolume(v, run)) return false;
  if (run('ps', '-aq', '--filter', 'volume=' + v.name)) throw Error('临时卷仍被容器引用');
  run('volume', 'rm', v.name);
  return true;
}
function inventory(env, run, live) {
  const filter = 'label=' + projectLabel + '=' + env.project;
  const items = [];
  for (const c of live.filter((c) => c.labels?.[projectLabel] === env.project)) {
    items.push({ type: 'container', name: c.name, id: c.id });
  }
  for (const type of ['volume', 'network', 'image']) {
    const ids = words(
      run(type, 'ls', '-q', ...(type === 'volume' ? [] : ['--no-trunc']), '--filter', filter),
    );
    for (const id of new Set(ids)) {
      const obj = inspect(run, type, id);
      if (labels(obj, type)[projectLabel] !== env.project) throw Error('Docker 资源归属变化');
      items.push({ type, name: type === 'volume' ? obj.Name : id, id: stamp(obj, type) });
    }
  }
  return items;
}
function saveMaven(common, id, item, trees, live, run) {
  const taskDir = join(rootFor(common), id);
  const retained = join(rootFor(common), 'maven-objects');
  mkdirSync(retained, { recursive: true, mode: 0o700 });
  if (realpathSync(retained) !== retained) throw Error('制品保全目录不可使用链接');
  const stage = mkdtempSync(join(taskDir, '.maven-' + randomUUID() + '-'));
  const refs = [
    ...new Set(
      live
        .filter(
          (c) =>
            c.state === 'running' &&
            [dirname(common), read(join(common, 'zdm-acceptance.json'))?.directory].includes(
              c.labels?.[projectLabel + '.working_dir'],
            ),
        )
        .flatMap((c) =>
          c.mounts.filter((m) => m.Type === 'volume' && m.Destination === '/root/.m2').map((m) => m.Name),
        ),
    ),
  ];
  try {
    if (!refs.length || refs.includes(item.name)) throw Error('无法确认独立的常驻 Maven 卷');
    const image = run('image', 'inspect', 'node:24-alpine', '--format', '{{.Id}}');
    const mounts = [
      '--mount',
      'type=volume,src=' + item.name + ',dst=/candidate,readonly,volume-nocopy',
      '--mount',
      'type=bind,src=' + stage + ',dst=/save',
    ];
    for (const [n, ref] of refs.entries())
      mounts.push('--mount', 'type=volume,src=' + ref + ',dst=/refs/' + n + ',readonly,volume-nocopy');
    const raw = command(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--pull=never',
        '--network',
        'none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user',
        process.getuid() + ':' + process.getgid(),
        ...mounts,
        '--entrypoint',
        'node',
        image,
        '--input-type=module',
        '-',
      ],
      {
        input: readFileSync(new URL('./maven-delta.mjs', import.meta.url)),
      },
    );
    const files = JSON.parse(raw);
    for (const { sha256 } of files) {
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw Error('保全摘要无效');
      const target = join(retained, sha256);
      if (!existsSync(target)) {
        try {
          linkSync(join(stage, sha256), target);
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
      }
      if (!lstatSync(target).isFile() || digest(target) !== sha256) throw Error('独立保全内容不一致');
    }
    const name = 'maven-' + item.name + '.json';
    writeJson(
      taskDir,
      name,
      { volume: item.name, created: item.id, references: refs, files },
      { replace: true },
    );
    return { receipt: name, uniqueFiles: files.length };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
function keepContainerLogs(common, id, item) {
  if (!/^[a-f0-9]{64}$/.test(item.id)) throw Error('容器 ID 不完整');
  const dir = join(rootFor(common), id);
  const stage = mkdtempSync(join(dir, '.retired-logs-'));
  try {
    const files = ['stdout', 'stderr'].map((stream) => join(stage, stream));
    const fds = files.map((path) => openSync(path, 'wx', 0o600));
    try {
      const result = spawnSync('docker', ['logs', '--timestamps', item.id], { stdio: ['ignore', ...fds] });
      if (result.error || result.status !== 0) throw Error('无法保全容器日志');
    } finally {
      fds.forEach((fd) => closeSync(fd));
    }
    for (const path of files) {
      if (!lstatSync(path).size) continue;
      const sha = digest(path),
        target = join(dir, 'container-' + item.id + '-' + path.split('/').pop() + '-' + sha + '.log');
      if (!existsSync(target)) linkSync(path, target);
      if (digest(target) !== sha) throw Error('容器日志保全失败');
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
export function collectCompose(
  common,
  id,
  state,
  trees,
  { run = docker, scan = containers, preserve = saveMaven, keepLogs = keepContainerLogs } = {},
) {
  const env = state.environment,
    project = env.project;
  if (!/^zdm-dev-[0-9a-f]{16}$/.test(project) || !env.engine || engineIdentity(run) !== env.engine)
    throw Error('无法确认创建时的 Docker 守护进程');
  if (read(join(common, 'zdm-acceptance.json'))?.directory) {
    for (const tree of trees) {
      const path = join(tree, '.env');
      if (
        existsSync(path) &&
        readFileSync(path, 'utf8')
          .split(/\r?\n/)
          .some((line) => {
            const value = line.match(/^\s*(?:export\s+)?COMPOSE_PROJECT_NAME\s*=\s*([^#]*)/);
            return value && value[1].trim().replace(/^['"]|['"]$/g, '') === project;
          })
      )
        throw Error('Compose 项目仍由工作区使用：' + tree);
    }
    const info = join(
      read(join(common, 'zdm-acceptance.json')).directory,
      '.private/acceptance-runtime.json',
    );
    if (read(info)?.project === project) throw Error('5274 的常驻 Compose 项目受保护');
  }
  const removed = [],
    retained = [],
    pending = [];
  const first = scan(run);
  if (
    first.some(
      (c) =>
        c.labels?.[projectLabel] === project &&
        c.labels?.[projectLabel + '.working_dir'] !== state.workspace.path,
    )
  )
    throw Error('同名 Compose 项目存在其他工作目录的容器');
  if (!env.items) {
    env.items = inventory(env, run, first);
    writeJson(join(rootFor(common), id), 'resources-v1.json', state, { replace: true });
  }
  for (const item of env.items) {
    const { type, name } = item;
    try {
      if (type === 'container') {
        const c = scan(run).find((c) => c.id === item.id);
        if (!c) continue;
        if (
          c.labels?.[projectLabel] !== project ||
          c.labels?.[projectLabel + '.working_dir'] !== state.workspace.path ||
          c.state !== 'exited' ||
          run('diff', item.id)
        )
          throw Error('容器仍在用或可写层有独有资料');
        keepLogs(common, id, item);
        const same = scan(run).find((c) => c.id === item.id);
        if (same?.state !== 'exited' || run('diff', item.id)) throw Error('容器在保全期间发生变化');
        run('container', 'rm', item.id);
      } else {
        const identifiers = words(run(type, 'ls', '-q', ...(type === 'volume' ? [] : ['--no-trunc'])));
        if (!identifiers.includes(name)) continue;
        const obj = inspect(run, type, name),
          data = labels(obj, type);
        if (data[projectLabel] !== project || stamp(obj, type) !== item.id)
          throw Error('对象已被替换，保留新对象');
        if (type === 'volume') {
          if (
            data['com.zdm.retained-data'] ||
            data[labelPrefix + 'volume'] !== 'maven' ||
            name !== project + '_maven'
          ) {
            retained.push({ object: name, reason: '持久数据卷或用途未核实' });
            continue;
          }
          if (obj.Driver !== 'local' || Object.keys(obj.Options ?? {}).length)
            throw Error('卷使用其他存储配置');
          if (
            !Number.isFinite(Date.parse(obj.CreatedAt)) ||
            Date.parse(obj.CreatedAt) < Math.floor(env.at / 1000) * 1000
          )
            throw Error('卷早于任务环境');
          const live = scan(run);
          if (live.some((c) => c.mounts.some((m) => m.Name === name))) throw Error('卷仍被挂载');
          preserve(common, id, item, trees, live, run);
          if (
            stamp(inspect(run, type, name), type) !== item.id ||
            scan(run).some((c) => c.mounts.some((m) => m.Name === name))
          )
            throw Error('卷在核对期间发生变化');
        } else if (type === 'network') {
          if (
            obj.Name !== project + '_default' ||
            data[labelPrefix + 'network'] !== 'default' ||
            Object.keys(obj.Containers ?? {}).length
          )
            throw Error('网络非专属默认空网络');
        } else if (type === 'image') {
          if (
            data[labelPrefix + 'service'] !== 'ledger' ||
            obj.RepoTags?.length !== 1 ||
            obj.RepoTags[0] !== project + '-ledger:latest' ||
            scan(run).some((c) => c.image === item.id)
          )
            throw Error('镜像仍有其他引用或无法证明可重建');
        }
        run(type, 'rm', type === 'volume' ? name : item.id);
      }
      removed.push(type + ' ' + name);
    } catch (e) {
      pending.push({ object: type + ' ' + name, reason: e.message });
    }
  }
  return { removed, retained, pending };
}
