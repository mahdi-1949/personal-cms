import { HttpError } from './content.mjs';
import { getContentEditor,saveContentDraft,applyContentDraft,restoreContentDraft,duplicateContent } from './content-workspace.mjs';
import { permissions } from './permissions.mjs';
import { recordAudit } from './audit.mjs';
export async function contentAPI({db,req,res,path,method,session,readBody,respond,ip}){
  const allowed=permissions(session),match=path.match(/^\/api\/content\/([a-f0-9-]{36})\/(editor|draft|apply|restore|duplicate|revisions)(?:\/([a-f0-9-]{36}))?$/);
  if(path==='/api/content/drafts' && method==='POST'){if(!allowed.contentEdit)throw new HttpError(403,'دسترسی ویرایش محتوا لازم است.');respond(res,201,saveContentDraft(db,await readBody(req),session.user_id));return true;}
  if(!match)return false;const [,id,action,revisionId]=match;
  if(action==='editor' && !revisionId && method==='GET'){respond(res,200,getContentEditor(db,id));return true;}
  if(action==='revisions' && revisionId && method==='GET'){const row=db.prepare('SELECT payload FROM content_revisions WHERE id=? AND content_id=?').get(revisionId,id);if(!row)throw new HttpError(404,'نسخه پیدا نشد.');respond(res,200,JSON.parse(row.payload));return true;}
  if(!allowed.contentEdit)throw new HttpError(403,'دسترسی ویرایش محتوا لازم است.');
  if(revisionId)throw new HttpError(404,'مسیر پیدا نشد.');
  if(action==='draft' && method==='PUT'){respond(res,200,saveContentDraft(db,await readBody(req),session.user_id,id));return true;}
  if(action==='restore' && method==='POST'){const result=restoreContentDraft(db,id,await readBody(req),session.user_id);recordAudit(db,{event:'content.restored',actorId:session.user_id,targetId:id,ip});respond(res,200,result);return true;}
  if(action==='duplicate' && method==='POST'){const result=duplicateContent(db,id,await readBody(req),session.user_id);recordAudit(db,{event:'content.duplicated',actorId:session.user_id,targetId:result.id,ip});respond(res,201,result);return true;}
  if(action==='apply' && method==='POST'){
    const data=await readBody(req),editor=getContentEditor(db,id);
    if((data.status==='published' || editor.content.status==='published') && !allowed.contentPublish)throw new HttpError(403,'انتشار یا تغییر نسخه عمومی به مدیر یا ویرایشگر نیاز دارد.');
    const result=applyContentDraft(db,id,data,session.user_id);recordAudit(db,{event:data.status==='published'?'content.published':'content.applied',actorId:session.user_id,targetId:id,ip});respond(res,200,result);return true;
  }
  throw new HttpError(404,'مسیر پیدا نشد.');
}
