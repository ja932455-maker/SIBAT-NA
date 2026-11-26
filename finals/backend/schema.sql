-- ============================================================================
--  SIBAT NA — backend/schema.sql
--  MySQL 8 reference schema for the Sibat Na demo.
--
--  HOW THIS IS USED
--    The shipped C++ engine persists the same model to data/state.json so the
--    project runs with zero dependencies.  This schema is the production shape
--    of that model: run it in MySQL, then point a persistence adapter at it.
--
--  DEMO NOTES
--    • The login OTP is hard-coded to 123456 in the browser demo.  No table
--      stores OTPs; production would add otp_challenges with hashed codes.
--    • Every person, plate and document number below is fictional.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS sibatna
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE sibatna;

-- ---------------------------------------------------------------------------
--  ACCOUNTS — passengers and drivers share one table, split by role
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id              VARCHAR(32)   NOT NULL PRIMARY KEY,
  role            ENUM('passenger','driver') NOT NULL DEFAULT 'passenger',
  name            VARCHAR(120)  NOT NULL,
  email           VARCHAR(190)  NULL,
  phone           VARCHAR(32)   NULL,
  emergency       VARCHAR(64)   NULL,
  status          ENUM('offline','online','busy') NOT NULL DEFAULT 'offline',
  lat             DECIMAL(10,7) NULL,
  lng             DECIMAL(10,7) NULL,
  rating          DECIMAL(3,2)  NOT NULL DEFAULT 4.90,
  earnings        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  trips           INT UNSIGNED  NOT NULL DEFAULT 0,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_accounts_role (role, status),
  KEY idx_accounts_phone (phone)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
--  DRIVER DOCUMENTS — one row per driver (all demo values are fictional)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS driver_documents (
  driver_id       VARCHAR(32)  NOT NULL PRIMARY KEY,
  license_no      VARCHAR(64)  NULL,
  nbi_no          VARCHAR(64)  NULL,
  or_cr_no        VARCHAR(64)  NULL,
  ltfrb_no        VARCHAR(64)  NULL,
  other_docs      VARCHAR(255) NULL,
  plate_no        VARCHAR(32)  NULL,
  vehicle         VARCHAR(80)  NULL,
  id_image        MEDIUMTEXT   NULL,      -- data URL in the demo; use object storage in prod
  CONSTRAINT fk_docs_driver FOREIGN KEY (driver_id)
    REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
--  LOCATIONS — saved landmarks used by the admin/ops screens
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
  id              VARCHAR(32)   NOT NULL PRIMARY KEY,
  name            VARCHAR(160)  NOT NULL,
  zone            VARCHAR(80)   NOT NULL,
  lat             DECIMAL(10,7) NOT NULL,
  lng             DECIMAL(10,7) NOT NULL,
  active          TINYINT(1)    NOT NULL DEFAULT 1,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_locations_zone (zone, active)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
--  ROUTES — named fare corridors
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routes (
  id              VARCHAR(32)   NOT NULL PRIMARY KEY,
  name            VARCHAR(160)  NOT NULL,
  from_zone       VARCHAR(80)   NOT NULL,
  to_zone         VARCHAR(80)   NOT NULL,
  distance_km     DECIMAL(6,1)  NOT NULL,
  base_fare       DECIMAL(8,2)  NOT NULL DEFAULT 15.00,
  per_km          DECIMAL(8,2)  NOT NULL DEFAULT 2.50,
  active          TINYINT(1)    NOT NULL DEFAULT 1,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
--  RIDES — every booking, its queue position and trip lifecycle
--  status flow: pending → offered → arriving → at_pickup → on_trip
--               → completed | cancelled
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rides (
  id              VARCHAR(32)   NOT NULL PRIMARY KEY,
  code            VARCHAR(24)   NOT NULL UNIQUE,
  passenger_id    VARCHAR(32)   NULL,
  passenger_name  VARCHAR(120)  NOT NULL,
  phone           VARCHAR(32)   NULL,
  driver_id       VARCHAR(32)   NULL,
  pickup_label    VARCHAR(255)  NOT NULL,
  pickup_area     VARCHAR(80)   NOT NULL,
  pickup_lat      DECIMAL(10,7) NOT NULL,
  pickup_lng      DECIMAL(10,7) NOT NULL,
  dest_label      VARCHAR(255)  NOT NULL,
  dest_area       VARCHAR(80)   NOT NULL,
  dest_lat        DECIMAL(10,7) NOT NULL,
  dest_lng        DECIMAL(10,7) NOT NULL,
  distance_km     DECIMAL(6,1)  NOT NULL,
  fare            DECIMAL(8,2)  NOT NULL,
  seats           TINYINT UNSIGNED NOT NULL DEFAULT 1,
  queue_key       VARCHAR(200)  NOT NULL,
  status          ENUM('pending','offered','arriving','at_pickup','on_trip','completed','cancelled')
                  NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  matched_at      TIMESTAMP     NULL,
  completed_at    TIMESTAMP     NULL,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rides_passenger FOREIGN KEY (passenger_id)
    REFERENCES accounts (id) ON DELETE SET NULL,
  CONSTRAINT fk_rides_driver FOREIGN KEY (driver_id)
    REFERENCES accounts (id) ON DELETE SET NULL,
  -- the live shared queue is simply: WHERE status = 'pending' ORDER BY created_at
  KEY idx_rides_queue (queue_key, status, created_at),
  KEY idx_rides_passenger (passenger_id, created_at),
  KEY idx_rides_driver (driver_id, created_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
--  RIDE EVENTS — append-only audit of each phase transition
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ride_id         VARCHAR(32) NOT NULL,
  phase           VARCHAR(24) NOT NULL,
  actor           VARCHAR(80) NULL,
  note            VARCHAR(255) NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_events_ride FOREIGN KEY (ride_id)
    REFERENCES rides (id) ON DELETE CASCADE,
  KEY idx_events_ride (ride_id, created_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
--  UI TEXT — labels editable from the Operations Center
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ui_texts (
  text_key        VARCHAR(120) NOT NULL PRIMARY KEY,
  text_value      VARCHAR(500) NOT NULL,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
--  SETTINGS — one row, id = 1
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  id                  TINYINT UNSIGNED NOT NULL PRIMARY KEY DEFAULT 1,
  service_name        VARCHAR(80)  NOT NULL DEFAULT 'Sibat Na',
  currency            VARCHAR(8)   NOT NULL DEFAULT '₱',
  base_fare           DECIMAL(8,2) NOT NULL DEFAULT 15.00,
  included_km         DECIMAL(6,1) NOT NULL DEFAULT 4.0,
  per_km              DECIMAL(8,2) NOT NULL DEFAULT 2.50,
  match_delay_seconds INT UNSIGNED NOT NULL DEFAULT 3,
  dispatch_mode       ENUM('auto','manual') NOT NULL DEFAULT 'auto',
  CONSTRAINT chk_single_row CHECK (id = 1)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
--  AUDIT LOG — admin mutations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor           VARCHAR(80) NULL,
  action          VARCHAR(40) NOT NULL,
  entity          VARCHAR(40) NOT NULL,
  entity_id       VARCHAR(64) NULL,
  payload         JSON NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_entity (entity, entity_id),
  KEY idx_audit_created (created_at)
) ENGINE=InnoDB;

-- ============================================================================
--  DEMO SEED (fictional)
-- ============================================================================
INSERT IGNORE INTO settings
  (id, service_name, currency, base_fare, included_km, per_km, match_delay_seconds, dispatch_mode)
VALUES
  (1, 'Sibat Na', '₱', 15.00, 4.0, 2.50, 3, 'auto');

INSERT IGNORE INTO accounts (id, role, name, email, phone, status, lat, lng, rating, earnings, trips) VALUES
  ('DRV-100', 'driver', 'Mika Reyes',    'driver1@sibatna.demo', '09171234560', 'online',  14.5995, 120.9842, 4.70, 1240.00, 28),
  ('DRV-200', 'driver', 'Paolo Santos',  'driver2@sibatna.demo', '09171234561', 'offline', 14.6090, 120.9940, 4.75, 1555.00, 35),
  ('DRV-300', 'driver', 'Liza Cruz',     'driver3@sibatna.demo', '09171234562', 'offline', 14.5870, 120.9760, 4.80, 1870.00, 42),
  ('DRV-400', 'driver', 'Andres Dizon',  'driver4@sibatna.demo', '09171234563', 'offline', 14.6150, 120.9700, 4.85, 2185.00, 49),
  ('PAS-7001', 'passenger', 'Demo Passenger', 'demo@sibatna.ph', '09171234567', 'offline', NULL, NULL, 5.00, 0.00, 0);

INSERT IGNORE INTO driver_documents
  (driver_id, license_no, nbi_no, or_cr_no, ltfrb_no, plate_no, vehicle)
VALUES
  ('DRV-100', 'N01-23-456780', 'NBI-2026-001', 'OR-CR-7781', 'LTFRB-TNVS-881', 'NCR 2841', 'Toyota Vios'),
  ('DRV-200', 'N01-23-456781', 'NBI-2026-002', 'OR-CR-7782', 'LTFRB-TNVS-882', 'NCR 7715', 'Mitsubishi Mirage'),
  ('DRV-300', 'N01-23-456782', 'NBI-2026-003', 'OR-CR-7783', 'LTFRB-TNVS-883', 'NCR 3306', 'Suzuki Ertiga'),
  ('DRV-400', 'N01-23-456783', 'NBI-2026-004', 'OR-CR-7784', 'LTFRB-TNVS-884', 'NCR 9022', 'Toyota Innova');

INSERT IGNORE INTO locations (id, name, zone, lat, lng) VALUES
  ('LOC-101', 'SM North EDSA',         'Quezon City', 14.6564, 121.0306),
  ('LOC-102', 'Trinoma',               'Quezon City', 14.6538, 121.0330),
  ('LOC-103', 'Mall of Asia',          'Pasay',       14.5354, 120.9822),
  ('LOC-104', 'Bonifacio Global City', 'Taguig',      14.5547, 121.0509),
  ('LOC-105', 'Makati CBD',            'Makati',      14.5547, 121.0244),
  ('LOC-106', 'Intramuros',            'Manila',      14.5896, 120.9747),
  ('LOC-107', 'NAIA Terminal 3',       'Pasay',       14.5118, 121.0194),
  ('LOC-108', 'Ortigas Center',        'Pasig',       14.5866, 121.0647);

INSERT IGNORE INTO routes (id, name, from_zone, to_zone, distance_km, base_fare, per_km) VALUES
  ('RTE-201', 'QC → Makati shuttle', 'Quezon City', 'Makati', 11.8, 15.00, 2.50),
  ('RTE-202', 'Pasay → BGC loop',    'Pasay',       'Taguig',  8.4, 15.00, 2.50),
  ('RTE-203', 'Manila heritage run', 'Manila',      'Pasay',   7.2, 15.00, 2.50);

INSERT IGNORE INTO ui_texts (text_key, text_value) VALUES
  ('brand.tagline', 'Share the road. Split the fare.'),
  ('passenger.heroTitle', 'Where are we going?'),
  ('passenger.searchPlaceholder', 'Search a destination in the Philippines'),
  ('passenger.bookButton', 'Book this ride'),
  ('driver.title', 'Driver Mode'),
  ('driver.onlineLabel', 'Go online'),
  ('ops.title', 'Operations Center');
