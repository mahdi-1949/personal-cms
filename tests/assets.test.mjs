import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm,readFile,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.mjs';
import { createUser,createSession } from '../src/auth.mjs';
import { processDesignAsset } from '../src/asset-processing.mjs';
import { uploadMedia,mediaPath } from '../src/media.mjs';
import { putContent } from '../src/content.mjs';
import { saveDesign,publishDesign,getDesign,issueDesignPreview } from '../src/designs.mjs';
import { createBackup,restoreBackup } from '../src/backup.mjs';
import { openDatabase } from '../src/database.mjs';
import { exportSite } from '../src/export.mjs';
import { normalizeMedia } from '../src/normalize-media.mjs';
import { designPresets } from '../src/design-presets.mjs';
import { modelGLB } from './fixtures/model.mjs';
import { brandFont } from './fixtures/font.mjs';
const password='Asset-test-password-123!',page=blocks=>({kind:'pages',title:'Home',slug:'home',status:'published',excerpt:'',body:'',seo_title:'',seo_description:'',blocks});
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'cms-assets-')),dbPath=join(dir,'source/cms.sqlite'),origin='http://cms.test',app=await createApp({dbPath,origin});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const user=await createUser(app.db,{email:'admin@example.test',password}),editor=await createUser(app.db,{email:'editor@example.test',password,role:'editor'}),session=createSession(app.db,user.id),editorSession=createSession(app.db,editor.id);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  const req=(path,{method='GET',body,mime,auth=session,csrf=true}={})=>fetch(base+path,{method,headers:{...(auth?{Cookie:`cms_session=${auth.token}`,...(csrf?{'X-CSRF-Token':auth.csrf}:{})}:{}),...(method!=='GET'?{Origin:origin}:{}),...(body?{'Content-Type':mime||'application/json','X-Filename':encodeURIComponent(mime==='font/woff'?'brand.woff':'product.glb')}: {})},...(body?{body:mime?body:JSON.stringify(body)}:{})});
  const actor=()=>app.db.prepare('SELECT s.*,u.role,u.design_access FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.user_id=?').get(user.id);
  const upload=(buffer,mime)=>uploadMedia(app.db,app.mediaDir,buffer,{mime,filename:mime==='font/woff'?'brand.woff':'model.glb',userId:user.id});
  return {dir,dbPath,app,user,req,actor,upload,editorSession};
}
test('validated embedded GLB and WOFF are stored unchanged with safe generated filenames',async t=>{
  const f=await fixture(t);for(const [buffer,mime,ext] of [[modelGLB(),'model/gltf-binary','glb'],[brandFont,'font/woff','woff']]){const item=await f.upload(buffer,mime);assert.equal(item.width,0);assert.equal(item.size,buffer.length);assert.ok(mediaPath(f.app.mediaDir,item).endsWith(`.${ext}`));assert.deepEqual(await readFile(mediaPath(f.app.mediaDir,item)),buffer);}
});
test('GLB rejects external/data URIs, compression, malformed accessors, corrupt images and excessive complexity',async()=>{
  const bad=[Buffer.from('<svg/>'),modelGLB(j=>j.buffers[0].uri='https://example.test/steal'),modelGLB(j=>j.images[0].uri='data:image/png;base64,x'),modelGLB(j=>j.extensionsRequired=['KHR_draco_mesh_compression']),modelGLB(j=>j.accessors[0].count=1000001),modelGLB(j=>j.nodes=Array.from({length:2001},()=>({mesh:0}))),modelGLB(j=>j.accessors[0].bufferView=99),modelGLB((j,b)=>b.fill(0,136)),modelGLB(j=>{j.extras={};let x=j.extras;for(let i=0;i<40;i++)x=x.n={};})];
  const length=modelGLB();length.writeUInt32LE(length.length+4,8);bad.push(length);for(const buffer of bad)await assert.rejects(processDesignAsset(buffer,'model/gltf-binary'),e=>e.status===422);
  await assert.rejects(processDesignAsset(Buffer.alloc(20*1024*1024+1),'model/gltf-binary'),e=>e.status===413);
});
test('WOFF rejects wrong signature, lengths, overlaps, bad checksums and decompression limits',async()=>{
  for(const mutate of [b=>b.writeUInt32BE(0,0),b=>b.writeUInt32BE(7,8),b=>b.writeUInt32BE(99999999,16),b=>b.writeUInt32BE(0,48),b=>b.writeUInt32BE(0,60),b=>b.fill(0,b.readUInt32BE(48),b.readUInt32BE(48)+10)]){const b=Buffer.from(brandFont);mutate(b);await assert.rejects(processDesignAsset(b,'font/woff'),e=>e.status===422);}
  await assert.rejects(processDesignAsset(Buffer.alloc(2*1024*1024+1),'font/woff'),e=>e.status===413);
});
test('asset upload requires design access, CSRF and live account; model/font cannot be used as image blocks',async t=>{
  const f=await fixture(t),buffer=modelGLB();assert.equal((await f.req('/api/media',{method:'POST',body:buffer,mime:'model/gltf-binary',auth:f.editorSession})).status,403);assert.equal((await f.req('/api/media',{method:'POST',body:buffer,mime:'model/gltf-binary',csrf:false})).status,403);
  const response=await f.req('/api/media',{method:'POST',body:buffer,mime:'model/gltf-binary'});assert.equal(response.status,201);const item=await response.json();
  for(const block of [{type:'image',mediaId:item.id,alt:'',caption:''},{type:'hero',variant:'split',title:'Hero',text:'',mediaId:item.id,alt:'',contentId:'',label:''}])assert.throws(()=>putContent(f.app.db,page([block])),e=>e.status===422);
  assert.equal((await f.req(`/media/${item.id}.glb`,{auth:null})).status,404);assert.equal((await f.req(`/media/${item.id}.jpg`)).status,404);
});
test('preview asset capabilities are scoped, expire and publish only with referenced releases; history protects deletion',async t=>{
  const f=await fixture(t),model=await f.upload(modelGLB(),'model/gltf-binary'),font=await f.upload(brandFont,'font/woff'),unused=await f.upload(modelGLB(),'model/gltf-binary'),preset=designPresets.find(p=>p.key==='glb-hero');
  let d=saveDesign(f.app.db,{...preset,name:'Product',assets:[model.id,font.id]},f.user.id),preview=issueDesignPreview(f.app.db,d.id,{},f.actor()),prefix=preview.url.replace('index.html','');
  assert.equal((await f.req(prefix+`assets/${model.id}.glb`,{auth:null})).status,200);assert.equal((await f.req(prefix+`assets/${unused.id}.glb`,{auth:null})).status,404);assert.equal((await f.req(prefix+`assets/${font.id}.glb`,{auth:null})).status,404);
  const doc=await f.req(preview.url,{auth:null}),csp=doc.headers.get('content-security-policy');assert.ok(csp.includes(`connect-src http://cms.test${prefix}assets/ blob:`));assert.match(csp,/sandbox allow-scripts;/);assert.doesNotMatch(csp,/allow-same-origin/);
  d=await publishDesign(f.app.db,d.id,{revisionId:d.draft_id,currentPassword:password,expected_updated_at:d.updated_at},f.actor,null,'127.0.0.1');let content=putContent(f.app.db,page([{type:'code-design',designId:d.id,title:'Product',height:500}]));
  const runtime=`/design-runtime/${d.id}/${d.published_id}/`;assert.equal((await f.req(runtime+`assets/${model.id}.glb`,{auth:null})).headers.get('access-control-allow-origin'),'*');assert.equal((await f.req('/api/settings',{auth:null})).headers.get('access-control-allow-origin'),null);assert.equal((await f.req(`/media/${font.id}.woff`,{auth:null})).status,200);
  assert.equal((await f.req(`/api/media/${model.id}`,{method:'DELETE',body:{expected_updated_at:model.updated_at}})).status,409);
  content=putContent(f.app.db,{...content,status:'draft'},content.id);assert.equal((await f.req(runtime+`assets/${model.id}.glb`,{auth:null})).status,404);
  f.app.db.prepare('DELETE FROM sessions').run();assert.equal((await f.req(prefix+`assets/${model.id}.glb`,{auth:null})).status,404);
});
test('backup restore and static subpath export retain models/fonts, approved loader files and exclude draft assets',async t=>{
  const f=await fixture(t),model=await f.upload(modelGLB(),'model/gltf-binary'),font=await f.upload(brandFont,'font/woff'),privateAsset=await f.upload(modelGLB(),'model/gltf-binary'),preset=designPresets.find(p=>p.key==='glb-hero');
  let d=saveDesign(f.app.db,{...preset,name:'Product',assets:[model.id,font.id]},f.user.id);d=await publishDesign(f.app.db,d.id,{revisionId:d.draft_id,currentPassword:password,expected_updated_at:d.updated_at},f.actor,null,'127.0.0.1');putContent(f.app.db,page([{type:'code-design',designId:d.id,title:'Product',height:500}]));
  saveDesign(f.app.db,{...preset,name:'Product',assets:[privateAsset.id],expected_updated_at:d.updated_at},f.user.id,d.id);const output=join(f.dir,'export');await exportSite({dbPath:f.dbPath,outputDir:output,publicURL:'https://example.test/client'});
  const assets=await readdir(join(output,`design-runtime/${d.id}/${d.published_id}/assets`));assert.deepEqual(assets.sort(),[`${model.id}.glb`,`${font.id}.woff`].sort());assert.ok((await readFile(join(output,'design-vendor/addons/loaders/GLTFLoader.js'),'utf8')).includes("from 'three'"));assert.ok((await readFile(join(output,`design-runtime/${d.id}/${d.published_id}/index.html`),'utf8')).includes('/client/design-vendor/addons/'));assert.equal((await f.req('/design-vendor/addons/loaders/DRACOLoader.js',{auth:null})).status,404);
  await f.app.close();assert.equal((await normalizeMedia({dbPath:f.dbPath})).normalized,0);assert.deepEqual(await readFile(mediaPath(f.app.mediaDir,model)),modelGLB());const backup=join(f.dir,'backup'),restored=join(f.dir,'restored/cms.sqlite');await createBackup({dbPath:f.dbPath,outputDir:backup});await restoreBackup({inputDir:backup,dbPath:restored});const db=openDatabase(restored);try{assert.equal(getDesign(db,d.id).published_id,d.published_id);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media').get().n,3);assert.deepEqual(await readFile(mediaPath(join(f.dir,'restored/media'),font)),brandFont);}finally{db.close();}
});
