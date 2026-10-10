export function createTemplates({state,api,esc,toast,load,heading}) {
  const $=selector=>document.querySelector(selector);
  const dialog=document.createElement('dialog');dialog.className='page-preview-dialog';dialog.innerHTML='<div class="dialog-heading"><h2>پیش‌نمایش صفحه ذخیره‌شده</h2><button type="button" class="ghost" data-close-page-preview aria-label="بستن پیش‌نمایش">×</button></div><div class="form-actions"><button type="button" class="ghost" data-page-device="desktop">دسکتاپ</button><button type="button" class="ghost" data-page-device="tablet">تبلت</button><button type="button" class="ghost" data-page-device="mobile">موبایل</button></div><div data-page-preview-wrap class="device-desktop"><iframe title="پیش‌نمایش خصوصی صفحه" width="100%" height="650" class="designer-frame"></iframe></div>';document.body.append(dialog);
  dialog.querySelector('[data-close-page-preview]').onclick=()=>{dialog.querySelector('iframe').removeAttribute('src');dialog.close();};
  dialog.querySelectorAll('[data-page-device]').forEach(b=>b.onclick=()=>dialog.querySelector('[data-page-preview-wrap]').className=`device-${b.dataset.pageDevice}`);
  const responsive=document.createElement('button');responsive.id='responsive-preview';responsive.type='button';responsive.className='ghost';responsive.textContent='پیش‌نمایش موبایل / دسکتاپ';$('#preview-content').after(responsive);
  responsive.onclick=()=>{dialog.querySelector('iframe').src=$('#preview-content').href;dialog.showModal();};
  function openPage(item,kind) {
    const select=$('#editor-form').elements.template;
    select.innerHTML=state.templates.pageTemplates.filter(template=>template.kinds.includes(kind)).map(template=>`<option value="${template.key}">${esc(template.label)}</option>`).join('');
    select.value=item?.template||state.templates.defaults[kind];
    const preview=$('#preview-content');preview.hidden=!item;responsive.hidden=!item;
    if(item)preview.href=`/api/content/${item.id}/preview`;
  }
  function render(view) {
    if(state.view!=='templates')return false;
    const theme=state.site.theme;
    view.innerHTML=heading('قالب و ظاهر سایت','طرح پایه سایت و رنگ برند؛ تغییر قالب محتوای صفحات را پاک نمی‌کند.')+`<form id="theme-form" class="box"><div class="theme-options">${state.templates.siteTemplates.map(template=>`<label class="theme-option"><input type="radio" name="template" value="${template.key}" ${theme.template===template.key?'checked':''} required><strong>${esc(template.label)}</strong><div class="theme-sample sample-${template.key}" aria-hidden="true"><div>نام برند · منوی سایت</div><h3>معرفی کسب‌وکار</h3><span>خدمات</span><span>مقالات</span></div><p>${esc(template.description)}</p></label>`).join('')}</div><div class="form-row"><label>رنگ اصلی برند<input name="primaryColor" type="color" value="${esc(theme.primaryColor)}"></label><label>گوشه عناصر<select name="corners"><option value="rounded" ${theme.corners==='rounded'?'selected':''}>گرد</option><option value="square" ${theme.corners==='square'?'selected':''}>کم‌انحنا</option></select></label></div><div class="form-row">${[['font','خانواده قلم',[['system','قلم سیستم'],['tahoma','Tahoma / Arial'],['serif','Serif']]],['density','فاصله بخش‌ها',[['compact','فشرده'],['normal','معمولی'],['airy','باز']]],['typeScale','اندازه متن',[['normal','معمولی'],['large','درشت']]],['header','طرح سربرگ',[['inline','برند و منو کنار هم'],['centered','برند و منو وسط‌چین']]]].map(([key,label,values])=>`<label>${label}<select name="${key}">${values.map(([value,text])=>`<option value="${value}" ${theme[key]===value?'selected':''}>${text}</option>`).join('')}</select></label>`).join('')}</div><p class="muted">طرح هر صفحه در ویرایش محتوا انتخاب می‌شود. بخش‌های معرفی، کارت‌ها و پرسش‌ها نیز طرح و ترتیب جداگانه دارند.</p><div class="form-actions"><button class="primary" type="submit">ذخیره ظاهر سایت</button><a class="ghost" href="/" target="_blank" rel="noopener">مشاهده سایت ↗</a></div><p id="theme-feedback" role="alert"></p></form>`;
    $('#theme-form').onsubmit=async event=>{
      event.preventDefault();const button=event.target.querySelector('[type=submit]');button.disabled=true;
      try{await api('/settings','PUT',{...state.site,theme:Object.fromEntries(new FormData(event.target))});await load();toast('ظاهر سایت ذخیره شد.');}
      catch(error){$('#theme-feedback').textContent=error.message;}finally{button.disabled=false;}
    };
    return true;
  }
  return {openPage,render};
}
