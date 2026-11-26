import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

const schemas = new Map([
  ['docs/ui/operation-feedback-registry.json', { table: 'approvedChanges', list: 'patches', count: 'patchCount' }],
  ['docs/ui/visual-refactor.json', { table: 'contracts', list: 'approvedBusinessPatches' }],
]);
export const isCopyRegistry = path => schemas.has(path);

function replay(source, patches, visual) {
  let result = source.before;
  for (const patch of patches) {
    const fields = visual ? ['before', 'after', 'stage', 'task', 'reason'] : ['before', 'after', 'stage'];
    if (Object.keys(patch).some(k => !fields.includes(k))
        || (patch.stage !== undefined && patch.stage !== 'before-migrations')
        || (visual && (!/^\d+$/.test(patch.task) || typeof patch.reason !== 'string'))
        || typeof patch.before !== 'string' || typeof patch.after !== 'string'
        || !patch.before || !patch.after || patch.before === patch.after) return false;
    const at = result.indexOf(patch.before);
    if (at < 0 || result.indexOf(patch.before, at + 1) !== -1) return false;
    result = result.slice(0, at) + patch.after + result.slice(at + patch.before.length);
  }
  return result === source.after;
}

// Model exactly the permitted append and compare the complete JSON documents afterwards.
// A change to any other key, existing patch, target, base hash or policy stays independently visible.
export function copyRegistration(change, sources) {
  const schema = schemas.get(change.path);
  if (!schema || !sources.size || change.unsafeType) return false;
  try {
    const expected = JSON.parse(change.before), next = JSON.parse(change.after);
    let matched = false;
    for (const [path, source] of sources) {
      let prior = expected[schema.table]?.[path];
      const current = next[schema.table]?.[path];
      if (!current || isDeepStrictEqual(prior, current)) continue;
      if (!prior) {
        if (!schema.count || !expected[schema.table]) return false;
        prior = { baseSha256: createHash('sha256').update(source.before).digest('hex'), patchCount: 0 };
        expected[schema.table][path] = prior;
      }
      const old = prior[schema.list] ?? [], patches = current[schema.list];
      if (!Array.isArray(old) || !Array.isArray(patches) || patches.length <= old.length
          || !isDeepStrictEqual(old, patches.slice(0, old.length))
          || !replay(source, patches.slice(old.length), !schema.count)) return false;
      if (schema.count) {
        if (prior[schema.count] !== old.length) return false;
        prior[schema.count] = patches.length;
      }
      prior[schema.list] = patches;
      matched = true;
    }
    return matched && isDeepStrictEqual(expected, next);
  } catch {
    return false;
  }
}

export function changesRegistrationProtection(change, changes, copies) {
  const schema = schemas.get(change.path);
  try {
    const old = JSON.parse(change.before), next = JSON.parse(change.after);
    const prior = old[schema.table], current = next[schema.table];
    delete old[schema.table]; delete next[schema.table];
    if (!isDeepStrictEqual(old, next)) return true;
    const files = new Set(changes.map(c => c.path));
    return [...new Set([...Object.keys(prior), ...Object.keys(current)])].some(path => {
      const a = prior[path], b = current[path];
      if (isDeepStrictEqual(a, b)) return false;
      if (!files.has(path) || !b || (a && a.baseSha256 !== b.baseSha256)) return true;
      const previous = a?.[schema.list] ?? [], patches = b[schema.list] ?? [];
      return !isDeepStrictEqual(previous, patches.slice(0, previous.length))
        || Boolean(schema.count && patches.length !== b[schema.count])
        || (copies.has(path) && !replay(copies.get(path), patches.slice(previous.length), !schema.count));
    });
  } catch {
    return true;
  }
}
