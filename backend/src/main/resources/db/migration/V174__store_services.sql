CREATE TABLE store_services (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  store_id BIGINT NOT NULL,
  name VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  price DECIMAL(65,2) NOT NULL,
  image_id BIGINT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_account_id BIGINT NOT NULL,
  creator_name VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  live_name VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin
    GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) STORED,
  UNIQUE KEY uq_store_service_name (tenant_id,store_id,live_name),
  CONSTRAINT fk_store_service_store FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT chk_store_service_price CHECK (price >= 0)
);
