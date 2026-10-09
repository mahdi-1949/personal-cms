import { randomBytes } from 'node:crypto';
import { digest,verifyPassword,hashPassword } from './auth.mjs';
import { encrypt,decrypt,base32,matchTotp } from './security-crypto.mjs';
import { HttpError } from './content.mjs';
import { recordAudit } from './audit.mjs';
import { enqueueMail,cancelResets } from './mail.mjs';

const version=user=>new Date(Math.max(Date.now(),Date.parse(user.updated_at)+1)).toISOString();
function configured(key){if(!key)throw new HttpError(503,'تنظیمات امنیتی این قابلیت هنوز آماده نیست.');}
export function assertSecurityKey(db,key) {
  for(const user of db.prepare('SELECT id,mfa_secret,mfa_pending_secret FROM users WHERE mfa_secret IS NOT NULL OR mfa_pending_secret IS NOT NULL').all()) {
    try{if(user.mfa_secret)decrypt(user.mfa_secret,key,`mfa:${user.id}`);if(user.mfa_pending_secret)decrypt(user.mfa_pending_secret,key,`mfa:${user.id}`);}
    catch{throw new Error('CMS_SECURITY_KEY is missing or does not match this database; restore the original key');}
  }
  for(const mail of db.prepare('SELECT id,payload FROM mail_outbox WHERE payload IS NOT NULL').all())try{decrypt(mail.payload,key,`mail:${mail.id}`);}catch{throw new Error('CMS_SECURITY_KEY does not match the mail queue');}
}
export function consumeFactor(db,user,code,key) {
  if(!user.mfa_secret)return true;
  configured(key);
  if(typeof code!=='string' || code.length>64)return false;
  const compact=code.replace(/-/g,'').toLowerCase();
  if(/^[a-f0-9]{24}$/.test(compact))return Boolean(db.prepare('DELETE FROM recovery_codes WHERE user_id=? AND code_hash=?').run(user.id,digest(compact)).changes);
  const step=matchTotp(decrypt(user.mfa_secret,key,`mfa:${user.id}`),code.trim(),user.mfa_last_step);
  if(step===null)return false;
  return Boolean(db.prepare('UPDATE users SET mfa_last_step=? WHERE id=? AND mfa_last_step<?').run(step,user.id,step).changes);
}
async function reauthenticate(db,id,data,authorize) {
  const old=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(id);
  if(!old || !await verifyPassword(data.password,old.password_hash))throw new HttpError(422,'رمز یا کد تأیید صحیح نیست.');
  authorize?.();
  const user=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(id);
  if(!user || user.updated_at!==old.updated_at || user.password_hash!==old.password_hash)throw new HttpError(409,'حساب تغییر کرده؛ دوباره وارد شوید.');
  return user;
}
function recoveryCodes(db,userId) {
  db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(userId);
  const codes=Array.from({length:10},()=>randomBytes(12).toString('hex'));
  for(const code of codes)db.prepare('INSERT INTO recovery_codes VALUES(?,?)').run(userId,digest(code));
  return codes.map(code=>code.match(/.{6}/g).join('-'));
}
function revoke(db,id){db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);cancelResets(db,id);}
export const mfaStatus=(db,id,key)=>({enabled:Boolean(db.prepare('SELECT mfa_secret FROM users WHERE id=?').get(id)?.mfa_secret),configured:Boolean(key),recoveryRemaining:db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id=?').get(id).n});
export async function startMfa(db,id,data,key,authorize) {
  configured(key);const user=await reauthenticate(db,id,data,authorize);
  if(user.mfa_secret)throw new HttpError(409,'ورود دومرحله‌ای فعال است؛ ابتدا با تأیید هویت غیرفعالش کنید.');
  const secret=base32(randomBytes(20));
  db.prepare('UPDATE users SET mfa_pending_secret=?,mfa_pending_expires=? WHERE id=?').run(encrypt(secret,key,`mfa:${id}`),Date.now()+10*60*1000,id);
  recordAudit(db,{event:'auth.mfa_setup_started',actorId:id,targetId:id});
  return {secret,uri:`otpauth://totp/${encodeURIComponent(`Core CMS:${user.email}`)}?secret=${secret}&issuer=Core%20CMS&algorithm=SHA1&digits=6&period=30`};
}
export function confirmMfa(db,id,data,key,notify) {
  configured(key);db.exec('BEGIN IMMEDIATE');
  try {
    const user=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(id);
    if(!user?.mfa_pending_secret || user.mfa_pending_expires<=Date.now() || user.mfa_secret)throw new HttpError(422,'فعال‌سازی منقضی شده؛ دوباره شروع کنید.');
    const secret=decrypt(user.mfa_pending_secret,key,`mfa:${id}`),step=matchTotp(secret,data.code);
    if(step===null)throw new HttpError(422,'کد تأیید صحیح نیست.');
    const codes=recoveryCodes(db,id);
    db.prepare('UPDATE users SET mfa_secret=mfa_pending_secret,mfa_pending_secret=NULL,mfa_pending_expires=0,mfa_last_step=?,updated_at=? WHERE id=?').run(step,version(user),id);
    revoke(db,id);recordAudit(db,{event:'auth.mfa_enabled',actorId:id,targetId:id});notify?.(user,'ورود دومرحله‌ای حساب شما فعال شد.');
    db.exec('COMMIT');return {recoveryCodes:codes};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export async function changeMfa(db,id,data,key,authorize,{disable=false,notify}={}) {
  configured(key);const old=await reauthenticate(db,id,data,authorize);db.exec('BEGIN IMMEDIATE');
  try {
    const user=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(id);
    if(user.updated_at!==old.updated_at || !user.mfa_secret || !consumeFactor(db,user,data.code,key))throw new HttpError(422,'رمز یا کد تأیید صحیح نیست.');
    const codes=disable?[]:recoveryCodes(db,id);
    if(disable){db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(id);db.prepare('UPDATE users SET mfa_secret=NULL,mfa_pending_secret=NULL,mfa_pending_expires=0,mfa_last_step=-1,updated_at=? WHERE id=?').run(version(user),id);}
    else db.prepare('UPDATE users SET updated_at=? WHERE id=?').run(version(user),id);
    revoke(db,id);recordAudit(db,{event:disable?'auth.mfa_disabled':'auth.recovery_codes_replaced',actorId:id,targetId:id});notify?.(user,disable?'ورود دومرحله‌ای حساب شما غیرفعال شد.':'کدهای بازیابی ورود دومرحله‌ای حساب شما عوض شدند.');
    db.exec('COMMIT');return {recoveryCodes:codes};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function issueReset(db,email,key,origin) {
  configured(key);
  db.prepare("DELETE FROM mail_outbox WHERE kind='password_reset' AND entity_id IN (SELECT token_hash FROM password_resets WHERE expires_at<=?)").run(Date.now());
  db.prepare('DELETE FROM password_resets WHERE expires_at<=?').run(Date.now());
  const user=db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
  if(!user)return;
  const token=randomBytes(32).toString('hex'),hash=digest(token);
  db.exec('BEGIN IMMEDIATE');
  try {
    cancelResets(db,user.id);db.prepare('INSERT INTO password_resets VALUES(?,?,?,?)').run(hash,user.id,user.updated_at,Date.now()+20*60*1000);
    enqueueMail(db,key,'password_reset',{to:user.email,subject:'بازیابی رمز Core CMS',text:`برای تعیین رمز تازه، لینک زیر را باز کنید. این لینک ۲۰ دقیقه اعتبار دارد و یک بار قابل استفاده است.\n\n${origin}/admin/reset-password/#token=${token}\n\nاگر این درخواست از شما نبود، آن را نادیده بگیرید. در صورت فعال‌بودن ورود دومرحله‌ای، کد برنامه یا کد بازیابی نیز لازم است.`},hash);
    recordAudit(db,{event:'auth.password_reset_requested',targetId:user.id});db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export async function resetPassword(db,data,key,notify) {
  if(typeof data.token!=='string' || !/^[a-f0-9]{64}$/.test(data.token))throw new HttpError(422,'لینک یا کد تأیید معتبر نیست.');
  let hash;try{hash=await hashPassword(data.newPassword);}catch(error){throw new HttpError(422,error.message);}
  db.exec('BEGIN IMMEDIATE');
  try {
    const reset=db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND expires_at>?').get(digest(data.token),Date.now());
    const user=reset?db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(reset.user_id):null;
    if(!user || user.updated_at!==reset.user_version || !consumeFactor(db,user,data.mfaCode,key))throw new HttpError(422,'لینک یا کد تأیید معتبر نیست.');
    db.prepare('UPDATE users SET password_hash=?,mfa_pending_secret=NULL,mfa_pending_expires=0,updated_at=? WHERE id=?').run(hash,version(user),user.id);
    revoke(db,user.id);recordAudit(db,{event:'auth.password_reset_completed',actorId:user.id,targetId:user.id});notify?.(user,'رمز عبور حساب شما تغییر کرد. اگر این کار از شما نبود، با پشتیبانی سایت تماس بگیرید.');db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
