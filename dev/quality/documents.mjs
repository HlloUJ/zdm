import { posix } from 'node:path';
import { git } from './repository.mjs';

function localLinks(markdown, file) {
  const result = [];
  for (const match of markdown.matchAll(/\[[^\]\n]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
    const link = match[1] || match[2];
    if (/^(?:[a-z][a-z+.-]*:|\/\/)/i.test(link)) continue;
    const [target, fragment] = link.split('#');
    const decoded = decodeURIComponent(target.split('?')[0]);
    result.push({
      target: decoded
        ? posix.normalize(
            posix.join(decoded.startsWith('/') ? '' : posix.dirname(file), decoded.replace(/^\//, '')),
          )
        : file,
      fragment: fragment ? decodeURIComponent(fragment) : null,
    });
  }
  return result;
}
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, (c) => (c === '-' || c === '_' ? c : ''))
    .replace(/\s/g, '-');
}
export function checkDocuments(snap) {
  const files = new Set(snap.blobs.map(([name]) => name));
  let count = 0;
  for (const file of snap.files.filter((path) => path.endsWith('.md') && files.has(path))) {
    const patch = git(snap.cwd, [
      '--literal-pathspecs',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '-U0',
      snap.from,
      snap.tree,
      '--',
      file,
    ]);
    const added = patch
      .split('\n')
      .filter((line) => /^\+(?!\+\+)/.test(line))
      .map((line) => line.slice(1))
      .join('\n');
    for (const link of localLinks(added, file)) {
      let target = link.target;
      if (!files.has(target) && files.has(posix.join(target, 'README.md')))
        target = posix.join(target, 'README.md');
      if (!files.has(target)) throw Error(file + ' 引用了不存在的文件 ' + target);
      if (link.fragment && target.endsWith('.md')) {
        const source = git(snap.cwd, ['show', snap.tree + ':' + target]);
        const headings = [...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1]));
        if (!headings.includes(link.fragment) && !source.includes('id="' + link.fragment + '"'))
          throw Error(file + ' 引用了不存在的标题 ' + target + '#' + link.fragment);
      }
      count++;
    }
  }
  return '已核对本次文档改动中的 ' + count + ' 个仓内链接。\n';
}
