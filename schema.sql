-- =============================================================
-- schema.sql — Cloudflare D1 schema for the Temp Mail service
-- Apply with:
--   npx wrangler d1 execute temone-tempmail --remote --file=./schema.sql
-- All timestamps are Unix epoch MILLISECONDS (Date.now()).
-- =============================================================

CREATE TABLE IF NOT EXISTS inboxes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  address      TEXT    NOT NULL UNIQUE,      -- full lowercase email address
  access_token TEXT    NOT NULL,             -- UUID, required to read/recover the inbox
  expires_at   INTEGER NOT NULL,             -- when the inbox dies
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inboxes_expires ON inboxes (expires_at);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_address TEXT    NOT NULL,            -- references inboxes.address
  sender        TEXT,
  subject       TEXT,
  body_html     TEXT,                        -- HTML (or escaped text wrapped in <pre>)
  received_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages (inbox_address, received_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Default settings (editable from the Admin panel; INSERT OR IGNORE preserves edits)
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('site_name',         'EM-TempMail'),
  ('ads_enabled',       '1'),
  ('ad_banner_top',     ''),   -- Adsterra banner code (728x90 / 320x50 etc.)
  ('ad_banner_bottom',  ''),   -- Adsterra banner code
  ('ad_native',         ''),   -- Adsterra Native Banner code
  ('ad_social_bar',     ''),   -- Adsterra Social Bar script
  ('ad_popunder',       ''),   -- Adsterra Popunder <script>
  ('ad_direct_link',    ''),   -- Optional Adsterra Direct Link
  ('popunder_cooldown', '60'), -- Seconds between popunder triggers
  ('powered_name',      'Earnmaster Mind'),
  ('powered_link',      'https://t.me/earnmastermind'),
  ('social_platforms',  '[{"name":"Telegram","url":"https://t.me/earnmastermind"}]'),
  ('sponsor_top',       ''),
  ('sponsor_bottom',    '');
