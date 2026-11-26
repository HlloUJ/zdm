import { protectionChanged } from './change-facts.mjs';

// Planning also runs before npm ci, using the verifier extracted from the target branch.
// Recognize a bounded presentation grammar. Unrecognized syntax stays in the ordinary planner.
const digits = '零一二三四五六七八九';
function chineseOrdinal(n) {
  if (n < 10) return digits[n];
  return (n < 20 ? '' : digits[Math.floor(n / 10)]) + '十' + (n % 10 ? digits[n % 10] : '');
}
const ordinals = new Map(Array.from({ length: 100 }, (_, n) => [chineseOrdinal(n), String(n)]));
const canonical = value => value.trim().replace(/[ \t]+/g, ' ').replace(/[：:]$/, '')
  .replaceAll('商品中心', '选品中心').replaceAll('可售库存数量', '可售数量')
  .replace(/^请(?:输入|填写)(?=\p{Script=Han})/u, '请输入')
  .replace(/第([零一二三四五六七八九十]+)(?=[级步章节项页组轮])/gu,
    (match, n) => ordinals.has(n) ? '第' + ordinals.get(n) : match)
  .replace(/([零一二三四五六七八九十]+)(?=级)/gu, (match, n) => ordinals.get(n) ?? match);

const textTags = new Set('span label caption th p button h1 h2 h3 h4 h5 h6 t-button t-link'.split(' '));
const nativeTitle = /^(?:a|button|div|h[1-6]|input|label|p|section|span|table|td|textarea|th)$/;
function presentationProp(tag, name, wrapper) {
  if (['title', 'aria-label'].includes(name) && nativeTitle.test(tag)) return true;
  if (name === 'placeholder' && /^(?:input|textarea|t-input|t-textarea)$/.test(tag)) return true;
  if (name === 'label' && tag === 't-form-item') return true;
  return name === 'header' && (tag === 't-dialog' || wrapper(tag));
}

// Quoted '>' in Vue bindings is an attribute value, not the end of a tag.
const markup = /<!--[\s\S]*?-->|\{\{[\s\S]*?\}\}|<\/?[\w:-]+(?:[^'"<>]|"[^"]*"|'[^']*')*?>/g;
const attribute = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
function structure(source, wrapper) {
  const start = /^\s*<template>/.exec(source);
  if (!start) return;
  const nextBlock = source.search(/<(?:script|style)(?:\s|>)/);
  const end = source.lastIndexOf('</template>', nextBlock < 0 ? source.length : nextBlock);
  if (end < start[0].length) return;
  const template = source.slice(start[0].length, end);
  const slots = [], stack = [], elements = [];
  let cursor = 0, skeleton = source.slice(0, start[0].length);
  function slot(kind, value) {
    slots.push({ kind, value });
    return '\0' + kind + '\0';
  }
  function text(value) {
    return value.trim() && !/[<>{}]/.test(value) && textTags.has(stack.at(-1))
      ? slot('text', value) : value;
  }
  for (const match of template.matchAll(markup)) {
    skeleton += text(template.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('{{')) { skeleton += token; continue; }
    const tag = /^<(\/?)([\w:-]+)/.exec(token);
    if (tag[1]) {
      if (stack.pop() !== tag[2]) return;
      skeleton += token;
      continue;
    }
    const props = new Map();
    const attrs = token.slice(tag[0].length).replace(attribute, (raw, key, double, single) => {
      const value = double ?? single;
      props.set(key, value);
      const name = key.replace(/^(?::|v-bind:)/, '');
      if (!value || !presentationProp(tag[2], name, wrapper)) return raw;
      const quote = double !== undefined ? '"' : "'";
      return raw.slice(0, raw.indexOf(quote) + 1) + slot(key === name ? 'text' : 'expression', value) + quote;
    });
    elements.push(props);
    skeleton += tag[0] + attrs;
    if (!token.endsWith('/>') && !voidTags.has(tag[2])) stack.push(tag[2]);
  }
  if (stack.length) return;
  return { slots, elements, skeleton: skeleton + text(template.slice(cursor)) + source.slice(end) };
}

// Extract literals only from the display branches. Conditions and data references must match exactly.
function branches(expression) {
  const conditional = /^([\w$.]+(?:\s*(?:===|!==)\s*'[^'\\]*')?)\s*\?\s*(.+?)\s*:\s*(.+)$/s.exec(expression);
  const values = conditional ? conditional.slice(2) : [expression];
  if (values.some(value => !/^(?:'[^'\\]*'|"[^"\\]*"|`[^`\\]*`)$/s.test(value)
      || (value[0] !== '`' && value.includes('${')))) return;
  return { condition: conditional?.[1] ?? '', values: values.map(value => value.slice(1, -1)) };
}
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function rangeEvidence(variable, start, end, page, elements, condition) {
  const setup = /<script\s+setup(?:\s[^>]*)?>([\s\S]*?)<\/script>/.exec(page);
  if (!setup) return false;
  const source = setup[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const name = escaped(variable);
  const union = new RegExp('^const\\s+' + name + '\\s*(?::\\s*([\\d |]+)\\s*=|=\\s*ref<([\\d |]+)>)', 'm').exec(source);
  if (union) {
    const values = (union[1] || union[2]).split('|').map(Number);
    return values.length > 0 && values.every(n => Number.isSafeInteger(n) && n >= start && n <= end);
  }
  // A tree creation dialog can open at the root or from a bounded parent-row action.
  // Follow the actual computed field, mode setter, call sites and row projection.
  const child = new RegExp('\\bconst\\s+' + name + '\\s*=\\s*computed\\(\\(\\)\\s*=>\\s*\\((\\w+)\\.value\\s*\\?\\s*\\1\\.value\\.(\\w+)\\s*\\+\\s*1\\s*:\\s*1\\)\\)').exec(source);
  const mode = /^(\w+)\s*===\s*'([\w-]+)'$/.exec(condition);
  if (!child || !mode || start !== 1) return false;
  const field = escaped(child[2]);
  const setters = [...source.matchAll(new RegExp('\\b' + mode[1] + "\\.value\\s*=\\s*'" + mode[2] + "'", 'g'))];
  if (setters.length !== 1) return false;
  const handler = /const\s+(\w+)\s*=\s*\((\w+)\?:\s*(\w+)\)\s*=>\s*\{\s*$/.exec(source.slice(0, setters[0].index));
  if (!handler) return false;
  const selected = new RegExp('\\bconst\\s+' + child[1] + '\\s*=\\s*computed\\(\\(\\)\\s*=>\\s*(\\w+)\\((\\w+\\.\\w+)\\)\\)').exec(source);
  const body = source.slice(setters[0].index).split(/\n\};/, 1)[0];
  if (!selected || !new RegExp('\\bif\\s*\\(' + handler[2] + '\\)\\s*' + escaped(selected[2])
      + '\\s*=\\s*' + handler[2] + '\\.(\\w+)\\s*;').test(body)) return false;
  const type = new RegExp('\\binterface\\s+' + handler[3] + '\\s*\\{([^}]+)\\}').exec(source);
  const bounds = new RegExp('\\b' + field + '\\s*:\\s*([\\d |]+);').exec(type?.[1] ?? '');
  if (!bounds || !bounds[1].split('|').map(Number).every(n => n >= start && n <= end)) return false;
  const usages = elements.flatMap(attrs => [...attrs.entries()]
    .filter(([key, v]) => /^@click(?:\.|$)/.test(key) && v?.startsWith(handler[1] + '('))
    .map(([, value]) => ({ attrs, value })));
  if (!usages.length || (page.match(new RegExp('\\b' + handler[1] + '\\b', 'g')) || []).length !== usages.length + 1) return false;
  return usages.every(({ attrs, value }) => {
    if (value === handler[1] + '()') return true;
    const row = /^\w+\((\w+)\.(\w+)\)$/.exec(value);
    if (!row) return false;
    const guard = (attrs.get('v-if') || '').split(/\s*&&\s*/);
    return guard.every(part => /^[\w.]+$/.test(part) || part === row[1] + '.' + child[2] + ' < ' + end)
      && guard.includes(row[1] + '.' + child[2] + ' < ' + end)
      && [...source.matchAll(/\b\w+\.push\(\{([\s\S]*?)\}\)/g)].some(([, fields]) =>
        new RegExp('\\b' + field + '\\s*:\\s*' + row[2] + '\\.' + field + '\\s*,').test(fields)
        && new RegExp('(?:^|,)\\s*' + row[2] + '\\s*,?\\s*$').test(fields) && !fields.includes('...'));
  });
}

function equivalent(old, next, source, elements, condition, terms) {
  // Only replace a lookup by its original variable after independently proving its reachable domain.
  const normalize = (value, other) => value.replace(/\$\{\s*\[\s*('[^'\\]*'(?:\s*,\s*'[^'\\]*')*)\s*,?\s*\]\[([A-Za-z_$][\w$]*)(?:\s*-\s*(\d+))?\]\s*\}/g,
    (raw, items, variable, offset) => {
      const labels = [...items.matchAll(/'([^']*)'/g)].map(m => m[1]);
      const start = Number(offset || 0), end = start + labels.length - 1;
      if (end >= 100 || !labels.every((label, i) => label === chineseOrdinal(start + i))
          || !rangeEvidence(variable, start, end, source, elements, condition)) return raw;
      for (const [i, label] of labels.entries()) {
        terms.add(other.replace('${' + variable + '}', String(start + i)));
        terms.add(value.replace(raw, label));
      }
      return '${' + variable + '}';
    });
  const fields = text => [...text.matchAll(/\$\{([^{}]+)\}/g)].map(m => m[1]);
  const left = normalize(old, next), right = normalize(next, old);
  const a = fields(left), b = fields(right);
  if (a.length !== b.length || !a.every((field, i) =>
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(field) && field === b[i])) return false;
  if (/[{}]/.test(left.replace(/\$\{[^{}]+\}/g, '')) || /[{}]/.test(right.replace(/\$\{[^{}]+\}/g, ''))) return false;
  return canonical(left) === canonical(right);
}

export function presentationCopy(change, wrapper = () => false) {
  if (!change.path.endsWith('.vue') || !change.before || !change.after || change.unsafeType) return;
  if (/\.(?:textContent|innerText|innerHTML)\b|\.getAttribute\s*\(\s*['"](?:title|placeholder|aria-label)['"]/.test(
    [change.before, change.after, ...(change.readerUses || [])].join('\n'))) return;
  const before = structure(change.before, wrapper), after = structure(change.after, wrapper);
  if (!before || before.skeleton !== after?.skeleton || before.slots.length !== after.slots.length) return;
  const terms = new Set();
  for (const [i, old] of before.slots.entries()) {
    const next = after.slots[i];
    if (old.value === next.value) continue;
    if (old.kind === 'text') {
      if (canonical(old.value) !== canonical(next.value)) return;
      terms.add(old.value.trim()); terms.add(next.value.trim());
      continue;
    }
    const a = branches(old.value), b = branches(next.value);
    if (!a || !b || a.condition !== b.condition || a.values.length !== b.values.length) return;
    for (const [j, value] of a.values.entries()) {
      if (value === b.values[j]) continue;
      if (!equivalent(value, b.values[j], change.before, before.elements, a.condition, terms)) return;
      for (const label of [value, b.values[j]]) if (!label.includes('${')) terms.add(label);
    }
    terms.add(next.value);
  }
  if (terms.size) return [...terms];
}

// Existing assertions and setup may move as part of adding a display check. Account for each
// removed line once. Only proven text in a display lookup or expectation can be substituted.
function testSections(source) {
  const cases = new Map(), outside = [];
  let cursor = 0;
  for (const m of source.matchAll(/^([ \t]*)(?:test|it)\(\s*(['"])([^'"\\\n]+)\2\s*,/gm)) {
    if (m.index < cursor || cases.has(m[3])) return;
    const closing = new RegExp('^' + m[1] + '\\}\\);[ \\t]*$', 'm').exec(source.slice(m.index + m[0].length));
    if (!closing) return;
    outside.push(source.slice(cursor, m.index));
    cursor = m.index + m[0].length + closing.index + closing[0].length;
    cases.set(m[3], source.slice(m.index, cursor));
  }
  if (!cases.size) return;
  cases.set('', outside.join('\n') + source.slice(cursor));
  return cases;
}

export function copyTestWeakened(change, terms) {
  const normalize = line => {
    if (!/\b(?:getByText|getByRole|getByPlaceholder|getByLabel|toHaveText|toContainText|toHaveAccessibleName|hasText)\b/.test(line)) return line.trim();
    return line.trim().replace(/(\b(?:getByText|getByPlaceholder|getByLabel|toHaveText|toContainText|toHaveAccessibleName)\(\s*|\b(?:name|hasText):\s*)(['"])([^'"\\]*)\2/g,
      (raw, prefix, quote, label) => terms.has(label) ? prefix + quote + canonical(label) + quote : raw);
  };
  if (protectionChanged({ ...change, removed: change.removed.map(normalize), added: change.added.map(normalize) })) return true;
  if (!change.before && testSections(change.after || '')) return false;
  function altered(removed, added) {
    const count = new Map();
    for (const line of added.map(normalize)) count.set(line, (count.get(line) || 0) + 1);
    for (const line of removed.map(normalize)) {
      if (!line) continue;
      if (!count.get(line)) return true;
      count.set(line, count.get(line) - 1);
    }
    return [...count].some(([line, n]) => n && (
      /\b(?:return|throw|catch|if|else|for|while|finally|test\.skip|test\.fixme|expect\.soft|test\.only)\b|\/\*|\*\//.test(line)
      || /\.(?:route|unroute|mock|spyOn|mockImplementation|abort|fulfill|setDefaultTimeout)\s*\(/.test(line)
    ));
  }
  const before = testSections(change.before || ''), after = testSections(change.after || '');
  if (!before || !after) return altered(change.removed || [], change.added || []);
  for (const [name, body] of before) {
    const next = after.get(name);
    if (next === undefined || (body !== next && altered(body.split('\n'), next.split('\n')))) return true;
  }
  return false;
}
