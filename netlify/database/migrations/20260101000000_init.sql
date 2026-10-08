CREATE TABLE seq (name TEXT PRIMARY KEY, n INTEGER NOT NULL);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('CUSTOMER','ADMIN')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
  qr TEXT NOT NULL,
  qr_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one active QR value maps to exactly one station
CREATE UNIQUE INDEX ux_active_qr ON stations (qr) WHERE qr_active;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  station_id TEXT NOT NULL REFERENCES stations(id),
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE rates (
  key TEXT PRIMARY KEY,
  points_per_kg NUMERIC NOT NULL CHECK (points_per_kg >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  device_event_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  station_id TEXT NOT NULL REFERENCES stations(id),
  category TEXT NOT NULL,
  subcategory TEXT,
  weight_kg NUMERIC(8,4) NOT NULL CHECK (weight_kg > 0),
  rate_used NUMERIC NOT NULL,
  points_awarded INTEGER NOT NULL CHECK (points_awarded >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX ix_tx_user ON transactions (user_id, created_at DESC);

CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prototype Point Rates (not official market rates)
INSERT INTO rates (key, points_per_kg) VALUES
  ('plastic',40),('metal',50),('paper',25),('glass',25),
  ('wet',15),('sanitary',0),('special',0),('mixed',10);

-- Labelled demo stations
INSERT INTO stations (id,name,location,status,qr) VALUES
  ('PURNA-001','Purna Chakra Station 01 (demo)','Prototype site A','ACTIVE','PURNA-001'),
  ('PURNA-002','Purna Chakra Station 02 (demo)','Prototype site B','INACTIVE','PURNA-002');
