const browserSpec = p => /^tests\/e2e\/.+\.spec\.[jt]s$/.test(p);

// These shared controls have a measured geometry regression in the cited suite.
// A coverage entry selects tests only after the source has been classified as presentation.
const sharedCoverage = [{
  selectors: new Set([
    '.t-button[data-loading-button]:has(>.t-button__text:not(:empty)):not(:has(>.t-icon,>.t-loading))::before',
    '.t-button.t-size-s[data-loading-button]', '.t-button.t-size-l[data-loading-button]',
    '.row-loading-slot', '.t-link .t-link__prefix-icon:has(>.row-loading-slot):not(:has(.t-loading))',
  ]),
  properties: /^(?:width|display|content|flex|justify-content|margin-inline-end|--loading-icon-size)$/,
  suites: ['tests/e2e/store-category-management.spec.ts'],
}];

// The selector, measurement and assertion must occur in the same active browser case on both trees.
export function measuresSelector(source, selector, dimension) {
  const starts = [...source.matchAll(/(?:^|\n)\s*test(\.[\w.]+)?\s*\(/g)];
  const locator = new RegExp("\\b(?:locator|querySelector(?:All)?|matches)\\s*\\(\\s*(['\"])" +
    selector.replace(/[^\w-]/g, '\\$&') + "\\1\\s*\\)");
  return starts.some((start, i) => {
    if (start[1]) return false;
    const body = source.slice(start.index, starts[i + 1]?.index);
    if (dimension === 'width' && !/\b(?:width|offsetWidth)\b/.test(body)) return false;
    if (dimension === 'height' && !/\b(?:height|offsetHeight)\b/.test(body)) return false;
    return locator.test(body) && /\b(?:offsetWidth|offsetHeight|boundingBox|getBoundingClientRect)\b/.test(body) &&
      /\bexpect\s*\(/.test(body);
  });
}

function blocks(source) {
  const rules = new Map();
  for (const [, header, body] of source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = header.trim();
    const bodies = rules.get(selector) || [];
    bodies.push(body.trim());
    rules.set(selector, bodies);
  }
  return rules;
}

function topLevelSelectors(header) {
  let depth = 0, start = 0;
  const selectors = [];
  if (/['"\\]/.test(header)) return [];
  for (let i = 0; i < header.length; i++) {
    const char = header[i];
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (depth < 0) return [];
    if (char === ',' && !depth) {
      selectors.push(header.slice(start, i));
      start = i + 1;
    }
  }
  return depth ? [] : [...selectors, header.slice(start)];
}

const geometryProperty = /^(?:width|height|min-width|max-width|min-height|max-height|margin(?:-[\w-]+)?|padding(?:-[\w-]+)?|gap|font-size|line-height)$/;

function sharedSuites(before, after, files, evidence) {
  if (!evidence) return [];
  // Unknown nesting, cascade reordering and indirection need the entire frontend suite.
  const atRules = source => {
    const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
    return [...text.matchAll(/@[\w-]+[^;{]*(?:;|\{)/g)].map(match => {
      let end = match.index + match[0].length;
      let depth = match[0].endsWith('{') ? 1 : 0;
      while (depth && end < text.length) {
        if (text[end] === '{') depth++;
        if (text[end++] === '}') depth--;
      }
      return text.slice(match.index, end);
    });
  };
  if (JSON.stringify(atRules(before)) !== JSON.stringify(atRules(after))) return [];
  const left = blocks(before), right = blocks(after);
  if (JSON.stringify([...left.keys()].filter(k => right.has(k))) !==
      JSON.stringify([...right.keys()].filter(k => left.has(k)))) return [];
  const changed = [...new Set([...left.keys(), ...right.keys()])]
    .filter(key => JSON.stringify(left.get(key)) !== JSON.stringify(right.get(key)));
  if (!changed.length) return [];
  const suites = new Set();
  for (const key of changed) {
    const declarations = [...(left.get(key) || []), ...(right.get(key) || [])]
      .flatMap(body => body.split(';')).map(d => d.trim()).filter(Boolean);
    const selectors = topLevelSelectors(key);
    const coverage = sharedCoverage.find(row => selectors.length && selectors.every(s =>
      row.selectors.has(s.trim().replace(/\s*([>,])\s*/g, '$1').replace(/\s+/g, ' '))) &&
      declarations.every(d => row.properties.test(d.split(':')[0].trim())) &&
      row.suites.every(p => files.includes(p) && evidence.measured(p, '.t-loading', 'width')));
    if (coverage) {
      for (const suite of coverage.suites) suites.add(suite);
      continue;
    }
    if (!selectors.length || !declarations.every(d => geometryProperty.test(d.split(':')[0].trim()))) return [];
    for (const selector of selectors.map(s => s.trim())) {
      if (!/^[.#][\w-]+$/.test(selector)) return [];
      const dimensions = ['width', 'height'].filter(dimension =>
        declarations.some(d => d.split(':')[0].trim().endsWith(dimension)));
      const matching = evidence.find(selector).filter(p => browserSpec(p) &&
        (dimensions.length ? dimensions : [null]).every(dimension => evidence.measured(p, selector, dimension)));
      if (!matching.length) return [];
      for (const suite of matching) suites.add(suite);
    }
  }
  return [...suites].sort();
}

export function layoutImpact(change, files, evidence) {
  let before = change.before || '', after = change.after || '';
  if (change.path.endsWith('.vue')) {
    const style = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
    if (!before || !after || before.replace(style, '') !== after.replace(style, '') ||
        !before.match(style)?.length || !after.match(style)?.length) return null;
    // A change of scope, preprocessing or external stylesheet is a component contract change.
    const tags = text => [...text.matchAll(/<style\b[^>]*>/gi)].map(m => m[0]);
    if (JSON.stringify(tags(before)) !== JSON.stringify(tags(after))) return null;
    before = before.match(style).map(s => s.replace(/^<style\b[^>]*>|<\/style>$/gi, '')).join('\n');
    after = after.match(style).map(s => s.replace(/^<style\b[^>]*>|<\/style>$/gi, '')).join('\n');
  } else if (!change.path.endsWith('.css')) return null;
  if (/@import|url\(|expression\(/i.test(change.patch)) return null;
  const e2e = sharedSuites(before, after, files, evidence);
  return { e2e, reason: e2e.length ? '布局尺寸或视口变化，验证实际页面或共享控件的回归用例：' + e2e.join('、')
    : '布局尺寸或视口变化，缺少覆盖全部变更选择器的定向用例，执行前端端到端全套' };
}

function editedText(old, next) {
  let start = 0, a = old.length, b = next.length;
  while (start < a && start < b && old[start] === next[start]) start++;
  while (a > start && b > start && old[a - 1] === next[b - 1]) { a--; b--; }
  return old.slice(start, a) + ' ' + next.slice(start, b);
}

// Only exclusively visual wording may follow a layout change. Unrecognized contractual text retains its own review.
const visualTerm = /宽|高|字号|字体|行距|间距|图标|布局|排版|\b(?:width|height|font|spacing|layout|icon)\b/i;
const visualWords = /字号|字体|文字|行距|尺寸|间距|图标|宽度|高度|排版|位置|布局|按钮|行内操作|自适应|空闲|动画|显示|出现|结束|恢复|撑开|扩宽|稳定|保持|旁边|已有|自然|遵守同一规则|颜色|背景|对齐|仅在|以及|之前|之后|时|按|后|的|和|与|在|[A-Za-z]+|[\d\s\p{P}\p{S}]+/gu;
const englishVisual = /^(?:the|a|an|of|on|in|at|and|or|to|for|with|when|from|is|its|now|px|em|rem|button|panel|label|row|column|width|height|font|size|line|spacing|layout|icon|icons|expands?|shows?|visible|hidden|idle|loading|text|natural|auto|color|background|align|padding|margin)$/i;
export function layoutNote(change) {
  if (!/^docs\/ui\/.+\.md$/.test(change.path) || !change.added?.length ||
      change.added.length !== change.removed.length) return false;
  return change.added.every((line, i) => {
    const changed = editedText(change.removed[i], line);
    const dimension = /((?:宽度|高度|字号|行距|间距|\bwidth|\bheight|\bfont-size|\bspacing)\s*[:：]?\s*)\d+(?:\.\d+)?(?:px|em|rem|%)?/gi;
    if (change.removed[i] !== line && change.removed[i].replace(dimension, '$1#') === line.replace(dimension, '$1#')) return true;
    return visualTerm.test(changed) && !changed.replace(visualWords,
      word => /^[a-z]+$/i.test(word) && !englishVisual.test(word) ? word : '').trim();
  });
}
