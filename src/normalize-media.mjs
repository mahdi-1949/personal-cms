import { lstat,mkdtemp,writeFile,readFile,rename,rm } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { acquireDataLock } from './data-lock.mjs';
import { openDatabase } from './database.mjs';
import { mediaPath,listMedia } from './media.mjs';
import { processImage } from './image-processing.mjs';

// Offline upgrade of legacy files. Preflight all images; each replacement is atomic.
export async function normalizeMedia({dbPath,mediaDir=resolve(dirname(dbPath),'media')}) {
  const release=acquireDataLock(dbPath);let db,stage,keepStage=false;
  try {
    if(!(await lstat(dbPath)).isFile())throw new Error('An existing database is required');
    db=openDatabase(dbPath);const items=listMedia(db);
    if(!items.length)return {normalized:0};
    const directory=await lstat(mediaDir);
    if(!directory.isDirectory() || directory.isSymbolicLink())throw new Error('Media directory must be a real directory');
    stage=await mkdtemp(join(mediaDir,'.normalize-'));
    const prepared=[];
    for(const item of items) {
      const path=mediaPath(mediaDir,item),stat=await lstat(path);
      if(!stat.isFile() || stat.isSymbolicLink() || stat.size>5*1024*1024)throw new Error('Media file is invalid');
      const original=await readFile(path),result=await processImage(original,item.mime);
      const replacement=join(stage,`${item.id}.new`),backup=join(stage,`${item.id}.original`);
      await writeFile(replacement,result.buffer,{flag:'wx',mode:0o600});
      await writeFile(backup,original,{flag:'wx',mode:0o600});
      prepared.push({item,path,replacement,backup,width:result.width,height:result.height,size:result.buffer.length});
    }
    for(const entry of prepared) {
      let replaced=false;db.exec('BEGIN IMMEDIATE');
      try {
        await rename(entry.replacement,entry.path);replaced=true;
        const now=new Date(Math.max(Date.now(),Date.parse(entry.item.updated_at)+1)).toISOString();
        db.prepare('UPDATE media SET size=?,width=?,height=?,updated_at=? WHERE id=?').run(entry.size,entry.width,entry.height,now,entry.item.id);
        db.exec('COMMIT');
      }catch(error) {
        db.exec('ROLLBACK');
        if(replaced)try{await rename(entry.backup,entry.path);}catch{keepStage=true;throw new Error(`Image rollback failed. Restore your backup before restarting. Recovery files: ${stage}`);}
        throw error;
      }
    }
    return {normalized:prepared.length};
  }finally{try{if(stage && !keepStage)await rm(stage,{recursive:true,force:true});}finally{try{db?.close();}finally{release();}}}
}
