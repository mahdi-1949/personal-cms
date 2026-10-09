import { digest } from './auth.mjs';
import { HttpError } from './content.mjs';

export function recordAudit(db,{event,actorId=null,targetId=null,ip=null}) {
  if(!/^[a-z][a-z0-9_.]{1,80}$/.test(event))throw new Error('Invalid audit event');
  // Only identifiers are accepted; never log request bodies, passwords, OTPs or reset links.
  db.prepare('INSERT INTO audit_log(event,actor_id,target_id,ip_hash,created_at) VALUES(?,?,?,?,?)').run(event,actorId,targetId,ip?digest(ip):null,new Date().toISOString());
  db.exec('DELETE FROM audit_log WHERE id<=(SELECT MAX(id)-10000 FROM audit_log)');
}
export function listAudit(db,page=1) {
  if(!Number.isSafeInteger(page) || page<1 || page>100000)throw new HttpError(422,'شماره صفحه معتبر نیست.');
  return {events:db.prepare('SELECT a.*,u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 50 OFFSET ?').all((page-1)*50),total:db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,page,pageSize:50};
}
export function mutationEvent(method,path) {
  const groups={content:'content',users:'user',media:'media',navigation:'navigation',settings:'settings',categories:'category',redirects:'redirect',messages:'message'};
  const match=path.match(/^\/api\/([a-z]+)(?:\/([a-f0-9-]{36}))?$/);
  if(match && groups[match[1]] && ['POST','PUT','DELETE'].includes(method))return `${groups[match[1]]}.${method==='POST'?'created':method==='DELETE'?'deleted':'updated'}`;
  if(path==='/api/auth/logout' && method==='POST')return 'auth.logout';
  if(path.startsWith('/api/auth/sessions/') && method==='DELETE')return 'auth.session_revoked';
  return null;
}
