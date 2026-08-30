import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);
  return db;
}

const MIGRATIONS = [
  // 1 — core schema
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    emoji         TEXT NOT NULL DEFAULT '🙂',
    hue           INTEGER NOT NULL DEFAULT 20,
    recovery_hash TEXT UNIQUE,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label      TEXT,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE push_subs (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    failures   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_push_user ON push_subs(user_id);

  CREATE TABLE groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    emoji       TEXT NOT NULL DEFAULT '✨',
    tz          TEXT NOT NULL DEFAULT 'UTC',
    unlock_hour INTEGER NOT NULL DEFAULT 20,
    invite_code TEXT NOT NULL UNIQUE,
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE members (
    group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX idx_members_user ON members(user_id);

  CREATE TABLE hangouts (
    id         TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vibe       TEXT NOT NULL DEFAULT 'hang',
    note       TEXT,
    lat        REAL,
    lng        REAL,
    accuracy   REAL,
    place      TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    closed_at  INTEGER
  );
  CREATE INDEX idx_hangouts_group ON hangouts(group_id, created_at DESC);

  CREATE TABLE hangout_responses (
    hangout_id TEXT NOT NULL REFERENCES hangouts(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    answer     TEXT NOT NULL,
    lat        REAL,
    lng        REAL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (hangout_id, user_id)
  );

  CREATE TABLE clips (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day         TEXT NOT NULL,
    shot_at     INTEGER NOT NULL,
    duration    REAL NOT NULL DEFAULT 0,
    caption     TEXT,
    mime        TEXT NOT NULL DEFAULT 'video/mp4',
    ext         TEXT NOT NULL DEFAULT 'mp4',
    size        INTEGER NOT NULL DEFAULT 0,
    width       INTEGER,
    height      INTEGER,
    has_poster  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_clips_day ON clips(group_id, day, shot_at);

  CREATE TABLE clip_views (
    clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (clip_id, user_id)
  );

  CREATE TABLE reactions (
    clip_id    TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (clip_id, user_id, emoji)
  );

  CREATE TABLE reels (
    group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    day       TEXT NOT NULL,
    status    TEXT NOT NULL DEFAULT 'pending',
    clip_ids  TEXT NOT NULL DEFAULT '',
    size      INTEGER NOT NULL DEFAULT 0,
    error     TEXT,
    built_at  INTEGER,
    PRIMARY KEY (group_id, day)
  );

  CREATE TABLE events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   TEXT NOT NULL,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_events_group ON events(group_id, seq);
  `,
];

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT)');
  const row = db.prepare('SELECT v FROM schema_meta WHERE k = ?').get('version');
  let version = row ? Number(row.v) : 0;

  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare('INSERT OR REPLACE INTO schema_meta (k, v) VALUES (?, ?)')
        .run('version', String(i + 1));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version = i + 1;
  }
  return version;
}
