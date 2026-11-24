package com.zdm.platform.inventory;

import com.zdm.platform.security.PermissionGuard;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.function.Consumer;
import org.springframework.security.access.AccessDeniedException;

public record StoreBatchCategoryRequest(String tab, @NotNull @Positive Long categoryId,
    @NotEmpty List<@NotNull @Positive Long> ids) {
  @FunctionalInterface
  interface Update {
    void apply(Long id, Long categoryId, Consumer<String> authorize);
  }

  OperationsBatchShelfService.Result execute(String prefix, PermissionGuard guard, Update update) {
    guard.requireDataPermission();
    if (!List.of("warehouse", "selling", "all").contains(tab == null ? "" : tab)) {
      throw new IllegalArgumentException("当前列表不能批量设置分类");
    }
    guard.requirePermission(prefix + "." + tab + ".view");
    if ("all".equals(tab)) {
      guard.requirePermission(prefix + ".warehouse.batch-set-category");
      guard.requirePermission(prefix + ".selling.batch-set-category");
    } else {
      guard.requirePermission(prefix + "." + tab + ".batch-set-category");
    }
    var selected = new LinkedHashSet<>(ids);
    var failures = new ArrayList<OperationsBatchShelfService.Failure>();
    for (Long id : selected) {
      try {
        update.apply(id, categoryId, state -> {
          if (!List.of("warehouse", "selling").contains(state) || !("all".equals(tab) || tab.equals(state))) {
            throw new IllegalArgumentException("商品当前状态不允许在本列表设置分类");
          }
          guard.requirePermission(prefix + "." + state + ".view");
          guard.requirePermission(prefix + "." + state + ".batch-set-category");
        });
      } catch (AccessDeniedException denied) {
        failures.add(new OperationsBatchShelfService.Failure(id, "NOT_ACCESSIBLE", "商品不存在或无权操作"));
      } catch (IllegalArgumentException invalid) {
        failures.add(new OperationsBatchShelfService.Failure(id, "VALIDATION_FAILED", invalid.getMessage()));
      } catch (RuntimeException failed) {
        failures.add(new OperationsBatchShelfService.Failure(id, "EXECUTION_FAILED", "设置分类失败，请刷新后核对"));
      }
    }
    return new OperationsBatchShelfService.Result(selected.size(), selected.size() - failures.size(), failures.size(), failures);
  }
}
