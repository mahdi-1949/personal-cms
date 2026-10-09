import { randomUUID } from 'node:crypto';
import { HttpError } from './content.mjs';
import { rememberRedirect } from './redirects.mjs';

export const categoryPath=category=>`/articles/category/${category.slug}/`;
export const listCategories=db=>db.prepare('SELECT * FROM categories ORDER BY name,id').all();
export function categoryIds(db,id) {
  return db.prepare('SELECT category_id FROM content_categories WHERE content_id=? ORDER BY category_id').all(id).map(row=>row.category_id);
}
export function validateCategoryIds(db,kind,ids) {
  if(!Array.isArray(ids) || ids.length>10 || ids.some(id=>typeof id!=='string') || new Set(ids).size!==ids.length)throw new HttpError(422,'حداکثر ۱۰ دسته بدون تکرار مجاز است.');
  if(kind!=='posts' && ids.length)throw new HttpError(422,'دسته‌بندی فقط برای مقالات است.');
  for(const id of ids)if(!db.prepare('SELECT id FROM categories WHERE id=?').get(id))throw new HttpError(422,'دسته پیدا نشد.');
  return ids;
}
export function putCategory(db,data,id) {
  if(typeof data.name!=='string' || !data.name.trim() || data.name.length>100 || typeof data.slug!=='string' || data.slug.length>120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.slug))throw new HttpError(422,'نام و آدرس دسته معتبر نیست.');
  const old=id?db.prepare('SELECT * FROM categories WHERE id=?').get(id):null;
  if(id && !old)throw new HttpError(404,'دسته پیدا نشد.');
  if(old && data.expected_updated_at!==old.updated_at)throw new HttpError(409,'دسته تغییر کرده؛ فهرست را تازه کنید.');
  const duplicate=db.prepare('SELECT id FROM categories WHERE slug=?').get(data.slug);
  if(duplicate && duplicate.id!==id)throw new HttpError(409,'آدرس دسته تکراری است.');
  const path=categoryPath(data),alias=db.prepare('SELECT * FROM redirects WHERE path=?').get(path);
  if(alias && alias.category_id!==id)throw new HttpError(409,'این آدرس برای ریدایرکت رزرو است؛ ابتدا ریدایرکت را حذف کنید.');
  const now=new Date(Math.max(Date.now(),old?Date.parse(old.updated_at)+1:0)).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    if(alias)db.prepare('DELETE FROM redirects WHERE id=?').run(alias.id);
    if(old)db.prepare('UPDATE categories SET name=?,slug=?,updated_at=? WHERE id=?').run(data.name.trim(),data.slug,now,id);
    else {id=randomUUID();db.prepare('INSERT INTO categories VALUES(?,?,?,?,?)').run(id,data.name.trim(),data.slug,now,now);}
    if(old && old.slug!==data.slug)rememberRedirect(db,categoryPath(old),{categoryId:id});
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return db.prepare('SELECT * FROM categories WHERE id=?').get(id);
}
export function publicCategories(db,items) {
  const posts=items.filter(item=>item.kind==='posts');
  return listCategories(db).flatMap(category=>{
    const count=posts.filter(item=>item.categoryIds.includes(category.id)).length;
    return count?[{id:category.id,name:category.name,slug:category.slug,path:categoryPath(category),count}]:[];
  });
}
