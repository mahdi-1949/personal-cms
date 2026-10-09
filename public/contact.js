const form=document.querySelector('#contact-form');
const feedback=document.querySelector('#contact-feedback');
const button=form.querySelector('[type=submit]');
const retry=document.querySelector('#contact-retry');
let token='',readyAt=0,timer;
async function prepare(){
  clearTimeout(timer);button.disabled=true;retry.hidden=true;token='';feedback.textContent='در حال آماده‌سازی فرم…';
  try{
    const response=await fetch('/api/public/contact-token',{credentials:'omit'});const data=await response.json();
    if(!response.ok)throw new Error(data.error||'ارتباط برقرار نشد.');
    token=data.token;readyAt=Date.now()+data.waitMs;
    timer=setTimeout(()=>{button.disabled=false;feedback.textContent='فرم آماده ارسال است.';},data.waitMs+100);
  }catch(error){feedback.textContent=error.message;retry.hidden=false;}
}
retry.onclick=prepare;
form.onsubmit=async event=>{
  event.preventDefault();if(!token || Date.now()<readyAt)return;button.disabled=true;clearTimeout(timer);
  feedback.textContent='در حال ارسال…';
  try{
    const response=await fetch('/api/public/contact',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({...Object.fromEntries(new FormData(form)),token})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'ارسال انجام نشد.');
    form.reset();feedback.textContent='پیام شما ثبت شد.';
  }catch(error){feedback.textContent=error.message;}
  token='';retry.hidden=false;retry.textContent='آماده‌سازی فرم برای ارسال';
};
prepare();
