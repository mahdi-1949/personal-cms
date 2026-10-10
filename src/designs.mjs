import { randomUUID,randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { HttpError,publishedContent,listContent } from './content.mjs';
import { getSite } from './database.mjs';
import { digest,verifyPassword } from './auth.mjs';
import { consumeFactor } from './account-security.mjs';
import { recordAudit } from './audit.mjs';

export const canDesign=session=>session?.role==='admin' || Boolean(session?.design_access);
export function requireDesigner(session){if(!canDesign(session))throw new HttpError(403,'دسترسی فضای طراحی لازم است.');}
const revision=row=>row?{...row,assets:JSON.parse(row.assets)}:null;
export const designAssets=db=>db.prepare('SELECT assets FROM design_revisions').all().flatMap(row=>JSON.parse(row.assets));
export function releasedDesigns(db,items,{includeUnreferenced=false}={}) {
  const ids=new Set(items.flatMap(item=>(item.blocks||[]).filter(b=>b.type==='code-design').map(b=>b.designId)));
  return db.prepare('SELECT r.*,d.name FROM designs d JOIN design_revisions r ON r.id=d.published_id').all().filter(row=>includeUnreferenced || ids.has(row.design_id)).map(revision);
}
export function designList(db) {
  return db.prepare('SELECT d.*,r.number AS draftNumber,p.number AS publishedNumber FROM designs d LEFT JOIN design_revisions r ON r.id=d.draft_id LEFT JOIN design_revisions p ON p.id=d.published_id ORDER BY d.updated_at DESC').all();
}
export function getDesign(db,id) {
  const design=designList(db).find(d=>d.id===id);if(!design)throw new HttpError(404,'طرح پیدا نشد.');
  const history=db.prepare('SELECT id,number,created_at,created_by FROM design_revisions WHERE design_id=? ORDER BY number DESC').all(id);
  const uses=listContent(db).filter(item=>item.blocks.some(b=>b.type==='code-design' && b.designId===id)).map(({id,title,status})=>({id,title,status}));
  return {...design,draft:revision(db.prepare('SELECT * FROM design_revisions WHERE id=?').get(design.draft_id)),history,uses};
}
export function getRevision(db,id,revisionId) {
  if(typeof revisionId!=='string' || !/^[a-f0-9-]{36}$/.test(revisionId))throw new HttpError(422,'نسخه معتبر انتخاب کنید.');
  const row=revision(db.prepare('SELECT * FROM design_revisions WHERE id=? AND design_id=?').get(revisionId,id));if(!row)throw new HttpError(404,'نسخه پیدا نشد.');return row;
}
function validate(db,data) {
  if(typeof data.name!=='string' || !data.name.trim() || data.name.length>100)throw new HttpError(422,'نام طرح معتبر نیست.');
  for(const [key,max] of [['html',65536],['css',65536],['js',131072]])if(typeof data[key]!=='string' || Buffer.byteLength(data[key])>max)throw new HttpError(422,'حجم کد بیش از حد مجاز است: HTML/CSS هرکدام ۶۴ و JavaScript ۱۲۸ کیلوبایت.');
  if(!Array.isArray(data.assets??[]) || (data.assets??[]).length>20 || (data.assets??[]).some(id=>typeof id!=='string' || !db.prepare('SELECT id FROM media WHERE id=?').get(id)))throw new HttpError(422,'تصاویر طرح معتبر نیست.');
  return {name:data.name.trim(),html:data.html,css:data.css,js:data.js,assets:[...new Set(data.assets??[])]};
}
export function saveDesign(db,data,actorId,id) {
  const clean=validate(db,data);const now=new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    let old;
    if(id){old=db.prepare('SELECT * FROM designs WHERE id=?').get(id);if(!old)throw new HttpError(404,'طرح پیدا نشد.');if(data.expected_updated_at!==old.updated_at)throw new HttpError(409,'طرح در جلسه دیگری تغییر کرده؛ کد خود را کپی کنید و نسخه تازه را باز کنید.');}
    else {if(db.prepare('SELECT COUNT(*) AS n FROM designs').get().n>=50)throw new HttpError(422,'حداکثر ۵۰ طرح مجاز است.');id=randomUUID();db.prepare('INSERT INTO designs(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(id,clean.name,now,now);}
    const previous=old?getRevision(db,id,old.draft_id):null;
    if(previous && old.name===clean.name && ['html','css','js'].every(k=>previous[k]===clean[k]) && JSON.stringify(previous.assets)===JSON.stringify(clean.assets)){db.exec('COMMIT');return getDesign(db,id);}
    if(db.prepare('SELECT COALESCE(SUM(length(CAST(html AS BLOB))+length(CAST(css AS BLOB))+length(CAST(js AS BLOB))),0) AS n FROM design_revisions').get().n+Buffer.byteLength(clean.html+clean.css+clean.js)>64*1024*1024)throw new HttpError(422,'فضای تاریخچه طراحی پر شده است.');
    const revisionId=randomUUID(),number=db.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM design_revisions WHERE design_id=?').get(id).n;
    const updated=new Date(Math.max(Date.now(),Date.parse(old?.updated_at||now)+1)).toISOString();
    db.prepare('INSERT INTO design_revisions VALUES(?,?,?,?,?,?,?,?,?)').run(revisionId,id,number,clean.html,clean.css,clean.js,JSON.stringify(clean.assets),actorId,updated);
    db.prepare('UPDATE designs SET name=?,draft_id=?,updated_at=? WHERE id=?').run(clean.name,revisionId,updated,id);
    // Keep 40 recent versions plus any older published version. Never prune a release.
    db.prepare('DELETE FROM design_revisions WHERE design_id=? AND id NOT IN (SELECT id FROM design_revisions WHERE design_id=? ORDER BY number DESC LIMIT 40) AND id<>COALESCE((SELECT published_id FROM designs WHERE id=?),\'\')').run(id,id,id);
    db.exec('COMMIT');return getDesign(db,id);
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function restoreDesign(db,id,data,actorId){const source=getRevision(db,id,data.revisionId);return saveDesign(db,{...source,name:getDesign(db,id).name,expected_updated_at:data.expected_updated_at},actorId,id);}
let parsers=0;
async function checkScript(source) {
  if(parsers>=2)throw new HttpError(503,'بررسی کد مشغول است؛ دوباره تلاش کنید.');parsers++;
  try {await new Promise((resolve,reject)=>{
    // Syntax check only: user JavaScript is never evaluated by Node.js.
    const child=spawn(process.execPath,['--max-old-space-size=32','--check','--input-type=module'],{stdio:['pipe','ignore','ignore'],env:{},cwd:'/'});
    const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.stdin.on('error',()=>{});child.stdin.end(source);
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new HttpError(422,'JavaScript خطای نحوی دارد؛ پیش‌نمایش و کنسول را بررسی کنید.'));});
  });}finally{parsers--;}
}
export async function publishDesign(db,id,data,authorize,key,ip) {
  let session=authorize();if(session.role!=='admin')throw new HttpError(403,'فقط مدیر می‌تواند کد را منتشر کند.');
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id);
  if(!await verifyPassword(data.currentPassword,user.password_hash))throw new HttpError(422,'رمز فعلی صحیح نیست.');
  const source=data.revisionId===null?null:getRevision(db,id,data.revisionId);
  if(source)await checkScript(source.js);
  session=authorize();if(session.role!=='admin')throw new HttpError(403,'دسترسی انتشار معتبر نیست.');
  const latest=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(session.user_id);
  if(latest?.password_hash!==user.password_hash)throw new HttpError(409,'حساب تغییر کرده؛ دوباره وارد شوید.');
  const design=getDesign(db,id);if(data.expected_updated_at!==design.updated_at)throw new HttpError(409,'طرح تغییر کرده؛ نسخه تازه را باز کنید.');
  db.exec('BEGIN IMMEDIATE');
  try {
    if(!consumeFactor(db,latest,data.mfaCode,key))throw new HttpError(422,'کد دومرحله‌ای صحیح نیست.');
    const now=new Date(Math.max(Date.now(),Date.parse(design.updated_at)+1)).toISOString();
    db.prepare('UPDATE designs SET published_id=?,updated_at=? WHERE id=?').run(source?.id||null,now,id);
    recordAudit(db,{event:source?'design.published':'design.unpublished',actorId:session.user_id,targetId:id,ip});db.exec('COMMIT');return getDesign(db,id);
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function issueDesignPreview(db,id,data,session,{releasedOnly=false}={}) {
  if(!releasedOnly)requireDesigner(session);const design=getDesign(db,id),source=getRevision(db,id,data.revisionId||design.draft_id);
  if(releasedOnly && source.id!==design.published_id)throw new HttpError(404,'نسخه منتشرشده پیدا نشد.');
  const now=Date.now();db.prepare('DELETE FROM design_previews WHERE expires_at<=?').run(now);
  // Bound temporary capabilities to a live session and limit retained previews per session.
  db.prepare('DELETE FROM design_previews WHERE session_hash=? AND token_hash NOT IN (SELECT token_hash FROM design_previews WHERE session_hash=? ORDER BY expires_at DESC LIMIT 80)').run(session.token_hash,session.token_hash);
  const token=randomBytes(32).toString('hex');db.prepare('INSERT INTO design_previews VALUES(?,?,?,?,?)').run(digest(token),source.id,session.token_hash,now+10*60*1000,Number(releasedOnly));
  return {url:`/design-preview/${token}/index.html`,expiresAt:now+10*60*1000};
}
export function previewRevision(db,token,requireAdminMfa=false) {
  if(!/^[a-f0-9]{64}$/.test(token))throw new HttpError(404,'پیش‌نمایش منقضی شده است.');
  const row=db.prepare('SELECT r.*,d.name,d.published_id,p.released_only,u.role,u.design_access,u.mfa_secret FROM design_previews p JOIN design_revisions r ON r.id=p.revision_id JOIN designs d ON d.id=r.design_id JOIN sessions s ON s.token_hash=p.session_hash JOIN users u ON u.id=s.user_id WHERE p.token_hash=? AND p.expires_at>? AND s.expires_at>? AND u.active=1').get(digest(token),Date.now(),Date.now());
  if(!row || (!row.released_only && !canDesign(row)) || (row.released_only && row.published_id!==row.id) || (requireAdminMfa && row.role==='admin' && !row.mfa_secret))throw new HttpError(404,'پیش‌نمایش منقضی شده است.');
  // Do not expose identity or authentication data to the runtime renderer.
  const {role,design_access,mfa_secret,published_id,released_only,...source}=row;return revision(source);
}
export function publicRevision(db,designId,revisionId) {
  const source=releasedDesigns(db,publishedContent(db,getSite(db))).find(r=>r.design_id===designId && r.id===revisionId);
  if(!source)throw new HttpError(404,'طرح عمومی پیدا نشد.');return source;
}
