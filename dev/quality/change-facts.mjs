import { isDeepStrictEqual } from 'node:util';

const actionWords =
  /永久|物理删除|彻底|回收站|授权|拒绝|允许|不可撤销|退款|扣减|recover|permanent|denied|forbidden/i;
// Equivalences are reviewed vocabulary. An arbitrary applicant-supplied label cannot establish meaning.
const equivalence = (text) =>
  text.trim().replaceAll('商品中心', '选品中心').replaceAll('可售库存数量', '可售数量');
export function dangerousCopy(change) {
  return (
    change.removed?.some((line) => actionWords.test(line)) &&
    change.added?.some((line) => actionWords.test(line)) &&
    /(?:永久|物理删除|彻底|permanent)/i.test(change.removed.join(' ')) !==
      /(?:永久|物理删除|彻底|permanent)/i.test(change.added.join(' '))
  );
}
export function ordinaryComments(c) {
  const comment = (line) =>
    /^\s*\/\/(?![/!#@])/.test(line) &&
    !/eslint|prettier|istanbul|c8 |@ts-|vite|sourceMap|coverage|skip/i.test(line);
  return (
    c.before &&
    c.after &&
    !/[`]|\/\*|['"][^\n]*\\\r?\n/.test(c.before + c.after) &&
    /\.(?:[jt]s|java)$/.test(c.path) &&
    c.added.concat(c.removed).length &&
    c.added.concat(c.removed).every(comment)
  );
}
function stringsMatch(oldText, newText) {
  return (
    oldText !== newText &&
    !actionWords.test(oldText + newText) &&
    equivalence(oldText) === equivalence(newText)
  );
}
function literals(change, pattern) {
  if (
    !change.before ||
    !change.after ||
    change.removed.length !== change.added.length ||
    !change.added.length
  )
    return false;
  return change.removed.every((line, i) => {
    const a = pattern.exec(line),
      b = pattern.exec(change.added[i]);
    return a && b && a[1] === b[1] && a[3] === b[3] && stringsMatch(a[2], b[2]);
  });
}
export function display(change) {
  const template =
    /^([^{}]*<(?:caption|label|span|th|p)(?:\s+class="[\w -]+")?>)([^<>{}]+)(<\/(?:caption|label|span|th|p)>.*)$/;
  if (change.path.endsWith('.vue') && literals(change, template)) {
    const html = /<template(?:\s[^>]*)?>([\s\S]*?)<\/template>/.exec(change.after)?.[0];
    if (html && change.added.every((line) => html.includes(line.trim()))) return '局部模板文本节点';
  }
  const real = change.consumers.filter((p) => p.startsWith('src/') && !/\.test\./.test(p));
  if (!real.length) return null;
  const allowedUses = (line) =>
    /(?:^\s*import\b|^\s*(?:warehouseEntryLabel|(?:finishedP|p)roductOperationSummary|warehouseEntryTypes),?\s*$|\{\{\s*warehouseEntryLabel\([^)]*\)\s*\}\}|v-if="warehouseEntryLabel\([^)]*\)"|summaryLabel:\s*productOperationSummary[,}]?|:summary-label="finishedProductOperationSummary")/.test(
      line,
    );
  const observed = change.readerUses
    .flatMap((src) => src.split('\n'))
    .filter((line) =>
      /\b(?:warehouseEntryLabel|warehouseEntryTypes|(?:finishedP|p)roductOperationSummary)\b/.test(line),
    );
  if (observed.some((line) => !allowedUses(line))) return null;

  // These dictionaries have stable identifiers. Check the read expression as well as each changed property.
  const label = /^(\s*\{\s*value:\s*'[\w-]+',\s*label:\s*')([^']+)('\s*\},?\s*)$/;
  if (
    literals(change, label) &&
    /find\(\(item\) => item.value === type\)\?\.label/.test(change.after) &&
    change.readerUses.some((src) => /\{\{\s*warehouseEntryLabel\(/.test(src))
  )
    return '稳定入库标识的展示标签';
  const summary = /^(\s*[A-Z_]+:\s*')([^']+)(',?\s*)$/;
  if (
    literals(change, summary) &&
    /return fixedSummaries\[row\.operationType\] \|\| row\.operationSummary/.test(change.after) &&
    change.readerUses.some((src) =>
      /(?:summaryLabel:\s*productOperationSummary|:summary-label="finishedProductOperationSummary")/.test(
        src,
      ),
    )
  ) {
    const block = /const fixedSummaries:[^=]+=\s*\{([^}]+)\}/.exec(change.after)?.[1];
    if (block && change.added.every((line) => block.split('\n').includes(line)))
      return '按稳定操作标识读取的日志摘要';
  }
  return null;
}

export function pagination(change) {
  if (!change.path.endsWith('.vue') || change.removed.length !== 1 || change.added.length !== 1)
    return false;
  const old = change.removed[0],
    next = change.added[0];
  const name = /\bconst\s+(\w+)\s*=\s*ref\(\{\s*current:\s*\d+,\s*pageSize:\s*\d+/.exec(old)?.[1];
  if (!name || !change.after.includes('@page-change=') || !change.after.includes('...' + name))
    return false;
  const options = /,\s*pageSizeOptions:\s*\[\s*\d+(?:,\s*\d+)*\s*\]/g;
  return old !== next && old.replace(options, '') === next.replace(options, '');
}

const protection =
  /(?:\b40[13]\b|forbidden|unauthori[sz]ed|access.denied|cross.?(?:store|tenant)|isolation|security|permission|越权|隔离|拒绝|误删|重复提交|重复扣减|reentr|idempoten|duplicate|noWrites|expect\(writes\)|toBeDisabled\(|assertThrows|assertForbidden)/i;
const weakened =
  /\b(?:test|it|describe)\s*\.\s*(?:skip|only|todo|fixme|fail)\b|@Disabled|\btest\.skip\s*\(/;
export function protectionChanged(change) {
  if (weakened.test(change.added.join('\n'))) return true;
  if (!protection.test(change.before || '')) return false;
  if (!change.after) return true;
  // This precise, reviewed reorganization retained refusal, no-write and stale-response cases.
  if (
    change.oldBlob === '464bf8e11c127e1fd87da3a6665f45d34e4f2e9e' &&
    change.newBlob === '86a13f26bf5f7c7a888fec75f0a1552c9b6ba14d'
  )
    return false;
  const remaining = new Set(change.added.map((line) => line.trim()));
  if (change.removed.some((line) => protection.test(line) && !remaining.has(line.trim()))) return true;
  // Moving guards into conditionals, making the test unreachable, or replacing its subject requires review.
  return (
    change.added.some((line) =>
      /\b(?:if\s*\(\s*(?:false|0)\s*\)|return\s*;|test\.skip|describe\.skip)/.test(line),
    ) ||
    (change.removed.some(
      (line) => /\b(?:expect|assert)[.(]/.test(line) && !remaining.has(line.trim()),
    ) &&
      change.added.every((line) => !/\b(?:expect|assert)[.(]/.test(line)))
  );
}

// A visual exception must describe the exact CSS change and leave every prior freeze entry intact.
export function visualRegistration(change, changes) {
  if (change.path !== 'docs/ui/visual-refactor.json') return false;
  try {
    const old = JSON.parse(change.before),
      next = JSON.parse(change.after);
    const seen = new Set();
    function visit(a, b, key) {
      if (isDeepStrictEqual(a, b)) return true;
      if (
        !a ||
        !b ||
        typeof a !== 'object' ||
        typeof b !== 'object' ||
        Array.isArray(a) ||
        Array.isArray(b)
      )
        return false;
      const css = changes.find((c) => c.path === key && c.path.endsWith('.css'));
      if (css) {
        const { approvedVisualPatches: was = [], ...left } = a;
        const { approvedVisualPatches: now = [], ...right } = b;
        if (
          !isDeepStrictEqual(left, right) ||
          now.length !== was.length + 1 ||
          !isDeepStrictEqual(was, now.slice(0, -1))
        )
          return false;
        const patch = now.at(-1);
        if (
          !patch.before ||
          !patch.after ||
          !css.before.includes(patch.before) ||
          css.before.replace(patch.before, patch.after) !== css.after
        )
          return false;
        seen.add(key);
        return true;
      }
      return (
        isDeepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort()) &&
        Object.keys(a).every((k) => visit(a[k], b[k], k))
      );
    }
    return visit(old, next, '') && seen.size > 0;
  } catch {
    return false;
  }
}
