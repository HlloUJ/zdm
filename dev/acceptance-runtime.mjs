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
  const databaseUrl = 'jdbc:mysql://mysql:3306/' + settings.database;
  const usesDatabase = url => url === databaseUrl || url?.startsWith(databaseUrl + '?');

  function checkBindings() {
    const config = JSON.parse(compose('config', '--format', 'json'));
    if (config.name !== settings.project) throw new Error('5274 Compose 项目与登记不一致。');
    for (const name of ['database', 'media', 'ledger']) {
      const mount = config.volumes[name];
      if (!mount?.external || mount.name !== settings.volumes[name]) {
        throw new Error('5274 持久卷绑定不同，更新已停止：' + name);
      }
    }
    if (config.services.mysql.environment.MYSQL_DATABASE !== settings.database ||
        config.services.ledger.environment.ZDM_LEDGER_NAMESPACE !== settings.database) {
      throw new Error('5274 数据库或退出账本命名空间与登记不一致。');
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
    if (!usesDatabase(backend.environment.ZDM_DB_URL)
      || !backend.ports.some((port) => port.host_ip === '127.0.0.1' && String(port.published) === '8281' && port.target === 8080)
      || !backend.volumes.some((volume) => volume.type === 'bind' && volume.source === join(directory, 'backend')
        && volume.target === '/workspace/backend')) {
      throw new Error('5274 后端源码、端口或数据库连接与登记不一致。');
    }
    return config;
  }

  function checkRunningBindings(allowMissing = false) {
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
    for (const [service, key] of [['backend', 'ZDM_DB_URL'], ['mysql', 'MYSQL_DATABASE'], ['ledger', 'ZDM_LEDGER_NAMESPACE']]) {
      const id = compose('ps', ...(allowMissing ? ['--all'] : []), '-q', service);
      // Recovery may need to recreate a missing service. Check every container that still exists, including stopped ones.
      if (!id && allowMissing) continue;
      if (!id) throw new Error('5274 缺少运行中的服务：' + service);
      const format = '{{json .Mounts}}\n{{range .Config.Env}}{{if eq (index (split . "=") 0) "' +
        key + '"}}{{println .}}{{end}}{{end}}';
      const [mountsJson, variable] = run(directory, 'docker', ['inspect', '--format', format, id]).split('\n');
      const binding = variable?.startsWith(key + '=') ? variable.slice(key.length + 1) : '';
      if (service === 'backend' ? !usesDatabase(binding) : binding !== settings.database) {
        throw new Error('5274 运行容器的数据库或退出账本身份不同：' + service);
      }
      const actual = JSON.parse(mountsJson);
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
      '--retry', '35', '--retry-delay', '2', '--retry-max-time', '75', '--retry-all-errors', url,
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
    const gitCommon = git('rev-parse', '--path-format=absolute', '--git-common-dir');
    const backups = join(gitCommon, 'zdm-acceptance-data');
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
      checkRunningBindings();
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
      if (changed.some(file => [frontendInput, backendInput, ledgerInput, composeInput].some(input => input.test(file)))) {
        checkRunningBindings(true);
      }
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
