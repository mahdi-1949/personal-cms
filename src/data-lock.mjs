import { mkdirSync,writeFileSync,rmSync,realpathSync } from 'node:fs';
import { dirname,resolve,basename,join } from 'node:path';

function canonical(path) {
  try{return realpathSync(path);}catch(error){if(error.code!=='ENOENT')throw error;return join(canonical(dirname(path)),basename(path));}
}

// A single managed writer per install keeps offline database/media operations coherent.
// Stale locks are deliberately never removed automatically (PID reuse and shared volumes).
export function acquireDataLock(dbPath) {
  if(dbPath===':memory:')return ()=>{};
  const path=`${canonical(resolve(dbPath))}.cms-lock`;
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  try{mkdirSync(path,{mode:0o700});}
  catch(error){if(error.code==='EEXIST')throw new Error(`CMS data is locked: ${path}. Stop the running CMS first. For a stale lock, verify no CMS process uses this database before removing the lock directory.`);throw error;}
  try{writeFileSync(`${path}/owner.json`,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});}
  catch(error){rmSync(path,{recursive:true,force:true});throw error;}
  let released=false;
  return ()=>{if(!released){rmSync(path,{recursive:true,force:true});released=true;}};
}
