import { mkdir,writeFile,readFile,rename,rm,stat } from 'node:fs/promises';
import { resolve,dirname,join,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase,getSite } from './database.mjs';
import { publishedContent } from './content.mjs';
import { contentPath } from './modules/registry.mjs';
import { siteURL,renderHome,renderContent,renderNotFound,sitemap } from './render.mjs';
export async function exportSite({dbPath,outputDir,publicURL}) {
  const output=resolve(outputDir);const database=resolve(dbPath);const within=relative(output,database);
  if(output===dirname(output) || within==='' || (!within.startsWith('..') && !within.startsWith('/'))) throw new Error('Export destination must not contain the database');
  const baseURL=siteURL(publicURL);const basePath=new URL(baseURL).pathname.replace(/\/$/,'');
  let exists=false;
  try {await stat(output);exists=true;await readFile(join(output,'.core-cms-export'));}
  catch(error){if(exists)throw new Error('Destination exists and is not a Core CMS export; choose an empty path');if(error.code!=='ENOENT')throw error;}
  await stat(database); // A mistyped path must not silently export a new empty CMS.
  const staging=`${output}.staging-${randomUUID()}`;
  const db=openDatabase(database);
  try {
    const site=getSite(db);const items=publishedContent(db,site);const options={baseURL,basePath};
    await mkdir(join(staging,'assets'),{recursive:true});
    await writeFile(join(staging,'index.html'),renderHome(site,items,options));
    await writeFile(join(staging,'404.html'),renderNotFound(site,options));
    for(const item of items){const path=contentPath(item);if(path==='/')continue;const folder=join(staging,path.slice(1));await mkdir(folder,{recursive:true});await writeFile(join(folder,'index.html'),renderContent(site,item,options));}
    await writeFile(join(staging,'assets/site.css'),await readFile(fileURLToPath(new URL('../public/site.css',import.meta.url))));
    await writeFile(join(staging,'sitemap.xml'),sitemap(items,baseURL));
    await writeFile(join(staging,'robots.txt'),`User-agent: *\nAllow: /\nSitemap: ${baseURL}/sitemap.xml\n`);
    await writeFile(join(staging,'.nojekyll'),'');
    await writeFile(join(staging,'.core-cms-export'),JSON.stringify({version:'0.1.0',exportedAt:new Date().toISOString()}));
    if(exists){const previous=`${output}.previous-${randomUUID()}`;await rename(output,previous);try{await rename(staging,output);}catch(error){await rename(previous,output);throw error;}await rm(previous,{recursive:true});}
    else await rename(staging,output);
    return {output,count:items.length};
  } finally {db.close();await rm(staging,{recursive:true,force:true});}
}
