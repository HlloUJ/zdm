import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { digest } from './repository.mjs';
import { fileDigest } from './inputs.mjs';

function ensure(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
function atomic(path, value) {
  ensure(dirname(path));
  const temporary = path + '.' + randomUUID();
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
function installKey(path) {
  if (!existsSync(path)) {
    const tmp = path + '.' + randomUUID();
    writeFileSync(tmp, randomBytes(32), { flag: 'wx', mode: 0o600 });
    try {
      linkSync(tmp, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      unlinkSync(tmp);
    }
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw Error('本机验证密钥无效。');
  return key;
}
export class EvidenceStore {
  constructor(common) {
    this.root = ensure(join(common, 'zdm-quality/v1.1'));
    this.key = installKey(join(this.root, 'local.key'));
    ensure(join(this.root, 'logs'));
  }
  write(path, data) {
    const mac = createHmac('sha256', this.key).update(JSON.stringify(data)).digest('hex');
    atomic(path, JSON.stringify({ data, mac }) + '\n');
  }
  read(path) {
    try {
      const { data, mac } = JSON.parse(readFileSync(path, 'utf8'));
      const expected = createHmac('sha256', this.key).update(JSON.stringify(data)).digest();
      const actual = Buffer.from(mac, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected) ? data : null;
    } catch {
      return null;
    }
  }
  latest(directory) {
    if (!existsSync(directory)) return null;
    const file = readdirSync(directory)
      .filter((name) => /^\d{13}-[\da-f-]+\.json$/.test(name))
      .sort()
      .at(-1);
    return file ? this.read(join(directory, file)) : null;
  }
  attempt(run, row) {
    this.write(join(this.root, 'checks', row.fingerprint, run + '.json'), row);
  }
  cached(input) {
    return this.latest(join(this.root, 'checks', input.fingerprint));
  }
  log(run, id) {
    return join(this.root, 'logs', run + '-' + id + '.log');
  }
  intact(row) {
    if (
      !row ||
      !/^(passed|reused)$/.test(row.status) ||
      !/^[a-f\d]{64}$/.test(row.logDigest || '') ||
      row.log !== this.log(row.sourceRun, row.id)
    )
      return false;
    try {
      return fileDigest(row.log) === row.logDigest;
    } catch {
      return false;
    }
  }
  reportKey(report) {
    return digest(JSON.stringify([report.phase, report.head, report.base]));
  }
  save(report) {
    this.write(join(this.root, 'runs', report.run + '.json'), report);
    this.write(join(this.root, 'heads', this.reportKey(report), report.run + '.json'), {
      run: report.run,
    });
  }
  report(phase, snapshot) {
    const ref = this.latest(join(this.root, 'heads', this.reportKey({ phase, ...snapshot })));
    return ref && this.read(join(this.root, 'runs', ref.run + '.json'));
  }
}
export function runId() {
  return Date.now() + '-' + randomUUID();
}
