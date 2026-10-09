import { resolve } from 'node:path';
import { createBackup,verifyBackup } from '../src/backup.mjs';
if(process.argv[2]==='--verify') {
  if(!process.argv[3] || process.argv.length!==4)throw new Error('Usage: npm run backup -- --verify BACKUP_DIRECTORY');
  const manifest=await verifyBackup(resolve(process.argv[3]));console.log(`Backup verified: ${Object.keys(manifest.files).length} files, schema ${manifest.schemaVersion}`);
}else {
  if(!process.argv[2] || process.argv.length!==3)throw new Error('Usage: stop the CMS, then npm run backup -- NEW_BACKUP_DIRECTORY');
  const result=await createBackup({dbPath:resolve(process.env.CMS_DB_PATH||'data/cms.sqlite'),outputDir:resolve(process.argv[2]),...(process.env.CMS_MEDIA_DIR?{mediaDir:resolve(process.env.CMS_MEDIA_DIR)}:{})});
  console.log(`Backup verified and saved: ${result.output} (${result.files} files)`);
}
