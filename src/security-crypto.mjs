import { randomBytes,createCipheriv,createDecipheriv,createHmac,timingSafeEqual } from 'node:crypto';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function securityKey(value) {
  if(value===undefined || value===null || value==='')return null;
  const key=Buffer.isBuffer(value)?value:typeof value==='string' && /^[A-Za-z0-9+/]{43}=$/.test(value)?Buffer.from(value,'base64'):null;
  if(!key || key.length!==32)throw new Error('CMS_SECURITY_KEY must be a base64-encoded random 32-byte key');
  return key;
}
export function encrypt(value,key,context) {
  if(!key)throw new Error('Security encryption key is not configured');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(context));
  const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),bytes].map(part=>part.toString('base64url')).join('.');
}
export function decrypt(value,key,context) {
  if(!key)throw new Error('Security encryption key is not configured');
  const parts=value.split('.');if(parts.length!==3)throw new Error('Invalid encrypted value');
  const [iv,tag,bytes]=parts.map(part=>Buffer.from(part,'base64url'));
  const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(context));cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(bytes),cipher.final()]).toString('utf8');
}
export function base32(bytes) {
  let bits=0,value=0,result='';
  for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){result+=alphabet[(value>>>(bits-5))&31];bits-=5;}}
  if(bits)result+=alphabet[(value<<(5-bits))&31];return result;
}
function unbase32(secret) {
  if(!/^[A-Z2-7]+$/.test(secret))throw new Error('Invalid TOTP secret');
  let bits=0,value=0;const bytes=[];
  for(const char of secret){value=(value<<5)|alphabet.indexOf(char);bits+=5;if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8;}}
  return Buffer.from(bytes);
}
// RFC 6238 / RFC 4226, HMAC-SHA1, 30-second steps. Tested against published vectors.
export function totp(secret,time=Date.now(),digits=6) {
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(time/30000)));
  const hash=createHmac('sha1',unbase32(secret)).update(counter).digest(),offset=hash.at(-1)&15;
  return String((hash.readUInt32BE(offset)&0x7fffffff)%10**digits).padStart(digits,'0');
}
export function matchTotp(secret,code,lastStep=-1,time=Date.now()) {
  if(typeof code!=='string' || !/^\d{6}$/.test(code))return null;
  const step=Math.floor(time/30000);let found=null;
  for(const candidate of [step,step-1,step+1]) {
    if(candidate<0)continue;
    const matches=timingSafeEqual(Buffer.from(code),Buffer.from(totp(secret,candidate*30000)));
    if(matches && candidate>lastStep && found===null)found=candidate;
  }
  return found;
}
