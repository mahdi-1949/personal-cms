import { randomUUID } from 'node:crypto';
import { moduleByKey } from './modules/registry.mjs';
import { validateBlocks } from './blocks.mjs';
import { validatePageTemplate } from './templates.mjs';
import { categoryIds,validateCategoryIds } from './categories.mjs';
import { contentPath } from './modules/registry.mjs';
import { rememberRedirect } from './redirects.mjs';

export class HttpError extends Error {
  constructor(status,message) { super(message); this.status=status; }
}
function field(data,key,max,required=false) {
  if (typeof data[key] !== 'string') throw new HttpError(422,`فیلد ${key} باید متن باشد.`);
  const value=data[key].trim();
  if ((required && !value) || value.length>max) throw new HttpError(422,`مقدار ${key} معتبر نیست (حداکثر ${max} کاراکتر).`);
  return value;
}
export function validateContent(data) {
  if (!data || typeof data!=='object' || Array.isArray(data)) throw new HttpError(422,'محتوا معتبر نیست.');
  const kind=field(data,'kind',32,true);
  if (!moduleByKey(kind)) throw new HttpError(422,'ماژول نامعتبر است.');
  const title=field(data,'title',200,true);
  const slug=field(data,'slug',120,true);
  // ASCII slugs make portable static paths deterministic. Persian slugs are a future migration.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new HttpError(422,'آدرس فقط حروف کوچک انگلیسی، عدد و خط تیره باشد.');
  if (kind==='pages' && ['admin','api','assets','media','contact','services','articles','work','robots','sitemap','404','index'].includes(slug)) throw new HttpError(422,'این آدرس برای سیستم رزرو شده است.');
  if (!['draft','published'].includes(data.status)) throw new HttpError(422,'وضعیت نامعتبر است.');
  return {kind,title,slug,status:data.status,excerpt:field(data,'excerpt',500),body:field(data,'body',100000),seo_title:field(data,'seo_title',200),seo_description:field(data,'seo_description',500)};
}
export function putContent(db,data,id) {
  const item=validateContent(data);
  const blocks=validateBlocks(db,data.blocks??[]);
  const old=id?db.prepare('SELECT * FROM content WHERE id=?').get(id):null;
  if(id && !old)throw new HttpError(404,'محتوا پیدا نشد.');
  const template=validatePageTemplate(item.kind,data.template??old?.template);
  const ids=validateCategoryIds(db,item.kind,data.categoryIds??(old?categoryIds(db,id):[]));
  const duplicate=db.prepare('SELECT id FROM content WHERE kind=? AND slug=?').get(item.kind,item.slug);
  if(duplicate && duplicate.id!==id)throw new HttpError(409,'این آدرس قبلاً استفاده شده است.');
  const alias=db.prepare('SELECT * FROM redirects WHERE path=?').get(contentPath(item));
  if(alias && alias.content_id!==id)throw new HttpError(409,'این آدرس برای ریدایرکت رزرو است؛ ابتدا ریدایرکت را حذف کنید.');
  const now=new Date(Math.max(Date.now(),old?Date.parse(old.updated_at)+1:0)).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    if(alias)db.prepare('DELETE FROM redirects WHERE id=?').run(alias.id);
    if(id)db.prepare('UPDATE content SET kind=?,title=?,slug=?,excerpt=?,body=?,status=?,seo_title=?,seo_description=?,updated_at=?,blocks=?,template=? WHERE id=?').run(item.kind,item.title,item.slug,item.excerpt,item.body,item.status,item.seo_title,item.seo_description,now,JSON.stringify(blocks),template,id);
    else {id=randomUUID();db.prepare('INSERT INTO content(id,kind,title,slug,excerpt,body,status,seo_title,seo_description,created_at,updated_at,blocks,template) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,item.kind,item.title,item.slug,item.excerpt,item.body,item.status,item.seo_title,item.seo_description,now,now,JSON.stringify(blocks),template);}
    db.prepare('DELETE FROM content_categories WHERE content_id=?').run(id);
    for(const categoryId of ids)db.prepare('INSERT INTO content_categories VALUES(?,?)').run(id,categoryId);
    if(old && old.status==='published' && contentPath(old)!==contentPath(item))rememberRedirect(db,contentPath(old),{contentId:id});
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return serializeContent(db,db.prepare('SELECT * FROM content WHERE id=?').get(id));
}
export const serializeContent=(db,item)=>({...item,blocks:JSON.parse(item.blocks),categoryIds:categoryIds(db,item.id)});
export const listContent=db=>db.prepare('SELECT * FROM content ORDER BY updated_at DESC').all().map(item=>serializeContent(db,item));
export function publishedContent(db,site) {
  return db.prepare("SELECT * FROM content WHERE status='published' ORDER BY updated_at DESC").all().filter(item=>site.enabledModules.includes(item.kind)).map(item=>serializeContent(db,item));
}
