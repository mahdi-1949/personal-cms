export function createOperations({state,api,esc,toast,load,heading,number}) {
  const $=selector=>document.querySelector(selector);
  const statusLabel={new:'جدید',read:'خوانده‌شده',archived:'بایگانی'};
  const dialog=document.createElement('dialog');dialog.id='category-dialog';
  dialog.innerHTML='<form id="category-form"><div class="dialog-heading"><h2>دسته مقاله</h2><button id="close-category" class="ghost" type="button">×</button></div><label>نام دسته<input name="name" required maxlength="100"></label><label>آدرس دسته<input name="slug" dir="ltr" required maxlength="120" pattern="[a-z0-9]+(-[a-z0-9]+)*"></label><p id="category-error" role="alert"></p><button class="primary" type="submit">ذخیره دسته</button></form>';
  document.body.append(dialog);let editing=null,messagePage=1,messageStatus='';
  $('#close-category').onclick=()=>dialog.close();
  function openCategory(item){editing=item;const form=$('#category-form');form.reset();$('#category-error').textContent='';form.elements.name.value=item?.name||'';form.elements.slug.value=item?.slug||'';dialog.showModal();form.elements.name.focus();}
  $('#category-form').onsubmit=async event=>{
    event.preventDefault();const button=event.target.querySelector('[type=submit]');button.disabled=true;
    try{await api(editing?`/categories/${editing.id}`:'/categories',editing?'PUT':'POST',{...Object.fromEntries(new FormData(event.target)),...(editing?{expected_updated_at:editing.updated_at}:{})});dialog.close();await load();toast('دسته ذخیره شد.');}
    catch(error){$('#category-error').textContent=error.message;}finally{button.disabled=false;}
  };
  function categories(view){
    view.innerHTML=heading('دسته‌های مقاله','هر مقاله می‌تواند در چند دسته قرار بگیرد.','<button id="new-category" class="primary">+ دسته جدید</button>')+`<div class="table-wrap"><table><thead><tr><th>دسته</th><th>آدرس</th><th>عملیات</th></tr></thead><tbody>${state.categories.map(item=>`<tr><td>${esc(item.name)}</td><td dir="ltr">${esc(item.slug)}</td><td><button class="ghost" data-edit-category="${item.id}">ویرایش</button><button class="ghost danger" data-delete-category="${item.id}">حذف</button></td></tr>`).join('')}</tbody></table></div>`;
    $('#new-category').onclick=()=>openCategory(null);
    view.querySelectorAll('[data-edit-category]').forEach(button=>button.onclick=()=>openCategory(state.categories.find(item=>item.id===button.dataset.editCategory)));
    view.querySelectorAll('[data-delete-category]').forEach(button=>button.onclick=async()=>{
      const item=state.categories.find(item=>item.id===button.dataset.deleteCategory);if(!window.confirm(`دسته «${item.name}» حذف شود؟`))return;
      try{await api(`/categories/${item.id}`,'DELETE',{expected_updated_at:item.updated_at});await load();toast('دسته حذف شد.');}catch(error){toast(error.message);}
    });
  }
  async function messages(view){
    const page=messagePage,status=messageStatus;
    view.innerHTML=heading('پیام‌های تماس','فقط مدیر به اطلاعات فرستندگان دسترسی دارد.')+`<form id="contact-settings" class="box"><label class="check-label"><input name="enabled" type="checkbox" ${state.site.contactEnabled?'checked':''}>فرم تماس سایت فعال باشد</label><p class="muted">با فعال‌سازی، فرم در صفحه تماس با ما نمایش داده می‌شود. پیام‌ها در همین صندوق ثبت می‌شوند.</p><button class="primary" type="submit">ذخیره وضعیت فرم</button></form><label>فیلتر وضعیت<select id="message-filter"><option value="">همه</option>${Object.entries(statusLabel).map(([key,label])=>`<option value="${key}" ${status===key?'selected':''}>${label}</option>`).join('')}</select></label><div id="messages-list">در حال دریافت…</div>`;
    $('#contact-settings').onsubmit=async event=>{event.preventDefault();try{await api('/settings','PUT',{...state.site,contactEnabled:event.target.elements.enabled.checked});await load();toast('وضعیت فرم ذخیره شد.');}catch(error){toast(error.message);}};
    $('#message-filter').onchange=event=>{messageStatus=event.target.value;messagePage=1;messages(view);};
    try{
      const result=await api(`/messages?page=${page}&status=${status}`);
      if(state.view!=='messages' || messagePage!==page || messageStatus!==status)return;
      $('#messages-list').innerHTML=`<p class="muted">${number(result.total)} پیام · صفحه ${number(page)}</p>`+result.messages.map(item=>`<details class="box message-card"><summary><strong>${esc(item.subject)}</strong> · ${esc(item.name)} · ${statusLabel[item.status]}</summary><p dir="ltr">${esc(item.email)}</p><small>${new Date(item.created_at).toLocaleString('fa-IR')}</small><p class="message-body">${esc(item.message)}</p><div class="row-actions">${Object.entries(statusLabel).filter(([key])=>key!==item.status).map(([key,label])=>`<button class="ghost" data-message="${item.id}" data-status="${key}">${label}</button>`).join('')}<button class="ghost danger" data-delete-message="${item.id}">حذف پیام</button></div></details>`).join('')+`<div class="form-actions"><button class="ghost" id="messages-prev" ${page===1?'disabled':''}>صفحه قبل</button><button class="ghost" id="messages-next" ${page*50>=result.total?'disabled':''}>صفحه بعد</button></div>`;
      $('#messages-prev').onclick=()=>{messagePage--;messages(view);};$('#messages-next').onclick=()=>{messagePage++;messages(view);};
      $('#messages-list').querySelectorAll('[data-message]').forEach(button=>button.onclick=async()=>{
        const item=result.messages.find(item=>item.id===button.dataset.message);button.disabled=true;
        try{await api(`/messages/${item.id}`,'PUT',{status:button.dataset.status,expected_updated_at:item.updated_at});await messages(view);}catch(error){toast(error.message);button.disabled=false;}
      });
      $('#messages-list').querySelectorAll('[data-delete-message]').forEach(button=>button.onclick=async()=>{
        const item=result.messages.find(item=>item.id===button.dataset.deleteMessage);if(!window.confirm('پیام برای همیشه حذف شود؟'))return;
        try{await api(`/messages/${item.id}`,'DELETE',{expected_updated_at:item.updated_at});await messages(view);}catch(error){toast(error.message);}
      });
    }catch(error){toast(error.message);}
  }
  async function redirects(view){
    view.innerHTML=heading('ریدایرکت‌ها','با تغییر آدرس محتوای منتشرشده، آدرس قبلی به مقصد جدید منتقل می‌شود.')+`<form id="redirect-form" class="box"><label>آدرس قدیمی<input name="path" dir="ltr" placeholder="/old-page/" required maxlength="260"></label><label>مقصد<select name="contentId" required><option value="">انتخاب محتوا</option>${state.content.map(item=>`<option value="${item.id}">${esc(item.title)}${item.status==='draft'?' (پیش‌نویس)':''}</option>`).join('')}</select></label><button class="primary" type="submit">افزودن ریدایرکت</button></form><div id="redirect-list">در حال دریافت…</div>`;
    $('#redirect-form').onsubmit=async event=>{event.preventDefault();try{await api('/redirects','POST',Object.fromEntries(new FormData(event.target)));await redirects(view);toast('ریدایرکت اضافه شد.');}catch(error){toast(error.message);}};
    try{
      const result=await api('/redirects');if(state.view!=='redirects')return;
      $('#redirect-list').innerHTML=`<div class="table-wrap"><table><thead><tr><th>آدرس قدیمی</th><th>مقصد</th><th>عملیات</th></tr></thead><tbody>${result.redirects.map(item=>`<tr><td dir="ltr">${esc(item.path)}</td><td>${esc(state.content.find(content=>content.id===item.content_id)?.title||state.categories.find(category=>category.id===item.category_id)?.name||'مقصد حذف‌شده')}</td><td><button class="ghost danger" data-redirect="${item.id}">حذف</button></td></tr>`).join('')}</tbody></table></div><p class="muted">اگر مقصد پیش‌نویس یا ماژول آن غیرفعال باشد، انتقال عمومی انجام نمی‌شود.</p>`;
      $('#redirect-list').querySelectorAll('[data-redirect]').forEach(button=>button.onclick=async()=>{
        const item=result.redirects.find(item=>item.id===button.dataset.redirect);if(!window.confirm('این ریدایرکت حذف شود؟'))return;
        try{await api(`/redirects/${item.id}`,'DELETE',{expected_updated_at:item.updated_at});await redirects(view);toast('ریدایرکت حذف شد.');}catch(error){toast(error.message);}
      });
    }catch(error){toast(error.message);}
  }
  function backup(view){
    view.innerHTML=heading('بکاپ و بازیابی','دیتابیس و تصاویر باید با هم نگهداری شوند.')+'<section class="box"><h2>نسخه پشتیبان کامل</h2><p>در این نسخه، بکاپ و بازیابی از ترمینال سرور انجام می‌شوند. ابتدا CMS را متوقف کنید؛ سپس دستور زیر را اجرا کنید:</p><pre dir="ltr"><code>npm run backup -- backups/site-YYYY-MM-DD</code></pre><p>صحت فایل‌ها و دیتابیس بررسی می‌شود. پوشه بکاپ شامل اطلاعات کاربران و پیام‌هاست؛ آن را در فضای خصوصی نگهداری کنید.</p><h2>بررسی بکاپ</h2><pre dir="ltr"><code>npm run backup -- --verify backups/site-YYYY-MM-DD</code></pre><h2>بازیابی در مسیر تازه</h2><pre dir="ltr"><code>CMS_DB_PATH=recovered/cms.sqlite npm run restore -- backups/site-YYYY-MM-DD</code></pre><p>اگر مسیر رسانه سفارشی دارید، CMS_MEDIA_DIR را نیز به پوشه تازه تغییر دهید. پس از بررسی سایت بازیابی‌شده، تنظیمات سرویس را به مسیر تازه منتقل کنید. نشست‌های قبلی باطل می‌شوند و ورود دوباره لازم است.</p></section>';
  }
  return {
    openCategories(item,kind){$('#post-categories').hidden=kind!=='posts';$('#category-options').innerHTML=state.categories.map(category=>`<label class="check-label"><input type="checkbox" data-category-id="${category.id}" ${item?.categoryIds?.includes(category.id)?'checked':''}>${esc(category.name)}</label>`).join('')||'<p class="muted">مدیر می‌تواند دسته‌ها را در بخش دسته‌های مقاله بسازد.</p>';},
    collectCategories(){return state.editorKind==='posts'?[...$('#category-options').querySelectorAll('[data-category-id]:checked')].map(input=>input.dataset.categoryId):[];},
    reset(){dialog.close();$('#category-form').reset();messagePage=1;messageStatus='';},
    render(view){
      if(state.user.role!=='admin')return false;
      if(state.view==='categories'){categories(view);return true;}
      if(state.view==='messages'){messages(view);return true;}
      if(state.view==='redirects'){redirects(view);return true;}
      if(state.view==='backup'){backup(view);return true;}
      return false;
    }
  };
}
