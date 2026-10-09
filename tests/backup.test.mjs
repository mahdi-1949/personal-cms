import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile,readdir,cp,symlink,stat,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server.mjs';
import { createUser,createSession,verifyPassword } from '../src/auth.mjs';
import { openDatabase,getSite,saveSite } from '../src/database.mjs';
import { putContent,listContent } from '../src/content.mjs';
import { putCategory } from '../src/categories.mjs';
import { uploadMedia,mediaPath } from '../src/media.mjs';
import { createBackup,verifyBackup,restoreBackup } from '../src/backup.mjs';

const run=promisify(execFile),password='Backup-test-only-123!';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'cms-backup-')),dbPath=join(dir,'original/cms.sqlite'),mediaDir=join(dir,'original/media');
  const app=await createApp({dbPath,mediaDir,origin:'http://cms.test'});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const user=await createUser(app.db,{email:'admin@example.test',password});const session=createSession(app.db,user.id);
  const category=putCategory(app.db,{name:'دسته آزمایشی',slug:'test'});
  const image=await uploadMedia(app.db,mediaDir,png,{mime:'image/png',filename:'private.png',userId:user.id});
  let item=putContent(app.db,{kind:'posts',title:'محتوای آزمایشی',slug:'old',status:'published',excerpt:'خلاصه',body:'متن',seo_title:'',seo_description:'',categoryIds:[category.id],blocks:[{type:'image',mediaId:image.id,alt:'تصویر',caption:''}]});
  item=putContent(app.db,{...item,slug:'new'},item.id);
  app.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)').run('message-id','User','u@example.test','Private subject','Private message','new','2026-01-01','2026-01-01');
  saveSite(app.db,{...getSite(app.db),contactEnabled:true});
  return {dir,dbPath,mediaDir,app,user,session,category,image,item,outputDir:join(dir,'backups/full')};
}

test('complete backup restores content, categories, redirects, inbox, passwords and images; sessions are revoked',async t=>{
  const f=await fixture(t);const hash=f.app.db.prepare('SELECT password_hash FROM users').get().password_hash;await f.app.close();
  const result=await createBackup(f);assert.equal(result.files,2);const manifest=await verifyBackup(f.outputDir);assert.equal(manifest.schemaVersion,3);
  const source=openDatabase(f.dbPath);assert.equal(source.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,1);source.close();
  const restoredPath=join(f.dir,'recovered/cms.sqlite');const restored=await restoreBackup({inputDir:f.outputDir,dbPath:restoredPath});
  const app=await createApp({dbPath:restored.database,mediaDir:restored.media,origin:'http://cms.test'});t.after(()=>app.close());
  assert.equal(app.db.prepare('SELECT password_hash FROM users').get().password_hash,hash);assert.equal(await verifyPassword(password,hash),true);
  assert.equal(listContent(app.db)[0].slug,'new');assert.deepEqual(listContent(app.db)[0].categoryIds,[f.category.id]);
  assert.equal(app.db.prepare('SELECT path FROM redirects').get().path,'/articles/old/');
  assert.equal(app.db.prepare('SELECT message FROM messages').get().message,'Private message');assert.equal(getSite(app.db).contactEnabled,true);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);assert.deepEqual(await readFile(mediaPath(restored.media,f.image)),png);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  const alias=await fetch(`${base}/articles/old/`,{redirect:'manual'});assert.equal(alias.status,308);assert.equal(alias.headers.get('location'),'/articles/new/');
  assert.equal((await fetch(`${base}/media/${f.image.id}.png`)).status,200);
  assert.equal((await fetch(`${base}/api/auth/me`,{headers:{Cookie:`cms_session=${f.session.token}`}})).status,401);
  const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{Origin:'http://cms.test','Content-Type':'application/json'},body:JSON.stringify({email:'admin@example.test',password})});assert.equal(login.status,200);
  await app.close();
});

test('managed database locks reject live backups and concurrent server aliases and release after shutdown',async t=>{
  const f=await fixture(t);
  await assert.rejects(createBackup(f),/data is locked/);await assert.rejects(createApp({dbPath:f.dbPath}),/data is locked/);
  const alias=join(f.dir,'alias.sqlite');await symlink(f.dbPath,alias);
  await assert.rejects(createApp({dbPath:alias}),/data is locked/);
  await f.app.close();await createBackup(f);assert.equal((await verifyBackup(f.outputDir)).schemaVersion,3);
});

test('damaged backup bytes and invalid SQLite are rejected before any restore destination is installed',async t=>{
  const f=await fixture(t);await f.app.close();await createBackup(f);
  const damaged=join(f.dir,'damaged');await cp(f.outputDir,damaged,{recursive:true});
  await writeFile(join(damaged,'media',`${f.image.id}.png`),'broken');
  await assert.rejects(verifyBackup(damaged),/checksum mismatch/);
  const target=join(f.dir,'rejected/cms.sqlite');await assert.rejects(restoreBackup({inputDir:damaged,dbPath:target}),/checksum mismatch/);
  await assert.rejects(stat(target),/ENOENT/);await assert.rejects(stat(join(f.dir,'rejected/media')),/ENOENT/);
  const invalid=join(f.dir,'invalid-db');await cp(f.outputDir,invalid,{recursive:true});const bytes=Buffer.from('This is not SQLite');await writeFile(join(invalid,'cms.sqlite'),bytes);
  const manifest=JSON.parse(await readFile(join(invalid,'manifest.json'),'utf8'));manifest.files['cms.sqlite']={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};await writeFile(join(invalid,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(verifyBackup(invalid),/database|SQLite/i);
});

test('backup verification rejects path traversal, extra files and symlinked media',async t=>{
  const f=await fixture(t);await f.app.close();await createBackup(f);
  const unsafe=join(f.dir,'unsafe');await cp(f.outputDir,unsafe,{recursive:true});const manifest=JSON.parse(await readFile(join(unsafe,'manifest.json'),'utf8'));manifest.files['../outside']={size:0,sha256:'a'.repeat(64)};await writeFile(join(unsafe,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(verifyBackup(unsafe),/Unsafe path/);
  const extra=join(f.outputDir,'unexpected.txt');await writeFile(extra,'extra');await assert.rejects(verifyBackup(f.outputDir),/Unexpected files/);await rm(extra);
  const file=join(f.outputDir,'media',`${f.image.id}.png`);await rm(file);await symlink(mediaPath(f.mediaDir,f.image),file);await assert.rejects(verifyBackup(f.outputDir),/regular file/);
});

test('backup refuses overlapping paths, existing destinations and missing media without changing the source',async t=>{
  const f=await fixture(t);await f.app.close();
  await assert.rejects(createBackup({...f,outputDir:join(f.mediaDir,'backup')}),/must be separate/);
  await assert.rejects(createBackup({...f,outputDir:join(f.dir,'original')}),/must be separate/);
  await createBackup(f);await assert.rejects(createBackup(f),/already exists/);
  await rm(mediaPath(f.mediaDir,f.image));
  const missing=join(f.dir,'missing-image-backup');await assert.rejects(createBackup({...f,outputDir:missing}),/ENOENT/);await assert.rejects(stat(missing),/ENOENT/);
  assert.ok(!(await readdir(f.dir)).some(name=>name.includes('.staging-')));
  const db=openDatabase(f.dbPath);assert.equal(listContent(db)[0].id,f.item.id);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media').get().n,1);db.close();
  const app=await createApp({dbPath:f.dbPath});await app.close();
});

test('restore never overwrites an existing database or media directory',async t=>{
  const f=await fixture(t);await f.app.close();await createBackup(f);
  const before=await readFile(f.dbPath);await assert.rejects(restoreBackup({inputDir:f.outputDir,dbPath:f.dbPath,mediaDir:f.mediaDir}),/requires a new/);assert.deepEqual(await readFile(f.dbPath),before);
  const destination=join(f.dir,'existing-media');await mkdir(destination);await writeFile(join(destination,'keep.txt'),'keep');
  await assert.rejects(restoreBackup({inputDir:f.outputDir,dbPath:join(f.dir,'new.sqlite'),mediaDir:destination}),/requires a new/);assert.equal(await readFile(join(destination,'keep.txt'),'utf8'),'keep');
});

test('v0.2 backup is verified and upgraded during restore; existing contact content is preserved',async t=>{
  const f=await fixture(t);await f.app.close();const db=openDatabase(f.dbPath);
  db.exec('DROP TABLE contact_limits; DROP TABLE contact_tokens; DROP TABLE messages; DROP TABLE redirects; DROP TABLE content_categories; DROP TABLE categories; DELETE FROM schema_versions WHERE version=3;');
  db.prepare("UPDATE content SET kind='pages',slug='contact',blocks='[]' WHERE id=?").run(f.item.id);db.close();
  await createBackup(f);assert.equal((await verifyBackup(f.outputDir)).schemaVersion,2);
  const result=await restoreBackup({inputDir:f.outputDir,dbPath:join(f.dir,'legacy-restored/cms.sqlite')});
  const app=await createApp({dbPath:result.database,origin:'http://cms.test'});t.after(()=>app.close());
  assert.equal(app.db.prepare('SELECT MAX(version) AS n FROM schema_versions').get().n,3);assert.equal(listContent(app.db)[0].slug,'contact');assert.equal(getSite(app.db).contactEnabled,false);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/contact/`)).status,200);
  const session=createSession(app.db,f.user.id);const response=await fetch(`${base}/api/settings`,{method:'PUT',headers:{Origin:'http://cms.test','Content-Type':'application/json',Cookie:`cms_session=${session.token}`,'X-CSRF-Token':session.csrf},body:JSON.stringify({...getSite(app.db),contactEnabled:true})});assert.equal(response.status,409);
  await app.close();
});

test('documented backup and restore CLI commands work with explicit new paths',async t=>{
  const f=await fixture(t);await f.app.close();
  const options={cwd:process.cwd(),env:{...process.env,CMS_DB_PATH:f.dbPath,CMS_MEDIA_DIR:f.mediaDir}};
  const created=await run(process.execPath,['scripts/backup.mjs',f.outputDir],options);assert.match(created.stdout,/Backup verified and saved/);
  const verified=await run(process.execPath,['scripts/backup.mjs','--verify',f.outputDir],options);assert.match(verified.stdout,/Backup verified:/);
  const target=join(f.dir,'cli-restored/cms.sqlite'),targetMedia=join(f.dir,'cli-restored/media');
  const restored=await run(process.execPath,['scripts/restore.mjs',f.outputDir],{...options,env:{...options.env,CMS_DB_PATH:target,CMS_MEDIA_DIR:targetMedia}});assert.match(restored.stdout,/Restored and verified:/);assert.deepEqual(await readFile(join(targetMedia,`${f.image.id}.png`)),png);
});
