import { inflateSync } from 'node:zlib';
import validator from 'gltf-validator';
import sharp from 'sharp';
import { assetLimit } from './asset-types.mjs';
sharp.cache(false);sharp.concurrency(1);
const requireValue=condition=>{if(!condition)throw new Error('invalid asset');};
const integer=(n,min,max)=>Number.isSafeInteger(n) && n>=min && n<=max;
const within=(offset,length,total)=>integer(offset,0,total) && integer(length,0,total-offset);
async function glb(input) {
  requireValue(input.length>=28 && input.readUInt32LE(0)===0x46546c67 && input.readUInt32LE(4)===2 && input.readUInt32LE(8)===input.length);
  const jsonSize=input.readUInt32LE(12);requireValue(jsonSize%4===0 && jsonSize<=1024*1024 && within(20,jsonSize,input.length) && input.readUInt32LE(16)===0x4e4f534a);
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input.subarray(20,20+jsonSize))),offset=20+jsonSize;
  requireValue(offset+8<=input.length && input.readUInt32LE(offset+4)===0x004e4942);
  const size=input.readUInt32LE(offset);requireValue(size%4===0 && offset+8+size===input.length);
  const binary=input.subarray(offset+8);requireValue(data.asset?.version==='2.0' && data.buffers?.length===1 && integer(data.buffers[0].byteLength,1,size) && size-data.buffers[0].byteLength<=3);
  const safeExtensions=new Set(['KHR_materials_unlit','KHR_texture_transform']);
  // Bound JSON complexity and reject every URI, including data URIs and unused resources.
  let values=0;const stack=[[data,0]];
  while(stack.length){const [value,depth]=stack.pop();requireValue(++values<=150000 && depth<=32);if(value && typeof value==='object')for(const [key,child] of Object.entries(value)){requireValue(key!=='uri');if(key==='extensions')requireValue(Object.keys(child).every(k=>safeExtensions.has(k)));stack.push([child,depth+1]);}}
  requireValue((data.extensionsRequired||[]).every(k=>safeExtensions.has(k)) && (data.extensionsUsed||[]).every(k=>safeExtensions.has(k)));
  for(const [key,max] of [['nodes',2000],['meshes',1000],['materials',1000],['accessors',5000],['bufferViews',5000],['images',20],['animations',100]])requireValue(!data[key] || (Array.isArray(data[key]) && data[key].length<=max));
  let count=0;for(const accessor of data.accessors||[]){requireValue(integer(accessor.count,1,1000000));count+=accessor.count;}requireValue(count<=4000000);
  const report=await validator.validateBytes(new Uint8Array(input),{maxIssues:100,externalResourceFunction:()=>Promise.reject(new Error('external resources forbidden'))});
  requireValue(!report.issues.numErrors && !report.issues.truncated && (data.meshes||[]).some(mesh=>mesh.primitives?.length));
  // A small buffer can still create an expensive scene through repeated mesh instances.
  let workload=0;for(const node of data.nodes||[])if(node.mesh!==undefined){const mesh=data.meshes[node.mesh];for(const primitive of mesh.primitives){workload+=data.accessors[primitive.indices??primitive.attributes.POSITION].count;requireValue(workload<=2000000);}}
  for(const image of data.images||[]) {
    requireValue(['image/png','image/jpeg'].includes(image.mimeType) && integer(image.bufferView,0,(data.bufferViews||[]).length-1));
    const view=data.bufferViews[image.bufferView],start=view.byteOffset||0;requireValue(view.buffer===0 && within(start,view.byteLength,binary.length) && view.byteLength<=5*1024*1024);
    const pixels=sharp(binary.subarray(start,start+view.byteLength),{failOn:'warning',limitInputPixels:16000000,limitInputChannels:4,sequentialRead:true});
    const info=await pixels.metadata();requireValue(info.format===(image.mimeType==='image/png'?'png':'jpeg') && (info.pages||1)===1);
    await pixels.timeout({seconds:3}).raw().toBuffer();
  }
}
function woff(input) {
  requireValue(input.length>=44 && input.readUInt32BE(0)===0x774f4646 && [0x00010000,0x4f54544f].includes(input.readUInt32BE(4)) && input.readUInt32BE(8)===input.length && input.readUInt16BE(14)===0);
  const tables=input.readUInt16BE(12);requireValue(integer(tables,1,128) && 44+tables*20<=input.length);
  const sfnt=input.readUInt32BE(16);requireValue(integer(sfnt,12+tables*16,8*1024*1024));
  // Keep uploaded fonts free of metadata/private payloads.
  for(let i=24;i<44;i+=4)requireValue(input.readUInt32BE(i)===0);
  let original=12+tables*16,previous=-1;const tags=new Set(),ranges=[];
  for(let i=0;i<tables;i++) {
    const at=44+i*20,tag=input.readUInt32BE(at),offset=input.readUInt32BE(at+4),compressed=input.readUInt32BE(at+8),length=input.readUInt32BE(at+12),checksum=input.readUInt32BE(at+16);
    requireValue(tag>previous && !tags.has(tag) && offset%4===0 && offset>=44+tables*20 && within(offset,compressed,input.length) && integer(length,1,8*1024*1024) && compressed>0 && compressed<=length);tags.add(tag);previous=tag;ranges.push([offset,offset+Math.ceil(compressed/4)*4]);
    original+=Math.ceil(length/4)*4;requireValue(original<=sfnt);
    const raw=input.subarray(offset,offset+compressed),table=compressed===length?Buffer.from(raw):inflateSync(raw,{maxOutputLength:length});requireValue(table.length===length);
    if(tag===0x68656164){requireValue(length>=54 && table.readUInt32BE(12)===0x5f0f3cf5);table.fill(0,8,12);}
    let sum=0;for(let j=0;j<table.length;j+=4){let n=0;for(let k=0;k<4;k++)n=(n*256)+(table[j+k]||0);sum=(sum+n)>>>0;}requireValue(sum===checksum);
  }
  let last=44+tables*20;for(const [start,end] of ranges.sort((a,b)=>a[0]-b[0])){requireValue(start===last);last=end;}
  requireValue(original===sfnt && last===input.length && [0x68656164,0x68686561,0x6d617870,0x636d6170,0x686d7478,0x6e616d65,0x706f7374].every(tag=>tags.has(tag)) && (tags.has(0x43464620) || (tags.has(0x676c7966) && tags.has(0x6c6f6361))));
}
try {
  const mime=process.argv[2],chunks=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;requireValue(size<=assetLimit(mime));chunks.push(chunk);}
  const buffer=Buffer.concat(chunks);if(mime==='model/gltf-binary')await glb(buffer);else if(mime==='font/woff')woff(buffer);else throw new Error('invalid mime');
}catch{process.exitCode=1;}
