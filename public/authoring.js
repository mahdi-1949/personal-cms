export function createAuthoring({state,api,esc,toast,load,showLogin,heading,number}) {
  const $=selector=>document.querySelector(selector);
  const imageURL=image=>`/media/${image.id}.${image.mime==='image/png'?'png':'jpg'}`;
  const contentOptions=selected=>'<option value="">انتخاب صفحه</option>'+state.content.filter(item=>state.site.enabledModules.includes(item.kind)).map(item=>`<option value="${esc(item.id)}" ${selected===item.id?'selected':''}>${esc(item.title)}${item.status==='draft'?' (پیش‌نویس)':''}</option>`).join('');
  const mediaOptions=selected=>'<option value="">انتخاب تصویر</option>'+state.media.map(item=>`<option value="${esc(item.id)}" ${selected===item.id?'selected':''}>${esc(item.filename)}</option>`).join('');
  let blocks=[];let menu=[];
  function readBlocks(){
    blocks=[...$('#block-list').querySelectorAll('[data-block]')].map(row=>{
      const type=row.dataset.type;const val=name=>row.querySelector(`[data-field="${name}"]`).value;
      if(type==='heading')return {type,text:val('text'),level:Number(val('level'))};
      if(type==='paragraph')return {type,text:val('text')};
      if(type==='image')return {type,mediaId:val('mediaId'),alt:val('alt'),caption:val('caption')};
      return {type,label:val('label'),contentId:val('contentId')};
    });return blocks;
  }
  function renderBlocks(){
    $('#block-list').innerHTML=blocks.map((block,index)=>{
      const labels={heading:'عنوان',paragraph:'متن',image:'تصویر',cta:'دکمه'};
      let fields;
      if(block.type==='heading')fields=`<label>عنوان<input data-field="text" value="${esc(block.text)}" maxlength="200" required></label><label>سطح عنوان<select data-field="level"><option value="2" ${block.level===2?'selected':''}>عنوان اصلی بخش</option><option value="3" ${block.level===3?'selected':''}>زیرعنوان</option></select></label>`;
      if(block.type==='paragraph')fields=`<label>متن<textarea data-field="text" maxlength="10000" rows="4" required>${esc(block.text)}</textarea></label>`;
      if(block.type==='image')fields=`<label>تصویر<select data-field="mediaId" required>${mediaOptions(block.mediaId)}</select></label><label>متن جایگزین<input data-field="alt" value="${esc(block.alt)}" maxlength="500"></label><label>توضیح زیر تصویر<input data-field="caption" value="${esc(block.caption)}" maxlength="500"></label>`;
      if(block.type==='cta')fields=`<label>متن دکمه<input data-field="label" value="${esc(block.label)}" maxlength="100" required></label><label>صفحه مقصد<select data-field="contentId" required>${contentOptions(block.contentId)}</select></label>`;
      return `<section class="block-card" data-block="${index}" data-type="${esc(block.type)}"><div class="block-heading"><strong>${labels[block.type]} · ${number(index+1)}</strong><div><button type="button" class="ghost" data-move="${index}" data-direction="-1" aria-label="انتقال بلوک به بالا" ${index===0?'disabled':''}>↑</button><button type="button" class="ghost" data-move="${index}" data-direction="1" aria-label="انتقال بلوک به پایین" ${index===blocks.length-1?'disabled':''}>↓</button><button type="button" class="ghost danger" data-remove="${index}">حذف</button></div></div>${fields}</section>`;
    }).join('');
    $('#block-list').querySelectorAll('[data-remove]').forEach(button=>button.onclick=()=>{readBlocks();blocks.splice(Number(button.dataset.remove),1);renderBlocks();});
    $('#block-list').querySelectorAll('[data-move]').forEach(button=>button.onclick=()=>{readBlocks();const i=Number(button.dataset.move),j=i+Number(button.dataset.direction);[blocks[i],blocks[j]]=[blocks[j],blocks[i]];renderBlocks();});
    $('#plain-body').hidden=blocks.length>0;$('#blocks-help').textContent=blocks.length?'محتوای صفحه از بلوک‌های زیر ساخته می‌شود.':'متن صفحه را بنویسید یا بلوک اضافه کنید.';
  }
  $('#block-tools').querySelectorAll('[data-add-block]').forEach(button=>button.onclick=()=>{
    readBlocks();if(blocks.length>=40){toast('حداکثر ۴۰ بلوک مجاز است.');return;}
    const type=button.dataset.addBlock;
    blocks.push(type==='heading'?{type,text:'',level:2}:type==='paragraph'?{type,text:''}:type==='image'?{type,mediaId:'',alt:'',caption:''}:{type,label:'',contentId:''});renderBlocks();
  });

  const userDialog=document.createElement('dialog');userDialog.id='user-dialog';
  userDialog.innerHTML='<form id="user-form"><div class="dialog-heading"><h2 id="user-title">کاربر جدید</h2><button class="ghost" type="button" id="close-user">×</button></div><label>ایمیل<input name="email" type="email" dir="ltr" maxlength="254" required autocomplete="off"></label><label>نقش<select name="role"><option value="editor">نویسنده</option><option value="admin">مدیر</option></select></label><label>رمز عبور<input name="password" type="password" dir="ltr" autocomplete="new-password" minlength="12" maxlength="256"><small id="user-password-help"></small></label><label class="check-label"><input name="active" type="checkbox" checked>حساب فعال باشد</label><p>با ذخیره تغییرات حساب، نشست‌های قبلی آن کاربر بسته می‌شوند.</p><p id="user-error" role="alert"></p><button class="primary" type="submit">ذخیره کاربر</button></form>';
  document.body.append(userDialog);$('#close-user').onclick=()=>userDialog.close();let editingUser=null;
  function openUser(user){
    editingUser=user;const form=$('#user-form');form.reset();$('#user-error').textContent='';$('#user-title').textContent=user?'ویرایش کاربر':'کاربر جدید';
    form.elements.email.value=user?.email||'';form.elements.role.value=user?.role||'editor';form.elements.active.checked=user?.active??true;form.elements.password.required=!user;
    $('#user-password-help').textContent=user?'برای حفظ رمز فعلی، خالی بگذارید.':'حداقل ۱۲ کاراکتر.';userDialog.showModal();form.elements.email.focus();
  }
  $('#user-form').onsubmit=async event=>{
    event.preventDefault();const button=event.target.querySelector('[type=submit]');button.disabled=true;$('#user-error').textContent='';
    const form=event.target;const data={email:form.elements.email.value,role:form.elements.role.value,password:form.elements.password.value,active:form.elements.active.checked,...(editingUser?{expected_updated_at:editingUser.updated_at}:{})};
    try{await api(editingUser?`/users/${editingUser.id}`:'/users',editingUser?'PUT':'POST',data);userDialog.close();form.reset();await load();toast('کاربر ذخیره شد.');}catch(error){$('#user-error').textContent=error.message;}finally{button.disabled=false;}
  };
  async function users(view){
    view.innerHTML=heading('کاربران','مدیر به تمام بخش‌ها دسترسی دارد؛ نویسنده محتوا و تصاویر را مدیریت می‌کند.','<button id="new-user" class="primary">+ کاربر جدید</button>')+'<p class="muted">در حال دریافت کاربران…</p>';
    $('#new-user').onclick=()=>openUser(null);
    try{
      const result=await api('/users');if(state.view!=='users')return;
      view.innerHTML=heading('کاربران','با غیرفعال‌کردن حساب، محتوای آن حفظ می‌شود.','<button id="new-user" class="primary">+ کاربر جدید</button>')+`<div class="table-wrap"><table><thead><tr><th>ایمیل</th><th>نقش</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${result.users.map(user=>`<tr><td dir="ltr">${esc(user.email)}</td><td>${user.role==='admin'?'مدیر':'نویسنده'}</td><td><span class="badge ${user.active?'':'draft'}">${user.active?'فعال':'غیرفعال'}</span></td><td><button class="ghost" data-user="${esc(user.id)}">ویرایش</button></td></tr>`).join('')}</tbody></table></div>`;
      $('#new-user').onclick=()=>openUser(null);view.querySelectorAll('[data-user]').forEach(button=>button.onclick=()=>openUser(result.users.find(user=>user.id===button.dataset.user)));
    }catch(error){toast(error.message);}
  }
  function media(view){
    view.innerHTML=heading('تصاویر','PNG و JPEG، حداکثر ۵ مگابایت؛ تصویر استفاده‌شده در پیش‌نویس عمومی نمی‌شود.')+`<form id="upload-form" class="box"><label>انتخاب تصویر<input name="image" type="file" accept="image/png,image/jpeg" required></label><button class="primary" type="submit">بارگذاری تصویر</button></form><div class="media-grid">${state.media.map(image=>`<article class="media-card"><a href="${imageURL(image)}" target="_blank" rel="noopener"><img src="${imageURL(image)}" alt="${esc(image.alt)}" loading="lazy"></a><strong>${esc(image.filename)}</strong><small>${number(image.width)} × ${number(image.height)} · ${number(Math.round(image.size/1024))} کیلوبایت</small><label>متن جایگزین<input maxlength="500" value="${esc(image.alt)}" data-alt="${image.id}"></label><div class="row-actions"><button class="ghost" data-save-alt="${image.id}">ذخیره متن</button>${state.user.role==='admin'?`<button class="ghost danger" data-delete-image="${image.id}">حذف</button>`:''}</div></article>`).join('')}</div>`;
    $('#upload-form').onsubmit=async event=>{
      event.preventDefault();const file=event.target.elements.image.files[0],button=event.target.querySelector('button');
      if(!file || file.size>5*1024*1024){toast('حداکثر حجم تصویر ۵ مگابایت است.');return;}button.disabled=true;
      try{
        const response=await fetch('/api/media',{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type,'X-CSRF-Token':state.csrf,'X-Filename':encodeURIComponent(file.name)},body:file});const result=await response.json();
        if(!response.ok){if(response.status===401)showLogin();throw new Error(result.error);}await load();toast('تصویر بارگذاری شد.');
      }catch(error){toast(error.message);}finally{button.disabled=false;}
    };
    view.querySelectorAll('[data-save-alt]').forEach(button=>button.onclick=async()=>{
      const image=state.media.find(image=>image.id===button.dataset.saveAlt);
      try{await api(`/media/${image.id}`,'PUT',{alt:view.querySelector(`[data-alt="${image.id}"]`).value,expected_updated_at:image.updated_at});await load();toast('متن جایگزین ذخیره شد.');}catch(error){toast(error.message);}
    });
    view.querySelectorAll('[data-delete-image]').forEach(button=>button.onclick=async()=>{
      const image=state.media.find(image=>image.id===button.dataset.deleteImage);if(!window.confirm(`تصویر «${image.filename}» حذف شود؟`))return;
      try{await api(`/media/${image.id}`,'DELETE',{expected_updated_at:image.updated_at});await load();toast('تصویر حذف شد.');}catch(error){toast(error.message);}
    });
  }
  function readMenu(){menu=[...$('#menu-list').querySelectorAll('[data-menu]')].map(row=>({label:row.querySelector('[name=label]').value,contentId:row.querySelector('[name=contentId]').value}));}
  function menuRows(){
    $('#menu-list').innerHTML=menu.map((item,index)=>`<div class="menu-row" data-menu="${index}"><label>متن لینک<input name="label" value="${esc(item.label)}" maxlength="80" required></label><label>صفحه<select name="contentId" required>${contentOptions(item.contentId)}</select></label><div class="row-actions"><button type="button" class="ghost" data-menu-up="${index}" ${index===0?'disabled':''}>↑</button><button type="button" class="ghost danger" data-menu-remove="${index}">حذف</button></div></div>`).join('');
    $('#menu-list').querySelectorAll('[data-menu-remove]').forEach(button=>button.onclick=()=>{readMenu();menu.splice(Number(button.dataset.menuRemove),1);menuRows();});
    $('#menu-list').querySelectorAll('[data-menu-up]').forEach(button=>button.onclick=()=>{readMenu();const i=Number(button.dataset.menuUp);[menu[i],menu[i-1]]=[menu[i-1],menu[i]];menuRows();});
  }
  function navigation(view){
    menu=structuredClone(state.menu.items);view.innerHTML=heading('منوی سایت','صفحات پیش‌نویس یا ماژول‌های غیرفعال در منوی عمومی نشان داده نمی‌شوند.')+'<form id="menu-form" class="box"><div id="menu-list"></div><div class="form-actions"><button class="ghost" type="button" id="add-menu">+ لینک جدید</button><button class="primary" type="submit">ذخیره منو</button></div></form>';menuRows();
    $('#add-menu').onclick=()=>{readMenu();if(menu.length>=12){toast('حداکثر ۱۲ لینک مجاز است.');return;}menu.push({label:'',contentId:''});menuRows();};
    $('#menu-form').onsubmit=async event=>{event.preventDefault();readMenu();try{await api('/navigation','PUT',{items:menu,expected_updated_at:state.menu.updated_at});await load();toast('منو ذخیره شد.');}catch(error){toast(error.message);}};
  }
  async function account(view){
    view.innerHTML=heading('حساب من','تغییر رمز و کنترل نشست‌های فعال')+'<form id="password-form" class="box settings-box"><h2>تغییر رمز عبور</h2><label>رمز فعلی<input type="password" name="currentPassword" autocomplete="current-password" required maxlength="256"></label><label>رمز جدید<input type="password" name="newPassword" autocomplete="new-password" required minlength="12" maxlength="256"></label><label>تکرار رمز جدید<input type="password" name="repeatPassword" autocomplete="new-password" required minlength="12" maxlength="256"></label><label>کد دومرحله‌ای، در صورت فعال‌بودن<input name="mfaCode" dir="ltr" autocomplete="one-time-code" maxlength="64"></label><p class="muted">با تغییر رمز، همه نشست‌ها بسته می‌شوند و دوباره وارد خواهید شد.</p><button class="primary" type="submit">تغییر رمز</button></form><section class="box sessions-box"><h2>نشست‌های فعال</h2><div id="session-list">در حال دریافت…</div></section>';
    $('#password-form').onsubmit=async event=>{
      event.preventDefault();const data=Object.fromEntries(new FormData(event.target));if(data.newPassword!==data.repeatPassword){toast('تکرار رمز یکسان نیست.');return;}
      const button=event.target.querySelector('button');button.disabled=true;
      try{await api('/auth/password','PUT',data);event.target.reset();showLogin();toast('رمز تغییر کرد؛ دوباره وارد شوید.');}catch(error){toast(error.message);}finally{button.disabled=false;}
    };
    try{
      const result=await api('/auth/sessions');if(state.view!=='account')return;
      $('#session-list').innerHTML=result.sessions.map(session=>`<div class="session-row"><span>${session.current?'نشست فعلی':'نشست دیگر'} · ${new Date(session.created_at).toLocaleString('fa-IR')}</span><button class="ghost danger" data-session="${esc(session.id)}">بستن نشست</button></div>`).join('');
      $('#session-list').querySelectorAll('[data-session]').forEach(button=>button.onclick=async()=>{
        const session=result.sessions.find(session=>session.id===button.dataset.session);
        try{await api(`/auth/sessions/${session.id}`,'DELETE',{});if(session.current)showLogin();else await account(view);toast('نشست بسته شد.');}catch(error){toast(error.message);}
      });
    }catch(error){toast(error.message);}
  }
  return {
    openBlocks(item){blocks=structuredClone(item?.blocks||[]);renderBlocks();},
    collectBlocks:readBlocks,
    reset(){userDialog.close();$('#user-form').reset();},
    render(view){
      if(state.view==='users'){users(view);return true;}
      if(state.view==='media'){media(view);return true;}
      if(state.view==='navigation'){navigation(view);return true;}
      if(state.view==='account'){account(view);return true;}
      return false;
    }
  };
}
