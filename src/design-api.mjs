import { recordAudit } from './audit.mjs';
import { HttpError } from './content.mjs';
import { digest,rateLimited } from './auth.mjs';
import { requireDesigner,designList,getDesign,getRevision,saveDesign,restoreDesign,publishDesign,issueDesignPreview } from './designs.mjs';
export async function designAPI({db,req,res,path,method,session,key,ip,readBody,respond,authorize}) {
  if(!path.startsWith('/api/designs'))return false;
  if(path==='/api/designs/options' && method==='GET'){respond(res,200,{designs:designList(db).filter(d=>d.published_id).map(({id,name,publishedNumber})=>({id,name,publishedNumber}))});return true;}
  requireDesigner(session);
  if(path==='/api/designs' && method==='GET'){respond(res,200,{designs:designList(db)});return true;}
  if(path==='/api/designs' && method==='POST'){respond(res,201,saveDesign(db,await readBody(req),session.user_id));return true;}
  const match=path.match(/^\/api\/designs\/([a-f0-9-]{36})(?:\/(preview|restore|publish|revisions)(?:\/([a-f0-9-]{36}))?)?$/);
  if(match) {
    const [,id,action,revisionId]=match;
    if(!action && method==='GET'){respond(res,200,getDesign(db,id));return true;}
    if(!action && method==='PUT'){respond(res,200,saveDesign(db,await readBody(req),session.user_id,id));return true;}
    if(action==='revisions' && revisionId && method==='GET'){respond(res,200,getRevision(db,id,revisionId));return true;}
    if(action==='restore' && !revisionId && method==='POST'){const result=restoreDesign(db,id,await readBody(req),session.user_id);recordAudit(db,{event:'design.restored',actorId:session.user_id,targetId:id,ip});respond(res,200,result);return true;}
    if(action==='preview' && !revisionId && method==='POST'){respond(res,200,issueDesignPreview(db,id,await readBody(req,4096),session));return true;}
    if(action==='publish' && !revisionId && method==='POST'){
      if(session.role!=='admin')throw new HttpError(403,'فقط مدیر می‌تواند کد را منتشر کند.');
      const attempt=digest(`design-publish:${session.user_id}`);if(rateLimited(db,attempt))throw new HttpError(429,'تلاش‌های انتشار زیاد است؛ بعداً تلاش کنید.');
      const data=await readBody(req,8192);const result=await publishDesign(db,id,data,authorize,key,ip);db.prepare('DELETE FROM login_attempts WHERE key=?').run(attempt);respond(res,200,result);return true;
    }
  }
  throw new HttpError(404,'مسیر طراحی پیدا نشد.');
}
