import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HttpError } from './content.mjs';
let running=0;
export async function processImage(buffer,mime) {
  if(!Buffer.isBuffer(buffer) || !buffer.length || buffer.length>5*1024*1024)throw new HttpError(413,'حداکثر حجم تصویر ۵ مگابایت است.');
  if(!['image/png','image/jpeg'].includes(mime))throw new HttpError(422,'فقط تصویر PNG یا JPEG معتبر مجاز است.');
  if(running>=2)throw new HttpError(503,'پردازش تصاویر مشغول است؛ کمی بعد دوباره امتحان کنید.');
  running++;
  try{return await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--max-old-space-size=128',fileURLToPath(new URL('./image-worker.mjs',import.meta.url)),mime],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH||'',LANG:'C',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{})}});
    const chunks=[];let size=0,timedOut=false,overflow=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},10000);timer.unref();
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>5*1024*1024+8){overflow=true;child.kill('SIGKILL');}else chunks.push(chunk);});
    child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(new HttpError(503,'سرویس پردازش تصویر در دسترس نیست.'));});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0 || timedOut || overflow || size<9){reject(new HttpError(422,'تصویر خراب، نامعتبر یا بیش از محدودیت پردازش است.'));return;}
      const output=Buffer.concat(chunks),width=output.readUInt32BE(0),height=output.readUInt32BE(4);
      if(!width || !height || width*height>16000000){reject(new HttpError(422,'ابعاد تصویر معتبر نیست.'));return;}
      resolve({buffer:output.subarray(8),width,height});
    });
    child.stdin.end(buffer);
  });}finally{running--;}
}
