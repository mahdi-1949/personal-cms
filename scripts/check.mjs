import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
async function files(dir){const entries=await readdir(dir,{withFileTypes:true});const results=[];for(const entry of entries){const path=join(dir,entry.name);if(entry.isDirectory())results.push(...await files(path));else if(/\.(mjs|js)$/.test(entry.name))results.push(path);}return results;}
const sources=(await Promise.all(['src','public','scripts','tests'].map(files))).flat().sort();
for(const path of sources)execFileSync(process.execPath,['--check',path],{stdio:'inherit'});
console.log(`${sources.length} JavaScript files parsed successfully.`);
