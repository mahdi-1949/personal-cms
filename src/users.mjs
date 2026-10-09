import { hashPassword,verifyPassword } from './auth.mjs';
import { randomUUID } from 'node:crypto';
import { HttpError } from './content.mjs';
import { cancelResets } from './mail.mjs';
import { consumeFactor } from './account-security.mjs';
import { recordAudit } from './audit.mjs';
const publicUser=user=>({id:user.id,email:user.email,role:user.role,active:Boolean(user.active),created_at:user.created_at,updated_at:user.updated_at,mfaEnabled:Boolean(user.mfa_secret)});
export const listUsers=db=>db.prepare('SELECT * FROM users ORDER BY created_at').all().map(publicUser);
function validateIdentity(data) {
  if(typeof data.email!=='string' || data.email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim()))throw new HttpError(422,'ایمیل معتبر وارد کنید.');
  if(!['admin','editor'].includes(data.role) || typeof data.active!=='boolean')throw new HttpError(422,'نقش و وضعیت معتبر وارد کنید.');
  return {...data,email:data.email.trim().toLowerCase()};
}
async function passwordHash(password){try{return await hashPassword(password);}catch(error){throw new HttpError(422,error.message);}}
function requireAdmin(db,actor){const id=typeof actor==='function'?actor().user_id:actor;if(id && !db.prepare("SELECT id FROM users WHERE id=? AND role='admin' AND active=1").get(id))throw new HttpError(403,'دسترسی مدیر دیگر معتبر نیست.');}
export async function addUser(db,data,actorId) {
  data=validateIdentity(data);
  // Validate before the asynchronous hash and recheck duplicates on insertion.
  const hash=await passwordHash(data.password);requireAdmin(db,actorId);
  try{
    const id=randomUUID(),now=new Date().toISOString();
    db.prepare('INSERT INTO users(id,email,password_hash,role,created_at,updated_at,active) VALUES(?,?,?,?,?,?,?)').run(id,data.email,hash,data.role,now,now,Number(data.active));
    return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  }catch(error){if(error.code?.startsWith('ERR_SQLITE') && db.prepare('SELECT id FROM users WHERE email=?').get(data.email))throw new HttpError(409,'این ایمیل قبلاً ثبت شده است.');throw error;}
}
export async function updateUser(db,id,data,actorId) {
  data=validateIdentity(data);
  const hash=data.password===undefined || data.password===''?null:await passwordHash(data.password);
  db.exec('BEGIN IMMEDIATE');
  try {
    requireAdmin(db,actorId);
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if(!user)throw new HttpError(404,'کاربر پیدا نشد.');
    if(data.expected_updated_at!==user.updated_at)throw new HttpError(409,'کاربر تغییر کرده؛ فهرست را تازه کنید.');
    const duplicate=db.prepare('SELECT id FROM users WHERE email=? AND id<>?').get(data.email,id);
    if(duplicate)throw new HttpError(409,'این ایمیل قبلاً ثبت شده است.');
    if(user.role==='admin' && user.active && (data.role!=='admin' || !data.active) && db.prepare("SELECT COUNT(*) AS count FROM users WHERE active=1 AND role='admin'").get().count<=1)throw new HttpError(409,'آخرین مدیر فعال را نمی‌توان غیرفعال کرد یا نقش او را تغییر داد.');
    const now=new Date(Math.max(Date.now(),Date.parse(user.updated_at)+1)).toISOString();
    db.prepare('UPDATE users SET email=?,role=?,active=?,password_hash=?,updated_at=? WHERE id=?').run(data.email,data.role,Number(data.active),hash||user.password_hash,now,id);
    // Credential or privilege changes invalidate every existing session.
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);cancelResets(db,id);
    db.prepare('UPDATE users SET mfa_pending_secret=NULL,mfa_pending_expires=0 WHERE id=?').run(id);
    db.exec('COMMIT');return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export async function changePassword(db,userId,data,authorize,key,notify) {
  const user=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(userId);
  if(!user || !await verifyPassword(data.currentPassword,user.password_hash))throw new HttpError(422,'رمز فعلی صحیح نیست.');
  const hash=await passwordHash(data.newPassword);
  db.exec('BEGIN IMMEDIATE');
  try{
    authorize?.();
    const latest=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(userId);
    if(!latest || latest.password_hash!==user.password_hash)throw new HttpError(409,'حساب تغییر کرده؛ دوباره وارد شوید.');
    if(!consumeFactor(db,latest,data.mfaCode,key))throw new HttpError(422,'کد دومرحله‌ای صحیح نیست.');
    const now=new Date(Math.max(Date.now(),Date.parse(latest.updated_at)+1)).toISOString();
    db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(hash,now,userId);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);cancelResets(db,userId);
    db.prepare('UPDATE users SET mfa_pending_secret=NULL,mfa_pending_expires=0 WHERE id=?').run(userId);
    recordAudit(db,{event:'auth.password_changed',actorId:userId,targetId:userId});notify?.(latest,'رمز عبور حساب شما تغییر کرد.');db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export const listSessions=(db,session)=>db.prepare('SELECT session_id,created_at,expires_at FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC').all(session.user_id,Date.now()).map(row=>({id:row.session_id,created_at:row.created_at,expires_at:row.expires_at,current:row.session_id===session.session_id}));
