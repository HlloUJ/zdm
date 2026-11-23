import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'vue/compiler-sfc';
import { NodeTypes } from '@vue/compiler-dom';
import ts from 'typescript';

const hash = (source) => createHash('sha256').update(source).digest('hex');
const types = new Set(['single', 'batch-partial', 'batch-atomic', 'form', 'view', 'query']);

// Store each binding once per component. A script change still invalidates all of its call sites.
export function inspectPage(source, file) {
  const { descriptor, errors } = parse(source, { filename: file });
  if (errors.length) throw new Error(file + ': ' + errors.join(', '));
  const script = [descriptor.script?.content, descriptor.scriptSetup?.content].filter(Boolean).join('\n');
  const template = descriptor.template?.ast;
  const bindings = new Set();
  function walk(node) {
    for (const prop of node.props || []) {
      if (prop.type !== NodeTypes.DIRECTIVE) continue;
      if (prop.name === 'on' || (prop.name === 'bind' && /^on[A-Z]/.test(prop.arg?.content || ''))) {
        bindings.add((prop.arg?.content || '[events]') + ' → ' + (prop.exp?.content || '').trim().replace(/\s+/g, ' '));
      }
      if (prop.name === 'bind' && prop.arg?.content === 'mode' && /['"]blocked['"]/.test(prop.exp?.content || '')) {
        throw new Error(file + ': 业务阻断弹框');
      }
    }
    if (node.type === NodeTypes.ELEMENT && node.tag === 'AdminConfirmDialog' && node.props.some(
      (p) => p.type === NodeTypes.ATTRIBUTE && p.name === 'mode' && p.value?.content === 'blocked',
    )) throw new Error(file + ': 业务阻断弹框');
    for (const child of node.children || []) if (typeof child === 'object') walk(child);
  }
  if (template) walk(template);
  const ast = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  function readsCondition(node) {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(ast);
      if (!['Promise.resolve', 'Promise.reject', 'requireCondition', 'Boolean', 'Object.is'].includes(name)
          && !/^operations\.(capture|select|pending)$/.test(name)) return true;
    }
    return Boolean(ts.forEachChild(node, (child) => readsCondition(child) || undefined));
  }
  function inspectCall(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'check' && node.expression.expression.getText(ast) === 'operations') {
      const inspect = node.arguments[1];
      if (!inspect || (ts.isArrowFunction(inspect) || ts.isFunctionExpression(inspect))
          && !readsCondition(inspect.body)) {
        throw new Error(file + ': 缺少真实预检');
      }
    }
    ts.forEachChild(node, inspectCall);
  }
  if (script.includes('.check')) inspectCall(ast);
  return { script: hash(script), bindings: [...bindings].sort() };
}

export function runtimePages(root) {
  function entries(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return entries(path);
      return path.endsWith('.vue') && !path.endsWith('.test.vue') ? [relative(root, path)] : [];
    });
  }
  return entries(resolve(root, 'src')).sort();
}

function validateAction(action, policies) {
  if (typeof action === 'string') {
    if (action.startsWith('@')) {
      const policy = policies[action.slice(1)];
      if (!policy || typeof policy === 'string') throw new Error('混合操作策略未登记');
      return validateAction(policy, policies);
    }
    if (!types.has(action) || action.startsWith('batch-')) throw new Error('操作类型或批量策略未登记');
    return;
  }
  if (!action || typeof action !== 'object') throw new Error('缺少操作登记');
  if (action.type === 'dispatch') {
    const branches = Object.values(action.branches || {});
    if (!branches.length) throw new Error('混合操作缺少分支');
    branches.forEach((branch) => validateAction(branch, policies));
    return;
  }
  if (!['batch-partial', 'batch-atomic'].includes(action.type)) throw new Error('操作类型无效');
  if (action.type === 'batch-partial' && action.preflight !== 'selection-only') throw new Error('部分成功批量禁止逐项全量预检');
  if (action.type === 'batch-atomic' && action.preflight !== 'existing') throw new Error('原子批量必须保留已有校验');
  if (!action.strategy) throw new Error('批量执行策略未登记');
}

export function verifyPage(file, inspected, entry, policies = {}) {
  if (!entry || entry.script !== inspected.script) throw new Error(file + ': 页面缺少登记或脚本指纹漂移');
  const bindings = Object.keys(entry.actions).sort();
  if (JSON.stringify(bindings) !== JSON.stringify(inspected.bindings)) throw new Error(file + ': 操作绑定登记与页面不一致');
  Object.values(entry.actions).forEach((action) => validateAction(action, policies));
}

// The historical visual contracts keep their original hashes. Undo only the registered
// business patches and verify that they reconstruct the exact pre-task component.
export function verifyApprovedChange(file, source, entry, patches) {
  if (patches.length !== entry.patchCount || !patches.length) throw new Error(file + ': 缺少获批差异');
  let restored = source;
  for (const { before, after } of [...patches].reverse()) {
    const position = restored.indexOf(after);
    if (!after || position < 0 || restored.indexOf(after, position + after.length) !== -1) {
      throw new Error(file + ': 无法准确还原获批差异');
    }
    restored = restored.slice(0, position) + before + restored.slice(position + after.length);
  }
  if (hash(restored) !== entry.baseSha256) throw new Error(file + ': 超出已登记业务差异');
}

export function policyChecks(root) {
  const { pages, dependencies, policies, approvedChanges, concurrentRevisions = [] } = JSON.parse(readFileSync(resolve(root, 'docs/ui/operation-feedback-registry.json'), 'utf8'));
  const { contracts } = JSON.parse(readFileSync(resolve(root, 'docs/ui/visual-refactor.json'), 'utf8'));
  const files = runtimePages(root);

  // An independently published revision can bring a different set of page actions.
  // Select its complete, reviewed registration by content, then run the same checks on it.
  for (const revision of concurrentRevisions) {
    const { source, sha256 } = revision;
    if (!Object.hasOwn(dependencies, source) && !Object.hasOwn(pages, source)) throw new Error('并行版本缺少来源登记');
    if (hash(readFileSync(resolve(root, source))) !== sha256) continue;
    if (Object.hasOwn(dependencies, source)) dependencies[source] = sha256;
    Object.assign(pages, revision.pages);
    for (const [file, before] of Object.entries(revision.beforeChanges)) {
      if (!approvedChanges[file]) throw new Error(file + ': 并行版本缺少原始变更登记');
      approvedChanges[file] = { ...approvedChanges[file], baseSha256: before };
    }
  }

  function verifyCoverage() {
    if (JSON.stringify(files) !== JSON.stringify(Object.keys(pages).sort())) throw new Error('运行时页面登记不完整');
    if (Object.keys(approvedChanges).some((file) => !pages[file])) throw new Error('获批差异缺少页面登记');
    for (const [file, fingerprint] of Object.entries(dependencies)) {
      if (hash(readFileSync(resolve(root, file))) !== fingerprint) throw new Error(file + ': 共享调用或路由指纹漂移');
    }
  }
  function verifyComponent(file) {
    const source = readFileSync(resolve(root, file), 'utf8');
    verifyPage(file, inspectPage(source, file), pages[file], policies);
    const entry = approvedChanges[file];
    if (entry) {
      const patches = entry.patches ?? (contracts[file]?.approvedBusinessPatches ?? []).filter((patch) => patch.task === '004');
      verifyApprovedChange(file, source, entry, patches);
    }
  }
  return { files, verifyCoverage, verifyComponent };
}

export function verifyPolicy(root) {
  const checks = policyChecks(root);
  checks.verifyCoverage();
  checks.files.forEach(checks.verifyComponent);
  return checks.files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('操作校验与反馈登记通过，共 ' + verifyPolicy(process.cwd()) + ' 个运行时组件');
}
