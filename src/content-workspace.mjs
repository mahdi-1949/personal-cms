import { HttpError,listContent,putContent,validateContent,contentSnapshot,recordContentRevision,pruneContentHistory } from './content.mjs';
import { validateBlocks } from './blocks.mjs';
import { validatePageTemplate } from './templates.mjs';
import { validateCategoryIds } from './categories.mjs';
import { getSite } from './database.mjs';
import { contentPath } from './modules/registry.mjs';
export function getContentEditor(db,id){
  const content=listContent(db).find(p=>p.id===id);if(!content)throw new HttpError(404,'محتوا پیدا نشد.');
  const work=db.prepare('SELECT w.*,r.payload FROM content_working w JOIN content_revisions r ON r.id=w.revision_id WHERE w.content_id=?').get(id);
  return {content,draft:work?JSON.parse(work.payload):null,draft_updated_at:work?.updated_at||null,draft_base_updated_at:work?.base_updated_at||null,history:db.prepare('SELECT id,number,source,created_by,created_at FROM content_revisions WHERE content_id=? ORDER BY number DESC').all(id)};
}
export const listAuthoringContent=db=>listContent(db).map(item=>({...item,hasWorkingDraft:Boolean(db.prepare('SELECT content_id FROM content_working WHERE content_id=?').get(item.id))}));
function checkVersion(editor,data){if(data.expected_updated_at!==editor.content.updated_at || (data.expected_draft_updated_at??null)!==editor.draft_updated_at)throw new HttpError(409,'محتوا یا پیش‌نویس در جلسه دیگری تغییر کرده؛ تغییرات خود را کپی کنید و نسخه تازه را باز کنید.');}
function cleanDraft(db,data,old){
  const item=validateContent({...data,status:'draft'});if(old && item.kind!==old.kind)throw new HttpError(422,'نوع محتوا قابل تغییر نیست.');
  if(!getSite(db).enabledModules.includes(item.kind))throw new HttpError(422,'این ماژول غیرفعال است.');
  if(item.kind==='pages' && item.slug==='contact' && getSite(db).contactEnabled)throw new HttpError(409,'آدرس contact برای فرم تماس رزرو است.');
  const duplicate=db.prepare('SELECT id FROM content WHERE kind=? AND slug=?').get(item.kind,item.slug),alias=db.prepare('SELECT content_id FROM redirects WHERE path=?').get(contentPath(item));
  if((duplicate && duplicate.id!==old?.id) || (alias && alias.content_id!==old?.id))throw new HttpError(409,'آدرس صفحه قبلاً استفاده شده است.');
  return {...item,blocks:validateBlocks(db,data.blocks??[]),template:validatePageTemplate(item.kind,data.template??old?.template),categoryIds:validateCategoryIds(db,item.kind,data.categoryIds??[])};
}
export function saveContentDraft(db,data,actorId,id,{source='autosave'}={}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const editor=id?getContentEditor(db,id):null;if(editor)checkVersion(editor,data);
    const clean=cleanDraft(db,data,editor?.content);
    if(!id){const item=putContent(db,clean,undefined,{actorId,source:'draft',transaction:false});id=item.id;}
    const current=editor||getContentEditor(db,id),previous=current.draft;
    if(previous && JSON.stringify(previous)===JSON.stringify(clean)){db.exec('COMMIT');return getContentEditor(db,id);}
    const revisionId=recordContentRevision(db,{...clean,id},actorId,source),now=new Date(Math.max(Date.now(),Date.parse(current.draft_updated_at||current.content.updated_at)+1)).toISOString();
    db.prepare('INSERT INTO content_working VALUES(?,?,?,?,?) ON CONFLICT(content_id) DO UPDATE SET revision_id=excluded.revision_id,base_updated_at=excluded.base_updated_at,updated_at=excluded.updated_at,created_by=excluded.created_by').run(id,revisionId,current.content.updated_at,now,actorId);
    pruneContentHistory(db,id);db.exec('COMMIT');return getContentEditor(db,id);
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function applyContentDraft(db,id,data,actorId){
  db.exec('BEGIN IMMEDIATE');
  try {const editor=getContentEditor(db,id);checkVersion(editor,data);if(!editor.draft || editor.draft_base_updated_at!==editor.content.updated_at)throw new HttpError(409,'پیش‌نویس باید با نسخه فعلی تطبیق داده شود.');
    if(!['draft','published'].includes(data.status))throw new HttpError(422,'وضعیت معتبر نیست.');
    const item=putContent(db,{...cleanDraft(db,editor.draft,editor.content),status:data.status},id,{actorId,source:data.status==='published'?'publish':'save',transaction:false});
    db.prepare('DELETE FROM content_working WHERE content_id=?').run(id);pruneContentHistory(db,id);db.exec('COMMIT');return item;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function restoreContentDraft(db,id,data,actorId){
  const revision=db.prepare('SELECT payload FROM content_revisions WHERE id=? AND content_id=?').get(data.revisionId,id);if(!revision)throw new HttpError(404,'نسخه پیدا نشد.');
  return saveContentDraft(db,{...JSON.parse(revision.payload),expected_updated_at:data.expected_updated_at,expected_draft_updated_at:data.expected_draft_updated_at},actorId,id,{source:'restore'});
}
export function duplicateContent(db,id,data,actorId){
  db.exec('BEGIN IMMEDIATE');try{
  const editor=getContentEditor(db,id);checkVersion(editor,data);
  if(!getSite(db).enabledModules.includes(editor.content.kind))throw new HttpError(422,'این ماژول غیرفعال است.');
  const source=contentSnapshot(editor.content);let slug='';const base=source.slug.slice(0,100).replace(/-+$/,'');
  for(let i=1;i<=1000;i++){const candidate=`${base}-copy${i===1?'':`-${i}`}`;if(!db.prepare('SELECT id FROM content WHERE kind=? AND slug=?').get(source.kind,candidate) && !db.prepare('SELECT id FROM redirects WHERE path=?').get(contentPath({...source,slug:candidate}))){slug=candidate;break;}}
  if(!slug)throw new HttpError(409,'آدرس آزاد برای کپی پیدا نشد.');const copy=putContent(db,{...source,title:`${source.title.slice(0,190)} (کپی)`,slug,status:'draft'},undefined,{actorId,source:'duplicate',transaction:false});db.exec('COMMIT');return copy;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function historicalContent(db){return db.prepare('SELECT payload FROM content_revisions').all().map(r=>JSON.parse(r.payload));}
