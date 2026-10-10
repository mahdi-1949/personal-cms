export function createSectionEditor({esc,toast,contentOptions,mediaOptions}) {
  const input=(name,label,value,max,required=false)=>`<label>${label}<input data-field="${name}" value="${esc(value||'')}" maxlength="${max}" ${required?'required':''}></label>`;
  const area=(name,label,value,max,required=false)=>`<label>${label}<textarea data-field="${name}" rows="3" maxlength="${max}" ${required?'required':''}>${esc(value||'')}</textarea></label>`;
  const imageFields=item=>`<label>تصویر، اختیاری<select data-field="mediaId">${mediaOptions(item.mediaId)}</select></label>${input('alt','متن جایگزین تصویر',item.alt,500)}`;
  const targetField=item=>`<label>صفحه مقصد، اختیاری<select data-field="contentId">${contentOptions(item.contentId)}</select></label>`;
  const val=(row,name)=>row.querySelector(`[data-field="${name}"]`).value;
  function collect(row) {
    const type=row.dataset.type;
    if(type==='hero')return {type,variant:val(row,'variant'),title:val(row,'title'),text:val(row,'text'),mediaId:val(row,'mediaId'),alt:val(row,'alt'),contentId:val(row,'contentId'),label:val(row,'label')};
    const items=[...row.querySelectorAll('[data-entry]')].map(entry=>type==='cards'?{title:val(entry,'title'),text:val(entry,'text'),mediaId:val(entry,'mediaId'),alt:val(entry,'alt'),contentId:val(entry,'contentId')}:{question:val(entry,'question'),answer:val(entry,'answer')});
    return {type,title:val(row,'title'),...(type==='cards'?{variant:val(row,'variant')}:{}),items};
  }
  const card=()=>({title:'',text:'',mediaId:'',alt:'',contentId:''});
  const question=()=>({question:'',answer:''});
  function blank(type) {
    if(type==='hero')return {type,variant:'split',title:'',text:'',mediaId:'',alt:'',contentId:'',label:''};
    if(type==='cards')return {type,variant:'grid',title:'',items:[card()]};
    return {type:'faq',title:'',items:[question()]};
  }
  function fields(block) {
    if(block.type==='hero')return `${input('title','عنوان معرفی',block.title,200,true)}${area('text','متن معرفی',block.text,2000)}<label>طرح بخش<select data-field="variant"><option value="split" ${block.variant==='split'?'selected':''}>متن و تصویر کنار هم</option><option value="centered" ${block.variant==='centered'?'selected':''}>معرفی وسط‌چین</option></select></label>${imageFields(block)}${targetField(block)}${input('label','متن دکمه؛ در صورت انتخاب مقصد لازم است',block.label,100)}`;
    return `${input('title','عنوان بخش، اختیاری',block.title,200)}${block.type==='cards'?`<label>طرح کارت‌ها<select data-field="variant"><option value="grid" ${block.variant==='grid'?'selected':''}>شبکه کارت‌ها</option><option value="list" ${block.variant==='list'?'selected':''}>فهرست کارت‌ها</option><option value="process" ${block.variant==='process'?'selected':''}>مراحل همکاری</option><option value="testimonials" ${block.variant==='testimonials'?'selected':''}>نظر مشتریان</option><option value="stats" ${block.variant==='stats'?'selected':''}>آمار</option></select></label>`:''}<div class="section-entries">${block.items.map((item,i)=>`<fieldset data-entry="${i}"><legend>${block.type==='cards'?'کارت':'پرسش'} ${i+1}</legend>${block.type==='cards'?input('title','عنوان کارت',item.title,200,true)+area('text','توضیح کارت',item.text,2000)+imageFields(item)+targetField(item):input('question','پرسش',item.question,300,true)+area('answer','پاسخ',item.answer,4000,true)}<div class="row-actions"><button type="button" class="ghost" data-entry-move="${i}" data-step="-1" ${i===0?'disabled':''} aria-label="انتقال مورد به بالا">↑</button><button type="button" class="ghost" data-entry-move="${i}" data-step="1" ${i===block.items.length-1?'disabled':''} aria-label="انتقال مورد به پایین">↓</button><button type="button" class="ghost danger" data-entry-remove="${i}" ${block.items.length===1?'disabled':''}>حذف ${block.type==='cards'?'کارت':'پرسش'}</button></div></fieldset>`).join('')}</div><button type="button" class="ghost" data-entry-add>+ ${block.type==='cards'?'کارت':'پرسش'} تازه</button>`;
  }
  function bind(container,read,render) {
    container.querySelectorAll('[data-entry-add],[data-entry-remove],[data-entry-move]').forEach(button=>button.onclick=()=>{
      const blocks=read(),block=blocks[Number(button.closest('[data-block]').dataset.block)];
      if(button.hasAttribute('data-entry-add')) {
        if(block.items.length>=(block.type==='cards'?12:20)){toast('تعداد موارد این بخش به حداکثر رسیده است.');return;}
        block.items.push(block.type==='cards'?card():question());
      }else if(button.hasAttribute('data-entry-remove'))block.items.splice(Number(button.dataset.entryRemove),1);
      else{const i=Number(button.dataset.entryMove),j=i+Number(button.dataset.step);[block.items[i],block.items[j]]=[block.items[j],block.items[i]];}
      render();
    });
  }
  return {collect,fields,blank,bind};
}
