export const standard = 'V1.1';

// This catalogue is used by planning, execution and evidence verification.
// A check's input set includes its tests, consumers and configuration.
const frontend =
  /^(src\/|public\/|index\.html$|package(?:-lock)?\.json$|(?:vite|vitest|playwright)\.config\.|tsconfig|\.npmrc$)/;
const backend = /^(backend\/|infrastructure\/store-exit-ledger\/|(?:docker-|compose\.)|\.mvn\/)/;
const governance =
  /^(dev\/quality(?:-entry\.mjs|\.mjs|\/)|tests\/quality[^/]*\.test\.mjs$|\.github\/workflows\/verification\.yml$)/;
const acceptance = /^(dev\/acceptance[^/]*\.mjs|tests\/acceptance[^/]*\.test\.mjs)$/;
const feedbackInputs = new Set([
  'dev/operation-feedback-policy.mjs',
  'docs/ui/operation-feedback-registry.json',
  'docs/ui/visual-refactor.json',
]);
const npmInput = /^(package(?:-lock)?\.json|\.npmrc)$/;
const nodeTest = (...files) => [process.execPath, '--test', ...files];
export const checks = {
  diff: { family: 'git', inputs: () => true },
  docs: { family: 'git', inputs: () => true },
  quality: {
    family: 'node',
    command: nodeTest('tests/quality*.test.mjs'),
    inputs: (p) => governance.test(p) || acceptance.test(p) || npmInput.test(p) ||
      p.startsWith('dev/task-timing/') || p === 'dev/task-timing.mjs',
  },
  acceptance: {
    family: 'node',
    command: nodeTest('tests/acceptance*.test.mjs'),
    inputs: (p) =>
      acceptance.test(p) || governance.test(p) || npmInput.test(p) || p === 'dev/init-env.mjs',
  },
  ledger: {
    family: 'node',
    command: nodeTest('tests/store-exit-ledger.test.mjs'),
    inputs: (p) =>
      p.startsWith('infrastructure/store-exit-ledger/') ||
      p === 'tests/store-exit-ledger.test.mjs' ||
      npmInput.test(p),
  },
  build: {
    family: 'frontend',
    before: [process.execPath, 'node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit'],
    command: [process.execPath, 'node_modules/vite/bin/vite.js', 'build', '--configLoader', 'runner'],
    inputs: (p) => frontend.test(p),
  },
  unit: {
    family: 'frontend',
    command: [process.execPath, 'node_modules/vitest/vitest.mjs', 'run'],
    inputs: (p) => frontend.test(p) || p.startsWith('tests/') || feedbackInputs.has(p) || backend.test(p),
  },
  e2e: {
    family: 'browser',
    command: [process.execPath, 'node_modules/@playwright/test/cli.js', 'test'],
    inputs: (p) => frontend.test(p) || backend.test(p) || p.startsWith('tests/e2e/'),
  },
  selection: {
    family: 'browser',
    command: [
      process.execPath,
      'node_modules/@playwright/test/cli.js',
      'test',
      'tests/e2e/selection-center.spec.ts',
    ],
    inputs: (p) => frontend.test(p) || backend.test(p) || p.startsWith('tests/e2e/'),
  },
  backend: {
    family: 'database',
    command: [
      'docker',
      'compose',
      'run',
      '--rm',
      '--no-deps',
      'backend-tools',
      'mvn',
      '-B',
      '--no-transfer-progress',
      'test',
    ],
    inputs: (p) => backend.test(p) || npmInput.test(p),
  },
};
const all = Object.keys(checks).filter((id) => id !== 'selection');
const front = ['unit', 'build', 'e2e'];
const cross = [...front, 'backend'];
const sensitivePath =
  /login|auth|secur|permission|(?:^|[/.])role|price|markup|inventory|stock|payment|scope|migration|delete|retention|storeexit|isolation|checkout/i;
const sensitiveCode =
  /(?:permission|authoriz|authenticat|tenantId|userId|roleId|stockQuantity|inventory|unitPrice|salePrice|purchasePrice|deleteFrom|removeAll|deleteBy|DROP\s+TABLE|DELETE\s+FROM|账号权限|数据隔离|价格库存)/i;
const directive =
  /必须|禁止|门禁|验收规则|任务完成|授权|应当|不得|shall\b|must\b|workflow|npm run |gh pr |git merge|```(?:sh|bash|js|yaml)/i;

export function explanatory(path, patch = '') {
  return (
    /^(?:docs\/(?!ui\/|product\/|architecture\/|api-contract|task-completion|verification).+\.md|(?:README|CHANGELOG)\.md)$/.test(
      path,
    ) && !directive.test(patch)
  );
}

function classify(change) {
  const { path, patch } = change;
  if (change.unsafeType) return [4, all, all, '未登记的文件类型'];
  if (governance.test(path) || change.onlyQualityAliases || path === 'docs/verification-v1.1.md') {
    return [4, ['quality', 'acceptance'], ['quality', 'acceptance'], '验证及合并控制'];
  }
  if (path === 'AGENTS.md' || path === 'README.md') {
    const lines = patch.split('\n').filter((line) => line.trim());
    if (lines.length && lines.every((line) => /V1\.1|verify:|dev\/quality|分级验证/.test(line))) {
      return [4, ['quality', 'acceptance'], ['quality', 'acceptance'], '分级验证入口约定'];
    }
  }
  if (change.onlyTestAdapters)
    return [4, ['quality', 'acceptance'], all, '原生构建与测试命令的证据接入'];
  if (acceptance.test(path)) return [4, ['acceptance'], ['acceptance'], '5274 组合、运行和恢复'];
  if (path === 'docs/task-completion-cleanup.md')
    return [4, ['quality', 'acceptance'], ['quality', 'acceptance'], '交付及资源保护'];
  if (explanatory(path, patch)) return [0, [], [], '纯说明内容'];
  if (path === 'src/pages/selection-center/selection-center.css')
    return [1, ['selection'], ['build', 'selection'], '选品中心布局及其已登记视口测试'];
  if (
    path === 'tests/store-exit-ledger.test.mjs' ||
    path.startsWith('infrastructure/store-exit-ledger/')
  ) {
    return [4, ['ledger'], ['ledger', 'backend'], '退出账本持久化和后端调用方'];
  }
  if (path.startsWith('tests/e2e/')) return [4, ['e2e'], ['e2e'], '端到端验证输入'];
  if (path.startsWith('backend/')) {
    if (
      sensitivePath.test(path) ||
      sensitiveCode.test(patch) ||
      /backend\/(?:pom\.xml|src\/main\/resources\/)/.test(path)
    ) {
      return [4, ['backend'], [...cross, 'ledger'], '数据、运行配置及真实消费者'];
    }
    return [3, ['backend'], cross, '后端业务域及接口消费者'];
  }
  if (path.startsWith('src/')) {
    if (sensitivePath.test(path) || sensitiveCode.test(patch))
      return [4, ['unit'], cross, '高风险前后端链路'];
    if (/\.test\.[jt]s$/.test(path)) return [4, ['unit'], ['unit', 'build'], '前端验证输入'];
    if (/(?:fetch\(|axios\.|\/api\/|ResponseEntity|@RequestMapping)/.test(patch))
      return [3, ['unit'], cross, '接口契约及调用方'];
    if (/^src\/pages\//.test(path) && !/(\/shared\/|\.css$)/.test(path))
      return [2, ['unit'], front, '页面功能及交互'];
    return [3, ['unit'], /^src\/(?:services|router)\//.test(path) ? cross : front, '共享能力及调用方'];
  }
  if (/^docs\/ui\//.test(path)) return [3, ['unit'], front, '共享界面约定'];
  return [4, all, all, '影响范围未证明，执行项目完整适用门禁'];
}

const scenarios = [
  [
    'concurrency',
    /concurr|async|reentran|retry|race|并发|重入/i,
    ['顺序变化', '重复请求', '竞争', '失败恢复'],
  ],
  [
    'state',
    /transition|workflowState|stateMachine|status|状态流转/i,
    ['合法转换', '非法转换', '转换失败后的状态'],
  ],
  ['access', /permission|auth|tenant|security|role|数据隔离/i, ['允许', '拒绝', '跨用户或组织隔离']],
  ['batch', /batch|bulk|批量/i, ['部分失败', '重复执行', '结果一致性']],
  [
    'api',
    /controller|@(?:Get|Post|Put|Delete)Mapping|\/api\/|src\/services\//i,
    ['请求', '响应', '错误处理', '调用方兼容'],
  ],
  ['migration', /migration|flyway|persist|持久化/i, ['历史数据', '约束', '升级路径']],
  ['cleanup', /cleanup|retention|delete|资源回收/i, ['归属', '引用保护', '重复执行', '中断接续']],
  [
    'delivery',
    /dev\/(?:quality|acceptance)|tests\/(?:quality|acceptance)|verification|交付控制/i,
    ['正常放行', '应当拒绝', '证据失效', '恢复'],
  ],
];

export function planChanges(changes, fallback = false) {
  const dev = new Set(['diff']);
  const delivery = new Set(['diff']);
  let level = 0;
  const reasons = [];
  const features = new Set();
  for (const change of changes) {
    const [risk, early, final, reason] = classify(change);
    level = Math.max(level, risk);
    if (change.path.endsWith('.md')) {
      dev.add('docs');
      delivery.add('docs');
    }
    if (risk > 0) {
      const content =
        governance.test(change.path) ||
        acceptance.test(change.path) ||
        reason === '分级验证入口约定' ||
        change.path === 'docs/verification-v1.1.md'
          ? change.path
          : change.path + '\n' + change.patch;
      for (const [name, pattern] of scenarios) if (pattern.test(content)) features.add(name);
    }
    early.forEach((id) => dev.add(id));
    final.forEach((id) => delivery.add(id));
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  if (fallback) {
    level = 4;
    all.forEach((id) => {
      dev.add(id);
      delivery.add(id);
    });
    reasons.push('分类输入不完整，按全项目回退');
    for (const [name] of scenarios) features.add(name);
  }
  const ordered = (ids) =>
    Object.keys(checks).filter((id) => ids.has(id) && !(id === 'selection' && ids.has('e2e')));
  const specialties = Object.fromEntries(
    scenarios.filter(([name]) => features.has(name)).map(([name, , required]) => [name, required]),
  );
  return {
    standard,
    risk: 'R' + level,
    reasons,
    specialties,
    dev: ordered(dev),
    delivery: ordered(delivery),
  };
}
