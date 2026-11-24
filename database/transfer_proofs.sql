-- MySQL 8+ / MariaDB InnoDB. Aplicar después de schema.sql.
-- CREATE IF NOT EXISTS no modifica ni repara una tabla preexistente diferente.
-- Los archivos se guardan por separado, fuera del repositorio y del webroot.
CREATE TABLE IF NOT EXISTS transfer_proofs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  family_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mime_type VARCHAR(32) CHARACTER SET ascii NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_transfer_proofs_stored_name (stored_name),
  KEY idx_transfer_proofs_family (family_id),
  KEY idx_transfer_proofs_user (user_id),
  KEY idx_transfer_proofs_created (created_at, id),
  CONSTRAINT fk_transfer_proofs_family FOREIGN KEY (family_id) REFERENCES families(id),
  CONSTRAINT fk_transfer_proofs_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
