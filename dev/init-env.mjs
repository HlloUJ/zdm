import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

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

// Only genuine task checkouts receive a creation receipt. CI, migration rehearsals and standalone directories keep their original behavior.
async function noteTaskProject() {
  const cwd = realpathSync('.');
  if (!existsSync(join(cwd,'.git'))) return;
  const {managedRepository}=await import('./task-timing/resource-host.mjs');
  if (!managedRepository(cwd)) return;
  const common = realpathSync(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());
  const branch = execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim();
  if (!branch || branch==='main' || dirname(common)===cwd || !existsSync(join(common,'zdm-tasks','activation.json'))) return;
  mkdirSync('.private',{recursive:true,mode:0o700});
  writeFileSync('.private/resource-environment.json',JSON.stringify({workspace:cwd,at:Date.now(),project:entries.COMPOSE_PROJECT_NAME})+'\n',{flag:'wx',mode:0o600});
  const context=process.env.ZDM_QUALITY_TIMING_CONTEXT;
  if (!context) return;
  const hint=JSON.parse(context);
  if (hint.common===common && hint.workspace===cwd && hint.ids?.length===1) {
    const {bindEnvironment}=await import('./task-timing/resources.mjs');
    bindEnvironment(common,hint.ids[0],cwd,entries.COMPOSE_PROJECT_NAME,Date.now());
  }
}
await noteTaskProject();
