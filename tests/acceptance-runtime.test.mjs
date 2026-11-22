import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntime } from '../dev/acceptance-runtime.mjs';

// Exercise the production binding checker through its command boundary, without touching 5274.
test('5274 verifies the running source, database, media and ledger as well as HTTP health', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'zdm-binding-contract-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, '.private'));
  const settings = {
    project: 'fixture',
    database: 'fixture_data',
    volumes: { database: 'existing-db', media: 'existing-media', ledger: 'existing-ledger' },
  };
  writeFileSync(join(directory, '.private/acceptance-runtime.json'), JSON.stringify(settings));
  const volume = (source, target) => ({ type: 'volume', source, target });
  const services = {
    mysql: {
      environment: { MYSQL_DATABASE: settings.database },
      volumes: [volume('database', '/var/lib/mysql')],
    },
    backend: {
      environment: { ZDM_DB_URL: 'jdbc:mysql://mysql:3306/fixture_data?x=1' },
      ports: [{ host_ip: '127.0.0.1', published: '8281', target: 8080 }],
      volumes: [
        volume('media', '/data/zdm/craft-images'),
        { type: 'bind', source: join(directory, 'backend'), target: '/workspace/backend' },
      ],
    },
    ledger: { volumes: [volume('ledger', '/data/store-exit-ledger')] },
  };
  const config = {
    name: 'fixture',
    services,
    volumes: Object.fromEntries(
      Object.entries(settings.volumes).map(([key, name]) => [key, { external: true, name }]),
    ),
  };
  const mounts = Object.fromEntries(
    Object.entries(services).map(([key, svc]) => [
      key,
      svc.volumes.map((m) => ({
        Destination: m.target,
        Type: m.type,
        Name: settings.volumes[m.source],
        Source: m.source,
      })),
    ]),
  );
  let health = 'UP';
  const run = (cwd, cmd, args) => {
    assert.equal(cwd, directory);
    if (cmd === 'curl')
      return args.at(-1).includes('/health') ? JSON.stringify({ status: health }) : '<div id="app">';
    if (cmd === 'launchctl') return 'working directory = ' + directory;
    if (cmd === 'docker' && args[1] === 'config') return JSON.stringify(config);
    if (cmd === 'docker' && args[1] === 'ps') return args.at(-1);
    if (cmd === 'docker' && args[0] === 'inspect') return JSON.stringify(mounts[args.at(-1)]);
    throw Error('unexpected fixture command ' + cmd);
  };
  const runtime = createRuntime(directory, run);
  runtime.check();
  for (const [service, key] of [
    ['mysql', 'database'],
    ['backend', 'media'],
    ['ledger', 'ledger'],
  ]) {
    const mount = mounts[service].find((m) => m.Type === 'volume');
    mount.Name = 'unrelated';
    assert.throws(() => runtime.check(), /运行容器/);
    mount.Name = settings.volumes[key];
  }
  services.mysql.environment.MYSQL_DATABASE = 'different';
  assert.throws(() => runtime.check(), /数据库/);
  services.mysql.environment.MYSQL_DATABASE = settings.database;
  health = 'DOWN';
  assert.throws(() => runtime.check(), /健康/);
  health = 'UP';
  runtime.check();
});
