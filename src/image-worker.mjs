import sharp from 'sharp';
sharp.cache(false);sharp.concurrency(1);
const MAX=5*1024*1024,mime=process.argv[2];let size=0;const chunks=[];
try {
  for await(const chunk of process.stdin){size+=chunk.length;if(size>MAX)throw new Error('too large');chunks.push(chunk);}
  const input=Buffer.concat(chunks),format=mime==='image/png'?'png':mime==='image/jpeg'?'jpeg':null;
  if(!format || !input.length || (format==='png'?!input.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):input[0]!==255 || input[1]!==216))throw new Error('invalid format');
  const image=sharp(input,{failOn:'warning',limitInputPixels:16000000,limitInputChannels:4,sequentialRead:true});
  const metadata=await image.metadata();
  if(metadata.format!==format || !metadata.width || !metadata.height || (metadata.pages||1)!==1)throw new Error('invalid image');
  let pipeline=image.rotate().resize({width:2560,height:2560,fit:'inside',withoutEnlargement:true}).timeout({seconds:5});
  pipeline=format==='png'?pipeline.png({compressionLevel:9}):pipeline.jpeg({quality:85,mozjpeg:false});
  // Default output strips EXIF/XMP/ICC; metadata() alone would not decode pixels.
  const {data,info}=await pipeline.toBuffer({resolveWithObject:true});
  if(data.length>MAX)throw new Error('too large');
  const header=Buffer.alloc(8);header.writeUInt32BE(info.width,0);header.writeUInt32BE(info.height,4);
  process.stdout.write(Buffer.concat([header,data]));
}catch{process.stderr.write('INVALID_IMAGE');process.exitCode=1;}
