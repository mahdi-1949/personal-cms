import { DatabaseSync,backup } from 'node:sqlite';
import { createHash,randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir,lstat,readdir,readFile,writeFile,copyFile,chmod,rename,rm,realpath } from 'node:fs/promises';
import { resolve,dirname,join,relative } from 'node:path';
import { openDatabase } from './database.mjs';
import { SCHEMA_VERSION } from './migrations.mjs';
import { acquireDataLock } from './data-lock.mjs';
import { extension,mediaExtensions } from './asset-types.mjs';

const FORMAT='core-cms-backup-v1';
const mediaName=/^[a-f0-9-]{36}\.(png|jpg|glb|woff)$/;
async function exists(path){try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function regular(path){const info=await lstat(path);if(!info.isFile() || info.isSymbolicLink())throw new Error(`Expected a regular file: ${path}`);return info;}
async function directory(path){const info=await lstat(path);if(!info.isDirectory() || info.isSymbolicLink())throw new Error(`Expected a directory: ${path}`);}
async function fingerprint(path) {
  const info=await regular(path),hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return {size:info.size,sha256:hash.digest('hex')};
}
function inside(a,b){const rel=relative(a,b);return rel==='' || (rel!=='..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !rel.startsWith('/'));}
// Resolve existing ancestors so a symlink cannot disguise a destination inside the source.
async function canonical(path) {
  path=resolve(path);
  try{return await realpath(path);}catch(error){if(error.code!=='ENOENT')throw error;return join(await canonical(dirname(path)),path.slice(dirname(path).length+1));}
}
async function disjoint(paths) {
  const normalized=await Promise.all(paths.map(canonical));
  for(let i=0;i<normalized.length;i++)for(let j=i+1;j<normalized.length;j++)if(inside(normalized[i],normalized[j]) || inside(normalized[j],normalized[i]))throw new Error('Backup, database and media paths must be separate and must not contain each other');
}
function inspectDatabase(db) {
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok' || db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Database integrity validation failed');
  const version=db.prepare('SELECT MAX(version) AS version FROM schema_versions').get().version;
  if(!Number.isInteger(version) || version<1 || version>SCHEMA_VERSION)throw new Error('Backup schema is unsupported; use a compatible CMS version');
  for(const table of ['users','content','settings','sessions'])db.prepare(`SELECT COUNT(*) FROM ${table}`).get();
  return version;
}
function mediaFiles(db,version) {
  return version<2?[]:db.prepare('SELECT id,mime,size FROM media ORDER BY id').all().map(item=>{
    const name=`${item.id}.${extension(item)}`;
    if(!mediaName.test(name) || !Object.hasOwn(mediaExtensions,item.mime))throw new Error('Database contains invalid media metadata');
    return {path:`media/${name}`,size:item.size};
  });
}
export async function createBackup({dbPath,outputDir,mediaDir=join(dirname(resolve(dbPath)),'media')}) {
  const database=resolve(dbPath),output=resolve(outputDir),media=resolve(mediaDir);
  await disjoint([database,media,output]);await regular(database);
  if(await exists(output))throw new Error('Backup destination already exists; choose a new directory');
  const release=acquireDataLock(database),staging=`${output}.staging-${randomUUID()}`;
  let db;
  try {
    db=new DatabaseSync(database,{readOnly:true});const version=inspectDatabase(db);
    await mkdir(join(staging,'media'),{recursive:true,mode:0o700});
    const snapshot=join(staging,'cms.sqlite');await backup(db,snapshot);await chmod(snapshot,0o600);
    const copy=new DatabaseSync(snapshot);
    try{copy.exec('DELETE FROM sessions; DELETE FROM login_attempts;');if(version>=3)copy.exec('DELETE FROM contact_tokens; DELETE FROM contact_limits;');if(version>=4)copy.exec('DELETE FROM password_resets; DELETE FROM mail_outbox; UPDATE users SET mfa_pending_secret=NULL,mfa_pending_expires=0;');if(version>=6)copy.exec('DELETE FROM design_previews;');copy.exec('VACUUM; PRAGMA journal_mode=DELETE;');inspectDatabase(copy);}finally{copy.close();}
    const files={'cms.sqlite':await fingerprint(snapshot)};
    const mediaEntries=mediaFiles(db,version);if(mediaEntries.length)await directory(media);
    for(const item of mediaEntries) {
      const source=join(media,item.path.slice(6)),target=join(staging,item.path);
      const fingerprintBefore=await fingerprint(source);
      if(fingerprintBefore.size!==item.size)throw new Error(`Media size mismatch: ${item.path}`);
      await copyFile(source,target);await chmod(target,0o600);files[item.path]=await fingerprint(target);
      if(files[item.path].sha256!==fingerprintBefore.sha256)throw new Error('Media changed during backup');
    }
    const manifest={format:FORMAT,cmsVersion:'0.7.0',schemaVersion:version,createdAt:new Date().toISOString(),files};
    await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    await verifyBackup(staging);if(await exists(output))throw new Error('Backup destination was created during backup');
    await rename(staging,output);return {output,files:Object.keys(files).length};
  }finally{try{db?.close();await rm(staging,{recursive:true,force:true});}finally{release();}}
}
export async function verifyBackup(inputDir) {
  const input=resolve(inputDir);await directory(input);await directory(join(input,'media'));
  const manifestPath=join(input,'manifest.json');const info=await regular(manifestPath);
  if(info.size>8*1024*1024)throw new Error('Backup manifest is too large');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  if(manifest.format!==FORMAT || !manifest.files || typeof manifest.files!=='object' || Array.isArray(manifest.files) || !manifest.files['cms.sqlite'])throw new Error('Invalid backup manifest');
  const names=Object.keys(manifest.files);
  if(names.length>100000)throw new Error('Backup has too many files');
  for(const name of names) {
    if(name!=='cms.sqlite' && !(name.startsWith('media/') && mediaName.test(name.slice(6))))throw new Error('Unsafe path in backup manifest');
    const expected=manifest.files[name];
    if(!Number.isSafeInteger(expected?.size) || expected.size<0 || typeof expected.sha256!=='string' || !/^[a-f0-9]{64}$/.test(expected.sha256))throw new Error('Invalid backup fingerprint');
    const actual=await fingerprint(join(input,name));
    if(actual.size!==expected.size || actual.sha256!==expected.sha256)throw new Error(`Backup checksum mismatch: ${name}`);
  }
  const rootFiles=(await readdir(input)).sort();if(JSON.stringify(rootFiles)!==JSON.stringify(['cms.sqlite','manifest.json','media']))throw new Error('Unexpected files in backup');
  const actualMedia=(await readdir(join(input,'media'))).sort(),expectedMedia=names.filter(name=>name.startsWith('media/')).map(name=>name.slice(6)).sort();
  if(JSON.stringify(actualMedia)!==JSON.stringify(expectedMedia))throw new Error('Unexpected media in backup');
  const db=new DatabaseSync(join(input,'cms.sqlite'),{readOnly:true});
  try {
    const version=inspectDatabase(db);if(version!==manifest.schemaVersion)throw new Error('Backup schema metadata mismatch');
    const referenced=mediaFiles(db,version);
    if(JSON.stringify(referenced.map(item=>item.path).sort())!==JSON.stringify(names.filter(name=>name.startsWith('media/')).sort()) || referenced.some(item=>manifest.files[item.path].size!==item.size))throw new Error('Backup media does not match database');
  }finally{db.close();}
  return manifest;
}
// Restore only to unused paths. Operators can verify the new install, then switch CMS_DB_PATH.
// The existing install is never replaced or deleted by this command.
export async function restoreBackup({inputDir,dbPath,mediaDir=join(dirname(resolve(dbPath)),'media')}) {
  const input=resolve(inputDir),database=resolve(dbPath),media=resolve(mediaDir);
  await disjoint([input,database,media]);
  const release=acquireDataLock(database),id=randomUUID(),dbStage=`${database}.restore-${id}`,mediaStage=`${media}.restore-${id}`;
  let installedDb=false,installedMedia=false;
  try {
    if(await exists(database) || await exists(`${database}-wal`) || await exists(`${database}-shm`) || await exists(media))throw new Error('Restore requires a new database path and a new media directory');
    const manifest=await verifyBackup(input);
    await mkdir(dirname(database),{recursive:true,mode:0o700});await mkdir(mediaStage,{recursive:true,mode:0o700});
    await copyFile(join(input,'cms.sqlite'),dbStage);await chmod(dbStage,0o600);
    for(const name of Object.keys(manifest.files).filter(name=>name.startsWith('media/'))) {const target=join(mediaStage,name.slice(6));await copyFile(join(input,name),target);await chmod(target,0o600);}
    // Validate copied bytes too; the source backup may have changed after verification.
    if((await fingerprint(dbStage)).sha256!==manifest.files['cms.sqlite'].sha256)throw new Error('Backup changed during restore');
    for(const name of Object.keys(manifest.files).filter(name=>name.startsWith('media/')))if((await fingerprint(join(mediaStage,name.slice(6)))).sha256!==manifest.files[name].sha256)throw new Error('Backup media changed during restore');
    const db=openDatabase(dbStage);
    try{db.exec('DELETE FROM design_previews; DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM contact_tokens; DELETE FROM contact_limits; DELETE FROM password_resets; DELETE FROM mail_outbox; UPDATE users SET mfa_pending_secret=NULL,mfa_pending_expires=0;');inspectDatabase(db);db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');}finally{db.close();}
    if(await exists(database) || await exists(media))throw new Error('Restore destination was created during restore');
    await rename(mediaStage,media);installedMedia=true;await rename(dbStage,database);installedDb=true;
    return {database,media,files:Object.keys(manifest.files).length};
  }catch(error){if(installedDb)await rm(database,{force:true});if(installedMedia)await rm(media,{recursive:true,force:true});throw error;}
  finally{try{await rm(dbStage,{force:true});await rm(`${dbStage}-wal`,{force:true});await rm(`${dbStage}-shm`,{force:true});await rm(mediaStage,{recursive:true,force:true});}finally{release();}}
}
