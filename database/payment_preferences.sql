-- Preferencia declarada, separada del método de pago operativo y sin activar cobros.
-- Aplicar después de database/schema.sql; no asigna preferencias a familias anteriores.
CREATE TABLE IF NOT EXISTS family_payment_preferences (
  family_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  payment_preference ENUM('manual', 'single_card', 'subscription') NOT NULL,
  KEY idx_family_payment_preference (payment_preference),
  CONSTRAINT fk_payment_preference_family FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
