import test from 'node:test';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { createUser } from '../src/auth.mjs';
import { openDatabase,getSite } from '../src/database.mjs';
import { putContent,listContent } from '../src/content.mjs';
import { uploadMedia } from '../src/media.mjs';
import { exportSite } from '../src/export.mjs';
import { createBackup,restoreBackup } from '../src/backup.mjs';
import { themeCSS,defaultTheme } from '../src/templates.mjs';

const origin='http://cms.test',password='Template-test-only-123!';
const content=(more={})=>({kind:'pages',title:'صفحه آزمایشی',slug:'sample',excerpt:'خلاصه',body:'متن قدیمی حفظ می‌شود',status:'draft',seo_title:'',seo_description:'',blocks:[],categoryIds:[],...more});
const png=await sharp({create:{width:8,height:8,channels:3,background:'#a18c6c'}}).png().toBuffer();
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'cms-templates-')),dbPath=join(dir,'source/cms.sqlite');
  const app=await createApp({dbPath,origin,publicURL:'https://example.com'});const user=await createUser(app.db,{email:'admin@example.test',password});await createUser(app.db,{email:'editor@example.test',password,role:'editor'});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  async function request(path,{method='GET',body,session,csrf=true}={}) {
    const headers={};if(!['GET','HEAD'].includes(method))headers.Origin=origin;if(session){headers.Cookie=session.cookie;if(csrf)headers['X-CSRF-Token']=session.csrf;}if(body!==undefined)headers['Content-Type']='application/json';
    const res=await fetch(base+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:res.status,data,headers:res.headers};
  }
  async function login(email){const result=await request('/api/auth/login',{method:'POST',body:{email,password}});assert.equal(result.status,200);return {cookie:result.headers.get('set-cookie').split(';')[0],csrf:result.data.csrf};}
  const admin=await login('admin@example.test'),editor=await login('editor@example.test');
  const req=(path,options={})=>request(path,{session:admin,...options});
  const image=()=>uploadMedia(app.db,app.mediaDir,png,{mime:'image/png',filename:'template.png',userId:user.id});
  return {dir,dbPath,app,req,admin,editor,image};
}

test('theme changes are admin/CSRF controlled, reject injection/stale changes and preserve content',async t=>{
  const f=await fixture(t),item=putContent(f.app.db,content());const site=(await f.req('/api/settings')).data;
  assert.equal((await f.req('/api/templates',{session:null})).status,401);
  assert.equal((await f.req('/api/templates',{session:f.editor})).data.siteTemplates.length,2);
  const body={...site,theme:{template:'services',primaryColor:'#fbc342',corners:'square'}};
  assert.equal((await f.req('/api/settings',{method:'PUT',session:f.editor,body})).status,403);
  assert.equal((await f.req('/api/settings',{method:'PUT',csrf:false,body})).status,403);
  const changed=await f.req('/api/settings',{method:'PUT',body});assert.equal(changed.status,200);assert.notEqual(changed.data.theme_updated_at,site.theme_updated_at);
  assert.equal((await f.req('/api/settings',{method:'PUT',body:{...site,theme:{...defaultTheme,primaryColor:'#123456'}}})).status,409);
  assert.equal((await f.req('/api/settings',{method:'PUT',body:{...changed.data,theme:{...defaultTheme,primaryColor:'#fff;url(secret)'}}})).status,422);
  assert.equal((await f.req('/api/settings',{method:'PUT',body:{...changed.data,theme:{...defaultTheme,template:'<script>'}}})).status,422);
  assert.deepEqual(listContent(f.app.db)[0],item);
  assert.match((await f.req('/')).data,/site-template-services/);assert.match((await f.req('/assets/theme.css')).data,/--brand:#fbc342;--on-brand:#000000/);
  assert.match(themeCSS(defaultTheme),/--on-brand:#ffffff/);
});

test('page templates validate kind, retain legacy text/blocks and use conflict-safe edits',async t=>{
  const {req,editor}=await fixture(t);
  const original=(await req('/api/content',{method:'POST',session:editor,body:content({blocks:[{type:'paragraph',text:'بلوک حفظ‌شده'}]})})).data;
  const body={...original,template:'landing',expected_updated_at:original.updated_at};
  const changed=await req(`/api/content/${original.id}`,{method:'PUT',session:editor,body});assert.equal(changed.status,200);assert.equal(changed.data.body,original.body);assert.deepEqual(changed.data.blocks,original.blocks);assert.equal(changed.data.slug,original.slug);
  assert.equal((await req(`/api/content/${original.id}`,{method:'PUT',body})).status,409);
  assert.equal((await req('/api/content',{method:'POST',body:content({slug:'bad',template:'article'})})).status,422);
  assert.equal((await req('/api/content',{method:'POST',body:content({kind:'posts',slug:'post'})})).data.template,'article');
  assert.equal((await req('/api/content',{method:'POST',body:content({kind:'portfolio',slug:'project'})})).data.template,'case-study');
});

test('private preview requires an active session, is noindex/no-store and never publishes a draft',async t=>{
  const f=await fixture(t),image=await f.image();
  const original=putContent(f.app.db,content({template:'landing',blocks:[{type:'hero',variant:'split',title:'راز پیش‌نویس',text:'متن خصوصی',mediaId:image.id,alt:'تصویر خصوصی'}]}));
  const path=`/api/content/${original.id}/preview`;
  assert.equal((await f.req(path,{session:null})).status,401);
  const preview=await f.req(path,{session:f.editor});assert.equal(preview.status,200);assert.equal(preview.headers.get('cache-control'),'no-store');assert.match(preview.headers.get('x-robots-tag'),/noindex/);
  assert.match(preview.data,/راز پیش‌نویس/);assert.match(preview.data,/page-template-landing/);assert.doesNotMatch(preview.data,/rel="canonical"/);assert.match(preview.data,/noindex,nofollow,noarchive/);
  assert.equal((await f.req('/sample/',{session:null})).status,404);assert.equal((await f.req(`/media/${image.id}.png`,{session:null})).status,404);
  assert.doesNotMatch((await f.req('/api/public/content')).data.content.map(item=>item.title).join(''),/آزمایشی/);assert.equal(listContent(f.app.db)[0].status,'draft');
  const site=getSite(f.app.db);await f.req('/api/settings',{method:'PUT',body:{...site,enabledModules:['pages']}});
  const service=putContent(f.app.db,content({kind:'services',slug:'hidden'}));assert.equal((await f.req(`/api/content/${service.id}/preview`)).status,404);
});

test('hero/card nested images respect publication and deletion rules; unpublished link targets stay private',async t=>{
  const f=await fixture(t),image=await f.image(),draft=putContent(f.app.db,content({slug:'secret',title:'مقصد خصوصی'}));
  const blocks=[{type:'hero',variant:'centered',title:'معرفی <script>',text:'متن',mediaId:image.id,alt:'تصویر',contentId:draft.id,label:'مقصد'}, {type:'cards',variant:'list',title:'خدمات',items:[{title:'کارت <img>',text:'توضیح',mediaId:image.id,contentId:draft.id}]},{type:'faq',title:'پرسش‌ها',items:[{question:'پرسش <script>',answer:'پاسخ <iframe>'}]}];
  let page=putContent(f.app.db,content({slug:'sections',blocks,status:'published'}));
  let html=(await f.req('/sections/',{session:null})).data;assert.match(html,/section-hero-centered/);assert.match(html,/cards-list/);assert.match(html,/<details><summary>پرسش &lt;script&gt;/);assert.doesNotMatch(html,/href="\/secret\/"|<iframe>|<img>/);
  const publicData=(await f.req('/api/public/content',{session:null})).data;assert.doesNotMatch(JSON.stringify(publicData),new RegExp(draft.id));
  assert.equal((await f.req(`/media/${image.id}.png`,{session:null})).status,200);
  assert.equal((await f.req(`/api/media/${image.id}`,{method:'DELETE',body:{expected_updated_at:image.updated_at}})).status,409);
  const target=putContent(f.app.db,{...draft,status:'published'},draft.id);html=(await f.req('/sections/')).data;assert.match(html,/href="\/secret\/"/);
  page=putContent(f.app.db,{...page,status:'draft'},page.id);assert.equal((await f.req(`/media/${image.id}.png`,{session:null})).status,404);
  putContent(f.app.db,{...page,blocks:[]},page.id);assert.equal((await f.req(`/api/media/${image.id}`,{method:'DELETE',body:{expected_updated_at:image.updated_at}})).status,200);assert.ok(target.id);
});

test('section models reject unsupported layouts, nonexistent references and excessive nested items',async t=>{
  const {req}=await fixture(t);
  const invalid=[{type:'hero',variant:'<svg>',title:'A',text:''},{type:'hero',variant:'split',title:'A',text:'',mediaId:'missing'},{type:'cards',variant:'grid',items:[]},{type:'cards',variant:'grid',items:Array.from({length:13},()=>({title:'A',text:''}))},{type:'cards',variant:'list',items:[{title:'A',text:'',contentId:'missing'}]},{type:'faq',items:[{question:'',answer:'A'}]},{type:'faq',items:[{question:'A',answer:'x'.repeat(4001)}]}];
  for(const block of invalid)assert.equal((await req('/api/content',{method:'POST',body:content({blocks:[block]})})).status,422);
});

test('static export includes the selected theme and nested public media with correct subpaths and excludes drafts',async t=>{
  const f=await fixture(t),image=await f.image(),privateImage=await f.image();
  putContent(f.app.db,content({slug:'home',title:'خانه',status:'published',template:'landing',blocks:[{type:'cards',variant:'grid',items:[{title:'کارت',text:'متن',mediaId:image.id}]}]}));
  putContent(f.app.db,content({slug:'secret',blocks:[{type:'hero',variant:'split',title:'راز',text:'',mediaId:privateImage.id}]}));
  const site=getSite(f.app.db);assert.equal((await f.req('/api/settings',{method:'PUT',body:{...site,theme:{...site.theme,template:'services'}}})).status,200);
  await f.app.close();const output=join(f.dir,'export');await exportSite({dbPath:f.dbPath,outputDir:output,publicURL:'https://example.com/customer'});
  const html=await readFile(join(output,'index.html'),'utf8');assert.match(html,/site-template-services/);assert.match(html,/page-template-landing/);assert.match(html,/href="\/customer\/assets\/theme.css"/);assert.match(html,new RegExp(`/customer/media/${image.id}.png`));assert.doesNotMatch(html,/راز/);
  assert.deepEqual(await readdir(join(output,'media')),[`${image.id}.png`]);assert.match(await readFile(join(output,'assets/theme.css'),'utf8'),/--brand:#245c73/);
});

test('schema 4 upgrades once and backups preserve theme and page/section choices after restore',async t=>{
  const f=await fixture(t),image=await f.image();const item=putContent(f.app.db,content({template:'landing',blocks:[{type:'hero',variant:'centered',title:'معرفی',text:'',mediaId:image.id}]}));
  const site=getSite(f.app.db);await f.req('/api/settings',{method:'PUT',body:{...site,theme:{...site.theme,template:'services',primaryColor:'#267651'}}});
  await f.app.close();const outputDir=join(f.dir,'backup');await createBackup({dbPath:f.dbPath,outputDir});const restored=await restoreBackup({inputDir:outputDir,dbPath:join(f.dir,'restored/cms.sqlite')});
  let db=openDatabase(restored.database);assert.equal(getSite(db).theme.template,'services');assert.equal(listContent(db)[0].template,'landing');assert.deepEqual(listContent(db)[0].blocks,item.blocks);db.close();
  const oldBlocks=[{type:'image',mediaId:image.id,alt:'تصویر قدیمی',caption:''}];
  db=openDatabase(f.dbPath);db.prepare('UPDATE content SET blocks=?').run(JSON.stringify(oldBlocks));db.exec('ALTER TABLE content DROP COLUMN template; DELETE FROM schema_versions WHERE version=5');const old=getSite(db);delete old.theme;delete old.theme_updated_at;db.prepare("UPDATE settings SET value=? WHERE key='site'").run(JSON.stringify(old));db.close();
  for(let i=0;i<2;i++){db=openDatabase(f.dbPath);assert.equal(db.prepare('SELECT MAX(version) AS n FROM schema_versions').get().n,5);assert.equal(listContent(db)[0].template,'standard');assert.deepEqual(listContent(db)[0].blocks,oldBlocks);assert.deepEqual(getSite(db).theme,defaultTheme);db.close();}
});
