import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp,readFile,writeFile,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { processImage } from '../src/image-processing.mjs';
import { normalizeMedia } from '../src/normalize-media.mjs';
import { openDatabase } from '../src/database.mjs';
import { acquireDataLock } from '../src/data-lock.mjs';

const png=()=>sharp({create:{width:32,height:16,channels:3,background:'#39a978'}}).png().toBuffer();
test('full image decoding rejects valid headers with corrupted or truncated pixel data',async()=>{
  const input=await png();
  await assert.rejects(processImage(input.subarray(0,45),'image/png'),{status:422});
  const corrupt=Buffer.from(input);corrupt.fill(0,45,corrupt.length-12);
  await assert.rejects(processImage(corrupt,'image/png'),{status:422});
  await assert.rejects(processImage(input,'image/jpeg'),{status:422});
  await assert.rejects(processImage(Buffer.alloc(5*1024*1024+1),'image/png'),{status:413});
});
test('JPEG pixels are auto-oriented, metadata is removed and the stored output decodes completely',async()=>{
  const input=await sharp({create:{width:80,height:40,channels:3,background:'#c28943'}}).withMetadata({orientation:6}).jpeg().toBuffer();
  assert.ok((await sharp(input).metadata()).exif);
  const output=await processImage(input,'image/jpeg'),metadata=await sharp(output.buffer).metadata();
  assert.equal(output.width,40);assert.equal(output.height,80);assert.equal(metadata.exif,undefined);assert.equal(metadata.icc,undefined);assert.equal(metadata.orientation,undefined);
  const decoded=await sharp(output.buffer).raw().toBuffer({resolveWithObject:true});assert.equal(decoded.info.width,40);
});
test('image dimensions are limited and large allowed images are resized',async()=>{
  const allowed=await sharp({create:{width:3000,height:2000,channels:3,background:'#ffffff'}}).png().toBuffer();
  const output=await processImage(allowed,'image/png');assert.equal(output.width,2560);assert.equal(output.height,1707);
  const oversized=await sharp({create:{width:5000,height:4000,channels:3,background:'#ffffff'}}).png().toBuffer();
  await assert.rejects(processImage(oversized,'image/png'),{status:422});
});
async function legacy(t,{invalid=false}={}) {
  const dir=await mkdtemp(join(tmpdir(),'cms-image-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const dbPath=join(dir,'cms.sqlite'),mediaDir=join(dir,'media');const {mkdir}=await import('node:fs/promises');await mkdir(mediaDir);
  const db=openDatabase(dbPath),user=randomUUID(),id=randomUUID(),time=new Date().toISOString();
  db.prepare('INSERT INTO users(id,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(user,'legacy@example.test','unused','admin',time,time);
  const buffer=invalid?Buffer.from('invalid'):await sharp({create:{width:80,height:40,channels:3,background:'#d38a23'}}).withMetadata({orientation:6}).jpeg().toBuffer();
  await writeFile(join(mediaDir,`${id}.jpg`),buffer);
  db.prepare('INSERT INTO media VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'old.jpg','image/jpeg',buffer.length,80,40,'قديم',time,time,user);db.close();return {dbPath,mediaDir,id,buffer};
}
test('offline image normalization upgrades legacy orientation/metadata while preserving IDs and references',async t=>{
  const f=await legacy(t);assert.equal((await normalizeMedia(f)).normalized,1);
  const db=openDatabase(f.dbPath),item=db.prepare('SELECT * FROM media WHERE id=?').get(f.id);db.close();
  const buffer=await readFile(join(f.mediaDir,`${f.id}.jpg`));assert.equal(item.width,40);assert.equal(item.height,80);assert.equal(item.size,buffer.length);assert.equal(item.alt,'قديم');assert.equal((await sharp(buffer).metadata()).exif,undefined);
  assert.equal((await readdir(f.mediaDir)).length,1);
});
test('normalization rejects a running install and corrupt legacy files without changing the file',async t=>{
  const f=await legacy(t,{invalid:true}),release=acquireDataLock(f.dbPath);
  await assert.rejects(normalizeMedia(f),/locked/);release();
  await assert.rejects(normalizeMedia(f),{status:422});assert.deepEqual(await readFile(join(f.mediaDir,`${f.id}.jpg`)),f.buffer);assert.equal((await readdir(f.mediaDir)).length,1);
});
