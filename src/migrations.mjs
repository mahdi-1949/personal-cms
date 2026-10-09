import { randomUUID } from 'node:crypto';

const migrations = [
  { version:1, apply(db) {
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor')), created_at TEXT NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE content (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('draft','published')), seo_title TEXT NOT NULL DEFAULT '', seo_description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(kind,slug));
      CREATE INDEX content_public ON content(kind,status);
    `);
    db.prepare('INSERT INTO settings VALUES(?,?)').run('site',JSON.stringify({name:'سایت اختصاصی من',description:'مدیریت محتوای سایت شرکتی و خدماتی',enabledModules:['pages','services','posts','portfolio']}));
  }},
  { version:2, apply(db) {
    db.exec(`
      ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1));
      ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
      UPDATE users SET updated_at=created_at;
      ALTER TABLE sessions ADD COLUMN session_id TEXT;
      ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      UPDATE sessions SET created_at=expires_at-28800000;
      ALTER TABLE content ADD COLUMN blocks TEXT NOT NULL DEFAULT '[]';
      CREATE TABLE media (id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, alt TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT REFERENCES users(id));
      CREATE TABLE navigation (id INTEGER PRIMARY KEY CHECK(id=1), items TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    for(const row of db.prepare('SELECT token_hash FROM sessions').all()) db.prepare('UPDATE sessions SET session_id=? WHERE token_hash=?').run(randomUUID(),row.token_hash);
    db.exec('CREATE UNIQUE INDEX session_id_unique ON sessions(session_id);');
    db.prepare('INSERT INTO navigation VALUES(1,?,?)').run('[]',new Date().toISOString());
  }},
  { version:3, apply(db) {
    db.exec(`
      CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE content_categories (content_id TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE, category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE, PRIMARY KEY(content_id,category_id));
      CREATE INDEX category_content ON content_categories(category_id);
      CREATE TABLE redirects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, content_id TEXT REFERENCES content(id) ON DELETE CASCADE, category_id TEXT REFERENCES categories(id) ON DELETE CASCADE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK((content_id IS NOT NULL)+(category_id IS NOT NULL)=1));
      CREATE TABLE messages (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('new','read','archived')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX message_status ON messages(status,created_at);
      CREATE TABLE contact_tokens (token_hash TEXT PRIMARY KEY, ip_hash TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE contact_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    `);
    const site=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='site'").get().value);
    site.contactEnabled=false;
    db.prepare("UPDATE settings SET value=? WHERE key='site'").run(JSON.stringify(site));
  }},
  { version:4, apply(db) {
    db.exec(`
      ALTER TABLE users ADD COLUMN mfa_secret TEXT;
      ALTER TABLE users ADD COLUMN mfa_pending_secret TEXT;
      ALTER TABLE users ADD COLUMN mfa_pending_expires INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN mfa_last_step INTEGER NOT NULL DEFAULT -1;
      CREATE TABLE recovery_codes (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL, PRIMARY KEY(user_id,code_hash));
      CREATE TABLE password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, user_version TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE mail_outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT, payload TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('waiting','failed')));
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, actor_id TEXT, target_id TEXT, ip_hash TEXT, created_at TEXT NOT NULL);
      CREATE INDEX audit_date ON audit_log(created_at,id);
    `);
  }},
];

export const SCHEMA_VERSION=migrations.at(-1).version;

export function applyMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const current=db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_versions').get().version;
  if(current>migrations.at(-1).version)throw new Error('Database schema is newer than this CMS version; upgrade the application');
  for(const migration of migrations) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Recheck under the write lock in case another startup already applied it.
      if(!db.prepare('SELECT version FROM schema_versions WHERE version=?').get(migration.version)) {
        migration.apply(db);
        db.prepare('INSERT INTO schema_versions VALUES(?,?)').run(migration.version,new Date().toISOString());
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
}
