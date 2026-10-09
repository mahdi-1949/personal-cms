import { randomBytes,randomUUID } from 'node:crypto';
import { digest } from './auth.mjs';
import { HttpError } from './content.mjs';

export const CONTACT_WAIT_MS=2000;
const WINDOW_MS=15*60*1000;
export function contactLimit(db,key,max) {
  const now=Date.now();db.prepare('DELETE FROM contact_limits WHERE reset_at<=?').run(now);
  if(db.prepare('SELECT count FROM contact_limits WHERE key=?').get(key)?.count>=max)throw new HttpError(429,'درخواست‌های زیادی ارسال شده؛ ۱۵ دقیقه بعد دوباره امتحان کنید.');
  db.prepare('INSERT INTO contact_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,now+WINDOW_MS);
}
export function issueContactToken(db,ip) {
  contactLimit(db,digest(`contact-token:${ip}`),30);
  const now=Date.now();db.prepare('DELETE FROM contact_tokens WHERE expires_at<=?').run(now);
  // Bound storage even when clients arrive with many different addresses.
  if(db.prepare('SELECT COUNT(*) AS count FROM contact_tokens').get().count>=10000)throw new HttpError(503,'لطفاً کمی بعد تلاش کنید.');
  const token=randomBytes(32).toString('hex');
  db.prepare('INSERT INTO contact_tokens VALUES(?,?,?,?)').run(digest(token),digest(ip),now,now+20*60*1000);
  return {token,waitMs:CONTACT_WAIT_MS};
}
function text(data,key,max,required=true) {
  if(typeof data[key]!=='string' || data[key].length>max || (required && !data[key].trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(data[key]))throw new HttpError(422,'فیلدهای فرم معتبر نیستند.');
  return data[key].trim();
}
export function submitContact(db,ip,data) {
  if(typeof data.token!=='string' || !/^[a-f0-9]{64}$/.test(data.token))throw new HttpError(422,'فرم منقضی شده؛ صفحه را تازه کنید.');
  const token=db.prepare('SELECT * FROM contact_tokens WHERE token_hash=?').get(digest(data.token));
  if(!token || token.ip_hash!==digest(ip) || token.expires_at<=Date.now())throw new HttpError(422,'فرم منقضی شده؛ صفحه را تازه کنید.');
  if(Date.now()-token.issued_at<CONTACT_WAIT_MS)throw new HttpError(422,'کمی صبر کنید و دوباره ارسال کنید.');
  db.prepare('DELETE FROM contact_tokens WHERE token_hash=?').run(token.token_hash);
  if(typeof data.website!=='string')throw new HttpError(422,'فرم معتبر نیست.');
  if(data.website.trim())return; // Quietly discard honeypot submissions.
  const name=text(data,'name',100),email=text(data,'email',254).toLowerCase(),subject=text(data,'subject',200),message=text(data,'message',5000);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new HttpError(422,'ایمیل معتبر وارد کنید.');
  if(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count>=10000)throw new HttpError(503,'صندوق پیام پر است؛ لطفاً بعداً تلاش کنید.');
  const now=new Date().toISOString();db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),name,email,subject,message,'new',now,now);
}
export function listMessages(db,{status,page=1}={}) {
  if(status && !['new','read','archived'].includes(status))throw new HttpError(422,'وضعیت پیام معتبر نیست.');
  if(!Number.isSafeInteger(page) || page<1 || page>100000)throw new HttpError(422,'شماره صفحه معتبر نیست.');
  const where=status?' WHERE status=?':'',args=status?[status]:[];
  const total=db.prepare(`SELECT COUNT(*) AS count FROM messages${where}`).get(...args).count;
  const messages=db.prepare(`SELECT * FROM messages${where} ORDER BY created_at DESC,id LIMIT 50 OFFSET ?`).all(...args,(page-1)*50);
  return {messages,total,page,pageSize:50};
}
export function updateMessage(db,id,data) {
  const old=db.prepare('SELECT * FROM messages WHERE id=?').get(id);
  if(!old)throw new HttpError(404,'پیام پیدا نشد.');
  if(data.expected_updated_at!==old.updated_at)throw new HttpError(409,'پیام تغییر کرده؛ فهرست را تازه کنید.');
  if(!['new','read','archived'].includes(data.status))throw new HttpError(422,'وضعیت پیام معتبر نیست.');
  const now=new Date(Math.max(Date.now(),Date.parse(old.updated_at)+1)).toISOString();
  db.prepare('UPDATE messages SET status=?,updated_at=? WHERE id=?').run(data.status,now,id);
  return db.prepare('SELECT * FROM messages WHERE id=?').get(id);
}
