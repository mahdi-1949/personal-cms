import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDatabase,getSite,saveSite } from './database.mjs';
import { getSession,createSession,verifyPassword,hashPassword,cookie,digest,rateLimited } from './auth.mjs';
import { HttpError,putContent,publishedContent,listContent } from './content.mjs';
import { listUsers,addUser,updateUser,changePassword,listSessions } from './users.mjs';
import { getMenu,putMenu,publicMenu,referencedMedia,publicBlocks } from './blocks.mjs';
import { MAX_IMAGE_BYTES,listMedia,uploadMedia,updateMedia,deleteMedia,loadMedia } from './media.mjs';
import { modules,moduleByKey,contentPath } from './modules/registry.mjs';
import { renderHome,renderContent,renderCategory,renderContact,renderNotFound,sitemap,siteURL } from './render.mjs';
import { listCategories,putCategory,publicCategories,categoryPath } from './categories.mjs';
import { listRedirects,putRedirect,publicRedirects } from './redirects.mjs';
import { contactLimit,issueContactToken,submitContact,listMessages,updateMessage } from './contact.mjs';
import { acquireDataLock } from './data-lock.mjs';
import { securityKey as parseSecurityKey } from './security-crypto.mjs';
import { consumeFactor,assertSecurityKey,mfaStatus,startMfa,confirmMfa,changeMfa,issueReset,resetPassword } from './account-security.mjs';
import { smtpMailer,mailWorker,enqueueMail,cancelResets } from './mail.mjs';
import { recordAudit,listAudit,mutationEvent } from './audit.mjs';
import { proxyList,clientIP } from './proxy.mjs';
import { siteTemplates,pageTemplates,defaultPageTemplate,validateTheme,themeCSS,templateLibrary } from './templates.mjs';
import { designAPI } from './design-api.mjs';
import { canDesign,releasedDesigns,previewRevision,publicRevision,issueDesignPreview } from './designs.mjs';
import { runtimeDocument,runtimeBridge,runtimePolicy,vendorFiles,vendorSource } from './design-runtime.mjs';
import { designPresets } from './design-presets.mjs';
const publicDir=fileURLToPath(new URL('../public/',import.meta.url));

function respond(res,status,body,type='application/json; charset=utf-8',extra={}) {
  if(status>=200 && status<300)res.cmsAudit?.(body);
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store',...extra});
  res.end(res.cmsHead?undefined:type.startsWith('application/json')?JSON.stringify(body):body);
}
async function readBytes(req,limit) {
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw new HttpError(413,'حجم درخواست بیش از حد مجاز است.');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
async function readBody(req,limit=512*1024) {
  if (!String(req.headers['content-type']||'').startsWith('application/json')) throw new HttpError(415,'درخواست باید JSON باشد.');
  const bytes=await readBytes(req,limit);let body;
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
export async function createApp({dbPath=':memory:',origin='http://localhost:3000',publicURL=origin,secureCookies=false,securityKey=null,mailer=null,requireAdminMfa=false,trustedProxyIPs=[],mediaDir=resolve(dirname(dbPath===':memory:'?'data/cms.sqlite':dbPath),'media')}={}) {
  origin=new URL(origin).origin;
  const baseURL=siteURL(publicURL);
  const key=parseSecurityKey(securityKey),trusted=proxyList(trustedProxyIPs);
  if((mailer || requireAdminMfa) && !key)throw new Error('CMS_SECURITY_KEY is required for SMTP and enforced administrator MFA');
  const release=acquireDataLock(dbPath);let db,dummyHash;
  try{db=openDatabase(dbPath);assertSecurityKey(db,key);dummyHash=await hashPassword(randomBytes(24).toString('hex'));}
  catch(error){db?.close();release();throw error;}
  const requireDesignerForRequest=session=>{if(!canDesign(session) || (requireAdminMfa && session.role==='admin' && !session.mfa_enabled))throw new HttpError(403,'دسترسی طراحی معتبر نیست.');};
  const delivery=mailWorker(db,key,mailer);
  const notify=mailer&&key?(user,text)=>enqueueMail(db,key,'security_notice',{to:user.email,subject:'اطلاع امنیتی Core CMS',text}):undefined;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(secureCookies) res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      let ip;try{ip=clientIP(req,trusted);}catch{throw new HttpError(400,'اطلاعات پراکسی معتبر نیست.');}
      const url=new URL(req.url,origin);const path=url.pathname;const method=req.method==='HEAD'?'GET':req.method;res.cmsHead=req.method==='HEAD';
      if(!['GET','HEAD','POST','PUT','DELETE'].includes(method)) throw new HttpError(405,'این روش پشتیبانی نمی‌شود.');
      if(['POST','PUT','DELETE'].includes(method) && req.headers.origin!==origin) throw new HttpError(403,'مبدأ درخواست معتبر نیست.');
      if(method==='GET' && path.startsWith('/design-vendor/')) {
        const name=path.slice('/design-vendor/'.length);if(!vendorFiles.includes(name))throw new HttpError(404,'کتابخانه پیدا نشد.');
        return respond(res,200,await vendorSource(name),name==='LICENSE.txt'?'text/plain; charset=utf-8':'text/javascript; charset=utf-8',{'Access-Control-Allow-Origin':'*'});
      }
      const runtime=path.match(/^\/(design-preview|design-runtime)\/([a-f0-9-]{36}|[a-f0-9]{64})(?:\/([a-f0-9-]{36}))?\/(index\.html|entry\.js|bridge\.js|style\.css|assets\/([a-f0-9-]{36})\.(png|jpg))$/);
      if(runtime && method==='GET') {
        const [,kind,id,revisionId,file,assetId,ext]=runtime;
        if((kind==='design-preview' && revisionId) || (kind==='design-runtime' && !revisionId))throw new HttpError(404,'طرح پیدا نشد.');
        const source=kind==='design-preview'?previewRevision(db,id,requireAdminMfa):publicRevision(db,id,revisionId);
        const prefix=`/${kind}/${id}/${revisionId?revisionId+'/':''}`;
        res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
        res.setHeader('X-Frame-Options','SAMEORIGIN');
        res.setHeader('Content-Security-Policy',runtimePolicy(prefix,origin).policy+`; sandbox allow-scripts; frame-ancestors ${origin}`);
        const extra={'Access-Control-Allow-Origin':'*'};
        if(file==='index.html')return respond(res,200,runtimeDocument(source,{prefix,origin}),'text/html; charset=utf-8',extra);
        if(file==='entry.js')return respond(res,200,source.js,'text/javascript; charset=utf-8',extra);
        if(file==='bridge.js')return respond(res,200,runtimeBridge(source,prefix,listMedia(db)),'text/javascript; charset=utf-8',extra);
        if(file==='style.css')return respond(res,200,source.css,'text/css; charset=utf-8',extra);
        const image=db.prepare('SELECT * FROM media WHERE id=?').get(assetId);
        if(!image || !source.assets.includes(assetId) || ext!==(image.mime==='image/png'?'png':'jpg'))throw new HttpError(404,'تصویر طرح پیدا نشد.');
        return respond(res,200,await loadMedia(mediaDir,image),image.mime,extra);
      }
      if(path==='/api/health' && method==='GET') return respond(res,200,{ok:true,version:'0.6.0'});
      if(path==='/api/auth/options' && method==='GET')return respond(res,200,{passwordRecovery:Boolean(mailer&&key)});
      if(path==='/api/auth/forgot-password' && method==='POST') {
        if(!mailer || !key)throw new HttpError(503,'بازیابی رمز در حال حاضر در دسترس نیست.');
        if(rateLimited(db,digest(`reset-ip:${ip}`)))throw new HttpError(429,'درخواست‌های زیادی ارسال شده؛ بعداً تلاش کنید.');
        const data=await readBody(req,4096);
        if(typeof data.email!=='string' || data.email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim()))throw new HttpError(422,'ایمیل معتبر وارد کنید.');
        const email=data.email.trim().toLowerCase();
        if(rateLimited(db,digest(`reset-email:${email}`),3))throw new HttpError(429,'درخواست‌های زیادی ارسال شده؛ بعداً تلاش کنید.');
        await verifyPassword(randomBytes(24).toString('hex'),dummyHash);
        try{issueReset(db,email,key,origin);}catch{console.error('CMS reset delivery could not be queued');}
        return respond(res,200,{ok:true,message:'اگر حساب فعال با این ایمیل وجود داشته باشد، لینک بازیابی برای آن ارسال خواهد شد.'});
      }
      if(path==='/api/auth/reset-password' && method==='POST') {
        if(rateLimited(db,digest(`reset-use:${ip}`)))throw new HttpError(429,'تلاش‌های زیادی انجام شده؛ بعداً تلاش کنید.');
        await resetPassword(db,await readBody(req,8192),key,notify);
        return respond(res,200,{ok:true},undefined,{'Set-Cookie':cookie('',secureCookies,true)});
      }
      if(path==='/api/auth/login'  && method==='POST') {
        const data=await readBody(req);
        if(typeof data.email!=='string' || data.email.length>254 || typeof data.password!=='string' || data.password.length>256) throw new HttpError(422,'ایمیل و رمز معتبر وارد کنید.');
        const email=data.email.trim().toLowerCase();
        // Forwarded headers are accepted only from explicitly configured proxy addresses.
        const ipKey=digest(`ip:${ip}`);const userKey=digest(`email:${email}`);
        const ipLimited=rateLimited(db,ipKey);const userLimited=rateLimited(db,userKey);
        if(ipLimited || userLimited) throw new HttpError(429,'تلاش‌های ورود زیاد است؛ ۱۵ دقیقه بعد دوباره امتحان کنید.');
        const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
        const valid=await verifyPassword(data.password,user?.password_hash||dummyHash);
        const upgraded=valid && user?.password_hash.split('$').length===3?await hashPassword(data.password):null;
        const latest=user?db.prepare('SELECT * FROM users WHERE id=?').get(user.id):null;
        if(!latest || !valid || !latest.active || latest.password_hash!==user.password_hash){recordAudit(db,{event:'auth.login_failed',targetId:userKey,ip});throw new HttpError(401,'ایمیل، رمز یا کد دومرحله‌ای صحیح نیست.');}
        let session;db.exec('BEGIN IMMEDIATE');
        try {
          if(!consumeFactor(db,latest,data.mfaCode,key))throw new HttpError(401,'ایمیل، رمز یا کد دومرحله‌ای صحیح نیست.');
          if(upgraded){db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(upgraded,new Date(Math.max(Date.now(),Date.parse(latest.updated_at)+1)).toISOString(),latest.id);cancelResets(db,latest.id);recordAudit(db,{event:'auth.password_hash_upgraded',actorId:latest.id,targetId:latest.id});}
          db.prepare('DELETE FROM login_attempts WHERE key IN (?,?)').run(ipKey,userKey);session=createSession(db,latest.id);
          recordAudit(db,{event:'auth.login',actorId:latest.id,targetId:latest.id,ip});db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');recordAudit(db,{event:'auth.login_failed',targetId:userKey,ip});throw error;}
        return respond(res,200,{user:{id:latest.id,email:latest.email,role:latest.role},csrf:session.csrf},undefined,{'Set-Cookie':cookie(session.token,secureCookies)});
      }
      if(path==='/api/public/contact-token' && method==='GET') {
        if(!getSite(db).contactEnabled)throw new HttpError(404,'فرم تماس غیرفعال است.');
        return respond(res,200,issueContactToken(db,ip));
      }
      if(path==='/api/public/contact' && method==='POST') {
        if(!getSite(db).contactEnabled)throw new HttpError(404,'فرم تماس غیرفعال است.');
        contactLimit(db,digest(`contact-send:${ip}`),10);
        const data=await readBody(req,16*1024);
        if(!getSite(db).contactEnabled)throw new HttpError(404,'فرم تماس غیرفعال است.');
        submitContact(db,ip,data);
        return respond(res,201,{ok:true,message:'پیام شما ثبت شد.'});
      }
      if(path==='/api/public/content'  && method==='GET') {
        const site=getSite(db);const items=publishedContent(db,site);const publicIds=new Set(items.map(item=>item.id));
        const content=items.map(item=>({...item,blocks:publicBlocks(item.blocks,publicIds)}));
        return respond(res,200,{site:{name:site.name,description:site.description,contactEnabled:site.contactEnabled,theme:site.theme},content,menu:publicMenu(db,items),categories:publicCategories(db,items)});
      }
      if(path.startsWith('/api/')) {
        const session=requireSession(db,req);
        req.cmsDb=db;
        const mfaRequired=requireAdminMfa && session.role==='admin' && !session.mfa_enabled;
        if(mfaRequired && !['/api/auth/me','/api/auth/logout'].includes(path) && !path.startsWith('/api/auth/mfa'))throw new HttpError(403,'برای مدیریت سایت ابتدا ورود دومرحله‌ای را فعال کنید.');
        const event=mutationEvent(method,path);if(event)res.cmsAudit=body=>recordAudit(db,{event,actorId:session.user_id,targetId:typeof body?.id==='string'?body.id:path.match(/[a-f0-9-]{36}$/)?.[0]||null,ip});
        if(['POST','PUT','DELETE'].includes(method) && req.headers['x-csrf-token']!==session.csrf) throw new HttpError(403,'توکن درخواست معتبر نیست؛ صفحه را تازه کنید.');
        if(path==='/api/auth/me' && method==='GET') return respond(res,200,{user:{id:session.user_id,email:session.email,role:session.role,mfaEnabled:Boolean(session.mfa_enabled),mfaRequired,canDesign:canDesign(session)},csrf:session.csrf});
        if(path==='/api/auth/logout' && method==='POST') { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);return respond(res,200,{ok:true},undefined,{'Set-Cookie':cookie('',secureCookies,true)}); }
        if(path==='/api/auth/password' && method==='PUT') {
          const attemptKey=digest(`password:${session.user_id}`);if(rateLimited(db,attemptKey))throw new HttpError(429,'تلاش‌های تغییر رمز زیاد است؛ بعداً امتحان کنید.');
          await changePassword(db,session.user_id,await readBody(req),()=>requireSession(db,req),key,notify);
          db.prepare('DELETE FROM login_attempts WHERE key=?').run(attemptKey);
          return respond(res,200,{ok:true},undefined,{'Set-Cookie':cookie('',secureCookies,true)});
        }
        if(path==='/api/auth/mfa' && method==='GET')return respond(res,200,mfaStatus(db,session.user_id,key));
        if(path.startsWith('/api/auth/mfa/') && method==='POST') {
          if(rateLimited(db,digest(`mfa:${session.user_id}`)))throw new HttpError(429,'تلاش‌های زیادی انجام شده؛ بعداً تلاش کنید.');
          const data=await readBody(req,4096);
          if(path==='/api/auth/mfa/setup')return respond(res,200,await startMfa(db,session.user_id,data,key,()=>requireSession(db,req)));
          if(path==='/api/auth/mfa/confirm')return respond(res,200,confirmMfa(db,session.user_id,data,key,notify),undefined,{'Set-Cookie':cookie('',secureCookies,true)});
          if(['/api/auth/mfa/disable','/api/auth/mfa/recovery-codes'].includes(path))return respond(res,200,await changeMfa(db,session.user_id,data,key,()=>requireSession(db,req),{disable:path.endsWith('/disable'),notify}),undefined,{'Set-Cookie':cookie('',secureCookies,true)});
        }
        if(path==='/api/audit' && method==='GET') {
          if(session.role!=='admin')throw new HttpError(403,'فقط مدیر به رخدادها دسترسی دارد.');
          return respond(res,200,listAudit(db,Number(url.searchParams.get('page')||1)));
        }
        if(path==='/api/auth/sessions' && method==='GET')return respond(res,200,{sessions:listSessions(db,session)});
        const sessionMatch=path.match(/^\/api\/auth\/sessions\/([a-f0-9-]{36})$/);
        if(sessionMatch && method==='DELETE') {
          const result=db.prepare('DELETE FROM sessions WHERE session_id=? AND user_id=?').run(sessionMatch[1],session.user_id);
          if(!result.changes)throw new HttpError(404,'نشست پیدا نشد.');
          return respond(res,200,{ok:true},undefined,sessionMatch[1]===session.session_id?{'Set-Cookie':cookie('',secureCookies,true)}:{});
        }
        if(await designAPI({db,req,res,path,method,session,key,ip,readBody,respond,authorize:()=>{const current=requireSession(db,req);requireDesignerForRequest(current);return current;}}))return;
        if(path==='/api/users' || path.startsWith('/api/users/')) {
          if(session.role!=='admin')throw new HttpError(403,'فقط مدیر می‌تواند کاربران را مدیریت کند.');
          if(path==='/api/users' && method==='GET')return respond(res,200,{users:listUsers(db)});
          if(path==='/api/users' && method==='POST')return respond(res,201,await addUser(db,await readBody(req),()=>requireSession(db,req)));
          const userMatch=path.match(/^\/api\/users\/([a-f0-9-]{36})$/);
          if(userMatch && method==='PUT')return respond(res,200,await updateUser(db,userMatch[1],await readBody(req),()=>requireSession(db,req)));
        }
        if(path==='/api/categories' && method==='GET')return respond(res,200,{categories:listCategories(db)});
        if(path==='/api/categories' || path.startsWith('/api/categories/')) {
          if(session.role!=='admin')throw new HttpError(403,'فقط مدیر می‌تواند دسته‌ها را مدیریت کند.');
          if(path==='/api/categories' && method==='POST')return respond(res,201,putCategory(db,await readBody(req)));
          const match=path.match(/^\/api\/categories\/([a-f0-9-]{36})$/);
          if(match && method==='PUT')return respond(res,200,putCategory(db,await readBody(req),match[1]));
          if(match && method==='DELETE') {
            const data=await readBody(req),old=db.prepare('SELECT * FROM categories WHERE id=?').get(match[1]);
            if(!old)throw new HttpError(404,'دسته پیدا نشد.');
            if(old.updated_at!==data.expected_updated_at)throw new HttpError(409,'دسته تغییر کرده؛ فهرست را تازه کنید.');
            if(db.prepare('SELECT content_id FROM content_categories WHERE category_id=? LIMIT 1').get(old.id))throw new HttpError(409,'این دسته در مقاله استفاده شده؛ ابتدا ارتباط را حذف کنید.');
            db.prepare('DELETE FROM categories WHERE id=?').run(old.id);return respond(res,200,{ok:true});
          }
        }
        if(path==='/api/redirects' || path.startsWith('/api/redirects/')) {
          if(session.role!=='admin')throw new HttpError(403,'فقط مدیر می‌تواند ریدایرکت‌ها را مدیریت کند.');
          if(path==='/api/redirects' && method==='GET')return respond(res,200,{redirects:listRedirects(db)});
          if(path==='/api/redirects' && method==='POST')return respond(res,201,putRedirect(db,await readBody(req)));
          const match=path.match(/^\/api\/redirects\/([a-f0-9-]{36})$/);
          if(match && method==='DELETE') {
            const data=await readBody(req),old=db.prepare('SELECT * FROM redirects WHERE id=?').get(match[1]);
            if(!old)throw new HttpError(404,'ریدایرکت پیدا نشد.');
            if(old.updated_at!==data.expected_updated_at)throw new HttpError(409,'ریدایرکت تغییر کرده؛ فهرست را تازه کنید.');
            db.prepare('DELETE FROM redirects WHERE id=?').run(old.id);return respond(res,200,{ok:true});
          }
        }
        if(path==='/api/messages' || path.startsWith('/api/messages/')) {
          if(session.role!=='admin')throw new HttpError(403,'فقط مدیر به پیام‌ها دسترسی دارد.');
          if(path==='/api/messages' && method==='GET')return respond(res,200,listMessages(db,{status:url.searchParams.get('status')||undefined,page:Number(url.searchParams.get('page')||1)}));
          const match=path.match(/^\/api\/messages\/([a-f0-9-]{36})$/);
          if(match && method==='PUT')return respond(res,200,updateMessage(db,match[1],await readBody(req)));
          if(match && method==='DELETE') {
            const data=await readBody(req),old=db.prepare('SELECT * FROM messages WHERE id=?').get(match[1]);
            if(!old)throw new HttpError(404,'پیام پیدا نشد.');
            if(old.updated_at!==data.expected_updated_at)throw new HttpError(409,'پیام تغییر کرده؛ فهرست را تازه کنید.');
            db.prepare('DELETE FROM messages WHERE id=?').run(old.id);return respond(res,200,{ok:true});
          }
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
        if(path==='/api/templates' && method==='GET')return respond(res,200,{siteTemplates,pageTemplates,designPresets,...templateLibrary,defaults:Object.fromEntries(modules.map(item=>[item.key,defaultPageTemplate(item.key)]))});
        if(path==='/api/modules' && method==='GET') return respond(res,200,{modules,enabled:getSite(db).enabledModules});
        if(path==='/api/settings' && method==='GET') return respond(res,200,getSite(db));
        if(path==='/api/settings' && method==='PUT') {
          if(session.role!=='admin') throw new HttpError(403,'فقط مدیر می‌تواند تنظیمات را تغییر دهد.');
          const data=await readBody(req);
          if(typeof data.name!=='string' || !data.name.trim() || data.name.length>100 || typeof data.description!=='string' || data.description.length>500 || !Array.isArray(data.enabledModules) || data.enabledModules.some(key=>!moduleByKey(key))) throw new HttpError(422,'تنظیمات معتبر نیست.');
          const contactEnabled=data.contactEnabled===undefined?getSite(db).contactEnabled:data.contactEnabled;
          if(typeof contactEnabled!=='boolean')throw new HttpError(422,'وضعیت فرم تماس معتبر نیست.');
          if(contactEnabled && db.prepare("SELECT id FROM content WHERE kind='pages' AND slug='contact'").get())throw new HttpError(409,'صفحه قدیمی با آدرس contact وجود دارد؛ پیش از فعال‌سازی، آدرس آن را تغییر دهید.');
          const previous=getSite(db),theme=validateTheme(data.theme??previous.theme);
          const changed=JSON.stringify(theme)!==JSON.stringify(previous.theme);
          if(changed && data.theme_updated_at!==previous.theme_updated_at)throw new HttpError(409,'قالب در جلسه دیگری تغییر کرده؛ تنظیمات را تازه کنید.');
          const theme_updated_at=changed?new Date(Math.max(Date.now(),Date.parse(previous.theme_updated_at||0)+1)).toISOString():previous.theme_updated_at;
          const site={theme,theme_updated_at,name:data.name.trim(),description:data.description.trim(),contactEnabled,enabledModules:[...new Set(['pages',...data.enabledModules])]};saveSite(db,site);return respond(res,200,site);
        }
        if(path==='/api/content' && method==='GET') return respond(res,200,{content:listContent(db)});
        if(path==='/api/content' && method==='POST') {
          const data=await readBody(req);if(!getSite(db).enabledModules.includes(data.kind)) throw new HttpError(422,'این ماژول غیرفعال است.');
          return respond(res,201,putContent(db,data));
        }
        const previewMatch=path.match(/^\/api\/content\/([a-f0-9-]{36})\/preview$/);
        if(previewMatch && method==='GET') {
          const site=getSite(db),item=listContent(db).find(item=>item.id===previewMatch[1]);
          if(!item || !site.enabledModules.includes(item.kind))throw new HttpError(404,'صفحه پیش‌نمایش پیدا نشد.');
          const items=publishedContent(db,site),designs=releasedDesigns(db,[item]).map(source=>({...source,previewURL:issueDesignPreview(db,source.design_id,{revisionId:source.id},session,{releasedOnly:true}).url})),options={baseURL,basePath:'',items,categories:publicCategories(db,items),menu:publicMenu(db,items),media:listMedia(db),designs,preview:true};
          res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
          res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Content-Security-Policy',res.getHeader('Content-Security-Policy').replace("frame-ancestors 'none'",`frame-ancestors ${origin}`));
          return respond(res,200,item.kind==='pages' && item.slug==='home'?renderHome(site,[...items.filter(current=>current.id!==item.id),item],options):renderContent(site,item,options),'text/html; charset=utf-8');
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
      const assets={'/admin':'admin.html','/admin/':'admin.html','/assets/admin.css':'admin.css','/assets/admin.js':'admin.js','/assets/authoring.js':'authoring.js','/assets/site.css':'site.css','/assets/contact.js':'contact.js','/assets/operations.js':'operations.js','/assets/security.js':'security.js','/assets/templates.js':'templates.js','/assets/section-editor.js':'section-editor.js','/assets/designer.js':'designer.js','/admin/reset-password/':'admin.html','/admin/reset-password':'admin.html'};
      if(path==='/assets/theme.css')return respond(res,200,themeCSS(getSite(db).theme),'text/css; charset=utf-8');
      if(assets[path]) {
        if(path.startsWith('/admin/reset-password'))res.setHeader('Referrer-Policy','no-referrer');
        const file=assets[path];const types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8'};
        return respond(res,200,await readFile(resolve(publicDir,file),'utf8'),types[file.split('.').pop()]);
      }
      const site=getSite(db);const items=publishedContent(db,site);const categories=publicCategories(db,items);const options={baseURL,basePath:'',items,categories,menu:publicMenu(db,items),media:listMedia(db),designs:releasedDesigns(db,items)};
      const imageMatch=path.match(/^\/media\/([a-f0-9-]{36})\.(png|jpg)$/);
      if(imageMatch) {
        const item=db.prepare('SELECT * FROM media WHERE id=?').get(imageMatch[1]);
        const session=getSession(db,req),authorized=session && !(requireAdminMfa && session.role==='admin' && !session.mfa_enabled);
        if(!item || (item.mime==='image/png'?'png':'jpg')!==imageMatch[2] || (!referencedMedia(items,releasedDesigns(db,items)).includes(item.id) && !authorized))throw new HttpError(404,'تصویر پیدا نشد.');
        return respond(res,200,await loadMedia(mediaDir,item),item.mime);
      }
      if(path==='/robots.txt') return respond(res,200,`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${baseURL}/sitemap.xml\n`,'text/plain; charset=utf-8');
      if(path==='/sitemap.xml') return respond(res,200,sitemap(items,baseURL,[...categories.map(categoryPath),...(site.contactEnabled?['/contact/']:[])]),'application/xml; charset=utf-8');
      if((path==='/contact/' || path==='/contact') && site.contactEnabled) {
        if(path==='/contact')return respond(res,308,'','text/plain',{Location:'/contact/'});
        return respond(res,200,renderContact(site,options),'text/html; charset=utf-8');
      }
      const category=categories.find(category=>categoryPath(category)===path || categoryPath(category)===`${path}/`);
      if(category) {
        if(!path.endsWith('/'))return respond(res,308,'','text/plain',{Location:categoryPath(category)});
        return respond(res,200,renderCategory(site,category,items,options),'text/html; charset=utf-8');
      }
      if(path==='/') return respond(res,200,renderHome(site,items,options),'text/html; charset=utf-8');
      const item=items.find(item=>contentPath(item)===path || contentPath(item)===`${path}/`);
      if(item) {
        if(!path.endsWith('/')) return respond(res,308,'','text/plain',{Location:contentPath(item)});
        return respond(res,200,renderContent(site,item,options),'text/html; charset=utf-8');
      }
      const alias=publicRedirects(db,items,categories).find(alias=>alias.path===path || alias.path===`${path}/`);
      if(alias)return respond(res,308,'','text/plain',{Location:alias.destination});
      return respond(res,404,renderNotFound(site,options),'text/html; charset=utf-8');
    } catch(error) {
      if(!error.status) console.error('CMS request failed:',error.name);
      if(!res.headersSent) respond(res,error.status||500,{error:error.status?error.message:'خطای داخلی سرور.'});
      else res.end();
    }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
  let closing;
  return {server,db,mediaDir,flushMail:delivery.flush,close:()=>closing??= (async()=>{try{if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}finally{try{await delivery.close();}finally{try{db.close();}finally{release();}}}})()};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.CMS_PORT||3000);const host=process.env.CMS_HOST||'127.0.0.1';
  const origin=process.env.CMS_ORIGIN||`http://localhost:${port}`;
  const secureCookies=process.env.CMS_SECURE_COOKIES==='1';
  if(process.env.NODE_ENV==='production' && (!secureCookies || new URL(origin).protocol!=='https:')) throw new Error('Production requires HTTPS CMS_ORIGIN and CMS_SECURE_COOKIES=1');
  const app=await createApp({dbPath:resolve(process.env.CMS_DB_PATH||'data/cms.sqlite'),origin,publicURL:process.env.CMS_PUBLIC_URL||origin,secureCookies,securityKey:process.env.CMS_SECURITY_KEY,mailer:smtpMailer(),requireAdminMfa:process.env.CMS_REQUIRE_ADMIN_MFA==='1',trustedProxyIPs:process.env.CMS_TRUSTED_PROXY_IPS||'',...(process.env.CMS_MEDIA_DIR?{mediaDir:resolve(process.env.CMS_MEDIA_DIR)}:{})});
  app.server.on('error',async error=>{console.error('CMS server failed:',error.code||error.name);await app.close();process.exitCode=1;});
  app.server.listen(port,host,()=>console.log(`Core CMS: ${origin}/admin`));
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await app.close();process.exit(0);});
}
