-- Aplicar después de database/schema.sql; no crea fechas para miembros existentes.
CREATE TABLE IF NOT EXISTS member_birth_dates (
  member_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  birth_date DATE NOT NULL,
  CONSTRAINT fk_birth_date_member FOREIGN KEY (member_id) REFERENCES family_members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
