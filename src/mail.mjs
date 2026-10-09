import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { encrypt,decrypt } from './security-crypto.mjs';
import { recordAudit } from './audit.mjs';

export function smtpMailer(env=process.env) {
  if(!env.CMS_SMTP_HOST)return null;
  const port=Number(env.CMS_SMTP_PORT||465),secure=env.CMS_SMTP_SECURE!=='0';
  if(!Number.isInteger(port) || port<1 || port>65535 || !env.CMS_MAIL_FROM || /[\r\n]/.test(env.CMS_MAIL_FROM))throw new Error('SMTP port and CMS_MAIL_FROM must be configured correctly');
  if(Boolean(env.CMS_SMTP_USER)!==Boolean(env.CMS_SMTP_PASSWORD))throw new Error('SMTP user and password must be configured together');
  const transport=nodemailer.createTransport({host:env.CMS_SMTP_HOST,port,secure,requireTLS:!secure,tls:{rejectUnauthorized:true},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,disableFileAccess:true,disableUrlAccess:true,...(env.CMS_SMTP_USER?{auth:{user:env.CMS_SMTP_USER,pass:env.CMS_SMTP_PASSWORD}}:{})});
  return {send:message=>transport.sendMail({...message,from:env.CMS_MAIL_FROM}),close:()=>transport.close()};
}
export function enqueueMail(db,key,kind,message,entityId=null) {
  db.exec("DELETE FROM mail_outbox WHERE status='failed' AND id NOT IN (SELECT id FROM mail_outbox WHERE status='failed' ORDER BY created_at DESC,id DESC LIMIT 1000)");
  if(db.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE status='waiting'").get().n>=1000)throw new Error('Mail queue is full');
  const id=randomUUID(),now=Date.now();
  db.prepare('INSERT INTO mail_outbox(id,kind,entity_id,payload,next_attempt_at,created_at,status) VALUES(?,?,?,?,?,?,?)').run(id,kind,entityId,encrypt(JSON.stringify(message),key,`mail:${id}`),now,new Date(now).toISOString(),'waiting');
  return id;
}
export function cancelResets(db,userId) {
  db.prepare("DELETE FROM mail_outbox WHERE kind='password_reset' AND entity_id IN (SELECT token_hash FROM password_resets WHERE user_id=?)").run(userId);
  db.prepare('DELETE FROM password_resets WHERE user_id=?').run(userId);
}
export function mailWorker(db,key,mailer,{intervalMs=5000}={}) {
  let busy=null,stopped=false;
  async function deliver(){
    if(!mailer || !key || stopped)return;
    if(busy)return busy;
    busy=(async()=>{
      const row=db.prepare("SELECT * FROM mail_outbox WHERE status='waiting' AND next_attempt_at<=? ORDER BY created_at,id LIMIT 1").get(Date.now());
      if(!row)return;
      if(row.kind==='password_reset' && !db.prepare('SELECT token_hash FROM password_resets WHERE token_hash=? AND expires_at>?').get(row.entity_id,Date.now())){db.prepare('DELETE FROM mail_outbox WHERE id=?').run(row.id);return;}
      try {
        await mailer.send(JSON.parse(decrypt(row.payload,key,`mail:${row.id}`)));
        db.prepare('DELETE FROM mail_outbox WHERE id=?').run(row.id);recordAudit(db,{event:'mail.sent',targetId:row.id});
      }catch {
        const attempts=row.attempts+1,failed=attempts>=5;
        db.prepare('UPDATE mail_outbox SET attempts=?,next_attempt_at=?,status=?,payload=CASE WHEN ? THEN NULL ELSE payload END WHERE id=?').run(attempts,Date.now()+Math.min(15*60*1000,10000*2**attempts),failed?'failed':'waiting',Number(failed),row.id);
        recordAudit(db,{event:failed?'mail.failed':'mail.retry',targetId:row.id});
      }
    })();
    try{await busy;}finally{busy=null;}
  }
  const timer=mailer?setInterval(()=>deliver().catch(()=>console.error('CMS mail worker failed')),intervalMs):null;timer?.unref();
  return {flush:deliver,close:async()=>{stopped=true;if(timer)clearInterval(timer);if(busy)await busy;mailer?.close?.();}};
}
