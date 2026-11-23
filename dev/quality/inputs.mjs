import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, basename, join, relative, posix } from 'node:path';
import { parseEnv } from 'node:util';
import { checks } from './policy.mjs';
import { checkedCommand, digest } from './repository.mjs';

export function fileDigest(path) {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(128 * 1024);
  try {
    let n;
    while ((n = readSync(fd, chunk, 0, chunk.length, null)) > 0) h.update(chunk.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}
function installedTree(directory) {
  if (!existsSync(directory)) return null;
  const root = realpathSync(directory);
  const h = createHash('sha256');
  function visit(path) {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      if (path === root && ['.vite', '.vite-temp', '.cache'].includes(item.name)) continue;
      const file = join(path, item.name);
      const rel = relative(root, file);
      h.update(rel + '\0');
      if (item.isSymbolicLink()) {
        if (!realpathSync(file).startsWith(root + '/')) throw Error('依赖包含未登记的外部链接');
        h.update('link:' + readlinkSync(file));
      } else if (item.isDirectory()) {
        h.update('dir');
        visit(file);
      } else if (item.isFile()) h.update(fileDigest(file));
      else throw Error('未知依赖文件类型');
      h.update('\0');
    }
  }
  visit(root);
  return h.digest('hex');
}
function browserBinary(cwd) {
  const channel = process.env.PLAYWRIGHT_CHANNEL;
  if (channel === 'chrome') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/opt/google/chrome/chrome',
    ].find(existsSync);
  }
  if (channel) return null;
  return checkedCommand(cwd, process.execPath, [
    '-p',
    "require('playwright').chromium.executablePath()",
  ]);
}
function dotenvIdentity(cwd, name, family) {
  const data = readFileSync(join(cwd, name), 'utf8');
  if (
    family === 'database' ||
    data.includes('$') ||
    checkedCommand(cwd, 'git', ['hash-object', 'vite.config.js']) !==
      'e6878f2c10c8102b89b05dc4005139ea8d85bf66'
  )
    return digest(data);
  const values = parseEnv(data);
  for (const key of [
    'COMPOSE_PROJECT_NAME',
    'ZDM_DB_NAME',
    'ZDM_DB_PASSWORD',
    'ZDM_DB_ROOT_PASSWORD',
    'ZDM_LEDGER_AUTH_TOKEN',
  ])
    delete values[key];
  return digest(JSON.stringify(Object.entries(values).sort()));
}
function browserIdentity(binary) {
  if (!binary || !existsSync(binary)) return null;
  if (process.env.PLAYWRIGHT_CHANNEL === 'chrome') return fileDigest(binary);
  let dir = dirname(binary);
  while (!/^chromium-\d+$/.test(basename(dir))) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  const installed = dirname(dir);
  const shells = readdirSync(installed)
    .filter((name) => /^chromium_headless_shell-\d+$/.test(name))
    .sort();
  if (!shells.length) return null;
  return digest(
    JSON.stringify([fileDigest(binary), ...shells.map((name) => installedTree(join(installed, name)))]),
  );
}
function environment(cwd, family) {
  const fields = {
    node: process.versions,
    os: [platform(), arch(), release()],
    git: checkedCommand(cwd, 'git', ['--version']),
    image: [process.env.ImageOS, process.env.ImageVersion],
  };
  const supplied = Object.entries(process.env)
    .filter(([name]) =>
      /^(TZ$|LANG$|LC_|CI$|NODE_OPTIONS$|NODE_PATH$|PLAYWRIGHT_|VITE_|ZDM_(?!QUALITY_)|COMPOSE_|DOCKER_|TESTCONTAINERS_|JAVA_TOOL_OPTIONS$|MAVEN_OPTS$|npm_config_(?:arch|platform|build_from_source)$)/i.test(
        name,
      ),
    )
    .sort();
  fields.config = digest(JSON.stringify(supplied));
  let reusable = true;
  if (['frontend', 'browser', 'database'].includes(family)) {
    fields.envFiles = readdirSync(cwd)
      .filter((name) => /^\.env(?:\.|$)/.test(name))
      .sort()
      .map((name) => [name, dotenvIdentity(cwd, name, family)]);
  }
  if (['frontend', 'browser'].includes(family)) {
    try {
      fields.dependencies = installedTree(join(cwd, 'node_modules'));
    } catch {
      fields.dependencies = null;
    }
    reusable = Boolean(fields.dependencies);
  }
  if (family === 'browser') {
    const binary = browserBinary(cwd);
    try {
      fields.browser = browserIdentity(binary);
    } catch {
      fields.browser = null;
    }
    // Live proxy/data, arbitrary channels and workstation fonts are not portable browser fixtures.
    reusable &&= Boolean(
      fields.browser &&
      process.env.ImageOS &&
      process.env.ImageVersion &&
      !process.env.ZDM_API_PROXY_TARGET,
    );
  }
  if (family === 'database') {
    fields.engine = checkedCommand(cwd, 'docker', ['version', '--format', '{{.Server.Version}}']);
    fields.images = checkedCommand(cwd, 'docker', [
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      'mysql:8.0',
      'maven:3.9.9-eclipse-temurin-21',
    ]);
    const config = checkedCommand(cwd, 'docker', [
      'compose',
      '--profile',
      'tools',
      'config',
      '--format',
      'json',
    ]);
    fields.compose = config ? digest(config) : null;
    // The mutable Maven volume and Testcontainers fixtures have no independent content attestation.
    reusable = false;
  }
  return {
    identity: digest(JSON.stringify(fields)),
    reusable,
    platform: [platform(), arch(), process.version].join('/'),
  };
}
// Other spec files can be excluded when the selected suite has statically resolvable imports.
function scopedTestFiles(snapshot, id, args) {
  if (!['e2e','unit'].includes(id) || !args.length) return null;
  const files=new Set(snapshot.blobs.map(([p])=>p));
  const visited=new Set(), queue=[...args];
  if (queue.some(p=>!files.has(p) || !/\.(?:spec|test)\.[jt]sx?$/.test(p))) return null;
  while(queue.length) {
    const path=queue.pop();
    if(visited.has(path)) continue;
    visited.add(path);
    const src=readFileSync(join(snapshot.cwd,path),'utf8');
    if(/\b(?:import|require)\s*\(\s*[^'"]/.test(src)) return null;
    for(const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*|\b(?:require|import)\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const spec=m[1];
      if(!spec.startsWith('.') && !spec.startsWith('@/')) continue;
      const base=spec.startsWith('@/') ? 'src/'+spec.slice(2) : posix.join(posix.dirname(path),spec);
      const resolved=[base,...['.ts','.tsx','.js','.vue','/index.ts','/index.js'].map(e=>base+e)].find(p=>files.has(p));
      if(!resolved) return null;
      if(/\.(?:[jt]sx?|vue)$/.test(resolved)) queue.push(resolved);
    }
  }
  return visited;
}
export function inputReader(snapshot) {
  const contexts = new Map();
  return (id, args = []) => {
    const check = checks[id];
    if (!contexts.has(check.family)) contexts.set(check.family, environment(snapshot.cwd, check.family));
    const env = contexts.get(check.family);
    const scoped=scopedTestFiles(snapshot,id,args);
    const paths = snapshot.blobs.filter(([path]) => {
      if (scoped && /\.(?:spec|test)\.[jt]sx?$/.test(path)) return scoped.has(path);
      return check.inputs(path) || !knownDomain(path);
    });
    let source = digest(JSON.stringify(paths));
    if (id === 'diff' || id === 'docs') source = digest(JSON.stringify([snapshot.from, snapshot.tree]));
    const fingerprint = digest(JSON.stringify([id, args, snapshot.policy, source, env.identity]));
    return { fingerprint, source, ...env };
  };
}
function knownDomain(path) {
  return /^(src\/|public\/|tests\/|backend\/|infrastructure\/store-exit-ledger\/|dev\/|\.github\/workflows\/|docs\/(?:notes|task-notes)\/|README\.md$|CHANGELOG\.md$|index\.html$|(?:vite|vitest|playwright)\.config\.|tsconfig|(?:docker-compose|compose\.[^/]+)\.yml$)/.test(
    path,
  );
}
