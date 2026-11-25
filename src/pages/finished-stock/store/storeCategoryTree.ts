interface CategoryNode {
  id: number;
  parentId?: number | null;
  status: string;
}

export function storeCategoryTree<T extends CategoryNode>(categories: T[]) {
  const children = new Map<number | null, T[]>();
  for (const node of categories) {
    if (node.status !== 'enabled') continue;
    const key = node.parentId ?? null;
    const group = children.get(key);
    if (group) group.push(node);
    else children.set(key, [node]);
  }

  const enabledIds = new Set<number>();
  const leafIds = new Set<number>();
  function visit(node: T) {
    if (enabledIds.has(node.id)) return;
    enabledIds.add(node.id);
    const next = children.get(node.id);
    if (next?.length) next.forEach(visit);
    else leafIds.add(node.id);
  }
  children.get(null)?.forEach(visit);
  return { children, enabledIds, leafIds };
}
