import { isIP } from 'node:net';
const normalize=ip=>ip?.toLowerCase().replace(/^::ffff:(?=\d+\.)/,'');
export function proxyList(value=[]) {
  const ips=Array.isArray(value)?value:String(value).split(',').map(value=>value.trim()).filter(Boolean);
  if(ips.some(ip=>!isIP(ip)))throw new Error('CMS_TRUSTED_PROXY_IPS must contain exact IP addresses, not CIDRs');
  return new Set(ips.map(normalize));
}
export function clientIP(req,trusted) {
  let peer=normalize(req.socket.remoteAddress)||'unknown';
  if(!trusted.has(peer))return peer;
  const raw=req.headers['x-forwarded-for'];if(!raw)return peer;
  if(typeof raw!=='string' || raw.length>1000)throw new Error('Invalid forwarding chain');
  const chain=raw.split(',').map(ip=>normalize(ip.trim()));
  if(chain.length>10 || chain.some(ip=>!isIP(ip)))throw new Error('Invalid forwarding chain');
  for(let index=chain.length-1;index>=0 && trusted.has(peer);index--)peer=chain[index];
  return peer;
}
