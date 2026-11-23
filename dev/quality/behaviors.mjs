// Names are portable facts. Free text and private references stay in the local task record.
export const behaviors = {
  note: [0, '说明或注释', ['diff', 'docs']],
  copy: [0, '展示文字、标签与详情', ['diff']],
  layout: [1, '局部布局、操作状态与视口', ['build', 'e2e']],
  pagination: [1, '分页选项、翻页与实际记录', ['build', 'e2e']],
  local: [2, '本域正常、边界与失败路径', ['unit', 'build', 'e2e']],
  shared: [3, '共用契约、事件及实际使用方', ['unit', 'build', 'e2e']],
  api: [3, '接口请求、响应、失败和消费者', ['unit', 'e2e', 'backend']],
  access: [4, '授权拒绝、同店并发和跨店数据隔离', ['backend', 'e2e']],
  inventory: [4, '库存或价格写入、重复处理与数据一致性', ['unit', 'backend', 'e2e']],
  deletion: [4, '误删、重复提交、部分失败及恢复', ['backend', 'e2e']],
  migration: [4, '历史数据、数据库绑定与恢复', ['backend', 'acceptance']],
  concurrency: [2, '并发顺序、重复请求、竞争和失败恢复', ['unit', 'e2e']],
  state: [2, '允许、拒绝的状态转换和失败后的状态', ['unit', 'e2e']],
  batch: [2, '批量部分失败、重复执行和结果一致性', ['unit', 'e2e']],
  control: [4, '错误放行、证据失效、并发写入及中断恢复', ['quality', 'acceptance']],
  guard: [4, '关键拒绝、隔离或防重复的保护用例', ['quality', 'e2e']],
  unknown: [
    4,
    '范围待核，完整适用门禁',
    ['diff', 'docs', 'quality', 'acceptance', 'ledger', 'build', 'unit', 'e2e', 'backend'],
  ],
};
export function kinds(values) {
  if (!Array.isArray(values) || !values.length || values.some((v) => !Object.hasOwn(behaviors, v)))
    throw Error('请逐项登记行为和对应依据。');
  return [...new Set(values)].sort();
}
export const riskOf = (values) => 'R' + Math.max(...kinds(values).map((v) => behaviors[v][0]));
export const highest = (...levels) => 'R' + Math.max(...levels.map((v) => Number(v.slice(1))));
export const checksOf = (values) => [...new Set(kinds(values).flatMap((v) => behaviors[v][2]))];

const domains = {
  frontend: ['unit', 'build', 'e2e'],
  backend: ['backend'],
  delivery: ['quality', 'acceptance'],
  ledger: ['ledger', 'backend'],
};
export function intentChecks(values, domain) {
  if (domain != null && !Object.hasOwn(domains, domain)) throw Error('未知验证域');
  if (!domain || !values.includes('unknown')) return checksOf(values);
  return [
    ...new Set([
      'diff',
      ...domains[domain],
      ...values.filter((v) => v !== 'unknown').flatMap((v) => behaviors[v][2]),
    ]),
  ];
}
