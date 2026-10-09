import { createAuthoring } from './authoring.js';
import { createOperations } from './operations.js';
const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={csrf:'',user:null,site:null,modules:[],content:[],media:[],categories:[],menu:null,view:'dashboard',editing:null};
const number=value=>new Intl.NumberFormat('fa-IR').format(value);
let toastTimer;
function toast(message){$('#notice').textContent=message;$('#notice').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#notice').hidden=true,4500);}
async function api(path,method='GET',body){
  const response=await fetch(`/api${path}`,{method,credentials:'same-origin',headers:{'Content-Type':'application/json',...(state.csrf?{'X-CSRF-Token':state.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(!response.ok){if(response.status===401 && path!=='/auth/login')showLogin();throw new Error(data.error||'خطای ارتباط با سرور');}return data;
}
function showLogin(){state.csrf='';state.user=null;state.view='dashboard';$('#workspace').hidden=true;$('#login-screen').hidden=false;$('#editor-dialog').close();authoring.reset();operations.reset();}
async function load(){
  const me=await api('/auth/me');state.user=me.user;state.csrf=me.csrf;
  const [settings,registry,content,media,menu,categories]=await Promise.all([api('/settings'),api('/modules'),api('/content'),api('/media'),api('/navigation'),api('/categories')]);
  state.site=settings;state.modules=registry.modules;state.content=content.content;state.media=media.media;state.menu=menu;state.categories=categories.categories;
  $('#login-screen').hidden=true;$('#workspace').hidden=false;$('#account').textContent=state.user.email;$('#site-name').textContent=state.site.name;
  renderNavigation();render();
}
function renderNavigation(){
  const items=[{key:'dashboard',label:'نمای کلی'},...state.modules.filter(m=>state.site.enabledModules.includes(m.key)),{key:'media',label:'تصاویر'},...(state.user.role==='admin'?[{key:'categories',label:'دسته‌های مقاله'},{key:'messages',label:'پیام‌های تماس'},{key:'redirects',label:'ریدایرکت‌ها'},{key:'backup',label:'بکاپ و بازیابی'},{key:'navigation',label:'منوی سایت'},{key:'users',label:'کاربران'},{key:'modules',label:'ماژول‌ها'},{key:'settings',label:'تنظیمات سایت'}]:[]),{key:'account',label:'حساب من'}];
  $('#navigation').innerHTML=items.map(item=>`<button data-view="${esc(item.key)}" class="${item.key===state.view?'active':''}">${esc(item.label)}</button>`).join('');
  $('#navigation').querySelectorAll('button').forEach(button=>button.onclick=()=>{state.view=button.dataset.view;renderNavigation();render();});
}
function heading(title,subtitle,action=''){return `<div class="page-heading"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${action}</div>`;}
function rows(items){return items.map(item=>`<tr><td><strong>${esc(item.title)}</strong><span class="slug">${esc(item.slug)}</span></td><td>${esc(state.modules.find(m=>m.key===item.kind)?.singular)}</td><td><span class="badge ${item.status==='draft'?'draft':''}">${item.status==='draft'?'پیش‌نویس':'منتشرشده'}</span></td><td>${new Date(item.updated_at).toLocaleDateString('fa-IR')}</td><td><div class="row-actions"><button class="ghost" data-edit="${esc(item.id)}">ویرایش</button>${state.user.role==='admin'?`<button class="ghost danger" data-delete="${esc(item.id)}">حذف</button>`:''}</div></td></tr>`).join('');}
function table(items){return items.length?`<div class="table-wrap"><table><thead><tr><th>عنوان / آدرس</th><th>نوع</th><th>وضعیت</th><th>آخرین تغییر</th><th>عملیات</th></tr></thead><tbody>${rows(items)}</tbody></table></div>`:'<div class="box empty"><h2>از اولین محتوا شروع کنید</h2><p>محتوا پس از انتشار در سایت نمایش داده می‌شود.</p></div>';}
function bindRows(){
  $('#view').querySelectorAll('[data-edit]').forEach(button=>button.onclick=()=>openEditor(state.content.find(item=>item.id===button.dataset.edit)));
  $('#view').querySelectorAll('[data-delete]').forEach(button=>button.onclick=async()=>{
    const item=state.content.find(item=>item.id===button.dataset.delete);
    if(!window.confirm(`«${item.title}» حذف شود؟`))return;
    try{await api(`/content/${item.id}`,'DELETE',{expected_updated_at:item.updated_at});await load();toast('محتوا حذف شد.');}catch(error){toast(error.message);}
  });
}
function render(){
  const view=$('#view');const enabled=state.content.filter(item=>state.site.enabledModules.includes(item.kind));
  if(operations.render(view) || authoring.render(view))return;
  if(state.view==='dashboard'){
    view.innerHTML=heading('نمای کلی','وضعیت محتوا و فعالیت‌های سایت')+`<div class="welcome"><p class="eyebrow">یک هسته؛ امکان‌های تازه</p><h2>سایت شما از همین‌جا رشد می‌کند.</h2><p>صفحات را بسازید، خدمات را معرفی کنید و محتوای تازه منتشر کنید. ماژول‌های هر پروژه با نیاز همان کسب‌وکار فعال می‌شوند.</p><a href="/" target="_blank" rel="noopener">مشاهده خروجی سایت ↗</a></div><div class="stats"><div class="stat"><span>کل محتوا</span><strong>${number(enabled.length)}</strong></div><div class="stat"><span>منتشرشده</span><strong>${number(enabled.filter(i=>i.status==='published').length)}</strong></div><div class="stat"><span>پیش‌نویس‌ها</span><strong>${number(enabled.filter(i=>i.status==='draft').length)}</strong></div><div class="stat"><span>ماژول‌های فعال</span><strong>${number(state.site.enabledModules.length)}</strong></div></div><h2>آخرین محتواها</h2>`+table(enabled.slice(0,6));bindRows();return;
  }
  if(state.view==='settings'){
    view.innerHTML=heading('تنظیمات سایت','مشخصات اصلی سایت')+`<form id="settings-form" class="box settings-box"><label>نام سایت<input name="name" required maxlength="100" value="${esc(state.site.name)}"></label><label>توضیح کوتاه<textarea name="description" maxlength="500">${esc(state.site.description)}</textarea></label><button class="primary">ذخیره تنظیمات</button></form>`;
    $('#settings-form').onsubmit=async event=>{event.preventDefault();try{await api('/settings','PUT',{...state.site,...Object.fromEntries(new FormData(event.target))});await load();toast('تنظیمات ذخیره شد.');}catch(error){toast(error.message);}};return;
  }
  if(state.view==='modules'){
    view.innerHTML=heading('ماژول‌های سایت','غیرفعال‌کردن ماژول، محتوای آن را حذف نمی‌کند.')+`<form id="modules-form"><div class="module-grid">${state.modules.map(module=>`<div class="module-card"><h2>${esc(module.label)}</h2><p class="muted">${module.required?'بخش ثابت هسته':'قابل استفاده برای پروژه‌های مرتبط'}</p><label><input name="module" type="checkbox" value="${esc(module.key)}" ${state.site.enabledModules.includes(module.key)?'checked':''} ${module.required?'disabled':''}>فعال در این سایت</label></div>`).join('')}</div><div class="form-actions"><button class="primary">ذخیره ماژول‌ها</button></div></form>`;
    $('#modules-form').onsubmit=async event=>{event.preventDefault();try{await api('/settings','PUT',{...state.site,enabledModules:['pages',...new FormData(event.target).getAll('module')]});await load();toast('ماژول‌ها به‌روزرسانی شدند.');}catch(error){toast(error.message);}};return;
  }
  const module=state.modules.find(module=>module.key===state.view);
  if(!module || !state.site.enabledModules.includes(module.key)){state.view='dashboard';renderNavigation();return render();}
  const items=state.content.filter(item=>item.kind===state.view);
  view.innerHTML=heading(module.label,`${number(items.length)} محتوا در این بخش`,`<button class="primary" id="new-content">+ ${esc(module.singular)} جدید</button>`)+`<input class="search" id="search" placeholder="جست‌وجو در عنوان…" aria-label="جست‌وجو در عنوان"><div id="content-list">${table(items)}</div>`;
  $('#new-content').onclick=()=>openEditor(null);bindRows();
  $('#search').oninput=event=>{$('#content-list').innerHTML=table(items.filter(item=>item.title.toLocaleLowerCase().includes(event.target.value.toLocaleLowerCase())));bindRows();};
}
function openEditor(item){
  state.editing=item;const kind=item?.kind||state.view;state.editorKind=kind;
  if(!state.site.enabledModules.includes(kind)){toast('این ماژول غیرفعال است.');return;}
  const form=$('#editor-form');form.reset();$('#editor-error').textContent='';
  $('#editor-heading').textContent=item?'ویرایش محتوا':`${state.modules.find(m=>m.key===kind).singular} جدید`;
  if(item)for(const key of ['title','slug','status','excerpt','body','seo_title','seo_description'])form.elements[key].value=item[key];
  authoring.openBlocks(item);operations.openCategories(item,kind);
  $('#editor-dialog').showModal();form.elements.title.focus();
}
$('#login-form').onsubmit=async event=>{
  event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;$('#login-error').textContent='';
  try{const result=await api('/auth/login','POST',Object.fromEntries(new FormData(event.target)));state.csrf=result.csrf;event.target.reset();await load();}catch(error){$('#login-error').textContent=error.message;}finally{button.disabled=false;}
};
$('#editor-form').onsubmit=async event=>{
  event.preventDefault();const button=event.target.querySelector('button[type=submit]');button.disabled=true;$('#editor-error').textContent='';
  const item={...Object.fromEntries(new FormData(event.target)),kind:state.editorKind,blocks:authoring.collectBlocks(),categoryIds:operations.collectCategories(),...(state.editing?{expected_updated_at:state.editing.updated_at}:{})};
  try{await api(state.editing?`/content/${state.editing.id}`:'/content',state.editing?'PUT':'POST',item);$('#editor-dialog').close();await load();toast('محتوا ذخیره شد.');}catch(error){$('#editor-error').textContent=error.message;}finally{button.disabled=false;}
};
for(const id of ['#close-editor','#cancel-editor'])$(id).onclick=()=>$('#editor-dialog').close();
$('#logout').onclick=async()=>{try{await api('/auth/logout','POST',{});showLogin();}catch(error){toast(error.message);}};
const authoring=createAuthoring({state,api,esc,toast,load,showLogin,heading,number});
const operations=createOperations({state,api,esc,toast,load,heading,number});
load().catch(error=>{showLogin();if(!error.message.includes('وارد شوید'))toast(error.message);});
