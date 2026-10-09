import { scrypt as scryptCallback, randomBytes, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const digest = value => createHash('sha256').update(value).digest('hex');
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('رمز عبور باید بین ۱۲ و ۲۵۶ کاراکتر باشد.');
}
export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, { N:16384, r:8, p:1 });
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [algorithm, salt, expected] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !/^[a-f0-9]{128}$/.test(expected)) return false;
  const actual = await scrypt(password, salt, 64, { N:16384, r:8, p:1 });
  return timingSafeEqual(actual, Buffer.from(expected,'hex'));
}
export async function createUser(db, { email, password, role='admin' }) {
  email = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('ایمیل معتبر وارد کنید.');
  if (!['admin','editor'].includes(role)) throw new Error('Invalid role');
  const hash = await hashPassword(password);
  const id = randomUUID();
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id,email,hash,role,new Date().toISOString());
  return { id,email,role };
}
export function createSession(db,userId) {
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  const expires = Date.now() + 8 * 60 * 60 * 1000;
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),userId,csrf,expires);
  return { token,csrf,expires };
}
export function getSession(db, req) {
  const token = (req.headers.cookie || '').split(';').map(part=>part.trim()).find(part=>part.startsWith('cms_session='))?.slice(12);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = db.prepare('SELECT s.*, u.email, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>?').get(digest(token),Date.now());
  return row ? { ...row, token } : null;
}
export function cookie(token,secure=false,clear=false) {
  return `cms_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:28800}${secure?'; Secure':''}`;
}
export function rateLimited(db,key) {
  const now=Date.now();
  db.prepare('DELETE FROM login_attempts WHERE reset_at<=?').run(now);
  const record=db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);
  if (record?.count >= 5) return true;
  db.prepare('INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,now+15*60*1000);
  return false;
}
