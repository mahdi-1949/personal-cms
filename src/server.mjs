import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDatabase,getSite,saveSite } from './database.mjs';
import { getSession,createSession,verifyPassword,hashPassword,cookie,digest,rateLimited } from './auth.mjs';
import { HttpError,putContent,publishedContent } from './content.mjs';
import { modules,moduleByKey,contentPath } from './modules/registry.mjs';
import { renderHome,renderContent,renderNotFound,sitemap,siteURL } from './render.mjs';
const publicDir=fileURLToPath(new URL('../public/',import.meta.url));

function respond(res,status,body,type='application/json; charset=utf-8',extra={}) {
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store',...extra});
  res.end(type.startsWith('application/json')?JSON.stringify(body):body);
}
async function readBody(req) {
  if (!String(req.headers['content-type']||'').startsWith('application/json')) throw new HttpError(415,'درخواست باید JSON باشد.');
  let size=0;const chunks=[];
  for await(const chunk of req) { size+=chunk.length; if(size>512*1024) throw new HttpError(413,'حجم درخواست بیش از حد مجاز است.'); chunks.push(chunk); }
  try { const body=JSON.parse(Buffer.concat(chunks).toString()); if (!body || typeof body!=='object' || Array.isArray(body)) throw new Error(); return body; }
  catch { throw new HttpError(400,'JSON معتبر نیست.'); }
}
function requireSession(db,req) {
  const session=getSession(db,req);
  if(!session) throw new HttpError(401,'برای ادامه وارد شوید.');
  if(!['admin','editor'].includes(session.role)) throw new HttpError(403,'دسترسی کافی ندارید.');
  return session;
}
export async function createApp({dbPath=':memory:',origin='http://localhost:3000',publicURL=origin,secureCookies=false}={}) {
  origin=new URL(origin).origin;
  const baseURL=siteURL(publicURL);
  const db=openDatabase(dbPath);
  const dummyHash=await hashPassword(randomBytes(24).toString('hex'));
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(secureCookies) res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const url=new URL(req.url,origin);const path=url.pathname;const method=req.method;
      if(!['GET','HEAD','POST','PUT','DELETE'].includes(method)) throw new HttpError(405,'این روش پشتیبانی نمی‌شود.');
      if(['POST','PUT','DELETE'].includes(method) && req.headers.origin!==origin) throw new HttpError(403,'مبدأ درخواست معتبر نیست.');
      if(method==='HEAD') { respond(res,405,{error:'HEAD is not supported'});return; }
      if(path==='/api/health' && method==='GET') return respond(res,200,{ok:true,version:'0.1.0'});
      if(path==='/api/auth/login' && method==='POST') {
        const data=await readBody(req);
        if(typeof data.email!=='string' || data.email.length>254 || typeof data.password!=='string' || data.password.length>256) throw new HttpError(422,'ایمیل و رمز معتبر وارد کنید.');
        const email=data.email.trim().toLowerCase();
        // Forwarded headers are deliberately not trusted. Proxy configuration is a production task.
        const ipKey=digest(`ip:${req.socket.remoteAddress}`);const userKey=digest(`email:${email}`);
        const ipLimited=rateLimited(db,ipKey);const userLimited=rateLimited(db,userKey);
        if(ipLimited || userLimited) throw new HttpError(429,'تلاش‌های ورود زیاد است؛ ۱۵ دقیقه بعد دوباره امتحان کنید.');
        const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
        const valid=await verifyPassword(data.password,user?.password_hash||dummyHash);
        if(!user || !valid) throw new HttpError(401,'ایمیل یا رمز عبور صحیح نیست.');
        db.prepare('DELETE FROM login_attempts WHERE key IN (?,?)').run(ipKey,userKey);
        const session=createSession(db,user.id);
        return respond(res,200,{user:{id:user.id,email:user.email,role:user.role},csrf:session.csrf},undefined,{'Set-Cookie':cookie(session.token,secureCookies)});
      }
      if(path==='/api/public/content' && method==='GET') {
        const site=getSite(db);return respond(res,200,{site:{name:site.name,description:site.description},content:publishedContent(db,site)});
      }
      if(path.startsWith('/api/')) {
        const session=requireSession(db,req);
        if(['POST','PUT','DELETE'].includes(method) && req.headers['x-csrf-token']!==session.csrf) throw new HttpError(403,'توکن درخواست معتبر نیست؛ صفحه را تازه کنید.');
        if(path==='/api/auth/me' && method==='GET') return respond(res,200,{user:{id:session.user_id,email:session.email,role:session.role},csrf:session.csrf});
        if(path==='/api/auth/logout' && method==='POST') { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);return respond(res,200,{ok:true},undefined,{'Set-Cookie':cookie('',secureCookies,true)}); }
        if(path==='/api/modules' && method==='GET') return respond(res,200,{modules,enabled:getSite(db).enabledModules});
        if(path==='/api/settings' && method==='GET') return respond(res,200,getSite(db));
        if(path==='/api/settings' && method==='PUT') {
          if(session.role!=='admin') throw new HttpError(403,'فقط مدیر می‌تواند تنظیمات را تغییر دهد.');
          const data=await readBody(req);
          if(typeof data.name!=='string' || !data.name.trim() || data.name.length>100 || typeof data.description!=='string' || data.description.length>500 || !Array.isArray(data.enabledModules) || data.enabledModules.some(key=>!moduleByKey(key))) throw new HttpError(422,'تنظیمات معتبر نیست.');
          const site={name:data.name.trim(),description:data.description.trim(),enabledModules:[...new Set(['pages',...data.enabledModules])]};saveSite(db,site);return respond(res,200,site);
        }
        if(path==='/api/content' && method==='GET') return respond(res,200,{content:db.prepare('SELECT * FROM content ORDER BY updated_at DESC').all()});
        if(path==='/api/content' && method==='POST') {
          const data=await readBody(req);if(!getSite(db).enabledModules.includes(data.kind)) throw new HttpError(422,'این ماژول غیرفعال است.');
          return respond(res,201,putContent(db,data));
        }
        const match=path.match(/^\/api\/content\/([a-f0-9-]{36})$/);
        if(match && method==='PUT') {
          const data=await readBody(req);const previous=db.prepare('SELECT * FROM content WHERE id=?').get(match[1]);
          if(!previous) throw new HttpError(404,'محتوا پیدا نشد.');
          if(data.expected_updated_at!==previous.updated_at) throw new HttpError(409,'این محتوا در جلسه دیگری تغییر کرده؛ فهرست را تازه کنید.');
          if(data.kind!==previous.kind) throw new HttpError(422,'نوع محتوا قابل تغییر نیست.');
          if(!getSite(db).enabledModules.includes(data.kind)) throw new HttpError(422,'این ماژول غیرفعال است.');
          return respond(res,200,putContent(db,data,match[1]));
        }
        if(match && method==='DELETE') {
          if(session.role!=='admin') throw new HttpError(403,'فقط مدیر می‌تواند محتوا را حذف کند.');
          const data=await readBody(req);const previous=db.prepare('SELECT updated_at FROM content WHERE id=?').get(match[1]);
          if(!previous) throw new HttpError(404,'محتوا پیدا نشد.');
          if(data.expected_updated_at!==previous.updated_at) throw new HttpError(409,'محتوا تغییر کرده؛ فهرست را تازه کنید.');
          db.prepare('DELETE FROM content WHERE id=?').run(match[1]);return respond(res,200,{ok:true});
        }
        throw new HttpError(404,'مسیر پیدا نشد.');
      }
      if(method!=='GET') throw new HttpError(405,'این روش پشتیبانی نمی‌شود.');
      const assets={'/admin':'admin.html','/admin/':'admin.html','/assets/admin.css':'admin.css','/assets/admin.js':'admin.js','/assets/site.css':'site.css'};
      if(assets[path]) {
        const file=assets[path];const types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8'};
        return respond(res,200,await readFile(resolve(publicDir,file),'utf8'),types[file.split('.').pop()]);
      }
      const site=getSite(db);const items=publishedContent(db,site);const options={baseURL,basePath:''};
      if(path==='/robots.txt') return respond(res,200,`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${baseURL}/sitemap.xml\n`,'text/plain; charset=utf-8');
      if(path==='/sitemap.xml') return respond(res,200,sitemap(items,baseURL),'application/xml; charset=utf-8');
      if(path==='/') return respond(res,200,renderHome(site,items,options),'text/html; charset=utf-8');
      const item=items.find(item=>contentPath(item)===path || contentPath(item)===`${path}/`);
      if(item) {
        if(!path.endsWith('/')) return respond(res,308,'','text/plain',{Location:contentPath(item)});
        return respond(res,200,renderContent(site,item,options),'text/html; charset=utf-8');
      }
      return respond(res,404,renderNotFound(site,options),'text/html; charset=utf-8');
    } catch(error) {
      if(!error.status) console.error('CMS request failed:',error.name);
      if(!res.headersSent) respond(res,error.status||500,{error:error.status?error.message:'خطای داخلی سرور.'});
      else res.end();
    }
  });
  return {server,db,close:async()=>{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));db.close();}};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.CMS_PORT||3000);const host=process.env.CMS_HOST||'127.0.0.1';
  const origin=process.env.CMS_ORIGIN||`http://localhost:${port}`;
  const secureCookies=process.env.CMS_SECURE_COOKIES==='1';
  if(process.env.NODE_ENV==='production' && (!secureCookies || new URL(origin).protocol!=='https:')) throw new Error('Production requires HTTPS CMS_ORIGIN and CMS_SECURE_COOKIES=1');
  const app=await createApp({dbPath:resolve(process.env.CMS_DB_PATH||'data/cms.sqlite'),origin,publicURL:process.env.CMS_PUBLIC_URL||origin,secureCookies});
  app.server.listen(port,host,()=>console.log(`Core CMS: ${origin}/admin`));
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await app.close();process.exit(0);});
}
