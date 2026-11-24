-- Migración adicional MySQL 8+ / MariaDB InnoDB. Aplicar después de schema.sql.
-- CREATE IF NOT EXISTS no repara tablas preexistentes con estructura distinta.
-- No se generan ni importes ni fechas de pago históricos.
CREATE TABLE IF NOT EXISTS historical_standing (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  family_id BIGINT UNSIGNED NOT NULL,
  year SMALLINT NOT NULL,
  status ENUM('current') NOT NULL,
  source VARCHAR(255) NOT NULL,
  recorded_by BIGINT UNSIGNED NOT NULL,
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_historical_standing_family_year (family_id, year),
  CONSTRAINT fk_historical_standing_family FOREIGN KEY (family_id) REFERENCES families(id),
  CONSTRAINT fk_historical_standing_user FOREIGN KEY (recorded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 'pending' significa que no hay resultado registrado, NO permiso para reenviar.
CREATE TABLE IF NOT EXISTS contact_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id BIGINT UNSIGNED NOT NULL,
  recipient VARCHAR(254) NOT NULL,
  status ENUM('pending','accepted','rejected','unknown') NOT NULL DEFAULT 'pending',
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_contact_delivery_recipient (contact_id, recipient),
  CONSTRAINT fk_contact_delivery_contact FOREIGN KEY (contact_id) REFERENCES contacts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
