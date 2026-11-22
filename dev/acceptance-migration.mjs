import { randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
    'export MYSQL_PWD="$MYSQL_PASSWORD"; exec mysql -N -B -u "$MYSQL_USER" "$MYSQL_DATABASE" "$@"',
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
    ].join('\n');
    writeFileSync(join(stage, 'preflight.yml'), unbound + '\n');
    const isolated = JSON.parse(compose('config', '--format', 'json'));
    if (isolated.name !== identity || isolated.services.backend.ports?.length ||
        Object.values(isolated.volumes).some((volume) => volume.external || !volume.name.startsWith(identity + '_')) ||
        Object.values(isolated.networks).some((network) => network.external || !network.name.startsWith(identity + '_'))) {
      throw new Error('迁移演练未能确认使用独立的临时数据库和媒体卷。');
    }
    created = true;
    compose('up', '-d', '--wait', 'mysql');
    const input = openSync(backup, 'r');
    try {
      mysql(null, { stdio: [input, 'pipe', 'pipe'] });
    } finally {
      closeSync(input);
    }

    const list = mysql("SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
    const tables = list.split('\n').filter((table) => table && table !== 'flyway_schema_history');
    const countQuery = tables.map((table) => 'SELECT COUNT(*) FROM `' + table.replaceAll('`', '``') + '`').join(';');
    const before = mysql(countQuery);
    compose('up', '-d', '--build', 'backend');
    compose('exec', '-T', 'backend', 'curl', '--fail', '--silent', '--show-error', '--max-time', '3',
      '--retry', '100', '--retry-delay', '2', '--retry-all-errors', 'http://127.0.0.1:8080/actuator/health');
    const after = mysql(countQuery);
    if (before !== after) throw new Error('迁移演练发现已有数据表的记录数变化，暂未更新 5274。');
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
