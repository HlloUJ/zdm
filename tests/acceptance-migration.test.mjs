import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rehearseMigration } from '../dev/acceptance-migration.mjs';

const dbPath = '/var/lib/mysql';
const imagePath = '/data/zdm/craft-images';
const ledgerPath = '/data/store-exit-ledger';
const named = (source, target) => ({ type: 'volume', source, target });
const rawHex = value => Buffer.from(value).toString('hex').toUpperCase();

// Model the Compose and SQL client boundaries. Real MySQL executes the same queries in the R4 rehearsal.
function fixture(t, { imageAfter = 'kept.jpg', rowsAfter = 1, changeConfig = () => {}, healthy = true, failStart = false, failCleanup = false, sharedImage = false, changedFile } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zdm-migration-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backup = join(dir, 'original.sql');
  writeFileSync(backup, 'isolated fixture');
  const operations = [];
  let candidateRunning = false;
  let stage, projectName, built = false;
  const imageId = 'sha256:'+'e'.repeat(64);
  function run(cwd, program, args, options) {
    if (program === 'tar') mkdirSync(join(cwd, 'backend/src/main/resources/db/migration'), { recursive: true });
    if (program === 'git' || program === 'tar' || program === process.execPath) return '';
    if (program === 'cmp') return execFileSync(program, args, { cwd });
    assert.equal(program, 'docker');
    if (cwd === dir) {
      assert.deepEqual(args.slice(0, 3), ['compose', 'exec', '-T']);
      const data = args.includes('tar') ? 'archive' : 'original checksum';
      writeFileSync(options.stdio[1], data);
      return '';
    }
    if (args[0]==='image' && args[1]==='ls') return built?imageId:'';
    if (args[0]==='image' && args[1]==='inspect') return JSON.stringify([projectName+'-ledger:latest',...(sharedImage ? ['shared:latest'] : [])])+'\n'+projectName+'\nledger';
    if (args[0]==='ps') return '';
    if (args[0]==='image' && args[1]==='rm') { assert.equal(args[2],imageId); built=false; return ''; }
    stage = cwd;
    const identity = args[2]; projectName=identity;
    const command = args.slice(args.indexOf('preflight.yml') + 1);
    operations.push(command[0]);
    if (command[0] === 'config') {
      const config = {
        name: identity,
        networks: { default: { name: identity + '_default' } },
        volumes: Object.fromEntries(['database', 'media', 'ledger'].map(key => [key, { name: identity + '_' + key }])),
        services: {
          mysql: { volumes: [named('database', dbPath)] },
          backend: { volumes: [named('media', imagePath), { type: 'bind', source: join(stage, 'backend'), target: '/workspace/backend' }] },
          ledger: { volumes: [named('ledger', ledgerPath)] },
        },
      };
      changeConfig(config);
      return JSON.stringify(config);
    }
    if (command[0] === 'up') {
      candidateRunning ||= command.includes('backend');
      if (candidateRunning) {
        const callbacks = join(stage, 'backend/src/main/resources/db/migration');
        const [name] = readdirSync(callbacks);
        assert.match(name, /^afterMigrate__/);
        const callback = readFileSync(join(callbacks, name), 'utf8');
        assert.match(callback, /SHA2/);
        assert.match(callback, /`image`/);
      }
      if (candidateRunning && failStart) throw Error('candidate startup failed');
      return '';
    }
    if (command[0] === 'build') { built=true; return ''; }
    if (command[0] === 'run') {
      assert(command.includes('tar'));
      assert.equal(readFileSync(options.stdio[0], 'utf8'), 'archive');
      return '';
    }
    if (command[0] === 'down') {
      if (failCleanup) throw Error('project still in use');
      return '';
    }
    assert.equal(command[0], 'exec');
    if (command.includes('cd "$1"; exec sha256sum -c -')) {
      assert.equal(readFileSync(options.stdio[0], 'utf8'), 'original checksum');
      if (command[2] === changedFile) throw Error('checksum mismatch');
      return '';
    }
    if (command.includes('backend')) return JSON.stringify({ status: healthy ? 'UP' : 'DOWN' });
    assert(command.includes('mysql'));
    const query = command.includes('-e') ? command.at(-1) : readFileSync(options.stdio[0], 'utf8');
    if (query === 'isolated fixture') return '';
    if (/information_schema\.columns/i.test(query)) return rawHex('accounts') + '\t' + rawHex('image');
    if (/information_schema\.tables/i.test(query)) return 'accounts';
    if (command.includes('-e') && /COUNT\(\*\)/i.test(query)) return '1';
    assert.match(query, candidateRunning ? /LOWER\(HEX\(row_digest\)\)/ : /SHA2/i);
    assert.match(query, /`accounts`/);
    assert.match(query, /COUNT\(\*\)/);
    if (!candidateRunning) assert.match(query, /`image`/);
    const value = candidateRunning ? imageAfter : 'kept.jpg';
    writeFileSync(options.stdio[1], 'rows:' + (candidateRunning ? rowsAfter : 1) + '\n' +
      createHash('sha256').update(value).digest('hex') + '\n');
    return '';
  }
  const rehearse = () => rehearseMigration(dir, 'candidate', backup, { services: { backend: { volumes: [] } } }, run);
  const checkCleanup = () => {
    assert.equal(operations.at(-1), 'down');
    assert.equal(existsSync(stage), false);
    assert.equal(readFileSync(backup, 'utf8'), 'isolated fixture');
  };
  return { rehearse, operations, checkCleanup, get stage() { return stage; }, backup };
}

test('migration rehearsal accepts intact original values and rejects changes with equal row counts', t => {
  const intact = fixture(t);
  intact.rehearse();
  intact.checkCleanup();
  const changed = fixture(t, { imageAfter: 'other.jpg' });
  assert.throws(changed.rehearse, /已有数据/);
  changed.checkCleanup();
  const missingAfterStartup = fixture(t, { rowsAfter: 0 });
  assert.throws(missingAfterStartup.rehearse, /已有数据/);
  missingAfterStartup.checkCleanup();
  const unhealthy = fixture(t, { healthy: false });
  assert.throws(unhealthy.rehearse, /健康/);
  unhealthy.checkCleanup();
});

test('migration rehearsal refuses unowned mounts and published service ports before starting any service', t => {
  for (const changeConfig of [
    c => { c.services.mysql.volumes[0] = { type: 'bind', source: '/unrelated', target: dbPath }; },
    c => { c.services.backend.volumes[0] = named('ledger', imagePath); },
    c => { c.services.ledger.volumes[0] = named('media', ledgerPath); },
    c => { c.services.ledger.ports = [{ published: 8090, target: 8090 }]; },
    c => { c.volumes.media.external = true; },
    c => { c.volumes.media.name = c.volumes.ledger.name; },
    c => { c.volumes.media.labels = { 'com.zdm.retained-data': 'media' }; },
  ]) {
    const f = fixture(t, { changeConfig });
    assert.throws(f.rehearse, /独立/);
    assert.deepEqual(f.operations, ['config']);
  }
});

test('an interrupted migration preserves its source and retains the recovery directory if teardown fails', t => {
  const interrupted = fixture(t, { failStart: true });
  assert.throws(interrupted.rehearse, /candidate startup failed/);
  interrupted.checkCleanup();
  const occupied = fixture(t, { failStart: true, failCleanup: true });
  assert.throws(occupied.rehearse, error => error.message.includes(occupied.stage) && error.cause?.message === 'project still in use');
  assert.equal(existsSync(occupied.stage), true);
  assert.equal(readFileSync(occupied.backup, 'utf8'), 'isolated fixture');
});

test('changing an original media or ledger file refuses the candidate even when all rows match', t => {
  for (const service of ['backend', 'ledger']) {
    const f = fixture(t, { changedFile: service });
    assert.throws(f.rehearse, error => error.message.includes('原文件') && error.message.includes(service));
    f.checkCleanup();
  }
});

test('a second tag protects a rehearsal image and its recovery record', t => {
  const f = fixture(t, { sharedImage: true });
  assert.throws(f.rehearse, error => error.cause?.message.includes('引用已变化'));
  assert.ok(existsSync(f.stage));
});
