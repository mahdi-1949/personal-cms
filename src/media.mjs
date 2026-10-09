import { randomUUID } from 'node:crypto';
import { mkdir,writeFile,unlink,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError,listContent } from './content.mjs';

export const MAX_IMAGE_BYTES=5*1024*1024;
const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
function pngSize(buffer) {
  if(buffer.length<45 || !buffer.subarray(0,8).equals(PNG_SIGNATURE) || buffer.readUInt32BE(8)!==13 || buffer.toString('ascii',12,16)!=='IHDR')return null;
  let offset=8,ended=false,hasData=false;
  while(offset+12<=buffer.length) {
    const size=buffer.readUInt32BE(offset),type=buffer.toString('ascii',offset+4,offset+8);
    if(size>buffer.length-offset-12)return null;
    if(type==='IDAT')hasData=true;
    offset+=12+size;
    if(type==='IEND'){ended=size===0 && offset===buffer.length;break;}
  }
  return ended && hasData?{width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)}:null;
}
function jpegSize(buffer) {
  if(buffer.length<4 || buffer[0]!==0xff || buffer[1]!==0xd8 || buffer[buffer.length-2]!==0xff || buffer[buffer.length-1]!==0xd9)return null;
  let offset=2;
  while(offset+4<=buffer.length) {
    if(buffer[offset++]!==0xff)return null;
    while(buffer[offset]===0xff)offset++;
    const marker=buffer[offset++];
    if(marker===0xda || marker===0xd9)return null;
    const size=buffer.readUInt16BE(offset);
    if(size<2 || offset+size>buffer.length)return null;
    if([0xc0,0xc1,0xc2].includes(marker)) {
      if(size<8)return null;
      return {height:buffer.readUInt16BE(offset+3),width:buffer.readUInt16BE(offset+5)};
    }
    offset+=size;
  }
  return null;
}
export function validateImage(buffer,mime) {
  if(!buffer.length || buffer.length>MAX_IMAGE_BYTES)throw new HttpError(413,'حداکثر حجم تصویر ۵ مگابایت است.');
  const size=mime==='image/png'?pngSize(buffer):mime==='image/jpeg'?jpegSize(buffer):null;
  if(!size || size.width<1 || size.height<1 || size.width*size.height>16000000)throw new HttpError(422,'فقط PNG یا JPEG معتبر با حداکثر ۱۶ میلیون پیکسل مجاز است.');
  return {...size,extension:mime==='image/png'?'png':'jpg'};
}
export const mediaPath=(dir,item)=>join(dir,`${item.id}.${item.mime==='image/png'?'png':'jpg'}`);
export const listMedia=db=>db.prepare('SELECT * FROM media ORDER BY created_at DESC').all();
export async function uploadMedia(db,dir,buffer,{mime,filename,userId,authorize}) {
  const dimensions=validateImage(buffer,mime);
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
  if(listContent(db).some(content=>content.blocks.some(block=>block.type==='image' && block.mediaId===id)))throw new HttpError(409,'تصویر در محتوا استفاده شده؛ ابتدا بلوک تصویر را حذف کنید.');
  // Remove the DB record synchronously so no concurrent edit can add a reference while unlink awaits.
  db.prepare('DELETE FROM media WHERE id=?').run(id);
  try{await unlink(mediaPath(dir,item));}catch(error){if(error.code!=='ENOENT')throw error;}
}
export async function loadMedia(dir,item){try{return await readFile(mediaPath(dir,item));}catch(error){if(error.code==='ENOENT')throw new HttpError(404,'فایل تصویر پیدا نشد.');throw error;}}
