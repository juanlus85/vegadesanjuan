-- Migración adicional, MySQL 8+ / MariaDB InnoDB. Aplicar después de schema.sql.
-- No activa suscripciones ni altera el esquema base. CREATE IF NOT EXISTS no
-- actualiza una tabla preexistente con estructura distinta: verificarla antes.
CREATE TABLE IF NOT EXISTS subscription_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  family_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  consent_version VARCHAR(64) NOT NULL,
  consent_text TEXT NOT NULL,
  consented_at_utc DATETIME NOT NULL,
  trial_end BIGINT UNSIGNED NOT NULL,
  session_expires_at BIGINT UNSIGNED NOT NULL,
  state ENUM('created','open','completed','expired','cancelled','needs_review') NOT NULL DEFAULT 'created',
  stripe_session_id VARCHAR(255) NULL,
  -- Estos dos campos solo pueden rellenarse a partir de un webhook verificado.
  stripe_customer_id VARCHAR(255) NULL,
  stripe_subscription_id VARCHAR(255) NULL,
  created_at_utc DATETIME NOT NULL,
  updated_at_utc DATETIME NOT NULL,
  UNIQUE KEY uq_subscription_attempt_family (family_id),
  UNIQUE KEY uq_subscription_attempt_session (stripe_session_id),
  UNIQUE KEY uq_subscription_attempt_customer (stripe_customer_id),
  UNIQUE KEY uq_subscription_attempt_subscription (stripe_subscription_id),
  CONSTRAINT fk_subscription_attempt_family FOREIGN KEY (family_id) REFERENCES families(id),
  CONSTRAINT fk_subscription_attempt_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- La fila única por familia se conserva incluso si caduca la sesión: su
-- conciliación y una eventual habilitación posterior requieren proceso explícito.
