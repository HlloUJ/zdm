import { randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function checkIsolation(config, identity, stage, historicalMigrations) {
  const privateResource = value => !value.external && value.name?.startsWith(identity + '_');
  const ownVolumes = Object.entries(config.volumes).every(([key, volume]) =>
    privateResource(volume) && volume.name === identity + '_' + key && !volume.driver_opts &&
    !Object.hasOwn(volume.labels ?? {}, 'com.zdm.retained-data'));
  if (config.name !== identity || !ownVolumes || !Object.values(config.networks).every(privateResource)) {
    throw new Error('迁移演练未能确认独立的项目、卷和网络。');
  }
  for (const [service, source, destination] of [
    ['mysql', 'database', '/var/lib/mysql'],
    ['backend', 'media', '/data/zdm/craft-images'],
    ['ledger', 'ledger', '/data/store-exit-ledger'],
  ]) {
    const { volumes, ports } = config.services[service];
    const data = volumes.find(m => m.target === destination);
    const isolated = volumes.every(m => {
      if (m.type === 'volume') return Object.hasOwn(config.volumes, m.source);
      if (m.type !== 'bind' || service !== 'backend') return false;
      return (m.target === '/workspace/backend' && m.source === join(stage, 'backend')) ||
        (m.read_only && historicalMigrations.some(original => original.source === m.source && original.target === m.target));
    });
    if (!isolated || data?.type !== 'volume' || data.source !== source || ports?.length) {
      throw new Error('迁移演练未能确认服务使用独立挂载和端口：' + service);
    }
  }
}

// Use the original columns on both sides so additive schema changes are allowed.
// Ordered, fixed-width row digests preserve duplicate rows and distinguish NULL from an empty value.
function snapshotQueries(mysql, observer) {
  const metadata = mysql(
    'SELECT HEX(c.TABLE_NAME), HEX(c.COLUMN_NAME) FROM information_schema.COLUMNS c ' +
    'JOIN information_schema.TABLES t USING (TABLE_SCHEMA, TABLE_NAME) ' +
    "WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE' AND c.TABLE_NAME <> 'flyway_schema_history' " +
    'ORDER BY BINARY c.TABLE_NAME, c.ORDINAL_POSITION');
  const tables = new Map();
  const identifier = hex => '`' + Buffer.from(hex, 'hex').toString('utf8').replaceAll('`', '``') + '`';
  for (const line of metadata.split('\n').filter(Boolean)) {
    const [table, column] = line.split('\t');
    if (!tables.has(table)) tables.set(table, []);
    tables.get(table).push("COALESCE(SHA2(CAST(" + identifier(column) + " AS BINARY), 256), 'NULL')");
  }
  const transaction = ['SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'];
  const before = [...transaction, "SELECT 'observed'"];
  const after = [...transaction, "SELECT 'observed' FROM " + observer + ' WHERE table_no = 0'];
  const callback = ['CREATE TABLE ' + observer + ' (table_no INT NOT NULL, row_digest BINARY(32), INDEX(table_no, row_digest))',
    'INSERT INTO ' + observer + ' VALUES (0, NULL)'];
  let number = 0;
  for (const [table, columns] of tables) {
    number++;
    const name = identifier(table);
    const digest = "SHA2(CONCAT_WS(':', " + columns.join(', ') + '), 256)';
    const marker = "SELECT 'table:" + table + "'";
    const count = "SELECT CONCAT('rows:', COUNT(*)) FROM " + name;
    before.push(marker, count, 'SELECT ' + digest + ' AS row_digest FROM ' + name + ' ORDER BY row_digest');
    // Flyway takes this observation before application schedulers can legitimately update the restored data.
    callback.push('INSERT INTO ' + observer + ' SELECT ' + number + ', UNHEX(' + digest + ') FROM ' + name);
    after.push(marker, count, 'SELECT LOWER(HEX(row_digest)) FROM ' + observer + ' WHERE table_no = ' + number + ' ORDER BY row_digest');
  }
  const sql = statements => statements.join(';\n') + ';\n';
  return { before: sql([...before, 'COMMIT']), callback: sql(callback), after: sql([...after, 'COMMIT']) };
}

function withFile(path, flags, action) {
  const fd = openSync(path, flags, 0o600);
  try {
    return action(fd);
  } finally {
    closeSync(fd);
  }
}

function captureRows(stage, mysql, sql, name) {
  const path = join(stage, 'snapshot.sql');
  writeFileSync(path, sql, { mode: 0o600 });
  withFile(path, 'r', query =>
    withFile(join(stage, name), 'wx', result => mysql(null, { stdio: [query, result, 'pipe'] })));
}

const fileStores = [['backend', '/data/zdm/craft-images'], ['ledger', '/data/store-exit-ledger']];
const inStore = (path, command) => ['sh', '-ec', 'cd "$1"; ' + command, 'snapshot', path];

function copyFiles(directory, stage, run, project) {
  for (const [service, path] of fileStores) {
    const source = (args, fd) => run(directory, 'docker', ['compose', 'exec', '-T', service, ...args],
      { stdio: ['ignore', fd, 'pipe'] });
    withFile(join(stage, service + '.sha256'), 'wx', fd =>
      source(inStore(path, 'exec find . -type f -exec sha256sum {} +'), fd));
    const archive = join(stage, service + '.tar');
    withFile(archive, 'wx', fd => source(['tar', '-C', path, '-cf', '-', '.'], fd));
    withFile(archive, 'r', fd =>
      project(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', service, '-C', path, '-xf', '-'],
        { stdio: [fd, 'ignore', 'pipe'] }));
  }
}

function verifyFiles(stage, project) {
  for (const [service, path] of fileStores) {
    const manifest = join(stage, service + '.sha256');
    if (!statSync(manifest).size) continue;
    try {
      withFile(manifest, 'r', fd => project(['exec', '-T', service, ...inStore(path, 'exec sha256sum -c -')],
        { stdio: [fd, 'ignore', 'pipe'] }));
    } catch (error) {
      throw new Error('迁移演练未能确认原文件保持完整：' + service, { cause: error });
    }
  }
}

export function rehearseMigration(directory, revision, backup, config, run) {
  const stage = mkdtempSync(join(dirname(backup), 'migration-preflight-'));
  const identity = 'zdm_acceptance_check_' + randomBytes(6).toString('hex');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COMPOSE_|ZDM_)/.test(key)));
  const project = (args, options = {}) => run(stage, 'docker', [
    'compose', '-p', identity, '--env-file', '.env', '-f', 'docker-compose.yml', '-f', 'preflight.yml', ...args,
  ], { env, ...options });
  const compose = (...args) => project(args);
  const mysql = (query, options = {}) => project([
    'exec', '-T', 'mysql', 'sh', '-ec',
    'export MYSQL_PWD="$MYSQL_PASSWORD"; exec mysql --quick -N -B -u "$MYSQL_USER" "$MYSQL_DATABASE" "$@"',
    'mysql', ...(query ? ['-e', query] : []),
  ], options);

  let created = false;
  try {
    run(directory, 'git', ['archive', '-o', join(stage, 'candidate.tar'), revision]);
    run(stage, 'tar', ['-xf', 'candidate.tar']);
    run(stage, process.execPath, ['dev/init-env.mjs', '5274', '8281'], { env });
    const historicalMigrations = config.services.backend.volumes.filter((mount) =>
      mount.type === 'bind' && mount.read_only &&
      /\/db\/migration\/V(5|132)__[^/]+\.sql$/.test(mount.target));
    const unbound = [
      'services:',
      '  backend:',
      '    ports: !reset []',
      '    volumes: ' + JSON.stringify(historicalMigrations),
      'volumes:',
      '  ledger:',
      '    labels: !reset {}',
    ].join('\n');
    writeFileSync(join(stage, 'preflight.yml'), unbound + '\n');
    const isolated = JSON.parse(compose('config', '--format', 'json'));
    checkIsolation(isolated, identity, stage, historicalMigrations);
    created = true;
    compose('up', '-d', '--no-deps', '--wait', 'mysql');
    withFile(backup, 'r', fd => mysql(null, { stdio: [fd, 'pipe', 'pipe'] }));

    const queries = snapshotQueries(mysql, identity + '_rows');
    captureRows(stage, mysql, queries.before, 'before.rows');
    const callbacks = join(stage, 'backend/src/main/resources/db/migration');
    writeFileSync(join(callbacks, 'afterMigrate__zz_' + identity + '.sql'), queries.callback, { flag: 'wx', mode: 0o600 });
    compose('build', 'ledger');
    copyFiles(directory, stage, run, project);
    compose('up', '-d', '--no-deps', 'ledger', 'backend');
    const health = compose('exec', '-T', 'backend', 'curl', '--fail', '--silent', '--show-error', '--max-time', '3',
      '--retry', '100', '--retry-delay', '2', '--retry-all-errors', 'http://127.0.0.1:8080/actuator/health');
    if (JSON.parse(health).status !== 'UP') throw new Error('迁移演练的候选后端未通过健康检查。');
    captureRows(stage, mysql, queries.after, 'after.rows');
    verifyFiles(stage, project);
    try {
      run(stage, 'cmp', ['-s', 'before.rows', 'after.rows']);
    } catch (error) {
      throw new Error('迁移演练未能确认已有数据保持一致，暂未更新 5274。', { cause: error });
    }
  } finally {
    if (created) {
      try {
        compose('down', '--volumes');
      } catch (error) {
        throw new Error('迁移演练环境尚未完成清理：' + stage, { cause: error });
      }
    }
    rmSync(stage, { recursive: true, force: true });
  }
}
