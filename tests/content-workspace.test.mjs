import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/server.mjs';
import { createUser,createSession } from '../src/auth.mjs';
import { putContent,listContent } from '../src/content.mjs';
import { getContentEditor,saveContentDraft,applyContentDraft } from '../src/content-workspace.mjs';
import { createBackup,restoreBackup } from '../src/backup.mjs';
import { openDatabase } from '../src/database.mjs';
import { uploadMedia } from '../src/media.mjs';
import { exportSite } from '../src/export.mjs';
import { putCategory } from '../src/categories.mjs';
const origin='http://cms.test',password='Content-workspace-password-123!';
const page=(more={})=>({kind:'pages',title:'Original title',slug:'original',status:'published',body:'PUBLIC BODY',excerpt:'Summary',seo_title:'SEO',seo_description:'Description',blocks:[],...more});
const versions=e=>({expected_updated_at:e.content.updated_at,expected_draft_updated_at:e.draft_updated_at});
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'cms-workspace-')),dbPath=join(dir,'source/cms.sqlite'),app=await createApp({dbPath,origin});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const admin=await createUser(app.db,{email:'admin@example.test',password}),sessions={admin:createSession(app.db,admin.id)};
  for(const profile of ['editor','author','designer','viewer']){const u=await createUser(app.db,{email:`${profile}@example.test`,password,role:'editor',accessProfile:profile});sessions[profile]=createSession(app.db,u.id);}
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  async function req(path,{method='GET',body,profile='admin',csrf=true,requestOrigin=origin}={}){
    const s=profile?sessions[profile]:null,headers={...(s?{Cookie:`cms_session=${s.token}`,...(csrf?{'X-CSRF-Token':s.csrf}:{})}:{}),...(method!=='GET'?{Origin:requestOrigin}:{}),...(body?{'Content-Type':'application/json'}:{})};
    const r=await fetch(base+path,{method,headers,redirect:'manual',...(body?{body:JSON.stringify(body)}:{})}),text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data,headers:r.headers};
  }
  const image=async()=>uploadMedia(app.db,app.mediaDir,await sharp({create:{width:3,height:3,channels:3,background:'#abcdef'}}).png().toBuffer(),{mime:'image/png',filename:'draft-only.png',userId:admin.id});
  return {app,dir,dbPath,admin,sessions,req,image};
}
test('autosave is private and leaves published HTML, slug, sitemap, navigation, media and export unchanged',async t=>{
  const f=await fixture(t),item=putContent(f.app.db,page()),image=await f.image(),e=getContentEditor(f.app.db,item.id),body={...item,title:'PRIVATE TITLE',slug:'private-slug',body:'PRIVATE BODY',blocks:[{type:'image',mediaId:image.id,alt:'Private image',caption:''}],...versions(e)};
  const r=await f.req(`/api/content/${item.id}/draft`,{method:'PUT',body,profile:'author'});assert.equal(r.status,200);assert.equal(r.data.draft.status,'draft');assert.deepEqual(listContent(f.app.db)[0],item);
  const publicHTML=(await f.req('/original/',{profile:null})).data;assert.match(publicHTML,/PUBLIC BODY/);assert.doesNotMatch(publicHTML,/PRIVATE/);assert.equal((await f.req('/private-slug/',{profile:null})).status,404);assert.equal((await f.req(`/media/${image.id}.png`,{profile:null})).status,404);
  assert.doesNotMatch(JSON.stringify((await f.req('/api/public/content',{profile:null})).data),/PRIVATE/);assert.doesNotMatch((await f.req('/sitemap.xml',{profile:null})).data,/private-slug/);
  const preview=await f.req(`/api/content/${item.id}/preview`);assert.match(preview.data,/PRIVATE TITLE/);assert.match(preview.data,/Private image/);assert.match(preview.headers.get('x-robots-tag'),/noindex/);assert.equal(preview.headers.get('cache-control'),'no-store');assert.equal((await f.req(`/api/content/${item.id}/editor`,{profile:null})).status,401);
  const out=join(f.dir,'export');await exportSite({dbPath:f.dbPath,outputDir:out,publicURL:'https://example.test'});assert.doesNotMatch(await readFile(join(out,'original/index.html'),'utf8'),/PRIVATE/);
});
test('both canonical and draft versions are checked; no-op autosaves do not grow history',async t=>{
  const f=await fixture(t),item=putContent(f.app.db,page()),first=getContentEditor(f.app.db,item.id),body={...item,body:'Draft A',...versions(first)};
  const a=(await f.req(`/api/content/${item.id}/draft`,{method:'PUT',body})).data;
  assert.equal((await f.req(`/api/content/${item.id}/draft`,{method:'PUT',body})).status,409);
  const noOp=(await f.req(`/api/content/${item.id}/draft`,{method:'PUT',body:{...body,...versions(a)}})).data;assert.equal(noOp.draft_updated_at,a.draft_updated_at);assert.equal(noOp.history.length,a.history.length);
  assert.equal((await f.req(`/api/content/${item.id}`,{method:'PUT',body:{...item,expected_updated_at:item.updated_at}})).status,409);
  putContent(f.app.db,{...item,body:'New canonical'},item.id);assert.equal((await f.req(`/api/content/${item.id}/apply`,{method:'POST',body:{status:'published',...versions(a)}})).status,409);
});
test('explicit apply publishes the chosen draft, redirects old slug and invalidates stale updates',async t=>{
  const f=await fixture(t),item=putContent(f.app.db,page()),e=getContentEditor(f.app.db,item.id),d=saveContentDraft(f.app.db,{...item,body:'NEW PUBLIC',slug:'new-url',...versions(e)},f.admin.id,item.id);
  assert.equal((await f.req(`/api/content/${item.id}/apply`,{method:'POST',csrf:false,body:{status:'published',...versions(d)}})).status,403);
  assert.equal((await f.req(`/api/content/${item.id}/apply`,{method:'POST',requestOrigin:'https://other.test',body:{status:'published',...versions(d)}})).status,403);
  const applied=await f.req(`/api/content/${item.id}/apply`,{method:'POST',profile:'editor',body:{status:'published',...versions(d)}});assert.equal(applied.status,200);assert.equal(getContentEditor(f.app.db,item.id).draft,null);assert.equal((await f.req('/original/',{profile:null})).status,308);assert.match((await f.req('/new-url/',{profile:null})).data,/NEW PUBLIC/);
  assert.equal((await f.req(`/api/content/${item.id}/draft`,{method:'PUT',body:{...item,...versions(d)}})).status,409);
  assert.ok(f.app.db.prepare("SELECT id FROM audit_log WHERE event='content.published'").get());
});
test('history restore creates a fresh draft and does not change public content; cross-page revision IDs are rejected',async t=>{
  const f=await fixture(t),item=putContent(f.app.db,page()),baseline=getContentEditor(f.app.db,item.id).history[0].id;
  putContent(f.app.db,{...item,body:'CURRENT PUBLIC'},item.id);let e=getContentEditor(f.app.db,item.id);
  const r=await f.req(`/api/content/${item.id}/restore`,{method:'POST',profile:'author',body:{revisionId:baseline,...versions(e)}});assert.equal(r.status,200);assert.equal(r.data.draft.body,'PUBLIC BODY');assert.match((await f.req('/original/',{profile:null})).data,/CURRENT PUBLIC/);assert.equal(r.data.history[0].source,'restore');
  const other=putContent(f.app.db,page({slug:'other'})),foreign=getContentEditor(f.app.db,other.id).history[0].id;e=r.data;assert.equal((await f.req(`/api/content/${item.id}/restore`,{method:'POST',body:{revisionId:foreign,...versions(e)}})).status,404);assert.equal((await f.req(`/api/content/${item.id}/revisions/${foreign}`)).status,404);
  assert.match((await f.req(`/api/content/${item.id}/preview?revision=${baseline}`)).data,/PUBLIC BODY/);
});
test('duplicate copies saved page blocks/template/categories into a fresh unpublished page with a unique slug',async t=>{
  const f=await fixture(t),category=putCategory(f.app.db,{name:'Category',slug:'category'}),item=putContent(f.app.db,page({kind:'posts',slug:'article',categoryIds:[category.id],blocks:[{type:'paragraph',text:'Saved blocks'}]}));
  let e=getContentEditor(f.app.db,item.id);saveContentDraft(f.app.db,{...item,body:'UNSAVED WORKING',...versions(e)},f.admin.id,item.id);e=getContentEditor(f.app.db,item.id);
  const a=await f.req(`/api/content/${item.id}/duplicate`,{method:'POST',profile:'author',body:versions(e)}),b=await f.req(`/api/content/${item.id}/duplicate`,{method:'POST',body:versions(e)});assert.equal(a.status,201);assert.equal(a.data.status,'draft');assert.equal(a.data.body,'PUBLIC BODY');assert.deepEqual(a.data.blocks,item.blocks);assert.deepEqual(a.data.categoryIds,item.categoryIds);assert.equal(a.data.template,item.template);assert.notEqual(a.data.slug,b.data.slug);assert.notEqual(a.data.id,item.id);assert.equal((await f.req(`/articles/${a.data.slug}/`,{profile:null})).status,404);
});
test('profiles enforce read/edit/publish/design/media/admin boundaries on the server',async t=>{
  const f=await fixture(t),item=putContent(f.app.db,page());
  for(const profile of ['author','designer','viewer']){
    const me=(await f.req('/api/auth/me',{profile})).data.user;assert.equal(me.accessProfile,profile);assert.equal(me.permissions.contentPublish,false);assert.equal((await f.req('/api/users',{profile})).status,403);assert.equal((await f.req('/api/settings',{method:'PUT',profile,body:{}})).status,403);
    assert.equal((await f.req('/api/content',{method:'POST',profile,body:page({slug:`${profile}-public`})})).status,403);assert.equal((await f.req(`/api/content/${item.id}`,{method:'PUT',profile,body:{...item,expected_updated_at:item.updated_at}})).status,403);assert.equal((await f.req(`/api/content/${item.id}`,{method:'DELETE',profile,body:{expected_updated_at:item.updated_at}})).status,403);
    assert.equal((await f.req('/api/designs',{profile})).status,profile==='designer'?200:403);
  }
  const e=getContentEditor(f.app.db,item.id);assert.equal((await f.req(`/api/content/${item.id}/draft`,{method:'PUT',profile:'viewer',body:{...item,...versions(e)}})).status,403);
  const d=(await f.req(`/api/content/${item.id}/draft`,{method:'PUT',profile:'designer',body:{...item,body:'Designer draft',...versions(e)}})).data;
  for(const status of ['draft','published'])assert.equal((await f.req(`/api/content/${item.id}/apply`,{method:'POST',profile:'author',body:{status,...versions(d)}})).status,403);
  const image=await f.image();assert.equal((await f.req(`/api/media/${image.id}`,{method:'PUT',profile:'viewer',body:{alt:'X',expected_updated_at:image.updated_at}})).status,403);
  const admin=(await f.req('/api/auth/me')).data.user;assert.ok(Object.values(admin.permissions).every(Boolean));
});
test('profile changes revoke sessions and designer preview capabilities; profiles cannot be self-escalated',async t=>{
  const f=await fixture(t),designer=(await f.req('/api/users')).data.users.find(u=>u.accessProfile==='designer');
  const d=(await f.req('/api/designs',{method:'POST',profile:'designer',body:{name:'Design',html:'<p>Draft</p>',css:'',js:'',assets:[]}})).data;
  const preview=(await f.req(`/api/designs/${d.id}/preview`,{method:'POST',profile:'designer',body:{}})).data.url;
  assert.equal((await f.req(`/api/users/${designer.id}`,{method:'PUT',profile:'designer',body:{...designer,role:'admin',expected_updated_at:designer.updated_at}})).status,403);
  assert.equal((await f.req(`/api/users/${designer.id}`,{method:'PUT',body:{...designer,accessProfile:'viewer',designAccess:false,expected_updated_at:designer.updated_at}})).status,200);
  assert.equal((await f.req('/api/auth/me',{profile:'designer'})).status,401);assert.equal((await f.req(preview,{profile:null})).status,404);
});
test('retained history protects images, keeps the saved revision past 40 draft changes and cascades on deletion',async t=>{
  const f=await fixture(t),image=await f.image(),item=putContent(f.app.db,page({blocks:[{type:'image',mediaId:image.id,alt:'Image',caption:''}]}));let e=getContentEditor(f.app.db,item.id);
  for(let i=0;i<45;i++)e=saveContentDraft(f.app.db,{...item,blocks:[],body:`Draft ${i}`,...versions(e)},f.admin.id,item.id);
  assert.equal(e.history.length,41);assert.ok(e.history.some(r=>r.number===1));assert.equal((await f.req(`/api/media/${image.id}`,{method:'DELETE',body:{expected_updated_at:image.updated_at}})).status,409);
  const applied=applyContentDraft(f.app.db,item.id,{status:'published',...versions(e)},f.admin.id);assert.equal((await f.req(`/api/media/${image.id}`,{method:'DELETE',body:{expected_updated_at:image.updated_at}})).status,200);
  assert.equal((await f.req(`/api/content/${item.id}`,{method:'DELETE',body:{expected_updated_at:applied.updated_at}})).status,200);assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM content_revisions').get().n,0);assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM content_working').get().n,0);
});
test('restoration revalidates removed references; invalid snapshots, disabled modules and stale drafts fail safely',async t=>{
  const f=await fixture(t),category=putCategory(f.app.db,{name:'C',slug:'c'}),item=putContent(f.app.db,page({kind:'posts',slug:'p',categoryIds:[category.id]})),baseline=getContentEditor(f.app.db,item.id).history[0].id;
  putContent(f.app.db,{...item,categoryIds:[]},item.id);f.app.db.prepare('DELETE FROM categories WHERE id=?').run(category.id);const e=getContentEditor(f.app.db,item.id);
  assert.equal((await f.req(`/api/content/${item.id}/restore`,{method:'POST',body:{revisionId:baseline,...versions(e)}})).status,422);
  assert.equal((await f.req(`/api/content/${item.id}/draft`,{method:'PUT',body:{...item,categoryIds:[],body:'x'.repeat(100001),...versions(e)}})).status,422);assert.equal(getContentEditor(f.app.db,item.id).draft,null);const settings=(await f.req('/api/settings')).data;await f.req('/api/settings',{method:'PUT',body:{...settings,enabledModules:['pages']}});assert.equal((await f.req(`/api/content/${item.id}/draft`,{method:'PUT',body:{...item,categoryIds:[],...versions(e)}})).status,422);
});
test('schema 6 migration preserves pages, settings, accounts/sessions and adds exactly one baseline revision',async t=>{
  const f=await fixture(t),item=putContent(f.app.db,page());await f.app.close();let db=openDatabase(f.dbPath);
  db.exec('DROP TABLE content_working; ALTER TABLE content DROP COLUMN saved_revision_id; DROP TABLE content_revisions; ALTER TABLE users DROP COLUMN access_profile; DELETE FROM schema_versions WHERE version=7;');const users=db.prepare('SELECT id,password_hash,updated_at FROM users ORDER BY id').all(),sessions=db.prepare('SELECT * FROM sessions ORDER BY token_hash').all();db.close();
  for(let i=0;i<2;i++){db=openDatabase(f.dbPath);assert.deepEqual(listContent(db)[0],item);assert.deepEqual(db.prepare('SELECT id,password_hash,updated_at FROM users ORDER BY id').all(),users);assert.deepEqual(db.prepare('SELECT * FROM sessions ORDER BY token_hash').all(),sessions);assert.equal(getContentEditor(db,item.id).history.length,1);assert.equal(db.prepare('SELECT MAX(version) AS n FROM schema_versions').get().n,7);db.close();}
});
test('backup/restore preserves drafts, history, profile permissions and media while revoking sessions',async t=>{
  const f=await fixture(t),image=await f.image(),item=putContent(f.app.db,page()),e=getContentEditor(f.app.db,item.id),draft=saveContentDraft(f.app.db,{...item,body:'PRIVATE RESTORED',blocks:[{type:'image',mediaId:image.id,alt:'',caption:''}],...versions(e)},f.admin.id,item.id);await f.app.close();const backup=join(f.dir,'backup'),restored=join(f.dir,'restore/cms.sqlite');await createBackup({dbPath:f.dbPath,outputDir:backup});await restoreBackup({inputDir:backup,dbPath:restored});const db=openDatabase(restored);try{const editor=getContentEditor(db,item.id);assert.deepEqual(editor.history,draft.history);assert.equal(editor.draft.body,'PRIVATE RESTORED');assert.equal(editor.content.body,'PUBLIC BODY');assert.equal(db.prepare("SELECT access_profile FROM users WHERE email='designer@example.test'").get().access_profile,'designer');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);}finally{db.close();}
});
test('deleting a page with working edits requires the current draft version and removes all history atomically',async t=>{
  const f=await fixture(t),item=putContent(f.app.db,page()),e=getContentEditor(f.app.db,item.id),draft=saveContentDraft(f.app.db,{...item,body:'Working',...versions(e)},f.admin.id,item.id);
  assert.equal((await f.req(`/api/content/${item.id}`,{method:'DELETE',body:{expected_updated_at:item.updated_at}})).status,409);
  assert.equal((await f.req(`/api/content/${item.id}`,{method:'DELETE',body:versions(draft)})).status,200);assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM content_revisions').get().n,0);assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM content_working').get().n,0);assert.equal(f.app.db.prepare('PRAGMA foreign_key_check').all().length,0);
});
