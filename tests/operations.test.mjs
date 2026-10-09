import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { createUser,digest } from '../src/auth.mjs';
import { exportSite } from '../src/export.mjs';

const origin='http://cms.test',password='Operations-test-only-123!';
const content=(more={})=>({kind:'posts',title:'مقاله عمومی',slug:'post',excerpt:'خلاصه',body:'متن',status:'published',seo_title:'',seo_description:'',blocks:[],categoryIds:[],...more});
const contact=token=>({token,name:'کاربر آزمایشی',email:'reader@example.test',subject:'سؤال درباره خدمات',message:'پیام آزمایشی خصوصی',website:''});
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'cms-operations-'));const dbPath=join(dir,'data/cms.sqlite');
  const app=await createApp({dbPath,origin,publicURL:'https://example.com'});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  await createUser(app.db,{email:'admin@example.test',password});await createUser(app.db,{email:'editor@example.test',password,role:'editor'});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  async function request(path,{method='GET',body,session,originHeader=origin,csrf=true}={}){
    const headers={};if(method!=='GET' && method!=='HEAD')headers.Origin=originHeader;
    if(session){headers.Cookie=session.cookie;if(csrf)headers['X-CSRF-Token']=session.csrf;}
    if(body!==undefined)headers['Content-Type']='application/json';
    const res=await fetch(base+path,{method,headers,redirect:'manual',...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:res.status,data,headers:res.headers};
  }
  async function login(email){const result=await request('/api/auth/login',{method:'POST',body:{email,password}});assert.equal(result.status,200);return {cookie:result.headers.get('set-cookie').split(';')[0],csrf:result.data.csrf};}
  const admin=await login('admin@example.test'),editor=await login('editor@example.test');
  const req=(path,options={})=>request(path,{session:admin,...options});
  async function enable(enabled=true){const site=(await req('/api/settings')).data;const result=await req('/api/settings',{method:'PUT',body:{...site,contactEnabled:enabled}});assert.equal(result.status,200,JSON.stringify(result.data));}
  async function token({age=3000,ip}={}){const result=await req('/api/public/contact-token',{session:null});assert.equal(result.status,200);app.db.prepare('UPDATE contact_tokens SET issued_at=? WHERE token_hash=?').run(Date.now()-age,digest(result.data.token));if(ip)app.db.prepare('UPDATE contact_tokens SET ip_hash=? WHERE token_hash=?').run(digest(ip),digest(result.data.token));return result.data.token;}
  return {dir,dbPath,app,req,admin,editor,enable,token};
}

test('categories are administered, assigned only to posts, and expose only published archives',async t=>{
  const {req,editor}=await fixture(t);
  assert.equal((await req('/api/categories',{method:'POST',session:editor,body:{name:'ممنوع',slug:'forbidden'}})).status,403);
  const category=(await req('/api/categories',{method:'POST',body:{name:'طراحی <وب>',slug:'design'}})).data;
  assert.equal((await req('/api/categories',{method:'POST',body:{name:'تکرار',slug:'design'}})).status,409);
  assert.equal((await req('/api/content',{method:'POST',body:content({kind:'pages',categoryIds:[category.id]})})).status,422);
  assert.equal((await req('/api/content',{method:'POST',body:content({categoryIds:['missing']})})).status,422);
  assert.equal((await req('/api/content',{method:'POST',body:content({categoryIds:[category.id,category.id]})})).status,422);
  const draft=(await req('/api/content',{method:'POST',body:content({title:'عنوان خصوصی',status:'draft',categoryIds:[category.id]})})).data;
  assert.equal((await req('/articles/category/design/',{session:null})).status,404);
  const published=(await req(`/api/content/${draft.id}`,{method:'PUT',session:editor,body:{...draft,status:'published',title:'مقاله عمومی',expected_updated_at:draft.updated_at}})).data;
  assert.deepEqual(published.categoryIds,[category.id]);
  const html=await req('/articles/category/design/',{session:null});assert.equal(html.status,200);assert.match(html.data,/طراحی &lt;وب&gt;/);assert.doesNotMatch(html.data,/عنوان خصوصی/);
  assert.match((await req('/articles/post/',{session:null})).data,/href="\/articles\/category\/design\/"/);
  assert.match((await req('/sitemap.xml',{session:null})).data,/articles\/category\/design\//);
  const api=(await req('/api/public/content',{session:null})).data;assert.equal(api.categories[0].count,1);
  assert.equal((await req(`/api/categories/${category.id}`,{method:'DELETE',body:{expected_updated_at:category.updated_at}})).status,409);
  assert.equal((await req(`/api/categories/${category.id}`,{method:'PUT',body:{...category,name:'جدید',expected_updated_at:'old'}})).status,409);
  await req(`/api/content/${published.id}`,{method:'PUT',body:{...published,categoryIds:[],expected_updated_at:published.updated_at}});
  assert.equal((await req(`/api/categories/${category.id}`,{method:'DELETE',body:{expected_updated_at:category.updated_at}})).status,200);
});

test('slug history resolves directly to the current URL, protects aliases and never redirects to drafts',async t=>{
  const {req,editor}=await fixture(t);
  let item=(await req('/api/content',{method:'POST',body:content({kind:'pages',slug:'first'})})).data;
  for(const slug of ['second','third']){const result=await req(`/api/content/${item.id}`,{method:'PUT',body:{...item,slug,expected_updated_at:item.updated_at}});assert.equal(result.status,200);item=result.data;}
  for(const path of ['/first/','/first','/second/']){const result=await req(path,{session:null});assert.equal(result.status,308);assert.equal(result.headers.get('location'),'/third/');}
  assert.equal((await req('/api/content',{method:'POST',body:content({kind:'pages',slug:'first'})})).status,409);
  assert.equal((await req('/api/redirects',{session:editor})).status,403);
  assert.equal((await req('/api/redirects',{method:'POST',body:{path:'https://evil.test/',contentId:item.id}})).status,422);
  assert.equal((await req('/api/redirects',{method:'POST',body:{path:'/admin/',contentId:item.id}})).status,422);
  assert.equal((await req('/api/redirects',{method:'POST',body:{path:'/third/',contentId:item.id}})).status,409);
  const manual=(await req('/api/redirects',{method:'POST',body:{path:'/campaign/',contentId:item.id}})).data;
  assert.equal((await req('/campaign/',{session:null})).headers.get('location'),'/third/');
  item=(await req(`/api/content/${item.id}`,{method:'PUT',body:{...item,slug:'first',expected_updated_at:item.updated_at}})).data;
  assert.equal((await req('/first/',{session:null})).status,200);assert.equal((await req('/third/',{session:null})).headers.get('location'),'/first/');
  item=(await req(`/api/content/${item.id}`,{method:'PUT',body:{...item,status:'draft',expected_updated_at:item.updated_at}})).data;
  assert.equal((await req('/second/',{session:null})).status,404);assert.equal((await req('/campaign/',{session:null})).status,404);
  assert.equal((await req(`/api/redirects/${manual.id}`,{method:'DELETE',body:{expected_updated_at:'stale'}})).status,409);
  assert.equal((await req(`/api/content/${item.id}`,{method:'DELETE',body:{expected_updated_at:item.updated_at}})).status,200);
  assert.equal((await req('/api/redirects')).data.redirects.length,0);
});

test('category renames keep redirects and disabling articles hides archives and their redirects',async t=>{
  const {req}=await fixture(t);
  let category=(await req('/api/categories',{method:'POST',body:{name:'توسعه',slug:'dev'}})).data;
  await req('/api/content',{method:'POST',body:content({categoryIds:[category.id]})});
  category=(await req(`/api/categories/${category.id}`,{method:'PUT',body:{...category,slug:'development',expected_updated_at:category.updated_at}})).data;
  const alias=await req('/articles/category/dev/',{session:null});assert.equal(alias.status,308);assert.equal(alias.headers.get('location'),'/articles/category/development/');
  assert.equal((await req('/api/categories',{method:'POST',body:{name:'تکرار',slug:'dev'}})).status,409);
  const site=(await req('/api/settings')).data;await req('/api/settings',{method:'PUT',body:{...site,enabledModules:['pages']}});
  for(const path of ['/articles/category/dev/','/articles/category/development/'])assert.equal((await req(path,{session:null})).status,404);
  assert.deepEqual((await req('/api/public/content',{session:null})).data.categories,[]);
});

test('contact form is opt-in and exposes accessible assets without admin credentials',async t=>{
  const {req,enable}=await fixture(t);
  assert.equal((await req('/contact/',{session:null})).status,404);assert.equal((await req('/api/public/contact-token',{session:null})).status,404);
  assert.equal((await req('/api/content',{method:'POST',body:content({kind:'pages',slug:'contact'})})).status,422);
  await enable();const html=await req('/contact/',{session:null});assert.equal(html.status,200);assert.match(html.data,/id="contact-form"/);assert.match(html.data,/aria-live="polite"/);assert.match(html.data,/src="\/assets\/contact.js"/);
  assert.equal((await req('/contact',{session:null})).status,308);
  for(const path of ['/assets/contact.js','/assets/operations.js']){const result=await req(path,{session:null});assert.equal(result.status,200);assert.match(result.headers.get('content-type'),/javascript/);}
  assert.equal((await req('/api/settings',{method:'PUT',body:{...(await req('/api/settings')).data,contactEnabled:null}})).status,422);
  await enable(false);assert.equal((await req('/api/public/contact',{method:'POST',session:null,body:contact('a'.repeat(64))})).status,404);
});

test('anonymous contact submissions validate one-use tokens, timing, IP, expiry and fields',async t=>{
  const {req,app,enable,token}=await fixture(t);await enable();
  const fresh=await token({age:0});
  assert.equal((await req('/api/public/contact',{method:'POST',session:null,body:contact(fresh)})).status,422);
  app.db.prepare('UPDATE contact_tokens SET issued_at=?').run(Date.now()-3000);
  assert.equal((await req('/api/public/contact',{method:'POST',session:null,originHeader:'https://evil.test',body:contact(fresh)})).status,403);
  const sent=await req('/api/public/contact',{method:'POST',session:null,body:contact(fresh)});assert.equal(sent.status,201);assert.deepEqual(sent.data,{ok:true,message:'پیام شما ثبت شد.'});
  assert.equal((await req('/api/public/contact',{method:'POST',session:null,body:contact(fresh)})).status,422);
  assert.equal((await req('/api/public/contact',{method:'POST',session:null,body:contact(await token({ip:'other-client'}))})).status,422);
  const expired=await token();app.db.prepare('UPDATE contact_tokens SET expires_at=? WHERE token_hash=?').run(Date.now()-1,digest(expired));
  assert.equal((await req('/api/public/contact',{method:'POST',session:null,body:contact(expired)})).status,422);
  assert.equal((await req('/api/public/contact',{method:'POST',session:null,body:{...contact(await token()),email:'invalid'}})).status,422);
  assert.equal((await req('/api/public/contact',{method:'POST',session:null,body:{...contact(await token()),message:'x'.repeat(5001)}})).status,422);
  assert.equal((await req('/api/public/contact',{method:'POST',session:null,body:{...contact(await token()),website:'bot.example'}})).status,201);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
  assert.doesNotMatch(JSON.stringify((await req('/api/public/content',{session:null})).data),/reader@example.test|پیام آزمایشی خصوصی/);
});

test('contact throttles requests and enforces a bounded inbox',async t=>{
  const {req,app,enable,token}=await fixture(t);await enable();
  for(let i=0;i<10;i++)assert.equal((await req('/api/public/contact',{method:'POST',session:null,body:contact('a'.repeat(64))})).status,422);
  assert.equal((await req('/api/public/contact',{method:'POST',session:null,body:contact('a'.repeat(64))})).status,429);
  app.db.exec('DELETE FROM contact_limits;');
  for(let i=0;i<30;i++)assert.equal((await req('/api/public/contact-token',{session:null})).status,200);
  assert.equal((await req('/api/public/contact-token',{session:null})).status,429);
  app.db.exec('DELETE FROM contact_limits;');const value=await token();
  const insert=app.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)');
  app.db.exec('BEGIN');for(let i=0;i<10000;i++)insert.run(`message-${i}`,'User','u@example.test','Subject','Body','new','2026-01-01','2026-01-01');app.db.exec('COMMIT');
  assert.equal((await req('/api/public/contact',{method:'POST',session:null,body:contact(value)})).status,503);
});

test('inbox protects personal data, paginates and requires CSRF and current version for changes',async t=>{
  const {req,app,editor,enable,token}=await fixture(t);await enable();
  await req('/api/public/contact',{method:'POST',session:null,body:{...contact(await token()),message:'<script>alert(1)</script>'}});
  assert.equal((await req('/api/messages',{session:null})).status,401);assert.equal((await req('/api/messages',{session:editor})).status,403);
  const inbox=(await req('/api/messages')).data;assert.equal(inbox.total,1);const item=inbox.messages[0];
  assert.equal((await req(`/api/messages/${item.id}`,{method:'PUT',csrf:false,body:{status:'read',expected_updated_at:item.updated_at}})).status,403);
  let result=await req(`/api/messages/${item.id}`,{method:'PUT',body:{status:'read',expected_updated_at:item.updated_at}});assert.equal(result.status,200);
  assert.equal((await req('/api/messages?status=new')).data.total,0);
  assert.equal((await req(`/api/messages/${item.id}`,{method:'DELETE',body:{expected_updated_at:item.updated_at}})).status,409);
  assert.equal((await req(`/api/messages/${item.id}`,{method:'DELETE',body:{expected_updated_at:result.data.updated_at}})).status,200);
  assert.equal((await req('/api/messages?page=-1')).status,422);assert.equal((await req('/api/messages?status=unknown')).status,422);
  const insert=app.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)');for(let i=0;i<51;i++)insert.run(`message-${i}`,'Name','n@example.test','Subject','Body','new','2026-01-01','2026-01-01');
  assert.equal((await req('/api/messages')).data.messages.length,50);assert.equal((await req('/api/messages?page=2')).data.messages.length,1);
});

test('static export includes category archives and internal redirect pages, excludes contact and inbox',async t=>{
  const {req,dir,dbPath,enable,token}=await fixture(t);await enable();
  await req('/api/public/contact',{method:'POST',session:null,body:contact(await token())});
  const category=(await req('/api/categories',{method:'POST',body:{name:'طراحی',slug:'design'}})).data;
  let item=(await req('/api/content',{method:'POST',body:content({slug:'old',categoryIds:[category.id]})})).data;
  item=(await req(`/api/content/${item.id}`,{method:'PUT',body:{...item,slug:'new',expected_updated_at:item.updated_at}})).data;
  const outputDir=join(dir,'dist');const result=await exportSite({dbPath,outputDir,publicURL:'https://account.github.io/project'});assert.equal(result.warnings.length,1);
  const alias=await readFile(join(outputDir,'articles/old/index.html'),'utf8');assert.match(alias,/0;url=\/project\/articles\/new\//);
  assert.match(await readFile(join(outputDir,'articles/category/design/index.html'),'utf8'),/href="\/project\/articles\/new\/"/);
  assert.match(await readFile(join(outputDir,'sitemap.xml'),'utf8'),/articles\/category\/design\//);
  const home=await readFile(join(outputDir,'index.html'),'utf8');assert.doesNotMatch(home,/contact\/|reader@example.test|پیام آزمایشی خصوصی/);
  await assert.rejects(readFile(join(outputDir,'contact/index.html')),/ENOENT/);
});
