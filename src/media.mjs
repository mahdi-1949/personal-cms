import { randomUUID } from 'node:crypto';
import { mkdir,writeFile,unlink,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError,listContent } from './content.mjs';
import { processImage } from './image-processing.mjs';
import { processDesignAsset } from './asset-processing.mjs';
import { extension,isImage } from './asset-types.mjs';
import { designAssets } from './designs.mjs';
import { referencedMedia } from './blocks.mjs';

export const MAX_IMAGE_BYTES=5*1024*1024;
export const mediaPath=(dir,item)=>join(dir,`${item.id}.${extension(item)}`);
export const listMedia=db=>db.prepare('SELECT * FROM media ORDER BY created_at DESC').all();
export async function uploadMedia(db,dir,buffer,{mime,filename,userId,authorize}) {
  const dimensions=await (isImage({mime})?processImage(buffer,mime):processDesignAsset(buffer,mime));
  buffer=dimensions.buffer;
  if(typeof filename!=='string' || !filename.trim() || filename.length>200 || /[\x00-\x1f]/.test(filename))throw new HttpError(422,'نام تصویر معتبر نیست.');
  const id=randomUUID(),now=new Date().toISOString();const item={id,mime};
  await mkdir(dir,{recursive:true,mode:0o700});const path=mediaPath(dir,item);
  await writeFile(path,buffer,{flag:'wx',mode:0o600});
  try {
    authorize?.();
    const active=db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(userId);
    if(!active)throw new HttpError(403,'حساب شما فعال نیست.');
    db.prepare('INSERT INTO media VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,filename.trim(),mime,buffer.length,dimensions.width,dimensions.height,'',now,now,userId);
  }catch(error){await unlink(path);throw error;}
  return db.prepare('SELECT * FROM media WHERE id=?').get(id);
}
export function updateMedia(db,id,data) {
  const item=db.prepare('SELECT * FROM media WHERE id=?').get(id);
  if(!item)throw new HttpError(404,'تصویر پیدا نشد.');
  if(data.expected_updated_at!==item.updated_at)throw new HttpError(409,'تصویر تغییر کرده؛ فهرست را تازه کنید.');
  if(typeof data.alt!=='string' || data.alt.length>500)throw new HttpError(422,'متن جایگزین معتبر نیست.');
  const now=new Date(Math.max(Date.now(),Date.parse(item.updated_at)+1)).toISOString();
  db.prepare('UPDATE media SET alt=?,updated_at=? WHERE id=?').run(data.alt.trim(),now,id);return db.prepare('SELECT * FROM media WHERE id=?').get(id);
}
export async function deleteMedia(db,dir,id,data) {
  const item=db.prepare('SELECT * FROM media WHERE id=?').get(id);
  if(!item)throw new HttpError(404,'تصویر پیدا نشد.');
  if(data.expected_updated_at!==item.updated_at)throw new HttpError(409,'تصویر تغییر کرده؛ فهرست را تازه کنید.');
  if(referencedMedia(listContent(db)).includes(id) || designAssets(db).includes(id))throw new HttpError(409,'تصویر در محتوا یا تاریخچه طراحی استفاده شده و قابل حذف نیست.');
  // Remove the DB record synchronously so no concurrent edit can add a reference while unlink awaits.
  db.prepare('DELETE FROM media WHERE id=?').run(id);
  try{await unlink(mediaPath(dir,item));}catch(error){if(error.code!=='ENOENT')throw error;}
}
export async function loadMedia(dir,item){try{return await readFile(mediaPath(dir,item));}catch(error){if(error.code==='ENOENT')throw new HttpError(404,'فایل تصویر پیدا نشد.');throw error;}}
