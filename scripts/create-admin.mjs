import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { resolve } from 'node:path';
import { openDatabase } from '../src/database.mjs';
import { createUser } from '../src/auth.mjs';
async function password(prompt) {
  process.stdout.write(prompt);emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';
    function cleanup(){process.stdin.off('keypress',handler);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');}
    function handler(text,key){
      if(key?.ctrl && key.name==='c'){cleanup();reject(new Error('Cancelled'));}
      else if(key?.name==='return' || key?.name==='enter'){cleanup();resolve(value);}
      else if(key?.name==='backspace'){value=Array.from(value).slice(0,-1).join('');}
      else if(text && !key?.ctrl && !key?.meta && !/[\x00-\x1f\x7f]/.test(text)){value+=text;}
    }
    process.stdin.on('keypress',handler);
  });
}
if(!process.stdin.isTTY)throw new Error('Run create-admin from an interactive terminal; passwords must not be shell arguments');
const rl=createInterface({input:process.stdin,output:process.stdout});const email=await rl.question('Admin email: ');rl.close();
const first=await password('Password (hidden, at least 12 characters): ');const second=await password('Repeat password (hidden): ');
if(first!==second)throw new Error('Passwords do not match');
const db=openDatabase(resolve(process.env.CMS_DB_PATH||'data/cms.sqlite'));
try{await createUser(db,{email,password:first});console.log('Admin created. Run npm start and open /admin.');}finally{db.close();}
