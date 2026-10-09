import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyMigrations } from './migrations.mjs';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  try{applyMigrations(db);}catch(error){db.close();throw error;}
  return db;
}
export const getSite = db => JSON.parse(db.prepare("SELECT value FROM settings WHERE key='site'").get().value);
export const saveSite = (db, site) => db.prepare("UPDATE settings SET value=? WHERE key='site'").run(JSON.stringify(site));
