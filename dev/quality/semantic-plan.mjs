import { active } from './release.mjs';
import { behaviors } from './behaviors.mjs';
import { layoutImpact, layoutNote } from './layout-impact.mjs';
import {
  dangerousCopy,
  ordinaryComments,
  display,
  pagination,
  protectionChanged,
  visualRegistration,
} from './change-facts.mjs';

const testPath = (path) => /(?:^tests\/|(?:^|\/)src\/test\/|\.(?:spec|test)\.[jt]sx?$)/.test(path);
const unitFile = (p) => /\.test\.[jt]sx?$/.test(p) && p.startsWith('src/');
const browserFile = (p) => /^tests\/e2e\/.+\.spec\.[jt]s$/.test(p);
const framework =
  /^(?:\.agents\/skills\/(?:zdm-task-assessment|zdm-admin-module-delivery)\/|dev\/operation-feedback-policy\.mjs$|dev\/(?:quality|task-(?:assess|timing))|tests\/quality|\.github\/workflows\/|docs\/(?:task-assessment|verification(?:-v1\.1)?|task-completion-cleanup|task-timing)\.md$)/;
const dangerous = [
  [
    'access',
    /(?:tenant(?:Id|_id)|store(?:Id|_id)|user(?:Id|_id)|permission|canAccess|authoriz|authenticat|hasRole|requireRole|@PreAuthorize|rowLevel|dataScope|隔离|越权)/i,
  ],
  [
    'inventory',
    /\b(?:stock|inventory|price|amount|stockQuantity|salePrice|unitPrice|purchasePrice|replenish|decrement|incrementStock)\b/i,
  ],
  [
    'deletion',
    /(?:\bdelete(?:From|By|All|If|Where|Product)?\b|\.remove(?:All|ById)?\(|DELETE\s+FROM|purge|幂等|防重|duplicate|idempoten)/i,
  ],
  ['migration', /(?:ALTER\s+TABLE|DROP\s+TABLE|FLYWAY|SPRING_DATASOURCE|MIGRATION|MIGRATE|jdbc:mysql)/i],
];
const effectSignals = {
  access: /(?:\b(?:if|return|throw|where|select|join|filter|scope|permit|deny|guard|require\w*|canAccess|hasRole|hasPermission|authorize\w*)\b|@PreAuthorize|[!=]==?|&&|\|\||(?:tenant|store|user)(?:Id|_id)\s*[:=]|(?:permissions?|roles?)\s*[:=]|\.includes\s*\()/i,
  inventory: /(?:\b(?:return|update|insert|set|where|save|reserve|release|adjust|replenish|decrement|incrementStock)\b|(?:stock|inventory|price|amount|quantity)\w*\s*[:=]|\w+\s*[+*/-]\s*\w+|\.(?:add|subtract|multiply|divide)\s*\()/i,
  deletion: /(?:\bdelete\s+(?:from|[\w$]+[.[])|\bdelete(?:From|By|All|If|Where|Product)?\s*\(|\.remove(?:All|ById)?\s*\(|\bpurge\w*\s*\(|['"]DELETE['"]|\b(?:if|return|throw|insert|constraint|conflict|unique)\b|@DeleteMapping|@\w+\s*=\s*["'][^"']*(?:remove|delete))/i,
  migration: /\b(?:alter|drop|create|rename|migrat\w*|flyway|spring_datasource|jdbc:mysql)\b/i,
};

function riskSignals(c) {
  const context = executableContext(c);
  const result = [];
  for (const [kind, terms] of dangerous) {
    if (!terms.test(context)) continue;
    if (effectSignals[kind].test(context)) result.push(kind);
    // A changed field, callback or decorator can alter a contract even without a visible local write.
    else if (terms.test(c.patch) && /=>|[=:()]|\b(?:public|private|final|export)\b/.test(c.patch))
      result.push('unknown');
  }
  if (/@DeleteMapping\b/i.test(context) && !result.includes('deletion')) result.push('deletion');
  // A removed check is still an observed change of authorization behavior.
  if (!result.includes('access') && (
      /\b(?:allow|deny|hasPermission|canAccess|authorize|authorized|tenantScope)\b/i.test(context) ||
      (/auth|permission|security|tenant|storeselection/i.test(c.path) &&
       /\b(?:return|throw|where|filter|select|update)\b/i.test(c.patch)))) result.push('access');
  if (!result.includes('inventory') && /\b(?:stockQuantity|salePrice)\b/i.test(context) &&
      effectSignals.inventory.test(context)) result.push('inventory');
  return [...new Set(result)];
}
function executableContext(c) {
  const code = [c.before || '', c.after || ''].join('\n');
  const timerCollections = new Set();
  if (c.path.startsWith('src/') && /\bsetTimeout\s*\(/.test(code) && /\bclearTimeout\s*\(/.test(code) &&
      /\bonScopeDispose\s*\(/.test(code) && !/\b(?:fetch|axios|indexedDB|localStorage|sessionStorage)\b/.test(code)) {
    for (const match of code.matchAll(/\bconst\s+(\w+)\s*=\s*new Map<[^;\n]*ReturnType<typeof setTimeout>/g))
      timerCollections.add(match[1]);
    for (const match of code.matchAll(/\bconst\s+(\w+)\s*=\s*reactive\(new Set\b/g)) {
      if (new RegExp('return\\s*\\([^()]*\\)\\s*=>\\s*' + match[1] + '\\.has\\(').test(code))
        timerCollections.add(match[1]);
    }
  }
  const patch = c.patch.replace(/\b(\w+)\.delete(?=\s*\()/g,
    (method, receiver) => timerCollections.has(receiver) ? receiver + '.clearLocalKey' : method);
  // An import printed in the Git hunk header is location metadata, not an edited price or access rule.
  const enclosing = (c.enclosing || []).filter(line => !/^\s*(?:import\b|export\s+.*\bfrom\b|\/\/)/.test(line));
  return [patch, ...enclosing].join('\n');
}
function classify(c, changes, files, oldPlan) {
  const { path, patch, consumers = [] } = c;
  const row = (kind, dev, delivery, reason, scope = {}, other = []) => ({
    path,
    kind,
    other,
    dev,
    delivery,
    reason,
    scope,
    consumers,
  });
  if (c.unsafeType)
    return row('unknown', behaviors.unknown[2], behaviors.unknown[2], '无法可靠解析文件类型或内容');
  if (ordinaryComments(c)) return row('note', [], [], '仅改独立说明注释，已核对指令和源代码');
  if (framework.test(path) || path === 'AGENTS.md' || c.onlyQualityAliases || c.onlyTestAdapters)
    return row(
      'control',
      ['quality', 'acceptance'],
      ['quality', 'acceptance'],
      '验证、任务开工、通知或合并前执行条件',
    );
  if (/^(?:dev\/acceptance|tests\/acceptance)/.test(path))
    return row('control', ['acceptance'], ['acceptance'], '5274 数据绑定、版本组合与中断恢复', {}, [
      'migration',
    ]);
  if (visualRegistration(c, changes))
    return row('layout', ['diff'], ['diff'], '已核对登记中的准确 CSS 前后内容及原有冻结条目');
  if (testPath(path)) {
    const id = path.startsWith('backend/')
      ? 'backend'
      : path.startsWith('tests/e2e/')
        ? 'e2e'
        : unitFile(path)
          ? 'unit'
          : null;
    if (id) {
      const weakened = protectionChanged(c);
      const scope =
        id === 'e2e'
          ? [path, ...consumers].filter((p) => files.includes(p) && browserFile(p))
          : id === 'unit' && files.includes(path)
            ? [path]
            : [];
      return row(
        weakened ? 'guard' : 'note',
        [id],
        [id],
        weakened ? '关键保护用例、拒绝断言或执行条件变化' : '配套用例、期望或模拟数据，重验实际用例',
        { [id]: scope },
      );
    }
  }
  if (path.startsWith('src/')) {
    if (dangerousCopy(c))
      return row(
        'deletion',
        ['unit', 'e2e'],
        ['unit', 'build', 'e2e', 'backend'],
        '危险操作提示改变了用户对删除后果的理解',
      );
    const label = display(c);
    if (label) {
      const unit = c.textTests.filter((p) => files.includes(p) && unitFile(p));
      const e2e = c.textTests.filter((p) => files.includes(p) && browserFile(p));
      const scoped = { unit, e2e };
      const ids = unit.length ? ['unit', 'e2e'] : path.endsWith('.vue') ? ['build', 'e2e'] : ['e2e'];
      return row('copy', ids, ids, label, scoped);
    }
    if (pagination(c)) {
      const scope = { e2e: files.filter((p) => browserFile(p) && /pagination/.test(p)) };
      return row(
        'pagination',
        ['e2e'],
        ['build', 'e2e'],
        '分页数据源与事件未变，核对选项 ' +
          (c.added.join(' ').match(/pageSizeOptions:\s*\[([\d, ]+)\]/)?.[1] || '及默认值') +
          '、翻页和实际记录',
        scope,
      );
    }
    const layout = c.layout ?? layoutImpact(c, files);
    if (layout) return row('layout', ['e2e'], ['build', 'e2e'], layout.reason, { e2e: layout.e2e });
  }
  if (path.startsWith('src/') || path.startsWith('backend/')) {
    const dangers = riskSignals(c);
    // When a guarded implementation is removed in full the guards still appear in the before image.
    if (dangers.includes('unknown'))
      return row('unknown', behaviors.unknown[2], behaviors.unknown[2],
        path + ' 的受保护契约有变，无法从当前调用关系证明后果，保留完整适用验证', {},
        dangers.filter(k => k !== 'unknown'));
    if (dangers.length)
      return row(
        dangers[0],
        path.startsWith('src/') ? ['unit', 'e2e'] : ['backend'],
        ['unit', 'e2e', 'build', 'backend'],
        path + ' 的可执行差异或所在行为涉及' + dangers.map((k) => behaviors[k][1]).join('，'),
        {},
        dangers.slice(1),
      );
    if (/\b(?:eval|Function)\s*\(|\bimport\s*\(\s*[^'"]/.test(patch))
      return row('unknown', behaviors.unknown[2], behaviors.unknown[2], '动态依赖的实际使用方未能核实');
    const users = consumers.filter((p) => !testPath(p));
    if (users.length > 1)
      return row(
        'shared',
        ['unit'],
        ['unit', 'build', 'e2e'],
        '共享契约的实际使用方：' + users.join('、'),
      );
    if (users.length === 1 && path.startsWith('src/'))
      return row('local', ['unit'], ['unit', 'build', 'e2e'], '已定位单一业务使用方：' + users[0]);
    if (/^src\/pages\//.test(path))
      return row('local', ['unit'], ['unit', 'build', 'e2e'], '局部页面功能与状态');
    if (/^(?:src\/components\/foundation\/|backend\/)/.test(path))
      return row(
        'shared',
        path.startsWith('backend/') ? ['backend'] : ['unit'],
        path.startsWith('backend/') ? ['backend', 'e2e', 'unit', 'build'] : ['unit', 'build', 'e2e'],
        '公共入口或接口，验证使用方兼容',
      );
  }
  const old = oldPlan([c]);
  const k = ['note', 'layout', 'local', 'shared', 'unknown'][Number(old.risk.slice(1))];
  return row(
    k,
    old.dev.filter((k) => !['diff', 'docs'].includes(k)),
    old.delivery.filter((k) => !['diff', 'docs'].includes(k)),
    old.reasons[0],
  );
}
// Match executable changes that establish a scenario, separately from keywords used to suggest tests.
const operations = [
  ['concurrency', /\bFOR\s+UPDATE\b|\b(?:compareAndSet|acquireLock|withLock|putIfAbsent|runExclusive)\s*\(|\b(?:ON\s+CONFLICT|ON\s+DUPLICATE\s+KEY)\b/i],
  ['api', /@(?:Get|Post|Put|Patch|Delete|Request)Mapping\s*\(|\brouter\.(?:get|post|put|patch|delete)\s*\(/],
  ['state', /\b(?:transitionTo|canTransition|applyTransition|setStatus)\s*\(|\.status\s*=(?!=)/],
  ['batch', /\b(?:executeBatch|batchUpdate|bulkWrite|allSettled)\s*\(/],
];
function withOperations(fact, change) {
  if (behaviors[fact.kind][0] < 2 || testPath(change.path) || !/^(?:src\/|backend\/src\/main\/)/.test(change.path))
    return fact;
  const lines = [...(change.removed || []), ...(change.added || [])]
    .filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join('\n');
  const extra = operations.filter(([kind, signal]) =>
    kind !== fact.kind && !fact.other.includes(kind) && signal.test(lines)).map(([kind]) => kind);
  if (!extra.length) return fact;
  const server = change.path.startsWith('backend/');
  const dev = server ? ['backend'] : ['unit', 'e2e'];
  const delivery = server ? ['backend', 'e2e'] : ['unit', 'build', 'e2e'];
  return { ...fact, other: [...fact.other, ...extra], reason: [fact.reason, ...extra.map(k => behaviors[k][1])].join('，'),
    dev: [...new Set([...fact.dev, ...dev])], delivery: [...new Set([...fact.delivery, ...delivery])] };
}
export function semanticPlan(changes, fallback, files, catalogue, legacy) {
  fallback ||= process.env.ZDM_QUALITY_FULL === '1';
  const old = legacy(changes, fallback);
  const facts = changes.map((c) => withOperations(classify(c, changes, files, legacy), c));
  if (facts.some(f => f.kind === 'layout' && f.path.startsWith('src/'))) {
    for (const [i, change] of changes.entries()) {
      if (facts[i].kind === 'shared' && layoutNote(change))
        facts[i] = { ...facts[i], kind: 'note', dev: [], delivery: [], reason: '随布局更新的展示说明，已核对改前改后文字' };
    }
  }
  // Evaluate the changed provider and its changed callers together, even if each alone has a single consumer.
  const changed = new Map(changes.map((c, i) => [c.path, { change: c, fact: facts[i] }]));
  for (const { change, fact } of changed.values()) {
    if (fact.kind !== 'local') continue;
    const implementation = [change.patch, ...(change.enclosing || [])].join('\n');
    const exports = [...implementation.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g)];
    if (!exports.length) continue;
    const callers = (change.consumers || []).filter(p => {
      const caller = changed.get(p);
      if (!caller || testPath(p) || behaviors[caller.fact.kind][0] < 2) return false;
      return exports.some(([, name]) => new RegExp('\\b' + name + '\\s*\\(').test(caller.change.patch));
    });
    if (callers.length) {
      fact.other = [...new Set([...fact.other, 'shared'])];
      fact.dev = [...new Set([...fact.dev, 'unit', 'e2e'])];
      fact.reason += '。导出行为与调用点共同变化：' + callers.join('、');
    }
  }
  if (fallback)
    facts.push({
      path: '',
      kind: 'unknown',
      other: [],
      dev: behaviors.unknown[2],
      delivery: behaviors.unknown[2],
      reason: '分类输入不完整，范围待核',
      scope: {},
      consumers: [],
    });
  const kinds = [...new Set(facts.flatMap((r) => [r.kind, ...r.other]))].sort();
  const risk = 'R' + Math.max(0, ...kinds.map((k) => behaviors[k][0]));
  function checks(stage) {
    const chosen = new Set(['diff']);
    if (changes.some((c) => c.path.endsWith('.md'))) chosen.add('docs');
    for (const row of facts) for (const id of row[stage]) chosen.add(id);
    return Object.keys(catalogue).filter((id) => chosen.has(id));
  }
  const scopes = {};
  for (const id of ['unit', 'e2e']) {
    const rows = facts.filter((r) => r.dev.includes(id) || r.delivery.includes(id));
    if (rows.length && rows.every((r) => r.scope[id]?.length))
      scopes[id] = [...new Set(rows.flatMap((r) => r.scope[id]))].sort();
  }
  const specialties = Object.fromEntries(kinds.map((k) => [k, [behaviors[k][1]]]));
  for (const fact of facts) {
    if (behaviors[fact.kind][0] < 2) continue;
    const change = changes.find((c) => c.path === fact.path);
    if (change) Object.assign(specialties, legacy([change]).specialties);
  }
  return {
    standard: 'V1.2',
    version: 'assessment-1',
    risk,
    reasons: [...new Set(facts.map((f) => f.reason))],
    behaviors: kinds,
    scopes,
    specialties,
    dev: checks('dev'),
    delivery: checks('delivery'),
    facts: facts.map(({ path, kind, other, reason, consumers, dev, delivery }) => ({
      path,
      kind,
      other,
      reason,
      consumers,
      dev,
      delivery,
    })),
    comparison: {
      active: active ? 'V1.2' : 'V1.1',
      proposedStandard: 'V1.2',
      previous: { risk: old.risk, dev: old.dev, delivery: old.delivery },
      proposed: risk,
    },
  };
}
