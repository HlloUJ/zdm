package com.zdm.platform.storeservice;

import com.zdm.platform.common.FieldValidationException;

import com.zdm.platform.inventory.CityPartnerStoreScope;
import com.zdm.platform.inventory.CityPartnerStoreScope.Store;
import com.zdm.platform.media.*;
import com.zdm.platform.security.PermissionGuard;
import com.zdm.platform.storeexit.StoreExitTargetService;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

@Service
public class StoreServiceCatalog {
  public record Input(String name, String price, Long imageId) {}
  public record Item(long id, String name, String price, Long imageId, String status,
                     String creatorName, LocalDateTime createdAt) {}
  private static final String PREFIX = "store.service-management";
  private static final String DOMAIN = "STORE_SERVICE_IMAGE";
  private static final String SELECT = """
      SELECT id,name,price,image_id,enabled,deleted_at,creator_name,created_at FROM store_services
      WHERE tenant_id=? AND store_id=?
      """;
  private final JdbcTemplate jdbc;
  private final CityPartnerStoreScope scope;
  private final StoreExitTargetService fence;
  private final PermissionGuard permissions;
  private final MediaAssetService media;
  private final MediaReferenceService references;
  private final MediaCleanupService cleanup;

  public StoreServiceCatalog(JdbcTemplate jdbc, CityPartnerStoreScope scope, StoreExitTargetService fence,
      PermissionGuard permissions, MediaAssetService media, MediaReferenceService references, MediaCleanupService cleanup) {
    this.jdbc = jdbc;
    this.scope = scope;
    this.fence = fence;
    this.permissions = permissions;
    this.media = media;
    this.references = references;
    this.cleanup = cleanup;
  }

  private Store reader() {
    permissions.requirePermission(PREFIX + ".view");
    return scope.require();
  }

  private Store writer(String action) {
    Store store = reader();
    permissions.requirePermission(PREFIX + "." + action);
    if (!fence.lockStore(store.storeId())) throw new AccessDeniedException("门店不可用");
    return store;
  }

  private Item item(ResultSet row, int index) throws SQLException {
    String status = row.getTimestamp("deleted_at") != null ? "deleted" : row.getBoolean("enabled") ? "enabled" : "disabled";
    return new Item(row.getLong("id"), row.getString("name"), row.getBigDecimal("price").toPlainString(),
        row.getObject("image_id", Long.class), status, row.getString("creator_name"), row.getTimestamp("created_at").toLocalDateTime());
  }

  public List<Item> list(boolean selectable) {
    Store store = reader();
    return jdbc.query(SELECT + " AND deleted_at IS NULL" + (selectable ? " AND enabled" : "") + " ORDER BY id DESC",
        this::item, store.tenantId(), store.storeId());
  }

  private Item find(Store store, long id, boolean includeDeleted) {
    return jdbc.query(SELECT + " AND id=?" + (includeDeleted ? "" : " AND deleted_at IS NULL"),
        this::item, store.tenantId(), store.storeId(), id).stream().findFirst()
        .orElseThrow(() -> new IllegalArgumentException("服务不存在"));
  }

  public Item lookup(long id, boolean includeDeleted) { return find(reader(), id, includeDeleted); }

  @Transactional
  public Item save(Long id, Input input) {
    Store store = writer(id == null ? "create" : "edit");
    Item previous = id == null ? null : find(store, id, false);
    String name = input.name() == null ? "" : input.name().strip();
    if (name.isBlank() || name.codePointCount(0,name.length()) > 10) throw new FieldValidationException("name", "服务名称须为 1 至 10 个字符");
    if (input.price() == null || !input.price().matches("[0-9]+([.][0-9]{1,2})?"))
      throw new FieldValidationException("price", "请填写非负价格，最多两位小数");
    BigDecimal price = new BigDecimal(input.price()).setScale(2);
    if (price.precision() > 65) throw new FieldValidationException("price", "金额超出可精确保存的范围");
    if (input.imageId() != null && (previous == null || !Objects.equals(previous.imageId(), input.imageId())))
      requireTemporaryImage(input.imageId(), store);
    try {
      if (id == null) {
        jdbc.update("INSERT INTO store_services(tenant_id,store_id,name,price,image_id,created_by_account_id,creator_name) VALUES(?,?,?,?,?,?,?)",
            store.tenantId(),store.storeId(),name,price,input.imageId(),store.accountId(),store.operatorName());
        id = jdbc.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
      } else {
        jdbc.update("UPDATE store_services SET name=?,price=?,image_id=? WHERE tenant_id=? AND store_id=? AND id=?",
            name,price,input.imageId(),store.tenantId(),store.storeId(),id);
      }
    } catch (DuplicateKeyException ex) {
      throw FieldValidationException.withHint("name", "本店已有同名服务", "服务名称已存在，请更换名称");
    }
    references.replace(DOMAIN,id,input.imageId() == null ? Map.of() : Map.of("image",input.imageId()));
    return find(store,id,false);
  }

  @Transactional
  public void status(long id, boolean enabled) {
    Store store = writer("toggle-status");
    find(store,id,false);
    jdbc.update("UPDATE store_services SET enabled=? WHERE tenant_id=? AND store_id=? AND id=?",enabled,store.tenantId(),store.storeId(),id);
  }

  @Transactional
  public void delete(long id) {
    Store store = writer("delete");
    find(store,id,false);
    jdbc.update("UPDATE store_services SET deleted_at=CURRENT_TIMESTAMP(3),image_id=NULL WHERE tenant_id=? AND store_id=? AND id=?",
        store.tenantId(),store.storeId(),id);
    references.removeBusiness(DOMAIN,id,"删除门店服务");
  }

  private Store imageWriter() {
    Store store = reader();
    permissions.requireAnyPermission(PREFIX+".create",PREFIX+".edit");
    if (!fence.lockStore(store.storeId())) throw new AccessDeniedException("门店不可用");
    return store;
  }

  private void requireTemporaryImage(long id, Store store) {
    MediaAsset asset = media.requireAvailableForUpdate(id);
    if (!"store-service".equals(asset.getAccessLevel()) || !"image".equals(asset.getMediaType())
        || !"temporary".equals(asset.getStatus()) || !Objects.equals(asset.getStoreId(),store.storeId())
        || !Objects.equals(asset.getTenantId(),store.tenantId()) || !Objects.equals(asset.getCreatedByAccountId(),store.accountId()))
      throw FieldValidationException.withHint("imageId", "服务主图不可用", "服务主图不可用，请重新选择图片");
  }

  @Transactional
  public long upload(MultipartFile file) {
    imageWriter();
    return media.uploadStoreServiceImage(file).id();
  }

  @Transactional
  public void release(long mediaId) {
    requireTemporaryImage(mediaId,imageWriter());
    cleanup.enqueueAfterCommit(List.of(mediaId),"取消服务主图上传");
  }

  public MediaAsset image(long id, long imageId) {
    Item service = lookup(id,false);
    if (!Objects.equals(service.imageId(),imageId)) throw new IllegalArgumentException("服务主图不存在");
    return media.requireAvailable(imageId);
  }
}
