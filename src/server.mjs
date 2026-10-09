import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDatabase,getSite,saveSite } from './database.mjs';
import { getSession,createSession,verifyPassword,hashPassword,cookie,digest,rateLimited } from './auth.mjs';
import { HttpError,putContent,publishedContent,listContent } from './content.mjs';
import { listUsers,addUser,updateUser,changePassword,listSessions } from './users.mjs';
import { getMenu,putMenu,publicMenu,referencedMedia } from './blocks.mjs';
import { MAX_IMAGE_BYTES,listMedia,uploadMedia,updateMedia,deleteMedia,loadMedia } from './media.mjs';
import { modules,moduleByKey,contentPath } from './modules/registry.mjs';
import { renderHome,renderContent,renderNotFound,sitemap,siteURL } from './render.mjs';
const publicDir=fileURLToPath(new URL('../public/',import.meta.url));

function respond(res,status,body,type='application/json; charset=utf-8',extra={}) {
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store',...extra});
  res.end(res.cmsHead?undefined:type.startsWith('application/json')?JSON.stringify(body):body);
}
async function readBytes(req,limit) {
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw new HttpError(413,'حجم درخواست بیش از حد مجاز است.');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
async function readBody(req) {
  if (!String(req.headers['content-type']||'').startsWith('application/json')) throw new HttpError(415,'درخواست باید JSON باشد.');
  const bytes=await readBytes(req,512*1024);let body;
  try { body=JSON.parse(bytes.toString()); if (!body || typeof body!=='object' || Array.isArray(body)) throw new Error(); }
  catch { throw new HttpError(400,'JSON معتبر نیست.'); }
  if(req.cmsDb)requireSession(req.cmsDb,req);
  return body;
}
function requireSession(db,req) {
  const session=getSession(db,req);
  if(!session) throw new HttpError(401,'برای ادامه وارد شوید.');
  if(!['admin','editor'].includes(session.role)) throw new HttpError(403,'دسترسی کافی ندارید.');
  return session;
}
export async function createApp({dbPath=':memory:',origin='http://localhost:3000',publicURL=origin,secureCookies=false,mediaDir=resolve(dirname(dbPath===':memory:'?'data/cms.sqlite':dbPath),'media')}={}) {
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
      const url=new URL(req.url,origin);const path=url.pathname;const method=req.method==='HEAD'?'GET':req.method;res.cmsHead=req.method==='HEAD';
      if(!['GET','HEAD','POST','PUT','DELETE'].includes(method)) throw new HttpError(405,'این روش پشتیبانی نمی‌شود.');
      if(['POST','PUT','DELETE'].includes(method) && req.headers.origin!==origin) throw new HttpError(403,'مبدأ درخواست معتبر نیست.');
      if(path==='/api/health' && method==='GET') return respond(res,200,{ok:true,version:'0.2.0'});
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
        const latest=user?db.prepare('SELECT * FROM users WHERE id=?').get(user.id):null;
        if(!latest || !valid || !latest.active || latest.password_hash!==user.password_hash) throw new HttpError(401,'ایمیل یا رمز عبور صحیح نیست.');
        db.prepare('DELETE FROM login_attempts WHERE key IN (?,?)').run(ipKey,userKey);
        const session=createSession(db,latest.id);
        return respond(res,200,{user:{id:latest.id,email:latest.email,role:latest.role},csrf:session.csrf},undefined,{'Set-Cookie':cookie(session.token,secureCookies)});
      }
      if(path==='/api/public/content' && method==='GET') {
        const site=getSite(db);const items=publishedContent(db,site);const publicIds=new Set(items.map(item=>item.id));
        const content=items.map(item=>({...item,blocks:item.blocks.filter(block=>block.type!=='cta' || publicIds.has(block.contentId))}));
        return respond(res,200,{site:{name:site.name,description:site.description},content,menu:publicMenu(db,items)});
      }
      if(path.startsWith('/api/')) {
        const session=requireSession(db,req);
        req.cmsDb=db;
        if(['POST','PUT','DELETE'].includes(method) && req.headers['x-csrf-token']!==session.csrf) throw new HttpError(403,'توکن درخواست معتبر نیست؛ صفحه را تازه کنید.');
        if(path==='/api/auth/me' && method==='GET') return respond(res,200,{user:{id:session.user_id,email:session.email,role:session.role},csrf:session.csrf});
        if(path==='/api/auth/logout' && method==='POST') { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);return respond(res,200,{ok:true},undefined,{'Set-Cookie':cookie('',secureCookies,true)}); }
        if(path==='/api/auth/password' && method==='PUT') {
          const key=digest(`password:${session.user_id}`);if(rateLimited(db,key))throw new HttpError(429,'تلاش‌های تغییر رمز زیاد است؛ بعداً امتحان کنید.');
          await changePassword(db,session.user_id,await readBody(req),()=>requireSession(db,req));
          db.prepare('DELETE FROM login_attempts WHERE key=?').run(key);
          return respond(res,200,{ok:true},undefined,{'Set-Cookie':cookie('',secureCookies,true)});
        }
        if(path==='/api/auth/sessions' && method==='GET')return respond(res,200,{sessions:listSessions(db,session)});
        const sessionMatch=path.match(/^\/api\/auth\/sessions\/([a-f0-9-]{36})$/);
        if(sessionMatch && method==='DELETE') {
          const result=db.prepare('DELETE FROM sessions WHERE session_id=? AND user_id=?').run(sessionMatch[1],session.user_id);
          if(!result.changes)throw new HttpError(404,'نشست پیدا نشد.');
          return respond(res,200,{ok:true},undefined,sessionMatch[1]===session.session_id?{'Set-Cookie':cookie('',secureCookies,true)}:{});
        }
        if(path==='/api/users' || path.startsWith('/api/users/')) {
          if(session.role!=='admin')throw new HttpError(403,'فقط مدیر می‌تواند کاربران را مدیریت کند.');
          if(path==='/api/users' && method==='GET')return respond(res,200,{users:listUsers(db)});
          if(path==='/api/users' && method==='POST')return respond(res,201,await addUser(db,await readBody(req),()=>requireSession(db,req)));
          const userMatch=path.match(/^\/api\/users\/([a-f0-9-]{36})$/);
          if(userMatch && method==='PUT')return respond(res,200,await updateUser(db,userMatch[1],await readBody(req),()=>requireSession(db,req)));
        }
        if(path==='/api/navigation' && method==='GET')return respond(res,200,getMenu(db));
        if(path==='/api/navigation' && method==='PUT') {
          if(session.role!=='admin')throw new HttpError(403,'فقط مدیر می‌تواند منو را تغییر دهد.');
          return respond(res,200,putMenu(db,await readBody(req)));
        }
        if(path==='/api/media' && method==='GET')return respond(res,200,{media:listMedia(db)});
        if(path==='/api/media' && method==='POST') {
          const mime=req.headers['content-type'];let filename;
          try{filename=decodeURIComponent(req.headers['x-filename']||'');}catch{throw new HttpError(422,'نام تصویر معتبر نیست.');}
          const buffer=await readBytes(req,MAX_IMAGE_BYTES);
          requireSession(db,req);
          return respond(res,201,await uploadMedia(db,mediaDir,buffer,{mime,filename,userId:session.user_id,authorize:()=>requireSession(db,req)}));
        }
        const mediaMatch=path.match(/^\/api\/media\/([a-f0-9-]{36})$/);
        if(mediaMatch && method==='PUT')return respond(res,200,updateMedia(db,mediaMatch[1],await readBody(req)));
        if(mediaMatch && method==='DELETE') {
          if(session.role!=='admin')throw new HttpError(403,'فقط مدیر می‌تواند تصویر را حذف کند.');
          await deleteMedia(db,mediaDir,mediaMatch[1],await readBody(req));return respond(res,200,{ok:true});
        }
        if(path==='/api/modules' && method==='GET') return respond(res,200,{modules,enabled:getSite(db).enabledModules});
        if(path==='/api/settings' && method==='GET') return respond(res,200,getSite(db));
        if(path==='/api/settings' && method==='PUT') {
          if(session.role!=='admin') throw new HttpError(403,'فقط مدیر می‌تواند تنظیمات را تغییر دهد.');
          const data=await readBody(req);
          if(typeof data.name!=='string' || !data.name.trim() || data.name.length>100 || typeof data.description!=='string' || data.description.length>500 || !Array.isArray(data.enabledModules) || data.enabledModules.some(key=>!moduleByKey(key))) throw new HttpError(422,'تنظیمات معتبر نیست.');
          const site={name:data.name.trim(),description:data.description.trim(),enabledModules:[...new Set(['pages',...data.enabledModules])]};saveSite(db,site);return respond(res,200,site);
        }
        if(path==='/api/content' && method==='GET') return respond(res,200,{content:listContent(db)});
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
      const assets={'/admin':'admin.html','/admin/':'admin.html','/assets/admin.css':'admin.css','/assets/admin.js':'admin.js','/assets/authoring.js':'authoring.js','/assets/site.css':'site.css'};
      if(assets[path]) {
        const file=assets[path];const types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8'};
        return respond(res,200,await readFile(resolve(publicDir,file),'utf8'),types[file.split('.').pop()]);
      }
      const site=getSite(db);const items=publishedContent(db,site);const options={baseURL,basePath:'',items,menu:publicMenu(db,items),media:listMedia(db)};
      const imageMatch=path.match(/^\/media\/([a-f0-9-]{36})\.(png|jpg)$/);
      if(imageMatch) {
        const item=db.prepare('SELECT * FROM media WHERE id=?').get(imageMatch[1]);
        if(!item || (item.mime==='image/png'?'png':'jpg')!==imageMatch[2] || (!referencedMedia(items).includes(item.id) && !getSession(db,req)))throw new HttpError(404,'تصویر پیدا نشد.');
        return respond(res,200,await loadMedia(mediaDir,item),item.mime);
      }
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
  return {server,db,mediaDir,close:async()=>{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));db.close();}};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.CMS_PORT||3000);const host=process.env.CMS_HOST||'127.0.0.1';
  const origin=process.env.CMS_ORIGIN||`http://localhost:${port}`;
  const secureCookies=process.env.CMS_SECURE_COOKIES==='1';
  if(process.env.NODE_ENV==='production' && (!secureCookies || new URL(origin).protocol!=='https:')) throw new Error('Production requires HTTPS CMS_ORIGIN and CMS_SECURE_COOKIES=1');
  const app=await createApp({dbPath:resolve(process.env.CMS_DB_PATH||'data/cms.sqlite'),origin,publicURL:process.env.CMS_PUBLIC_URL||origin,secureCookies,...(process.env.CMS_MEDIA_DIR?{mediaDir:resolve(process.env.CMS_MEDIA_DIR)}:{})});
  app.server.listen(port,host,()=>console.log(`Core CMS: ${origin}/admin`));
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await app.close();process.exit(0);});
}
