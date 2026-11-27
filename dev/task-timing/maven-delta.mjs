// Executed in an offline helper. Only /save is writable. The caller verifies the retained bytes again on the host.
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function digest(path) {
  const h = createHash('sha256'),
    fd = openSync(path, 'r'),
    block = Buffer.alloc(256 * 1024);
  try {
    let n;
    while ((n = readSync(fd, block, 0, block.length, null))) h.update(block.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}
const refs = readdirSync('/refs').map((n) => join('/refs', n));
if (!refs.length) throw Error('缺少独立的常驻制品副本');
const kept = [];
function scan(relative) {
  for (const entry of readdirSync(join('/candidate', relative), { withFileTypes: true })) {
    const path = join(relative, entry.name),
      src = join('/candidate', path);
    if (entry.isDirectory()) {
      scan(path);
      continue;
    }
    if (!entry.isFile()) throw Error('缓存含特殊文件，保留卷');
    if (
      path.startsWith('repository/') &&
      /(?:\/_remote\.repositories|\/resolver-status\.properties|\.lastUpdated)$/.test(path)
    )
      continue;
    const h = digest(src);
    if (
      refs.some((ref) => {
        const f = join(ref, path);
        return existsSync(f) && lstatSync(f).isFile() && digest(f) === h;
      })
    )
      continue;
    const target = join('/save', h);
    if (!existsSync(target)) copyFileSync(src, target);
    kept.push({ path, sha256: h });
  }
}
scan('');
console.log(JSON.stringify(kept));
