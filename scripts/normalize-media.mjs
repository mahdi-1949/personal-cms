import { resolve } from 'node:path';
import { normalizeMedia } from '../src/normalize-media.mjs';
try {
  const result=await normalizeMedia({dbPath:resolve(process.env.CMS_DB_PATH||'data/cms.sqlite'),...(process.env.CMS_MEDIA_DIR?{mediaDir:resolve(process.env.CMS_MEDIA_DIR)}:{})});
  console.log(`${result.normalized} images decoded, normalized and stripped of metadata.`);
}catch(error){console.error('Image normalization failed:',error.message);process.exitCode=1;}
