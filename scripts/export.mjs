import { resolve } from 'node:path';
import { exportSite } from '../src/export.mjs';
import { acquireDataLock } from '../src/data-lock.mjs';
if(!process.env.CMS_PUBLIC_URL)throw new Error('Set CMS_PUBLIC_URL to your public domain or GitHub Pages URL before export');
const release=acquireDataLock(resolve(process.env.CMS_DB_PATH||'data/cms.sqlite'));
try {
const result=await exportSite({dbPath:resolve(process.env.CMS_DB_PATH||'data/cms.sqlite'),outputDir:resolve(process.argv[2]||'dist'),publicURL:process.env.CMS_PUBLIC_URL,...(process.env.CMS_MEDIA_DIR?{mediaDir:resolve(process.env.CMS_MEDIA_DIR)}:{})});
console.log(`Exported ${result.count} published items to ${result.output}`);
for(const warning of result.warnings)console.log(warning);
}finally{release();}
