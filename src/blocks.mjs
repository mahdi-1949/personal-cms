import { HttpError } from './content.mjs';
import { contentPath } from './modules/registry.mjs';

function text(value,max,required=false) {
  if(typeof value!=='string' || value.length>max || (required && !value.trim()))throw new HttpError(422,'مقدار بلوک معتبر نیست.');
  return value.trim();
}
function mediaRef(db,value) {
  if(value===undefined || value==='')return '';
  if(typeof value!=='string' || !db.prepare('SELECT id FROM media WHERE id=?').get(value))throw new HttpError(422,'تصویر بخش پیدا نشد.');
  return value;
}
function contentRef(db,value) {
  if(value===undefined || value==='')return '';
  if(typeof value!=='string' || !db.prepare('SELECT id FROM content WHERE id=?').get(value))throw new HttpError(422,'صفحه مقصد بخش پیدا نشد.');
  return value;
}
export function validateBlocks(db,blocks) {
  if(!Array.isArray(blocks) || blocks.length>40)throw new HttpError(422,'حداکثر ۴۰ بلوک مجاز است.');
  return blocks.map(block=>{
    if(!block || typeof block!=='object' || Array.isArray(block))throw new HttpError(422,'بلوک معتبر نیست.');
    switch(block.type) {
      case 'heading':
        if(![2,3].includes(block.level))throw new HttpError(422,'سطح عنوان باید ۲ یا ۳ باشد.');
        return {type:'heading',text:text(block.text,200,true),level:block.level};
      case 'paragraph':return {type:'paragraph',text:text(block.text,10000,true)};
      case 'image':
        if(typeof block.mediaId!=='string' || !db.prepare('SELECT id FROM media WHERE id=?').get(block.mediaId))throw new HttpError(422,'تصویر بلوک پیدا نشد.');
        return {type:'image',mediaId:block.mediaId,alt:text(block.alt,500),caption:text(block.caption,500)};
      case 'cta': {
        if(typeof block.contentId!=='string' || !db.prepare('SELECT id FROM content WHERE id=?').get(block.contentId))throw new HttpError(422,'صفحه مقصد پیدا نشد.');
        return {type:'cta',label:text(block.label,100,true),contentId:block.contentId};
      }
      case 'hero': {
        if(!['split','centered'].includes(block.variant))throw new HttpError(422,'طرح معرفی معتبر نیست.');
        const contentId=contentRef(db,block.contentId);
        return {type:'hero',variant:block.variant,title:text(block.title,200,true),text:text(block.text,2000),mediaId:mediaRef(db,block.mediaId),alt:text(block.alt??'',500),contentId,label:text(block.label??'',100,Boolean(contentId))};
      }
      case 'cards': {
        if(!['grid','list'].includes(block.variant) || !Array.isArray(block.items) || !block.items.length || block.items.length>12)throw new HttpError(422,'طرح کارت‌ها و تعداد آن‌ها معتبر نیست.');
        return {type:'cards',variant:block.variant,title:text(block.title??'',200),items:block.items.map(item=>{
          if(!item || typeof item!=='object' || Array.isArray(item))throw new HttpError(422,'کارت معتبر نیست.');
          return {title:text(item.title,200,true),text:text(item.text,2000),mediaId:mediaRef(db,item.mediaId),alt:text(item.alt??'',500),contentId:contentRef(db,item.contentId)};
        })};
      }
      case 'faq': {
        if(!Array.isArray(block.items) || !block.items.length || block.items.length>20)throw new HttpError(422,'بین یک تا بیست پرسش وارد کنید.');
        return {type:'faq',title:text(block.title??'',200),items:block.items.map(item=>{
          if(!item || typeof item!=='object' || Array.isArray(item))throw new HttpError(422,'پرسش معتبر نیست.');
          return {question:text(item.question,300,true),answer:text(item.answer,4000,true)};
        })};
      }
      default:throw new HttpError(422,'نوع بلوک پشتیبانی نمی‌شود.');
    }
  });
}
export function referencedMedia(items) {
  return [...new Set(items.flatMap(item=>(item.blocks||[]).flatMap(block=>block.type==='cards'?block.items.map(card=>card.mediaId):['image','hero'].includes(block.type)?[block.mediaId]:[])).filter(Boolean))];
}
export function validateMenu(db,data) {
  if(!Array.isArray(data.items) || data.items.length>12)throw new HttpError(422,'حداکثر ۱۲ لینک منو مجاز است.');
  return data.items.map(item=>{
    if(!item || typeof item!=='object' || typeof item.contentId!=='string' || !db.prepare('SELECT id FROM content WHERE id=?').get(item.contentId))throw new HttpError(422,'صفحه منو معتبر نیست.');
    return {label:text(item.label,80,true),contentId:item.contentId};
  });
}
export function getMenu(db) {
  const row=db.prepare('SELECT * FROM navigation WHERE id=1').get();return {items:JSON.parse(row.items),updated_at:row.updated_at};
}
export function putMenu(db,data) {
  const items=validateMenu(db,data);const old=getMenu(db);
  if(data.expected_updated_at!==old.updated_at)throw new HttpError(409,'منو تغییر کرده؛ صفحه را تازه کنید.');
  const now=new Date(Math.max(Date.now(),Date.parse(old.updated_at)+1)).toISOString();
  db.prepare('UPDATE navigation SET items=?,updated_at=? WHERE id=1').run(JSON.stringify(items),now);return getMenu(db);
}
export function publicMenu(db,items) {
  return getMenu(db).items.flatMap(link=>{const item=items.find(item=>item.id===link.contentId);return item?[{label:link.label,path:contentPath(item)}]:[];});
}

export function publicBlocks(blocks,ids) {
  return blocks.flatMap(block=>{
    if(block.type==='cta')return ids.has(block.contentId)?[block]:[];
    if(block.type==='hero')return [{...block,contentId:ids.has(block.contentId)?block.contentId:'',label:ids.has(block.contentId)?block.label:''}];
    if(block.type==='cards')return [{...block,items:block.items.map(item=>({...item,contentId:ids.has(item.contentId)?item.contentId:''}))}];
    return [block];
  });
}
