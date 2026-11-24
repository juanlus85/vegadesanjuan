-- Vega de San Juan. MySQL 8+ / MariaDB con InnoDB. Aplicar con scripts/migrate.js.
CREATE TABLE IF NOT EXISTS families (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 address VARCHAR(255) NOT NULL, phone VARCHAR(40) NOT NULL DEFAULT '',
 status ENUM('pending','active','inactive') NOT NULL DEFAULT 'pending',
 payment_method ENUM('manual','card') NOT NULL DEFAULT 'manual',
 stripe_customer_id VARCHAR(255) NULL, stripe_subscription_id VARCHAR(255) NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS users (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 family_id BIGINT UNSIGNED NULL,
 name VARCHAR(160) NOT NULL, email VARCHAR(255) NOT NULL,
 password_hash VARCHAR(255) NOT NULL, role ENUM('admin','member') NOT NULL DEFAULT 'member',
 active BOOLEAN NOT NULL DEFAULT TRUE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_user_email (email), CONSTRAINT fk_user_family FOREIGN KEY (family_id) REFERENCES families(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS family_members (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 family_id BIGINT UNSIGNED NOT NULL, name VARCHAR(160) NOT NULL,
 relationship VARCHAR(80) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT fk_members_family FOREIGN KEY (family_id) REFERENCES families(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS charges (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 family_id BIGINT UNSIGNED NOT NULL, kind ENUM('annual','extra') NOT NULL,
 year SMALLINT NULL, description VARCHAR(255) NOT NULL, amount_cents INT UNSIGNED NOT NULL,
 due_date DATE NOT NULL, status ENUM('pending','paid','exempt') NOT NULL DEFAULT 'pending',
 paid_at DATETIME NULL, paid_reference VARCHAR(255) NULL, marked_by BIGINT UNSIGNED NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_charge_year (family_id,year),
 CONSTRAINT fk_charge_family FOREIGN KEY (family_id) REFERENCES families(id),
 CONSTRAINT fk_charge_marker FOREIGN KEY (marked_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS events (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 title VARCHAR(255) NOT NULL, description TEXT NOT NULL, starts_at DATETIME NOT NULL,
 location VARCHAR(255) NOT NULL DEFAULT '', published BOOLEAN NOT NULL DEFAULT FALSE,
 tickets_enabled BOOLEAN NOT NULL DEFAULT FALSE, member_price_cents INT UNSIGNED NOT NULL DEFAULT 250,
 guest_price_cents INT UNSIGNED NOT NULL DEFAULT 400, price_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
 capacity INT UNSIGNED NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS event_rsvps (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 event_id BIGINT UNSIGNED NOT NULL, family_id BIGINT UNSIGNED NOT NULL,
 attending BOOLEAN NOT NULL DEFAULT TRUE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_rsvp (event_id,family_id),
 CONSTRAINT fk_rsvp_event FOREIGN KEY (event_id) REFERENCES events(id),
 CONSTRAINT fk_rsvp_family FOREIGN KEY (family_id) REFERENCES families(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ticket_orders (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 event_id BIGINT UNSIGNED NOT NULL, family_id BIGINT UNSIGNED NOT NULL,
 member_qty INT UNSIGNED NOT NULL, guest_qty INT UNSIGNED NOT NULL, amount_cents INT UNSIGNED NOT NULL,
 status ENUM('pending','paid','expired','cancelled','refunded','needs_review') NOT NULL DEFAULT 'pending',
 stripe_session_id VARCHAR(255) NULL, expires_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_ticket_stripe_session (stripe_session_id),
 CONSTRAINT fk_ticket_event FOREIGN KEY (event_id) REFERENCES events(id),
 CONSTRAINT fk_ticket_family FOREIGN KEY (family_id) REFERENCES families(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS payments (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 family_id BIGINT UNSIGNED NOT NULL, charge_id BIGINT UNSIGNED NULL, ticket_order_id BIGINT UNSIGNED NULL,
 amount_cents INT UNSIGNED NOT NULL, provider ENUM('manual','stripe') NOT NULL,
 status ENUM('pending','paid','failed','refunded','needs_review') NOT NULL DEFAULT 'pending',
 stripe_session_id VARCHAR(255) NULL, stripe_payment_intent_id VARCHAR(255) NULL, stripe_invoice_id VARCHAR(255) NULL,
 reference VARCHAR(255) NULL, paid_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_payment_session (stripe_session_id), UNIQUE KEY uq_payment_intent (stripe_payment_intent_id),
 UNIQUE KEY uq_payment_invoice (stripe_invoice_id),
 CONSTRAINT fk_payment_family FOREIGN KEY (family_id) REFERENCES families(id),
 CONSTRAINT fk_payment_charge FOREIGN KEY (charge_id) REFERENCES charges(id),
 CONSTRAINT fk_payment_order FOREIGN KEY (ticket_order_id) REFERENCES ticket_orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stripe_events (
 event_id VARCHAR(255) NOT NULL PRIMARY KEY, event_type VARCHAR(120) NOT NULL,
 processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS settings (
 setting_key VARCHAR(100) NOT NULL PRIMARY KEY, setting_value TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS contacts (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 name VARCHAR(160) NOT NULL, email VARCHAR(255) NOT NULL, message TEXT NOT NULL,
 delivery_status ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS password_resets (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 user_id BIGINT UNSIGNED NOT NULL, token_hash CHAR(64) NOT NULL, expires_at DATETIME NOT NULL,
 used_at DATETIME NULL, UNIQUE KEY uq_reset_hash (token_hash),
 CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS audit_log (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 user_id BIGINT UNSIGNED NULL, action VARCHAR(100) NOT NULL, entity_type VARCHAR(60) NOT NULL,
 entity_id VARCHAR(100) NULL, details TEXT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS app_migrations (
 migration_key VARCHAR(120) NOT NULL PRIMARY KEY,
 applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
