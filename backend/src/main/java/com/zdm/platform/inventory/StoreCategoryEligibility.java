package com.zdm.platform.inventory;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class StoreCategoryEligibility {
  private StoreCategoryEligibility() {}

  public interface Node {
    Long id();
    Long parentId();
    String status();
  }

  /** Walk enabled paths from their roots. Disabled children do not prevent selection of the parent. */
  public static Set<Long> usableLeaves(Collection<? extends Node> nodes) {
    var children = new HashMap<Long, List<Long>>();
    var queue = new ArrayDeque<Long>();
    for (Node node : nodes) {
      if (!"enabled".equals(node.status())) continue;
      if (node.parentId() == null) queue.add(node.id());
      else children.computeIfAbsent(node.parentId(), key -> new ArrayList<>()).add(node.id());
    }
    var leaves = new HashSet<Long>();
    while (!queue.isEmpty()) {
      Long id = queue.remove();
      List<Long> enabledChildren = children.get(id);
      if (enabledChildren == null) leaves.add(id);
      else queue.addAll(enabledChildren);
    }
    return Set.copyOf(leaves);
  }
}
