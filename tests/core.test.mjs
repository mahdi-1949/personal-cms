import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,readdir,writeFile,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { createUser,hashPassword,verifyPassword,cookie } from '../src/auth.mjs';
import { openDatabase,getSite } from '../src/database.mjs';
import { exportSite } from '../src/export.mjs';

const password='Test-only-password-123!';const origin='http://cms.test';
let app,dir,dbPath,base,admin,editor;
async function request(path,{method='GET',body,session,csrf=true,requestOrigin=origin}={}) {
  const headers={};
  if(session)headers.Cookie=session.cookie;
  if(session && csrf)headers['X-CSRF-Token']=session.csrf;
  if(method!=='GET' && requestOrigin!==null)headers.Origin=requestOrigin;
  if(body!==undefined)headers['Content-Type']='application/json';
  const res=await fetch(base+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}
  return {status:res.status,data,headers:res.headers};
}
async function login(email){
  const result=await request('/api/auth/login',{method:'POST',body:{email,password}});assert.equal(result.status,200);
  return {cookie:result.headers.get('set-cookie').split(';')[0],csrf:result.data.csrf};
}
const content=(overrides={})=>({kind:'services',title:'تعمیر و نگهداری',slug:'maintenance',excerpt:'معرفی خدمات',body:'متن اصلی خدمات',status:'draft',seo_title:'خدمات تخصصی',seo_description:'شرح خدمات',...overrides});
before(async()=>{
  dir=await mkdtemp(join(tmpdir(),'core-cms-test-'));dbPath=join(dir,'database/cms.sqlite');
  app=await createApp({dbPath,origin,publicURL:'https://example.com'});
  await createUser(app.db,{email:'admin@example.test',password});
  await createUser(app.db,{email:'editor@example.test',password,role:'editor'});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;
  admin=await login('admin@example.test');editor=await login('editor@example.test');
});
after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});

test('passwords and sessions are hashed; cookie and login origin protections',async()=>{
  const hash=await hashPassword(password);assert.notEqual(hash,password);assert.equal(await verifyPassword(password,hash),true);assert.equal(await verifyPassword('wrong',hash),false);
  const stored=app.db.prepare('SELECT password_hash FROM users LIMIT 1').get();assert.match(stored.password_hash,/^scrypt\$/);
  const sessions=app.db.prepare('SELECT token_hash FROM sessions').all();assert.equal(sessions.some(row=>row.token_hash===admin.cookie.slice(12)),false);
  assert.match(cookie('test',true),/HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'admin@example.test',password},requestOrigin:'https://attacker.test'})).status,403);
  assert.equal((await request('/api/content')).status,401);
  assert.equal((await request('/api/content',{method:'POST',session:admin,csrf:false,body:content()})).status,403);
  assert.equal((await request('/api/content',{method:'POST',session:admin,requestOrigin:null,body:content()})).status,403);
});

let service;
test('draft stays private; publication adds escaped HTML, canonical and sitemap',async()=>{
  const draft=await request('/api/content',{method:'POST',session:admin,body:content({body:'<script>alert(1)</script>\nمتن'})});assert.equal(draft.status,201);service=draft.data;
  assert.equal((await request('/api/public/content')).data.content.length,0);
  assert.equal((await request('/services/maintenance/')).status,404);
  assert.doesNotMatch((await request('/sitemap.xml')).data,/maintenance/);
  const published=await request(`/api/content/${service.id}`,{method:'PUT',session:admin,body:{...service,status:'published',expected_updated_at:service.updated_at}});assert.equal(published.status,200);service=published.data;
  const publicPage=await request('/services/maintenance/');assert.equal(publicPage.status,200);
  assert.match(publicPage.data,/&lt;script&gt;/);assert.doesNotMatch(publicPage.data,/<script>/);
  assert.match(publicPage.data,/rel="canonical" href="https:\/\/example.com\/services\/maintenance\/"/);
  assert.match((await request('/sitemap.xml')).data,/services\/maintenance/);
  const redirected=await fetch(base+'/services/maintenance',{redirect:'manual'});assert.equal(redirected.status,308);assert.equal(redirected.headers.get('location'),'/services/maintenance/');
  const stale=await request(`/api/content/${service.id}`,{method:'PUT',session:admin,body:{...service,expected_updated_at:draft.data.updated_at}});assert.equal(stale.status,409);
});

test('slug collision, traversal and reserved names are rejected; bound SQL preserves text',async()=>{
  assert.equal((await request('/api/content',{method:'POST',session:admin,body:content()})).status,409);
  for(const slug of ['../escape','admin','services'])assert.equal((await request('/api/content',{method:'POST',session:admin,body:content({kind:'pages',slug})})).status,422);
  assert.equal((await request('/api/content',{method:'POST',session:admin,body:content({title:123,slug:'bad-title'})})).status,422);
  assert.equal((await request('/api/content',{method:'POST',session:admin,body:content({slug:'empty',title:'   '})})).status,422);
  const title="test'); DROP TABLE users; --";
  const item=await request('/api/content',{method:'POST',session:admin,body:content({slug:'bound-title',title})});assert.equal(item.status,201);assert.equal(item.data.title,title);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM users').get().count,2);
});

test('editor can create but cannot change settings or delete content',async()=>{
  assert.equal((await request('/api/settings',{method:'PUT',session:editor,body:{name:'bad',description:'',enabledModules:['pages']}})).status,403);
  assert.equal((await request(`/api/content/${service.id}`,{method:'DELETE',session:editor,body:{expected_updated_at:service.updated_at}})).status,403);
  const result=await request('/api/content',{method:'POST',session:editor,body:content({kind:'posts',slug:'editor-post',title:'مقاله نویسنده'})});assert.equal(result.status,201);
});

test('module disable hides public data and export without deleting it',async()=>{
  const settings=(await request('/api/settings',{session:admin})).data;
  const disabled=await request('/api/settings',{method:'PUT',session:admin,body:{...settings,enabledModules:['posts','portfolio']}});assert.equal(disabled.status,200);assert.ok(disabled.data.enabledModules.includes('pages'));
  assert.equal((await request('/services/maintenance/')).status,404);
  assert.equal((await request('/api/public/content')).data.content.length,0);
  assert.ok((await request('/api/content',{session:admin})).data.content.some(item=>item.id===service.id));
  assert.equal((await request('/api/content',{method:'POST',session:admin,body:content({slug:'disabled-write'})})).status,422);
  const outputDir=join(dir,'disabled-export');await exportSite({dbPath,outputDir,publicURL:'https://account.github.io/project'});
  assert.doesNotMatch(await readFile(join(outputDir,'index.html'),'utf8'),/maintenance/);
  await request('/api/settings',{method:'PUT',session:admin,body:settings});
  assert.equal((await request('/services/maintenance/')).status,200);
});

test('static export respects Pages subpath, excludes private data and removes stale pages',async()=>{
  const outputDir=join(dir,'export');await exportSite({dbPath,outputDir,publicURL:'https://account.github.io/project'});
  const html=await readFile(join(outputDir,'services/maintenance/index.html'),'utf8');
  assert.match(html,/href="\/project\/assets\/site.css"/);assert.match(html,/https:\/\/account.github.io\/project\/services\/maintenance\//);
  const files=await readdir(outputDir);assert.ok(!files.includes('admin'));assert.ok(!files.includes('data'));assert.ok(!files.includes('api'));
  const home=await readFile(join(outputDir,'index.html'),'utf8');assert.doesNotMatch(home,/admin@example|editor@example|password_hash|bound-title|editor-post/);
  const plain=await request('/api/content',{method:'POST',session:admin,body:content({slug:'remove-me',status:'published'})});assert.equal(plain.status,201);
  await exportSite({dbPath,outputDir,publicURL:'https://account.github.io/project'});assert.ok((await readdir(join(outputDir,'services'))).includes('remove-me'));
  await request(`/api/content/${plain.data.id}`,{method:'DELETE',session:admin,body:{expected_updated_at:plain.data.updated_at}});
  await exportSite({dbPath,outputDir,publicURL:'https://account.github.io/project'});assert.ok(!(await readdir(join(outputDir,'services'))).includes('remove-me'));
  const protectedDir=join(dir,'not-export');await mkdir(protectedDir);await writeFile(join(protectedDir,'keep.txt'),'keep');
  await assert.rejects(exportSite({dbPath,outputDir:protectedDir,publicURL:'https://example.com'}),/Destination exists/);assert.equal(await readFile(join(protectedDir,'keep.txt'),'utf8'),'keep');
  await assert.rejects(exportSite({dbPath,outputDir:dirnameOf(dbPath),publicURL:'https://example.com'}),/must not contain/);
});
function dirnameOf(path){return path.slice(0,path.lastIndexOf('/'));}

test('data survives reconnect; logout invalidates the session',async()=>{
  const other=openDatabase(dbPath);try{assert.equal(getSite(other).name,'سایت اختصاصی من');assert.ok(other.prepare('SELECT * FROM content WHERE id=?').get(service.id));}finally{other.close();}
  const temporary=await login('admin@example.test');assert.equal((await request('/api/auth/logout',{method:'POST',session:temporary,body:{}})).status,200);
  assert.equal((await request('/api/auth/me',{session:temporary})).status,401);
});

test('failed logins are throttled without disclosing whether an account exists',async()=>{
  for(let i=0;i<5;i++){const result=await request('/api/auth/login',{method:'POST',body:{email:'missing@example.test',password:'wrong'}});assert.equal(result.status,401);assert.equal(result.data.error,'ایمیل، رمز یا کد دومرحله‌ای صحیح نیست.');}
  assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'missing@example.test',password:'wrong'}})).status,429);
});
