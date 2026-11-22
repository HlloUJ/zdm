import { randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
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
function snapshotQuery(mysql) {
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
  const statements = ['SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'];
  for (const [table, columns] of tables) {
    statements.push("SELECT 'table:" + table + "'",
      "SELECT SHA2(CONCAT_WS(':', " + columns.join(', ') + '), 256) AS row_digest FROM ' +
      identifier(table) + ' ORDER BY row_digest');
  }
  statements.push('COMMIT');
  return statements.join(';\n') + ';\n';
}

function captureRows(stage, mysql, name) {
  const query = openSync(join(stage, 'snapshot.sql'), 'r');
  try {
    const result = openSync(join(stage, name), 'wx', 0o600);
    try {
      mysql(null, { stdio: [query, result, 'pipe'] });
    } finally {
      closeSync(result);
    }
  } finally {
    closeSync(query);
  }
}

export function rehearseMigration(directory, revision, backup, config, run) {
  const stage = mkdtempSync(join(dirname(backup), 'migration-preflight-'));
  const identity = 'zdm_acceptance_check_' + randomBytes(6).toString('hex');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COMPOSE_|ZDM_)/.test(key)));
  const compose = (...args) => run(stage, 'docker', [
    'compose', '-p', identity, '--env-file', '.env', '-f', 'docker-compose.yml', '-f', 'preflight.yml', ...args,
  ], { env });
  const mysql = (query, options = {}) => run(stage, 'docker', [
    'compose', '-p', identity, '--env-file', '.env', '-f', 'docker-compose.yml', '-f', 'preflight.yml',
    'exec', '-T', 'mysql', 'sh', '-ec',
    'export MYSQL_PWD="$MYSQL_PASSWORD"; exec mysql --quick -N -B -u "$MYSQL_USER" "$MYSQL_DATABASE" "$@"',
    'mysql', ...(query ? ['-e', query] : []),
  ], { env, ...options });

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
    const input = openSync(backup, 'r');
    try {
      mysql(null, { stdio: [input, 'pipe', 'pipe'] });
    } finally {
      closeSync(input);
    }

    writeFileSync(join(stage, 'snapshot.sql'), snapshotQuery(mysql), { mode: 0o600 });
    captureRows(stage, mysql, 'before.rows');
    compose('up', '-d', '--no-deps', '--build', 'ledger', 'backend');
    const health = compose('exec', '-T', 'backend', 'curl', '--fail', '--silent', '--show-error', '--max-time', '3',
      '--retry', '100', '--retry-delay', '2', '--retry-all-errors', 'http://127.0.0.1:8080/actuator/health');
    if (JSON.parse(health).status !== 'UP') throw new Error('迁移演练的候选后端未通过健康检查。');
    captureRows(stage, mysql, 'after.rows');
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
