import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','editor')), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS content (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL,
      excerpt TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('draft','published')),
      seo_title TEXT NOT NULL DEFAULT '', seo_description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(kind, slug)
    );
    CREATE INDEX IF NOT EXISTS content_public ON content(kind,status);
  `);
  db.prepare('INSERT OR IGNORE INTO schema_versions VALUES(1,?)').run(new Date().toISOString());
  db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('site', JSON.stringify({ name:'سایت اختصاصی من', description:'مدیریت محتوای سایت شرکتی و خدماتی', enabledModules:['pages','services','posts','portfolio'] }));
  return db;
}
export const getSite = db => JSON.parse(db.prepare("SELECT value FROM settings WHERE key='site'").get().value);
export const saveSite = (db, site) => db.prepare("UPDATE settings SET value=? WHERE key='site'").run(JSON.stringify(site));
