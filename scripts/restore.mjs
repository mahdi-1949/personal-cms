import { resolve } from 'node:path';
import { restoreBackup } from '../src/backup.mjs';
if(!process.argv[2] || process.argv.length!==3 || !process.env.CMS_DB_PATH)throw new Error('Usage: CMS_DB_PATH=NEW_DATABASE_PATH npm run restore -- BACKUP_DIRECTORY (CMS_MEDIA_DIR must also point to a new directory if set)');
const result=await restoreBackup({inputDir:resolve(process.argv[2]),dbPath:resolve(process.env.CMS_DB_PATH),...(process.env.CMS_MEDIA_DIR?{mediaDir:resolve(process.env.CMS_MEDIA_DIR)}:{})});
console.log(`Restored and verified: ${result.database}\nMedia: ${result.media}\nAll prior sessions were revoked. Verify this install before switching the service configuration.`);
