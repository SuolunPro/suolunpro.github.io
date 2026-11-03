CREATE TABLE IF NOT EXISTS vip_members (
 user_id TEXT PRIMARY KEY,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 vip_name TEXT NOT NULL DEFAULT '尊贵月卡VIP',
 expires_at TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
 password_salt TEXT,
 password_hash TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS login_attempts (
 email TEXT PRIMARY KEY COLLATE NOCASE,
 failures INTEGER NOT NULL DEFAULT 0,
 blocked_until TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vip_active_expiry ON vip_members(active,expires_at);

-- Administrator status is explicit; long expiry alone never grants privileges.
CREATE TABLE IF NOT EXISTS vip_admins (
 user_id TEXT PRIMARY KEY REFERENCES vip_members(user_id) ON DELETE CASCADE,
 granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
