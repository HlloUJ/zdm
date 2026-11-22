import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rehearseMigration } from './acceptance-migration.mjs';

const migrationDir = 'backend/src/main/resources/db/migration/';
const frontendInput = /^(src\/|public\/|index\.html$|vite\.config\.|tsconfig|package(?:-lock)?\.json$)/;
const backendInput = /^backend\/(src\/main\/|pom\.xml$)/;
const ledgerInput = /^infrastructure\/store-exit-ledger\//;
const composeInput = /^(docker-compose\.yml|compose\.private-migrations\.yml)$/;
const frontendService = 'com.zdm.local.acceptance-5274';
const frontendLabel = 'gui/' + process.getuid() + '/' + frontendService;
const loginURL = 'http://127.0.0.1:5274/login';
const healthURL = 'http://127.0.0.1:8281/actuator/health';

export function createRuntime(directory, run) {
  const privateDir = join(directory, '.private');
  const settings = JSON.parse(readFileSync(join(privateDir, 'acceptance-runtime.json'), 'utf8'));
  const git = (...args) => run(directory, 'git', args);
  const compose = (...args) => run(directory, 'docker', ['compose', ...args]);

  function checkBindings() {
    const config = JSON.parse(compose('config', '--format', 'json'));
    if (config.name !== settings.project) throw new Error('5274 Compose 项目与登记不一致。');
    for (const name of ['database', 'media', 'ledger']) {
      const mount = config.volumes[name];
      if (!mount?.external || mount.name !== settings.volumes[name]) {
        throw new Error('5274 持久卷绑定不同，更新已停止：' + name);
      }
    }
    if (config.services.mysql.environment.MYSQL_DATABASE !== settings.database) {
      throw new Error('5274 数据库与登记不一致。');
    }
    for (const [service, source, destination] of [
      ['mysql', 'database', '/var/lib/mysql'],
      ['backend', 'media', '/data/zdm/craft-images'],
      ['ledger', 'ledger', '/data/store-exit-ledger'],
    ]) {
      const mount = config.services[service].volumes.find((volume) => volume.target === destination);
      if (mount?.type !== 'volume' || mount.source !== source) {
        throw new Error('5274 服务挂载与登记不一致：' + service);
      }
    }
    const backend = config.services.backend;
    if (!backend.environment.ZDM_DB_URL.startsWith('jdbc:mysql://mysql:3306/' + settings.database + '?')
      || !backend.ports.some((port) => port.host_ip === '127.0.0.1' && String(port.published) === '8281' && port.target === 8080)
      || !backend.volumes.some((volume) => volume.type === 'bind' && volume.source === join(directory, 'backend')
        && volume.target === '/workspace/backend')) {
      throw new Error('5274 后端源码、端口或数据库连接与登记不一致。');
    }
    return config;
  }

  function checkRunningBindings() {
    const frontend = run(directory, 'launchctl', ['print', frontendLabel]);
    if (!frontend.split('\n').some((line) => line.trim() === 'working directory = ' + directory)) {
      throw new Error('5274 前端运行目录与登记不一致。');
    }
    const mounts = [
      ['backend', '/workspace/backend', join(directory, 'backend'), 'bind'],
      ['backend', '/data/zdm/craft-images', settings.volumes.media, 'volume'],
      ['mysql', '/var/lib/mysql', settings.volumes.database, 'volume'],
      ['ledger', '/data/store-exit-ledger', settings.volumes.ledger, 'volume'],
    ];
    for (const service of ['backend', 'mysql', 'ledger']) {
      const id = compose('ps', '-q', service);
      if (!id) throw new Error('5274 缺少运行中的服务：' + service);
      const actual = JSON.parse(run(directory, 'docker', ['inspect', '--format', '{{json .Mounts}}', id]));
      for (const [, destination, source, type] of mounts.filter(([owner]) => owner === service)) {
        if (!actual.some((mount) => mount.Destination === destination && mount.Type === type &&
          (type === 'volume' ? mount.Name : mount.Source.replace(/^\/host_mnt/, '')) === source)) {
          throw new Error('5274 运行容器使用了不同的源码或持久卷：' + service + ' ' + destination);
        }
      }
    }
  }

  function probe(url, backend = false) {
    const body = run(directory, 'curl', [
      '--noproxy', '*', '--fail', '--silent', '--show-error', '--max-time', '3',
      '--retry', '25', '--retry-delay', '2', '--retry-max-time', '55', '--retry-connrefused', url,
    ]);
    if (backend ? JSON.parse(body).status !== 'UP' : !body.includes('<div id="app">')) {
      throw new Error('5274 健康检查返回意外内容：' + url);
    }
  }

  function dependencies(revision) {
    const manifest = git('show', revision + ':package.json');
    const lock = git('show', revision + ':package-lock.json');
    const hash = createHash('sha256').update(manifest + '\0' + lock).digest('hex');
    const cache = join(privateDir, 'frontend-dependencies', hash);
    if (!existsSync(join(cache, 'node_modules', 'vite', 'bin', 'vite.js'))) {
      mkdirSync(join(privateDir, 'frontend-dependencies'), { recursive: true });
      const temporary = mkdtempSync(cache + '-');
      try {
        writeFileSync(join(temporary, 'package.json'), manifest + '\n');
        writeFileSync(join(temporary, 'package-lock.json'), lock + '\n');
        run(temporary, 'npm', ['ci', '--prefer-offline', '--no-audit'], { stdio: 'inherit' });
        renameSync(temporary, cache);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
    return join(cache, 'node_modules');
  }

  function useDependencies(revision) {
    const target = dependencies(revision);
    const link = join(directory, 'node_modules.acceptance-next');
    rmSync(link, { force: true });
    symlinkSync(target, link, 'dir');
    renameSync(link, join(directory, 'node_modules'));
  }

  function recordBackup() {
    const backups = join(privateDir, 'migration-backups');
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    const dump = join(backups, new Date().toISOString().replaceAll(':', '-') + '.sql');
    const output = openSync(dump + '.partial', 'wx', 0o600);
    try {
      run(directory, 'docker', ['compose', 'exec', '-T', 'mysql', 'sh', '-ec',
        'export MYSQL_PWD="$MYSQL_PASSWORD"; exec mysqldump --single-transaction --no-tablespaces --set-gtid-purged=OFF -u "$MYSQL_USER" "$MYSQL_DATABASE"',
      ], { stdio: ['ignore', output, 'pipe'] });
    } finally {
      closeSync(output);
    }
    renameSync(dump + '.partial', dump);
    console.log('已保存 5274 迁移前的数据库备份：' + dump);
    return dump;
  }

  return {
    installDependencies: useDependencies,
    check() {
      checkBindings();
      probe(healthURL, true);
      probe(loginURL);
      checkRunningBindings();
    },
    prepare(previous, candidate, changed) {
      const config = checkBindings();
      if (!existsSync(join(directory, 'node_modules'))) dependencies(previous);
      if (changed.some((file) => frontendInput.test(file))) dependencies(candidate);
      const migrations = changed.filter((file) => file.startsWith(migrationDir));
      if (migrations.length) {
        const existing = new Set(git('ls-tree', '-r', '--name-only', previous, migrationDir).split('\n'));
        if (migrations.some((file) => existing.has(file))) {
          throw new Error('候选会修改已展示的迁移。当前验收库保留原状，请先完成该迁移的隔离验证与兼容修订。');
        }
        rehearseMigration(directory, candidate, recordBackup(), config, run);
      }
    },
    reload(changed) {
      checkBindings();
      if (changed.some((file) => ledgerInput.test(file) || composeInput.test(file))) {
        compose('up', '-d', '--no-deps', '--build', 'ledger');
      }
      if (changed.some((file) => backendInput.test(file) || ledgerInput.test(file) || composeInput.test(file))) {
        compose('up', '-d', '--no-deps', '--force-recreate', 'backend');
      }
      if (changed.some((file) => frontendInput.test(file))) {
        useDependencies(git('rev-parse', 'HEAD'));
        run(directory, 'launchctl', ['kickstart', '-k', frontendLabel]);
      }
    },
  };
}
