package com.zdm.platform.storeservice;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.zdm.platform.security.CurrentIdentity;
import com.zdm.platform.support.SpringContainerTestSupport;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@SpringBootTest
@AutoConfigureMockMvc(addFilters = false)
@Testcontainers
class StoreServiceApiTest extends SpringContainerTestSupport {
  @Container private static final MySQLContainer<?> MYSQL = com.zdm.platform.support.MySqlTestDatabase.create()
      .withDatabaseName("service_api").withUsername("service_api").withPassword("service_api");
  @Autowired private JdbcTemplate jdbc;
  @Autowired private MockMvc mvc;
  @Autowired private StoreServiceCatalog service;
  @DynamicPropertySource static void datasource(DynamicPropertyRegistry registry) {
    registry.add("spring.datasource.url",MYSQL::getJdbcUrl);registry.add("spring.datasource.username",MYSQL::getUsername);registry.add("spring.datasource.password",MYSQL::getPassword);
  }
  @AfterEach void clear(){SecurityContextHolder.clearContext();}
  private void identity(long store, String... actions) {
    var grants = java.util.Arrays.stream(actions).map(a -> "store.service-management." + a).toList();
    var identity = new CurrentIdentity(1L,1L,1L,null,"admin",1L,store,"门店员工","self",List.of("STORE_ADMIN"),grants);
    SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(identity,null,List.of()));
  }

  @Test void storeScopeLifecycleAndHistoricalIdentity() throws Exception {
    for (long store : List.of(68101L,68102L))
      jdbc.update("INSERT INTO stores(id,tenant_id,name,type,status) VALUES(?,1,?,'cityPartner','enabled')",store,"门店"+store);
    var initial = new StoreServiceCatalog.Input(" VIP安装 ","100",null);
    identity(68101,"view");
    mvc.perform(post("/api/admin/store-services").contentType("application/json").content("{\"name\":\"配送\",\"price\":\"0\"}"))
        .andExpect(status().isForbidden());
    identity(68101,"view","create","edit","toggle-status","delete");
    var snapshot = service.save(null, initial);
    long id = snapshot.id();
    service.status(id,false);
    org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.save(null,new StoreServiceCatalog.Input("vip安装","0",null)))
        .isInstanceOfSatisfying(com.zdm.platform.common.FieldValidationException.class, error -> {
          assertThat(error.field()).isEqualTo("name");
          assertThat(error.hint()).isEqualTo("服务名称已存在，请更换名称");
        })
        .hasMessageContaining("同名");
    assertThat(service.list(true)).isEmpty();
    assertThat(service.lookup(id,true).status()).isEqualTo("disabled");
    service.status(id,true);
    service.save(id,new StoreServiceCatalog.Input("安装","120",null));
    assertThat(service.lookup(id,true).price()).isEqualTo("120.00");
    assertThat(snapshot.price()).isEqualTo("100.00");
    identity(68102,"view","create","delete");
    assertThat(service.list(false)).isEmpty();
    org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.delete(id)).hasMessageContaining("不存在");
    service.save(null,initial);
    identity(68101,"view","create","delete");
    service.delete(id);
    assertThat(service.lookup(id,true).status()).isEqualTo("deleted");
    assertThat(service.save(null,new StoreServiceCatalog.Input("安装","0",null)).id()).isNotEqualTo(id);
    org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.save(null,new StoreServiceCatalog.Input("配送","1.234",null)))
        .hasMessageContaining("两位");
  }

  @Test void serviceImageBelongsToItsStoreAndIsReleasedOnDelete() throws Exception {
    for (long store : List.of(68111L,68112L))
      jdbc.update("INSERT INTO stores(id,tenant_id,name,type,status) VALUES(?,1,?,'cityPartner','enabled')",store,"门店"+store);
    identity(68111,"view","create","delete");
    var file = new org.springframework.mock.web.MockMultipartFile("file","photo.png","image/png",
        java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8SdEAAAAASUVORK5CYII="));
    long media = service.upload(file);
    identity(68112,"view","create");
    org.assertj.core.api.Assertions.assertThatThrownBy(() ->
        service.save(null,new StoreServiceCatalog.Input("配送","0",media))).isInstanceOf(RuntimeException.class);
    identity(68111,"view","create","delete");
    var item = service.save(null,new StoreServiceCatalog.Input("配送","0",media));
    assertThat(service.image(item.id(),media).getId()).isEqualTo(media);
    identity(68112,"view");
    org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.image(item.id(),media)).hasMessageContaining("不存在");
    identity(68111,"view","delete");
    service.delete(item.id());
    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM media_references WHERE business_domain='STORE_SERVICE_IMAGE' AND media_id=?",Long.class,media)).isZero();
  }
}
