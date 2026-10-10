import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../src/server.mjs';
import { createUser,createSession,digest } from '../src/auth.mjs';
import { putContent,listContent } from '../src/content.mjs';
import { getSite,openDatabase } from '../src/database.mjs';
import { saveDesign,getDesign,designList } from '../src/designs.mjs';
import { uploadMedia } from '../src/media.mjs';
import { createBackup,restoreBackup } from '../src/backup.mjs';
import { exportSite } from '../src/export.mjs';
import { encrypt } from '../src/security-crypto.mjs';
import { templateLibrary,validateTheme,defaultTheme } from '../src/templates.mjs';
const origin='http://cms.test',password='Design-test-only-password-123!';
const code=(more={})=>({name:'طرح اختصاصی',html:'<h2>PUBLIC-DESIGN</h2>',css:'body{margin:0;color:#123456}',js:"console.log('ready');",assets:[],...more});
const page=(more={})=>({kind:'pages',title:'خانه',slug:'home',body:'',excerpt:'خلاصه',status:'published',seo_title:'',seo_description:'',blocks:[],...more});
async function fixture(t,{requireAdminMfa=false}={}) {
  const dir=await mkdtemp(join(tmpdir(),'cms-design-')),dbPath=join(dir,'source/cms.sqlite'),key=randomBytes(32);
  const app=await createApp({dbPath,origin,securityKey:key,requireAdminMfa});const adminUser=await createUser(app.db,{email:'admin@example.test',password}),editorUser=await createUser(app.db,{email:'editor@example.test',password,role:'editor'});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  const makeSession=id=>{const s=createSession(app.db,id);return {cookie:`cms_session=${s.token}`,csrf:s.csrf,token:s.token};},admin=makeSession(adminUser.id),editor=makeSession(editorUser.id);
  async function req(path,{method='GET',body,session=admin,csrf=true,requestOrigin=origin}={}) {
    const headers={};if(session){headers.Cookie=session.cookie;if(csrf)headers['X-CSRF-Token']=session.csrf;}if(method!=='GET')headers.Origin=requestOrigin;if(body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(base+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:response.status,data,headers:response.headers};
  }
  const create=async data=>{const r=await req('/api/designs',{method:'POST',body:code(data)});assert.equal(r.status,201);return r.data;};
  const publish=async(d,revisionId=d.draft_id,more={})=>req(`/api/designs/${d.id}/publish`,{method:'POST',body:{revisionId,currentPassword:password,expected_updated_at:d.updated_at,...more}});
  const image=()=>uploadMedia(app.db,app.mediaDir,png,{mime:'image/png',filename:'asset.png',userId:adminUser.id});
  return {dir,dbPath,app,key,adminUser,editorUser,admin,editor,makeSession,req,create,publish,image};
}
const png=await sharp({create:{width:8,height:8,channels:3,background:'#abcdef'}}).png().toBuffer();

test('design permissions are opt-in for editors; granting/revoking access revokes sessions and previews',async t=>{
  const f=await fixture(t);assert.equal((await f.req('/api/designs',{session:null})).status,401);assert.equal((await f.req('/api/designs',{session:f.editor})).status,403);
  const user=(await f.req('/api/users')).data.users.find(u=>u.id===f.editorUser.id);let updated=await f.req(`/api/users/${user.id}`,{method:'PUT',body:{...user,designAccess:true,expected_updated_at:user.updated_at}});assert.equal(updated.status,200);assert.equal(updated.data.canDesign,true);
  assert.equal((await f.req('/api/auth/me',{session:f.editor})).status,401);const designer=f.makeSession(user.id);assert.equal((await f.req('/api/auth/me',{session:designer})).data.user.canDesign,true);
  const design=(await f.req('/api/designs',{method:'POST',session:designer,body:code()})).data;assert.ok(design.id);
  const preview=(await f.req(`/api/designs/${design.id}/preview`,{method:'POST',session:designer,body:{}})).data.url;assert.equal((await f.req(preview,{session:null})).status,200);
  assert.equal((await f.publish(design,design.draft_id,{currentPassword:password})).status,200);
  assert.equal((await f.req(`/api/designs/${design.id}/publish`,{method:'POST',session:designer,body:{revisionId:design.draft_id,currentPassword:password,expected_updated_at:design.updated_at}})).status,403);
  updated=await f.req(`/api/users/${user.id}`,{method:'PUT',body:{...updated.data,designAccess:false,expected_updated_at:updated.data.updated_at}});assert.equal(updated.status,200);assert.equal((await f.req(preview,{session:null})).status,404);
});

test('draft code is private; preview capabilities expire and are bound to the originating live session',async t=>{
  const f=await fixture(t),d=await f.create({html:'<h2>DRAFT-SECRET</h2>'});assert.equal((await f.req(`/api/designs/${d.id}`,{session:f.editor})).status,403);
  const prefix=`/design-runtime/${d.id}/${d.draft_id}/`;assert.equal((await f.req(prefix+'entry.js',{session:null})).status,404);
  assert.equal((await f.req(`/api/designs/${d.id}/preview`,{method:'POST',csrf:false,body:{}})).status,403);
  const p=(await f.req(`/api/designs/${d.id}/preview`,{method:'POST',body:{}})).data;
  const preview=await f.req(p.url,{session:null});assert.equal(preview.status,200);assert.match(preview.data,/DRAFT-SECRET/);assert.match(preview.headers.get('content-security-policy'),/sandbox allow-scripts;/);assert.doesNotMatch(preview.headers.get('content-security-policy'),/allow-same-origin/);assert.equal(preview.headers.get('referrer-policy'),'no-referrer');assert.equal(preview.headers.get('cache-control'),'no-store');assert.match(preview.headers.get('x-robots-tag'),/noindex/);
  const token=p.url.split('/')[2];assert.equal(f.app.db.prepare('SELECT token_hash FROM design_previews').get().token_hash,digest(token));assert.doesNotMatch(JSON.stringify((await f.req('/api/public/content')).data),/DRAFT-SECRET/);
  f.app.db.prepare('UPDATE design_previews SET expires_at=0').run();assert.equal((await f.req(p.url,{session:null})).status,404);
  const fresh=(await f.req(`/api/designs/${d.id}/preview`,{method:'POST',body:{}})).data.url;await f.req('/api/auth/logout',{method:'POST',body:{}});assert.equal((await f.req(fresh,{session:null})).status,404);
});

test('publish requires admin, origin, CSRF, password and valid syntax; checking code does not execute it',async t=>{
  const f=await fixture(t),d=await f.create({js:"globalThis.__CMS_DESIGN_EXECUTED=true; console.log('browser only');"});
  assert.equal((await f.publish(d,d.draft_id,{currentPassword:'wrong'})).status,422);
  const body={revisionId:d.draft_id,currentPassword:password,expected_updated_at:d.updated_at};assert.equal((await f.req(`/api/designs/${d.id}/publish`,{method:'POST',csrf:false,body})).status,403);assert.equal((await f.req(`/api/designs/${d.id}/publish`,{method:'POST',requestOrigin:'https://evil.test',body})).status,403);
  const good=await f.publish(d);assert.equal(good.status,200);assert.equal(globalThis.__CMS_DESIGN_EXECUTED,undefined);
  const invalid=await f.req(`/api/designs/${d.id}`,{method:'PUT',body:code({js:'const = broken',expected_updated_at:good.data.updated_at})});assert.equal(invalid.status,200);assert.equal((await f.publish(invalid.data)).status,422);assert.equal(getDesign(f.app.db,d.id).published_id,d.draft_id);
  assert.ok(f.app.db.prepare("SELECT id FROM audit_log WHERE event='design.published' AND target_id=?").get(d.id));assert.doesNotMatch(JSON.stringify(f.app.db.prepare('SELECT * FROM audit_log').all()),new RegExp(password));
});

test('MFA enforced mode blocks designers until enrollment; MFA publication consumes a recovery code exactly once',async t=>{
  const f=await fixture(t,{requireAdminMfa:true});assert.equal((await f.req('/api/designs')).status,403);
  f.app.db.prepare('UPDATE users SET mfa_secret=? WHERE id=?').run(encrypt('JBSWY3DPEHPK3PXP',f.key,`mfa:${f.adminUser.id}`),f.adminUser.id);
  // Recovery codes are hashed with the same helper prefix used by enrollment.
  const codeValue='0123456789abcdef01234567';f.app.db.prepare('INSERT INTO recovery_codes VALUES(?,?)').run(f.adminUser.id,digest(codeValue));
  const d=await f.create();assert.equal((await f.publish(d)).status,422);const result=await f.publish(d,d.draft_id,{mfaCode:codeValue});assert.equal(result.status,200);assert.equal((await f.publish(result.data,null,{mfaCode:codeValue})).status,422);assert.equal(getDesign(f.app.db,d.id).published_id,d.draft_id);
});

test('draft saves and restores preserve releases, reject stale updates, and retain 40 versions plus the release',async t=>{
  const f=await fixture(t);let d=await f.create();d=(await f.publish(d)).data;const release=d.published_id,old=d.updated_at;
  for(let i=0;i<45;i++)d=saveDesign(f.app.db,code({html:`<p>draft ${i}</p>`,expected_updated_at:d.updated_at}),f.adminUser.id,d.id);
  assert.equal(d.published_id,release);assert.equal(d.history.length,41);assert.ok(d.history.some(r=>r.id===release));
  assert.equal((await f.req(`/api/designs/${d.id}`,{method:'PUT',body:code({expected_updated_at:old})})).status,409);
  const result=await f.req(`/api/designs/${d.id}/restore`,{method:'POST',body:{revisionId:release,expected_updated_at:d.updated_at}});assert.equal(result.status,200);assert.equal(result.data.draft.html,'<h2>PUBLIC-DESIGN</h2>');assert.equal(result.data.published_id,release);assert.notEqual(result.data.draft_id,release);
  const same=saveDesign(f.app.db,{...code(),expected_updated_at:result.data.updated_at},f.adminUser.id,d.id);assert.equal(same.draft_id,result.data.draft_id);
});

test('only the released version used by published enabled content is public; rollback and unpublish invalidate old runtime URLs',async t=>{
  const f=await fixture(t);let d=await f.create();d=(await f.publish(d)).data;const first=d.published_id,url=id=>`/design-runtime/${d.id}/${id}/index.html`;
  assert.equal((await f.req(url(first),{session:null})).status,404);
  const block={type:'code-design',designId:d.id,height:560,title:'طرح سه‌بعدی',fallback:'متن قابل خواندن'};let item=putContent(f.app.db,page({status:'draft',blocks:[block]}));
  const preview=await f.req(`/api/content/${item.id}/preview`,{session:f.editor});assert.match(preview.data,/design-preview/);const previewPath=preview.data.match(/src="(\/design-preview\/[^\"]+)"/)[1];assert.equal((await f.req(previewPath,{session:null})).status,200);
  item=putContent(f.app.db,{...item,status:'published'},item.id);assert.equal((await f.req(url(first),{session:null})).status,200);const html=(await f.req('/')).data;assert.match(html,/sandbox="allow-scripts"/);assert.doesNotMatch(html,/allow-same-origin/);assert.match(html,/متن قابل خواندن/);
  d=saveDesign(f.app.db,code({html:'<p>NEW-DRAFT-SECRET</p>',expected_updated_at:d.updated_at}),f.adminUser.id,d.id);assert.doesNotMatch((await f.req(url(first),{session:null})).data,/NEW-DRAFT-SECRET/);assert.equal((await f.req(url(d.draft_id),{session:null})).status,404);
  d=(await f.publish(d)).data;assert.equal((await f.req(url(first),{session:null})).status,404);assert.equal((await f.req(previewPath,{session:null})).status,404);
  d=(await f.publish(d,first)).data;assert.equal((await f.req(url(first),{session:null})).status,200);
  d=(await f.publish(d,null)).data;assert.equal((await f.req(url(first),{session:null})).status,404);assert.match((await f.req('/')).data,/نمای اختصاصی در حال حاضر/);
  // A previously attached design remains editable after its release is removed.
  assert.equal((await f.req(`/api/content/${item.id}`,{method:'PUT',body:{...item,expected_updated_at:item.updated_at}})).status,200);
});

test('disabling a referencing module closes public code and image URLs without deleting the design',async t=>{
  const f=await fixture(t),image=await f.image();let d=await f.create({assets:[image.id]});d=(await f.publish(d)).data;putContent(f.app.db,page({kind:'services',slug:'visual',blocks:[{type:'code-design',designId:d.id,height:500,title:'نمای خدمات'}]}));
  const path=`/design-runtime/${d.id}/${d.published_id}/index.html`;assert.equal((await f.req(path,{session:null})).status,200);const site=getSite(f.app.db);assert.equal((await f.req('/api/settings',{method:'PUT',body:{...site,enabledModules:['pages']}})).status,200);assert.equal((await f.req(path,{session:null})).status,404);assert.equal((await f.req(`/media/${image.id}.png`,{session:null})).status,404);assert.equal(getDesign(f.app.db,d.id).published_id,d.published_id);const latest=getSite(f.app.db);await f.req('/api/settings',{method:'PUT',body:{...latest,enabledModules:site.enabledModules}});assert.equal((await f.req(path,{session:null})).status,200);
});

test('assets are scoped to revisions; private images stay private and histories prevent destructive image deletion',async t=>{
  const f=await fixture(t),image=await f.image(),other=await f.image();let d=await f.create({assets:[image.id]});let p=(await f.req(`/api/designs/${d.id}/preview`,{method:'POST',body:{}})).data.url.replace('index.html','');
  assert.equal((await f.req(p+`assets/${image.id}.png`,{session:null})).status,200);assert.equal((await f.req(p+`assets/${other.id}.png`,{session:null})).status,404);assert.equal((await f.req(`/media/${image.id}.png`,{session:null})).status,404);
  d=(await f.publish(d)).data;let item=putContent(f.app.db,page({blocks:[{type:'code-design',designId:d.id,height:400,title:'تصویر'}]}));assert.equal((await f.req(`/media/${image.id}.png`,{session:null})).status,200);
  const bridge=(await f.req(`/design-runtime/${d.id}/${d.published_id}/bridge.js`,{session:null})).data;assert.match(bridge,new RegExp(image.id));assert.doesNotMatch(bridge,/csrf|password|admin@example/);assert.equal((await f.req(`/api/media/${image.id}`,{method:'DELETE',body:{expected_updated_at:image.updated_at}})).status,409);
  item=putContent(f.app.db,{...item,status:'draft'},item.id);assert.equal((await f.req(`/design-runtime/${d.id}/${d.published_id}/entry.js`,{session:null})).status,404);assert.equal((await f.req(`/media/${image.id}.png`,{session:null})).status,404);
});

test('code/asset/section limits reject malformed data and approved vendor routes cannot read arbitrary files',async t=>{
  const f=await fixture(t);for(const body of [code({html:'x'.repeat(65537)}),code({js:'x'.repeat(131073)}),code({assets:['missing']}),code({name:''}),code({css:null})])assert.equal((await f.req('/api/designs',{method:'POST',body})).status,422);
  const d=await f.create(),other=await f.create({name:'طرح دوم'});assert.equal((await f.publish(d,other.draft_id)).status,404);assert.equal((await f.publish(d,undefined,{revisionId:123})).status,422);assert.equal((await f.req(`/api/designs/${d.id}/restore`,{method:'POST',body:{revisionId:other.draft_id,expected_updated_at:d.updated_at}})).status,404);for(const height of [0,199,1201,'300'])assert.equal((await f.req('/api/content',{method:'POST',body:page({blocks:[{type:'code-design',designId:d.id,title:'A',height}]})})).status,422);
  assert.equal((await f.req('/design-vendor/three.module.js',{session:null})).status,200);assert.equal((await f.req('/design-vendor/three.core.js',{session:null})).headers.get('access-control-allow-origin'),'*');assert.equal((await f.req('/design-vendor/package.json',{session:null})).status,404);assert.equal((await f.req('/api/settings',{session:null})).headers.get('access-control-allow-origin'),null);
});

test('backup/restore retains design drafts, releases, histories, permissions and media; all previews and sessions are stripped',async t=>{
  const f=await fixture(t),image=await f.image();let d=await f.create({assets:[image.id]});d=(await f.publish(d)).data;d=saveDesign(f.app.db,code({html:'<p>private draft</p>',assets:[image.id],expected_updated_at:d.updated_at}),f.adminUser.id,d.id);
  await f.req(`/api/designs/${d.id}/preview`,{method:'POST',body:{}});f.app.db.prepare('UPDATE users SET design_access=1 WHERE id=?').run(f.editorUser.id);await f.app.close();const backup=join(f.dir,'backup');await createBackup({dbPath:f.dbPath,outputDir:backup});const result=await restoreBackup({inputDir:backup,dbPath:join(f.dir,'restore/cms.sqlite')});const db=openDatabase(result.database);
  try{const restored=getDesign(db,d.id);assert.deepEqual(restored.draft,d.draft);assert.equal(restored.published_id,d.published_id);assert.equal(restored.history.length,2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM design_previews').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);assert.equal(db.prepare('SELECT design_access FROM users WHERE id=?').get(f.editorUser.id).design_access,1);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);}finally{db.close();}
});

test('export copies only referenced released code/assets, never drafts or previews, with subpaths and hosting headers',async t=>{
  const f=await fixture(t),image=await f.image();let d=await f.create({assets:[image.id]});d=(await f.publish(d)).data;const release=d.published_id;putContent(f.app.db,page({blocks:[{type:'code-design',designId:d.id,title:'کد',height:500}]}));
  d=saveDesign(f.app.db,code({html:'<p>PRIVATE-DRAFT</p>',expected_updated_at:d.updated_at}),f.adminUser.id,d.id);const unused=await f.create({html:'<p>UNUSED-SECRET</p>'});await f.publish(unused);await f.req(`/api/designs/${d.id}/preview`,{method:'POST',body:{}});await f.app.close();const output=join(f.dir,'export');const result=await exportSite({dbPath:f.dbPath,outputDir:output,publicURL:'https://example.com/client'});assert.equal(result.warnings.length,1);
  const html=await readFile(join(output,'index.html'),'utf8');assert.match(html,new RegExp(`/client/design-runtime/${d.id}/${release}/index.html`));const runtime=await readFile(join(output,`design-runtime/${d.id}/${release}/index.html`),'utf8');assert.match(runtime,/PUBLIC-DESIGN/);assert.doesNotMatch(runtime,/PRIVATE-DRAFT|UNUSED-SECRET|design-preview/);assert.match(runtime,/\/client\/design-vendor\/three.module.js/);assert.deepEqual(await readdir(join(output,'design-runtime')),[d.id]);assert.ok((await readFile(join(output,'_headers'),'utf8')).includes('sandbox allow-scripts'));assert.equal((await readdir(join(output,`design-runtime/${d.id}/${release}/assets`)))[0],`${image.id}.png`);
});

test('schema 5 upgrades once without changing legacy content/theme; all presets validate for their content kind',async t=>{
  const f=await fixture(t);const oldContent=putContent(f.app.db,page({blocks:[{type:'paragraph',text:'legacy'}]}));const oldTheme={template:'services',primaryColor:'#234567',corners:'square'};await f.app.close();let db=openDatabase(f.dbPath);
  db.exec('DROP TABLE design_previews; UPDATE designs SET draft_id=NULL,published_id=NULL; DROP TABLE design_revisions; DROP TABLE designs; ALTER TABLE users DROP COLUMN design_access; DELETE FROM schema_versions WHERE version=6');const site=getSite(db);db.prepare("UPDATE settings SET value=? WHERE key='site'").run(JSON.stringify({...site,theme:oldTheme}));db.close();
  for(let i=0;i<2;i++){db=openDatabase(f.dbPath);assert.equal(db.prepare('SELECT MAX(version) AS n FROM schema_versions').get().n,6);assert.deepEqual(listContent(db)[0],oldContent);assert.equal(designList(db).length,0);assert.deepEqual(getSite(db).theme,{...defaultTheme,...oldTheme});db.close();}
  db=openDatabase(f.dbPath);try{for(const preset of templateLibrary.pagePresets)for(const kind of preset.kinds)assert.doesNotThrow(()=>putContent(db,page({kind,slug:`preset-${preset.key}`,template:preset.template,blocks:preset.blocks})));for(const preset of templateLibrary.sectionPresets)assert.doesNotThrow(()=>putContent(db,page({slug:`section-${preset.key}`,blocks:preset.blocks})));for(const key of ['font','density','typeScale','header'])assert.throws(()=>validateTheme({...defaultTheme,[key]:'<script>'}));}finally{db.close();}
});
