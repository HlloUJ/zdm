package com.zdm.platform.storeservice;

import com.zdm.platform.common.ApiResponse;
import com.zdm.platform.media.MediaStorageService;
import java.util.List;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/admin/store-services")
public class StoreServiceController {
  private final StoreServiceCatalog catalog;
  private final MediaStorageService storage;

  public StoreServiceController(StoreServiceCatalog catalog, MediaStorageService storage) {
    this.catalog = catalog;
    this.storage = storage;
  }

  @GetMapping
  public ApiResponse<List<StoreServiceCatalog.Item>> list() { return ApiResponse.ok(catalog.list(false)); }

  @GetMapping("/options")
  public ApiResponse<List<StoreServiceCatalog.Item>> options() { return ApiResponse.ok(catalog.list(true)); }

  @GetMapping("/{id}/reference")
  public ApiResponse<StoreServiceCatalog.Item> reference(@PathVariable long id) { return ApiResponse.ok(catalog.lookup(id,true)); }

  @GetMapping("/{id}")
  public ApiResponse<StoreServiceCatalog.Item> detail(@PathVariable long id) { return ApiResponse.ok(catalog.lookup(id,false)); }

  @PostMapping
  public ApiResponse<StoreServiceCatalog.Item> create(@RequestBody StoreServiceCatalog.Input input) {
    return ApiResponse.ok(catalog.save(null,input));
  }

  @PutMapping("/{id}")
  public ApiResponse<StoreServiceCatalog.Item> edit(@PathVariable long id,@RequestBody StoreServiceCatalog.Input input) {
    return ApiResponse.ok(catalog.save(id,input));
  }

  public record Status(Boolean enabled) {}

  @PutMapping("/{id}/status")
  public ApiResponse<Boolean> status(@PathVariable long id,@RequestBody Status status) {
    if (status.enabled() == null) throw new IllegalArgumentException("请指定服务状态");
    catalog.status(id,status.enabled());
    return ApiResponse.ok(true);
  }

  @DeleteMapping("/{id}")
  public ApiResponse<Boolean> delete(@PathVariable long id) {
    catalog.delete(id);
    return ApiResponse.ok(true);
  }

  @PostMapping("/images")
  public ApiResponse<Long> upload(@RequestParam MultipartFile file) { return ApiResponse.ok(catalog.upload(file)); }

  @DeleteMapping("/images/{mediaId}")
  public ApiResponse<Boolean> release(@PathVariable long mediaId) {
    catalog.release(mediaId);
    return ApiResponse.ok(true);
  }

  @GetMapping("/{id}/images/{mediaId}")
  public ResponseEntity<Resource> image(@PathVariable long id,@PathVariable long mediaId) {
    var image = catalog.image(id,mediaId);
    return ResponseEntity.ok().contentType(MediaType.parseMediaType(image.getMimeType()))
        .header("X-Content-Type-Options","nosniff").header("Cache-Control","private, no-store")
        .body(storage.load(image.getStorageKey()));
  }
}
