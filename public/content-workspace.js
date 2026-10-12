export function createContentWorkspace({state,api,esc,toast,load,authoring,templates,operations}){
  const $=s=>document.querySelector(s),form=$('#editor-form'),dialog=$('#editor-dialog');
  let current=null,dirty=false,halted=false,opening=false,generation=0,timer,saving=null,openToken=0;
  const status=message=>$('#content-save-state').textContent=message;
  const versions=()=>({expected_updated_at:current?.content.updated_at,expected_draft_updated_at:current?.draft_updated_at||null});
  function fields(){return {...Object.fromEntries(new FormData(form)),kind:state.editorKind,blocks:authoring.collectBlocks(),categoryIds:operations.collectCategories()};}
  function history(){
    $('#content-history').innerHTML=(current?.history||[]).map(r=>`<option value="${esc(r.id)}">نسخه ${r.number} · ${new Date(r.created_at).toLocaleString('fa-IR')} · ${esc({autosave:'ذخیره خودکار',restore:'بازیابی',publish:'انتشار',save:'ذخیره',baseline:'نسخه اولیه',draft:'پیش‌نویس',duplicate:'کپی'}[r.source]||r.source)}</option>`).join('');
    $('#content-history-box').hidden=!current;$('#restore-content-version').hidden=!state.user.permissions.contentEdit;
    const preview=$('#preview-content'),responsive=$('#responsive-preview');preview.hidden=!current;responsive.hidden=!current;if(current)preview.href=`/api/content/${current.content.id}/preview`;
  }
  function populate(item){
    opening=true;for(const key of ['title','slug','status','excerpt','body','seo_title','seo_description'])form.elements[key].value=item?.[key]|| (key==='status'?'draft':'');
    form.elements.status.value=state.user.permissions.contentPublish?(current?.content.status||'draft'):'draft';
    templates.openPage(item,state.editorKind);authoring.openBlocks(item);operations.openCategories(item,state.editorKind);opening=false;history();
  }
  async function open(item){
    const token=++openToken;clearTimeout(timer);current=null;dirty=false;halted=false;generation=0;opening=true;
    try{const editor=item?await api(`/content/${item.id}/editor`):null;if(token!==openToken)return;
      current=editor;state.editing=editor?.content||null;state.editorKind=editor?.content.kind||state.view;
      if(!state.site.enabledModules.includes(state.editorKind))throw new Error('این ماژول غیرفعال است.');
      form.reset();$('#editor-error').textContent='';$('#editor-heading').textContent=item?(state.user.permissions.contentEdit?'ویرایش محتوا':'مشاهده محتوا'):`${state.modules.find(m=>m.key===state.editorKind).singular} جدید`;
      // Reset read-only controls from the previous account before applying this account's permissions.
      form.querySelectorAll('input,textarea,select,button').forEach(el=>el.disabled=false);
      populate(editor?.draft||editor?.content);
      form.elements.status.querySelector('[value=published]').disabled=!state.user.permissions.contentPublish;
      if(!state.user.permissions.contentEdit)form.querySelectorAll('input,textarea,select,button:not(#close-editor):not(#cancel-editor):not(#responsive-preview):not(#inspect-content-version)').forEach(el=>el.disabled=true);
      $('#content-history').disabled=false;form.querySelector('[type=submit]').hidden=!state.user.permissions.contentEdit;
      status(!state.user.permissions.contentEdit?'این حساب فقط برای مشاهده است؛ تغییر یا انتشار مجاز نیست.':editor?.draft?'پیش‌نویس مستقل موجود است؛ نسخه عمومی تغییر نکرده.':'ذخیره خودکار پس از کامل‌شدن عنوان و آدرس فعال می‌شود.');dialog.showModal();form.elements.title.focus();
    }catch(error){toast(error.message);}finally{opening=false;}
  }
  function changed(){if(opening || !dialog.open || !state.user?.permissions.contentEdit)return;dirty=true;generation++;clearTimeout(timer);status('تغییر در انتظار ذخیره خودکار…');if(!halted)timer=setTimeout(()=>save().catch(()=>{}),1500);}
  form.addEventListener('input',changed);form.addEventListener('cms-content-change',changed);
  async function save(force=false){
    clearTimeout(timer);if(!state.user?.permissions.contentEdit || (!dirty && !force))return current;
    if(halted)throw new Error('ذخیره متوقف شده؛ تغییرات را کپی کنید و نسخه تازه را باز کنید.');
    if(!form.checkValidity()){status('برای ذخیره، عنوان، آدرس و فیلدهای ضروری را کامل کنید.');if(force){form.reportValidity();throw new Error('فیلدهای ضروری کامل نیستند.');}return current;}
    if(saving){await saving;return dirty||force?save(force):current;}
    const token=openToken,before=generation,data={...fields(),status:'draft',...versions()},id=current?.content.id;status('در حال ذخیره پیش‌نویس…');
    saving=(async()=>{try{const result=await api(id?`/content/${id}/draft`:'/content/drafts',id?'PUT':'POST',data);if(token!==openToken)return;current=result;state.editing=result.content;dirty=generation!==before;history();status(dirty?'تغییر تازه در انتظار ذخیره است.':'پیش‌نویس ذخیره شد؛ انتشار سایت تغییر نکرد.');}
      catch(error){if(token!==openToken)return;halted=[401,403,409].includes(error.status);$('#editor-error').textContent=error.message;status('ذخیره ناموفق؛ تغییرات هنوز در ویرایشگر هستند.');throw error;}finally{saving=null;}})();await saving;return dirty?save():current;
  }
  form.onsubmit=async event=>{
    event.preventDefault();const button=form.querySelector('[type=submit]'),wanted=form.elements.status.value;button.disabled=true;form.inert=true;$('#editor-error').textContent='';
    try{await save(true);if(state.user.permissions.contentPublish || current.content.status==='draft')await api(`/content/${current.content.id}/apply`,'POST',{status:wanted,...versions()});reset();await load();toast('محتوا ذخیره شد.');}catch(error){$('#editor-error').textContent=error.message;}finally{button.disabled=false;form.inert=false;}
  };
  async function close(){try{if(dirty && !form.checkValidity()){if(!confirm('فیلدهای ناقص ذخیره نشده‌اند؛ تغییرات را کپی کرده‌اید و می‌خواهید ببندید؟'))return;}else await save();reset();await load();}catch(error){$('#editor-error').textContent=error.message;}}
  const responsive=$('#responsive-preview'),showResponsive=responsive.onclick;responsive.onclick=async()=>{try{await save(true);showResponsive();}catch(error){$('#editor-error').textContent=error.message;}};
  for(const id of ['#close-editor','#cancel-editor'])$(id).onclick=close;dialog.oncancel=e=>{e.preventDefault();close();};
  $('#restore-content-version').onclick=async()=>{try{const revisionId=$('#content-history').value;await save();current=await api(`/content/${current.content.id}/restore`,'POST',{revisionId,...versions()});state.editing=current.content;populate(current.draft);dirty=false;status('نسخه انتخاب‌شده در پیش‌نویس بازیابی شد؛ انتشار تغییر نکرد.');}catch(error){$('#editor-error').textContent=error.message;}};
  $('#inspect-content-version').onclick=()=>{if(!current)return;const preview=document.querySelector('.page-preview-dialog');preview.querySelector('iframe').src=`/api/content/${current.content.id}/preview?revision=${encodeURIComponent($('#content-history').value)}`;preview.showModal();};
  addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  function reset(){++openToken;clearTimeout(timer);dirty=false;halted=false;current=null;dialog.close();$('#content-version-preview').hidden=true;}
  return {open,reset,save};
}
