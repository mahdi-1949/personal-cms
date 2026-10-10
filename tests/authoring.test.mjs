import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.mjs';
import { createUser,hashPassword,digest } from '../src/auth.mjs';
import { openDatabase } from '../src/database.mjs';
import { exportSite } from '../src/export.mjs';

const origin='http://cms.test',password='Authoring-test-only-123!';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
let dir,dbPath,mediaDir,app,base,admin,editor;
async function req(path,{method='GET',body,session=admin,bytes,mime='image/png',filename='test.png'}={}) {
  const headers={};if(session){headers.Cookie=session.cookie;headers['X-CSRF-Token']=session.csrf;}
  if(method!=='GET' && method!=='HEAD')headers.Origin=origin;
  if(bytes){headers['Content-Type']=mime;headers['X-Filename']=encodeURIComponent(filename);}
  else if(body!==undefined)headers['Content-Type']='application/json';
  const res=await fetch(base+path,{method,headers,...(bytes?{body:bytes}:body!==undefined?{body:JSON.stringify(body)}:{})});
  const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:res.status,data,headers:res.headers};
}
async function login(email,pwd=password){
  const result=await req('/api/auth/login',{method:'POST',session:null,body:{email,password:pwd}});assert.equal(result.status,200,JSON.stringify(result.data));
  return {cookie:result.headers.get('set-cookie').split(';')[0],csrf:result.data.csrf};
}
const item=(overrides={})=>({kind:'pages',slug:'authoring',title:'صفحه آزمایشی',body:'متن قدیمی',excerpt:'خلاصه',status:'draft',seo_title:'',seo_description:'',...overrides});
before(async()=>{
  dir=await mkdtemp(join(tmpdir(),'cms-authoring-'));dbPath=join(dir,'data/cms.sqlite');mediaDir=join(dir,'data/media');
  app=await createApp({dbPath,mediaDir,origin,publicURL:'https://example.com'});
  await createUser(app.db,{email:'admin@example.test',password});await createUser(app.db,{email:'editor@example.test',password,role:'editor'});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;
  admin=await login('admin@example.test');editor=await login('editor@example.test');
});
after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});

test('v0.1 database upgrades twice without losing content, settings, hashes or sessions',async()=>{
  const legacy=join(dir,'legacy.sqlite');const old=new DatabaseSync(legacy);const hash=await hashPassword(password);
  old.exec(`CREATE TABLE schema_versions(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
    INSERT INTO schema_versions VALUES(1,'2026-01-01');
    CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE login_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE content(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,slug TEXT NOT NULL,excerpt TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,seo_title TEXT NOT NULL,seo_description TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(kind,slug));`);
  old.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('legacy-user','legacy@example.test',hash,'admin','2026-01-01');
  old.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest('a'.repeat(64)),'legacy-user','old-csrf',Date.now()+60000);
  old.prepare('INSERT INTO settings VALUES(?,?)').run('site',JSON.stringify({name:'Legacy site',description:'old',enabledModules:['pages']}));
  old.prepare('INSERT INTO content VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('legacy-page','pages','عنوان قدیمی','legacy','خلاصه','متن قدیمی','published','','','2026-01-01','2026-01-01');old.close();
  for(let i=0;i<2;i++){
    const db=openDatabase(legacy);
    try{
      assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_versions').get().version,6);
      assert.equal(db.prepare('SELECT * FROM content').get().body,'متن قدیمی');assert.equal(db.prepare('SELECT * FROM content').get().blocks,'[]');
      assert.equal(db.prepare('SELECT * FROM users').get().password_hash,hash);assert.equal(db.prepare('SELECT * FROM users').get().active,1);
      assert.match(db.prepare('SELECT * FROM sessions').get().session_id,/^[a-f0-9-]{36}$/);
      assert.equal(JSON.parse(db.prepare('SELECT * FROM settings').get().value).name,'Legacy site');
    }finally{db.close();}
  }
});

test('user API hides credentials, enforces admin permissions and protects the last administrator',async()=>{
  const users=await req('/api/users');assert.equal(users.status,200);assert.doesNotMatch(JSON.stringify(users.data),/password_hash|scrypt|csrf|token_hash/);
  assert.equal((await req('/api/users',{session:editor})).status,403);
  assert.equal((await req('/api/users',{method:'POST',session:editor,body:{email:'blocked@example.test',password,role:'admin',active:true}})).status,403);
  const user=users.data.users.find(user=>user.role==='admin');
  const last=await req(`/api/users/${user.id}`,{method:'PUT',body:{...user,active:false,expected_updated_at:user.updated_at}});assert.equal(last.status,409);
  const invalid=await req('/api/users',{method:'POST',body:{email:'new@example.test',password:'short',role:'editor',active:true}});assert.equal(invalid.status,422);
  const created=await req('/api/users',{method:'POST',body:{email:'new@example.test',password,role:'editor',active:true}});assert.equal(created.status,201);assert.equal(created.data.active,true);
  assert.equal((await req('/api/users',{method:'POST',body:{email:'new@example.test',password,role:'editor',active:true}})).status,409);
  const newSession=await login('new@example.test');
  const disabled=await req(`/api/users/${created.data.id}`,{method:'PUT',body:{...created.data,active:false,expected_updated_at:created.data.updated_at}});assert.equal(disabled.status,200);
  assert.equal((await req('/api/auth/me',{session:newSession})).status,401);
  assert.equal((await req('/api/auth/login',{method:'POST',session:null,body:{email:'new@example.test',password}})).status,401);
  assert.equal((await req(`/api/users/${created.data.id}`,{method:'PUT',body:{...created.data,expected_updated_at:created.data.updated_at}})).status,409);
});

test('sessions can be revoked only by their owner; password changes revoke all sessions',async()=>{
  const other=await login('editor@example.test');const mine=(await req('/api/auth/sessions',{session:editor})).data.sessions;
  assert.equal(mine.length,2);assert.equal(mine.filter(row=>row.current).length,1);assert.doesNotMatch(JSON.stringify(mine),/token_hash|csrf|scrypt/);
  const current=mine.find(row=>row.current);
  assert.equal((await req(`/api/auth/sessions/${current.id}`,{method:'DELETE',session:admin,body:{}})).status,404);
  const old=mine.find(row=>!row.current);
  assert.equal((await req(`/api/auth/sessions/${old.id}`,{method:'DELETE',session:editor,body:{}})).status,200);
  assert.equal((await req('/api/auth/me',{session:other})).status,401);
  assert.equal((await req('/api/auth/password',{method:'PUT',session:editor,body:{currentPassword:'wrong',newPassword:'New-editor-password-123!'}})).status,422);
  assert.equal((await req('/api/auth/password',{method:'PUT',session:editor,body:{currentPassword:password,newPassword:'New-editor-password-123!'}})).status,200);
  assert.equal((await req('/api/auth/me',{session:editor})).status,401);
  editor=await login('editor@example.test','New-editor-password-123!');
});

let image,page;
test('uploads enforce image format and size; unpublished images remain private',async()=>{
  const uploaded=await req('/api/media',{method:'POST',session:editor,bytes:png,filename:'آزمایش.png'});assert.equal(uploaded.status,201,JSON.stringify(uploaded.data));image=uploaded.data;assert.equal(image.width,1);
  const path=`/media/${image.id}.png`;
  assert.equal((await req(path,{session:null})).status,404);assert.equal((await req(path,{session:editor})).status,200);
  assert.equal((await req('/api/media',{method:'POST',bytes:Buffer.from('<svg onload="alert(1)"></svg>'),mime:'image/svg+xml'})).status,422);
  assert.equal((await req('/api/media',{method:'POST',bytes:Buffer.from('<script>bad</script>'),mime:'image/png'})).status,422);
  assert.equal((await req('/api/media',{method:'POST',bytes:Buffer.alloc(5*1024*1024+1)})).status,413);
  const alt=await req(`/api/media/${image.id}`,{method:'PUT',session:editor,body:{alt:'تصویر آزمایشی',expected_updated_at:image.updated_at}});assert.equal(alt.status,200);image=alt.data;
});

test('block content escapes HTML, validates references and prevents deleting used images',async()=>{
  const blocks=[{type:'heading',text:'عنوان بخش',level:2},{type:'paragraph',text:'<script>alert(1)</script>'},{type:'image',mediaId:image.id,alt:'',caption:'توضیح تصویر'}];
  const created=await req('/api/content',{method:'POST',session:editor,body:item({blocks})});assert.equal(created.status,201);page=created.data;assert.ok(Array.isArray(page.blocks));
  const list=await req('/api/content');assert.ok(Array.isArray(list.data.content.find(row=>row.id===page.id).blocks));
  assert.equal((await req(`/api/media/${image.id}`,{method:'DELETE',body:{expected_updated_at:image.updated_at}})).status,409);
  assert.equal((await req('/api/content',{method:'POST',body:item({slug:'invalid-block',blocks:[{type:'html',text:'bad'}]})})).status,422);
  assert.equal((await req('/api/content',{method:'POST',body:item({slug:'bad-image',blocks:[{type:'image',mediaId:'missing',alt:'',caption:''}]})})).status,422);
  assert.equal((await req('/api/content',{method:'POST',body:item({slug:'bad-cta',blocks:[{type:'cta',label:'Click',contentId:'javascript:alert(1)'}]})})).status,422);
  const published=await req(`/api/content/${page.id}`,{method:'PUT',body:{...page,status:'published',expected_updated_at:page.updated_at}});assert.equal(published.status,200);page=published.data;
  const html=await req('/authoring/',{session:null});assert.equal(html.status,200);assert.match(html.data,/&lt;script&gt;/);assert.doesNotMatch(html.data,/<script>/);assert.match(html.data,/alt="تصویر آزمایشی"/);
  assert.equal((await req(`/media/${image.id}.png`,{session:null})).status,200);
  const head=await req('/authoring/',{method:'HEAD',session:null});assert.equal(head.status,200);assert.equal(head.data,'');
});

test('menu resolves IDs after slug changes and suppresses unpublished links and CTAs',async()=>{
  const draft=(await req('/api/content',{method:'POST',body:item({slug:'private-target',title:'عنوان خصوصی'})})).data;
  const menu=(await req('/api/navigation')).data;
  assert.equal((await req('/api/navigation',{method:'PUT',session:editor,body:{items:[],expected_updated_at:menu.updated_at}})).status,403);
  const result=await req('/api/navigation',{method:'PUT',body:{items:[{label:'لینک عمومی',contentId:page.id},{label:'لینک خصوصی',contentId:draft.id}],expected_updated_at:menu.updated_at}});assert.equal(result.status,200);
  page=(await req(`/api/content/${page.id}`,{method:'PUT',body:{...page,slug:'renamed-authoring',blocks:[...page.blocks,{type:'cta',label:'مقصد خصوصی',contentId:draft.id}],expected_updated_at:page.updated_at}})).data;
  const home=(await req('/',{session:null})).data;assert.match(home,/href="\/renamed-authoring\/"/);assert.doesNotMatch(home,/لینک خصوصی|private-target/);
  const html=(await req('/renamed-authoring/',{session:null})).data;assert.doesNotMatch(html,/مقصد خصوصی/);
  assert.doesNotMatch(JSON.stringify((await req('/api/public/content',{session:null})).data),/مقصد خصوصی|private-target/);
  assert.equal((await req('/api/navigation',{method:'PUT',body:{items:[],expected_updated_at:menu.updated_at}})).status,409);
});

test('export copies only published block media and keeps private media out of static output',async()=>{
  const privateImage=(await req('/api/media',{method:'POST',bytes:png,filename:'private.png'})).data;
  const outputDir=join(dir,'static');await exportSite({dbPath,mediaDir,outputDir,publicURL:'https://account.github.io/project'});
  const files=await readdir(join(outputDir,'media'));assert.deepEqual(files,[`${image.id}.png`]);assert.ok(!files.includes(`${privateImage.id}.png`));
  const html=await readFile(join(outputDir,'renamed-authoring/index.html'),'utf8');assert.match(html,new RegExp(`/project/media/${image.id}.png`));assert.doesNotMatch(html,/مقصد خصوصی/);
  const home=await readFile(join(outputDir,'index.html'),'utf8');assert.match(home,/href="\/project\/renamed-authoring\/"/);
  assert.equal((await req(`/api/media/${privateImage.id}`,{method:'DELETE',session:editor,body:{expected_updated_at:privateImage.updated_at}})).status,403);
  assert.equal((await req(`/api/media/${privateImage.id}`,{method:'DELETE',body:{expected_updated_at:privateImage.updated_at}})).status,200);
});

test('unpublishing a page removes public menu and image access',async()=>{
  page=(await req(`/api/content/${page.id}`,{method:'PUT',body:{...page,status:'draft',expected_updated_at:page.updated_at}})).data;
  assert.equal((await req(`/media/${image.id}.png`,{session:null})).status,404);
  assert.doesNotMatch((await req('/',{session:null})).data,/لینک عمومی/);
  assert.equal((await req('/api/public/content',{session:null})).data.menu.length,0);
});
