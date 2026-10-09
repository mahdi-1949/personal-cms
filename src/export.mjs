import { mkdir,writeFile,readFile,rename,rm,stat,copyFile } from 'node:fs/promises';
import { resolve,dirname,join,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase,getSite } from './database.mjs';
import { publishedContent } from './content.mjs';
import { contentPath } from './modules/registry.mjs';
import { publicMenu,referencedMedia } from './blocks.mjs';
import { listMedia,mediaPath } from './media.mjs';
import { publicCategories,categoryPath } from './categories.mjs';
import { publicRedirects } from './redirects.mjs';
import { siteURL,renderHome,renderContent,renderCategory,renderRedirect,renderNotFound,sitemap } from './render.mjs';
export async function exportSite({dbPath,outputDir,publicURL,mediaDir=join(dirname(resolve(dbPath)),'media')}) {
  const output=resolve(outputDir);const database=resolve(dbPath);const within=relative(output,database);
  if(output===dirname(output) || within==='' || (!within.startsWith('..') && !within.startsWith('/'))) throw new Error('Export destination must not contain the database');
  const mediaWithin=relative(output,resolve(mediaDir));
  if(mediaWithin==='' || (!mediaWithin.startsWith('..') && !mediaWithin.startsWith('/')))throw new Error('Export destination must not contain source media');
  const baseURL=siteURL(publicURL);const basePath=new URL(baseURL).pathname.replace(/\/$/,'');
  let exists=false;
  try {await stat(output);exists=true;await readFile(join(output,'.core-cms-export'));}
  catch(error){if(exists)throw new Error('Destination exists and is not a Core CMS export; choose an empty path');if(error.code!=='ENOENT')throw error;}
  await stat(database); // A mistyped path must not silently export a new empty CMS.
  const staging=`${output}.staging-${randomUUID()}`;
  const db=openDatabase(database);
  try {
    const site=getSite(db);const items=publishedContent(db,site);const ids=referencedMedia(items);const media=listMedia(db).filter(image=>ids.includes(image.id));
    const categories=publicCategories(db,items);const redirects=publicRedirects(db,items,categories);
    const options={baseURL,basePath,items,media,categories,menu:publicMenu(db,items)};
    const staticSite={...site,contactEnabled:false};
    await mkdir(join(staging,'assets'),{recursive:true});
    if(media.length)await mkdir(join(staging,'media'));
    for(const image of media)await copyFile(mediaPath(mediaDir,image),mediaPath(join(staging,'media'),image));
    await writeFile(join(staging,'index.html'),renderHome(staticSite,items,options));
    await writeFile(join(staging,'404.html'),renderNotFound(staticSite,options));
    for(const item of items){const path=contentPath(item);if(path==='/')continue;const folder=join(staging,path.slice(1));await mkdir(folder,{recursive:true});await writeFile(join(folder,'index.html'),renderContent(staticSite,item,options));}
    for(const category of categories){const folder=join(staging,categoryPath(category).slice(1));await mkdir(folder,{recursive:true});await writeFile(join(folder,'index.html'),renderCategory(staticSite,category,items,options));}
    for(const alias of redirects){const folder=join(staging,alias.path.slice(1));await mkdir(folder,{recursive:true});await writeFile(join(folder,'index.html'),renderRedirect(alias.destination,basePath));}
    await writeFile(join(staging,'assets/site.css'),await readFile(fileURLToPath(new URL('../public/site.css',import.meta.url))));
    await writeFile(join(staging,'sitemap.xml'),sitemap(items,baseURL,categories.map(categoryPath)));
    await writeFile(join(staging,'robots.txt'),`User-agent: *\nAllow: /\nSitemap: ${baseURL}/sitemap.xml\n`);
    await writeFile(join(staging,'.nojekyll'),'');
    await writeFile(join(staging,'.core-cms-export'),JSON.stringify({version:'0.3.0',exportedAt:new Date().toISOString()}));
    if(exists){const previous=`${output}.previous-${randomUUID()}`;await rename(output,previous);try{await rename(staging,output);}catch(error){await rename(previous,output);throw error;}await rm(previous,{recursive:true});}
    else await rename(staging,output);
    return {output,count:items.length,warnings:site.contactEnabled?['Contact form is excluded from static export; it requires the Node.js backend.']:[]};
  } finally {db.close();await rm(staging,{recursive:true,force:true});}
}
