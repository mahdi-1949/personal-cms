import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HttpError } from './content.mjs';
import { assetLimit } from './asset-types.mjs';
let running=0;
export async function processDesignAsset(buffer,mime) {
  if(!['model/gltf-binary','font/woff'].includes(mime))throw new HttpError(422,'فقط GLB یا فونت WOFF مجاز است.');
  if(!Buffer.isBuffer(buffer) || !buffer.length || buffer.length>assetLimit(mime))throw new HttpError(413,'حجم فایل بیش از حد مجاز است: GLB تا ۲۰ و WOFF تا ۲ مگابایت.');
  if(running>=2)throw new HttpError(503,'پردازش دارایی‌ها مشغول است؛ کمی بعد تلاش کنید.');
  running++;
  try {await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--max-old-space-size=128',fileURLToPath(new URL('./asset-worker.mjs',import.meta.url)),mime],{stdio:['pipe','ignore','ignore'],env:{PATH:process.env.PATH||'',LANG:'C',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{})}});
    const timer=setTimeout(()=>child.kill('SIGKILL'),10000);timer.unref();child.stdin.on('error',()=>{});
    child.once('error',()=>{clearTimeout(timer);reject(new HttpError(503,'پردازش فایل در دسترس نیست.'));});
    child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new HttpError(422,mime==='font/woff'?'فونت WOFF خراب یا بیش از محدودیت پردازش است.':'GLB معتبر و دارای منابع داخلی انتخاب کنید؛ مدل فشرده یا بسیار پیچیده پشتیبانی نمی‌شود.'));});
    child.stdin.end(buffer);
  });return {buffer,width:0,height:0};}finally{running--;}
}
