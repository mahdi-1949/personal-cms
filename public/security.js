export function createSecurity({state,api,esc,toast,showLogin,heading,number}) {
  const $=selector=>document.querySelector(selector);
  const forgot=document.createElement('dialog');forgot.id='forgot-dialog';
  forgot.innerHTML='<form id="forgot-form"><div class="dialog-heading"><h2>بازیابی رمز عبور</h2><button class="ghost" type="button" id="close-forgot">×</button></div><label>ایمیل حساب<input name="email" type="email" dir="ltr" autocomplete="email" required maxlength="254"></label><p id="forgot-feedback" role="status" aria-live="polite"></p><button class="primary" type="submit">ارسال لینک بازیابی</button></form>';
  document.body.append(forgot);$('#close-forgot').onclick=()=>forgot.close();
  $('#forgot-password').onclick=()=>{forgot.querySelector('form').reset();$('#forgot-feedback').textContent='';forgot.showModal();forgot.querySelector('input').focus();};
  $('#forgot-form').onsubmit=async event=>{
    event.preventDefault();const button=event.target.querySelector('[type=submit]');button.disabled=true;
    try{const result=await api('/auth/forgot-password','POST',Object.fromEntries(new FormData(event.target)));$('#forgot-feedback').textContent=result.message;}
    catch(error){$('#forgot-feedback').textContent=error.message;}finally{button.disabled=false;}
  };
  const codesDialog=document.createElement('dialog');codesDialog.id='recovery-dialog';
  codesDialog.innerHTML='<h2>کدهای بازیابی ورود دومرحله‌ای</h2><p>هر کد فقط یک بار قابل استفاده است. این کدها دوباره نمایش داده نمی‌شوند؛ در جای امن نگه دارید.</p><textarea id="recovery-codes" readonly rows="10" dir="ltr" aria-label="کدهای بازیابی"></textarea><button id="save-codes" class="primary" type="button">کدها را ذخیره کردم؛ ورود دوباره</button>';
  document.body.append(codesDialog);codesDialog.addEventListener('close',()=>{$('#recovery-codes').value='';});$('#save-codes').onclick=()=>{codesDialog.close();$('#recovery-codes').value='';};
  function showCodes(codes){showLogin();$('#recovery-codes').value=codes.join('\n');codesDialog.showModal();}
  let resetToken='';
  async function init(){
    const params=new URLSearchParams(location.hash.slice(1));resetToken=params.get('token')||'';
    if(location.pathname.startsWith('/admin/reset-password')){
      history.replaceState(null,'','/admin/reset-password/');
      $('#login-form').hidden=true;$('#reset-form').hidden=false;$('#forgot-password').hidden=true;
      if(!/^[a-f0-9]{64}$/.test(resetToken)){$('#reset-feedback').textContent='لینک بازیابی معتبر نیست؛ یک لینک تازه درخواست کنید.';$('#reset-form').querySelector('[type=submit]').disabled=true;}
      return;
    }
    try{$('#forgot-password').hidden=!(await api('/auth/options')).passwordRecovery;}catch{}
  }
  $('#reset-form').onsubmit=async event=>{
    event.preventDefault();const data=Object.fromEntries(new FormData(event.target)),button=event.target.querySelector('[type=submit]');
    if(data.newPassword!==data.repeatPassword){$('#reset-feedback').textContent='تکرار رمز یکسان نیست.';return;}button.disabled=true;
    try{await api('/auth/reset-password','POST',{token:resetToken,newPassword:data.newPassword,mfaCode:data.mfaCode});resetToken='';event.target.reset();location.assign('/admin/');}
    catch(error){$('#reset-feedback').textContent=error.message;button.disabled=false;}
  };
  async function security(view){
    view.innerHTML=heading('امنیت حساب','ورود دومرحله‌ای و کدهای بازیابی')+'<div id="mfa-settings" class="box">در حال دریافت…</div>';
    try{
      const status=await api('/auth/mfa');if(state.view!=='security')return;
      if(!status.configured){$('#mfa-settings').textContent='ورود دومرحله‌ای هنوز در این سایت آماده نیست؛ با مدیر سایت تماس بگیرید.';return;}
      if(!status.enabled){
        $('#mfa-settings').innerHTML=`${state.user.mfaRequired?'<p>برای مدیریت سایت باید ورود دومرحله‌ای را فعال کنید.</p>':''}<p>حساب را در برنامه Authenticator اضافه کنید؛ سپس کد شش‌رقمی آن را تأیید کنید.</p><form id="mfa-start"><label>رمز فعلی<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button class="primary" type="submit">شروع فعال‌سازی</button></form><div id="mfa-enrollment" hidden><label>کلید ورود دستی در برنامه<input id="mfa-secret" dir="ltr" readonly></label><p class="muted">این کلید خصوصی است؛ آن را برای دیگران نفرستید.</p><form id="mfa-confirm"><label>کد شش‌رقمی برنامه<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required dir="ltr"></label><button class="primary" type="submit">تأیید و فعال‌سازی</button></form></div>`;
        $('#mfa-start').onsubmit=async event=>{
          event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
          try{const result=await api('/auth/mfa/setup','POST',Object.fromEntries(new FormData(event.target)));event.target.reset();$('#mfa-secret').value=result.secret;$('#mfa-enrollment').hidden=false;}
          catch(error){toast(error.message);}finally{button.disabled=false;}
        };
        $('#mfa-confirm').onsubmit=async event=>{
          event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
          try{const result=await api('/auth/mfa/confirm','POST',Object.fromEntries(new FormData(event.target)));showCodes(result.recoveryCodes);toast('ورود دومرحله‌ای فعال شد. برای کد بعدی برنامه، تا دوره تازه صبر کنید.');}
          catch(error){toast(error.message);}finally{button.disabled=false;}
        };
      }else{
        $('#mfa-settings').innerHTML=`<p><span class="badge">ورود دومرحله‌ای فعال است</span> · ${number(status.recoveryRemaining)} کد بازیابی باقی مانده</p><form id="mfa-change"><label>رمز فعلی<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><label>کد برنامه یا کد بازیابی<input name="code" autocomplete="one-time-code" dir="ltr" required maxlength="64"></label><label>عملیات<select name="action"><option value="recovery-codes">ساخت کدهای بازیابی تازه</option><option value="disable">غیرفعال‌کردن ورود دومرحله‌ای</option></select></label><p class="muted">نشست‌های قبلی بسته می‌شوند. کدهای بازیابی قبلی با ساخت کد تازه باطل خواهند شد.</p><button class="primary" type="submit">تأیید تغییر</button></form>`;
        $('#mfa-change').onsubmit=async event=>{
          event.preventDefault();const data=Object.fromEntries(new FormData(event.target)),button=event.target.querySelector('button');button.disabled=true;
          try{const result=await api(`/auth/mfa/${data.action}`,'POST',data);if(result.recoveryCodes.length)showCodes(result.recoveryCodes);else{showLogin();toast('ورود دومرحله‌ای غیرفعال شد.');}}
          catch(error){toast(error.message);}finally{button.disabled=false;}
        };
      }
    }catch(error){toast(error.message);}
  }
  function eventLabel(event){
    const labels={'auth.login':'ورود موفق','auth.login_failed':'ورود ناموفق','auth.logout':'خروج از حساب','auth.session_revoked':'بستن نشست','auth.mfa_setup_started':'شروع فعال‌سازی ورود دومرحله‌ای','auth.mfa_enabled':'فعال‌شدن ورود دومرحله‌ای','auth.mfa_disabled':'غیرفعال‌شدن ورود دومرحله‌ای','auth.recovery_codes_replaced':'تعویض کدهای بازیابی','auth.password_changed':'تغییر رمز','auth.password_hash_upgraded':'ارتقای حفاظت رمز','auth.password_reset_requested':'درخواست بازیابی رمز','auth.password_reset_completed':'بازیابی رمز','mail.sent':'ارسال ایمیل','mail.retry':'تلاش دوباره ارسال ایمیل','mail.failed':'شکست ارسال ایمیل'};
    const [group,action]=event.split('.'),groups={content:'محتوا',user:'کاربر',media:'تصویر',navigation:'منو',settings:'تنظیمات',category:'دسته',redirect:'انتقال آدرس',message:'پیام'},actions={created:'ایجاد',updated:'ویرایش',deleted:'حذف'};
    return labels[event]||(groups[group]&&actions[action]?`${actions[action]} ${groups[group]}`:'رخداد سامانه');
  }
  async function audit(view,page=1){
    view.innerHTML=heading('گزارش رخدادها','آخرین فعالیت‌های حساب‌ها و مدیریت سایت')+'<div id="audit-list">در حال دریافت…</div>';
    try{
      const result=await api(`/audit?page=${page}`);if(state.view!=='audit')return;
      $('#audit-list').innerHTML=`<div class="table-wrap"><table><thead><tr><th>زمان</th><th>رخداد</th><th>کاربر</th></tr></thead><tbody>${result.events.map(item=>`<tr><td>${new Date(item.created_at).toLocaleString('fa-IR')}</td><td>${esc(eventLabel(item.event))}</td><td>${esc(item.actor_email||'سامانه')}</td></tr>`).join('')}</tbody></table></div><p>${number(result.total)} رخداد · صفحه ${number(page)}</p><div class="form-actions"><button id="audit-prev" class="ghost" ${page===1?'disabled':''}>صفحه قبل</button><button id="audit-next" class="ghost" ${page*50>=result.total?'disabled':''}>صفحه بعد</button></div>`;
      $('#audit-prev').onclick=()=>audit(view,page-1);$('#audit-next').onclick=()=>audit(view,page+1);
    }catch(error){toast(error.message);}
  }
  return {init,reset(){forgot.close();$('#forgot-form').reset();codesDialog.close();$('#recovery-codes').value='';$('#mfa-secret')?.remove();},render(view){if(state.view==='security'){security(view);return true;}if(state.view==='audit' && state.user.role==='admin'){audit(view);return true;}return false;}};
}
