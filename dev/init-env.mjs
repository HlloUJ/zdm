import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [frontend = '5273', backend = '8280'] = process.argv.slice(2);
const validPort = (value) => /^\d+$/.test(value) && Number(value) >= 1024 && Number(value) < 65536;
if (!validPort(frontend) || !validPort(backend) || Number(frontend) === Number(backend)) {
  throw new Error('请指定两个不同的开发端口，范围为 1024 至 65535。');
}

const id = randomBytes(8).toString('hex');
const database = 'zdm_dev_' + id;
const password = randomBytes(32).toString('hex');
const token = createHmac('sha256', password).update('zdm-store-exit:' + database).digest('hex');
const entries = {
  COMPOSE_PROJECT_NAME: 'zdm-dev-' + id,
  ZDM_FRONTEND_PORT: frontend,
  ZDM_BACKEND_PORT: backend,
  ZDM_DB_NAME: database,
  ZDM_DB_PASSWORD: password,
  ZDM_DB_ROOT_PASSWORD: randomBytes(32).toString('hex'),
  ZDM_LEDGER_AUTH_TOKEN: token,
};
const file = Object.entries(entries).map(([key, value]) => key + '=' + value).join('\n') + '\n';
writeFileSync('.env', file, { flag: 'wx', mode: 0o600 });
console.log('已为本工作目录创建 .env，前端端口 ' + frontend + '，后端端口 ' + backend + '。');
