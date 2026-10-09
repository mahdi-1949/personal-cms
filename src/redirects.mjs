import { randomUUID } from 'node:crypto';
import { HttpError } from './content.mjs';
import { contentPath } from './modules/registry.mjs';
import { categoryPath } from './categories.mjs';

export const listRedirects=db=>db.prepare('SELECT * FROM redirects ORDER BY updated_at DESC,id').all();
export function rememberRedirect(db,path,{contentId=null,categoryId=null}) {
  if(!validSource(path))return; // The homepage and reserved system endpoints keep their own routes.
  const now=new Date().toISOString();
  db.prepare('INSERT INTO redirects VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET content_id=excluded.content_id,category_id=excluded.category_id,updated_at=excluded.updated_at').run(randomUUID(),path,contentId,categoryId,now,now);
}
// Fixed route shapes prevent external destinations, traversal and collisions with system paths.
function validSource(path) {
  const slug='[a-z0-9]+(?:-[a-z0-9]+)*';
  if(typeof path!=='string' || path.length>260 || !new RegExp(`^/(?:${slug}/|(?:services|articles|work)/${slug}/|articles/category/${slug}/)$`).test(path))return false;
  return !/^\/(?:admin|api|assets|media|contact|robots|sitemap|404|index|home|services|articles|work)\/$/.test(path);
}
export function putRedirect(db,data) {
  if(!validSource(data.path) || typeof data.contentId!=='string')throw new HttpError(422,'آدرس قدیمی باید مسیر داخلی با اسلش پایانی باشد.');
  const target=db.prepare('SELECT * FROM content WHERE id=?').get(data.contentId);
  if(!target)throw new HttpError(422,'مقصد پیدا نشد.');
  if(db.prepare('SELECT * FROM content').all().some(item=>contentPath(item)===data.path) || db.prepare('SELECT * FROM categories').all().some(item=>categoryPath(item)===data.path))throw new HttpError(409,'این آدرس متعلق به محتوا یا دسته است.');
  if(db.prepare('SELECT id FROM redirects WHERE path=?').get(data.path))throw new HttpError(409,'این ریدایرکت وجود دارد.');
  rememberRedirect(db,data.path,{contentId:data.contentId});
  return db.prepare('SELECT * FROM redirects WHERE path=?').get(data.path);
}
export function publicRedirects(db,items,categories) {
  return listRedirects(db).flatMap(alias=>{
    const item=items.find(item=>item.id===alias.content_id);
    const category=categories.find(category=>category.id===alias.category_id);
    const destination=item?contentPath(item):category?categoryPath(category):null;
    return destination && alias.path!==destination?[{...alias,destination}]:[];
  });
}
