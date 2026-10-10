import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const vendorFiles=['three.module.js','three.core.js','LICENSE.txt'];
export const vendorSource=name=>readFile(fileURLToPath(new URL(name==='LICENSE.txt'?'../node_modules/three/LICENSE':`../node_modules/three/build/${name}`,import.meta.url)));
export function runtimePolicy(prefix,origin,basePath='') {
  const imports=JSON.stringify({imports:{three:`${basePath}/design-vendor/three.module.js`}});
  const hash=createHash('sha256').update(imports).digest('base64');
  // Absolute host sources also work when the document is forced to an opaque origin.
  const policy=`default-src 'none'; script-src ${origin}${prefix}entry.js ${origin}${prefix}bridge.js ${origin}${basePath}/design-vendor/ 'sha256-${hash}'; style-src ${origin}${prefix}style.css 'unsafe-inline'; img-src ${origin}${prefix}assets/ data: blob:; connect-src 'none'; font-src 'none'; media-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return {imports,policy};
}
export function runtimeDocument(source,{prefix,origin,basePath=''}) {
  const {imports,policy}=runtimePolicy(prefix,origin,basePath);
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${esc(policy)}"><title>${esc(source.name)}</title><link rel="stylesheet" href="${esc(prefix)}style.css"><script type="importmap">${imports}</script><script src="${esc(prefix)}bridge.js" crossorigin="anonymous"></script><script type="module" src="${esc(prefix)}entry.js" crossorigin="anonymous"></script></head><body>${source.html}</body></html>`;
}
export function runtimeBridge(source,prefix,media=[]) {
  const assets=Object.fromEntries(source.assets.flatMap(id=>{const image=media.find(m=>m.id===id);return image?[[id,`${prefix}assets/${id}.${image.mime==='image/png'?'png':'jpg'}`]]:[];}));
  return `window.cms=Object.freeze(${JSON.stringify({name:source.name,assets})});
(function(){let sent=0;const send=(type,text)=>{if(sent++<100)parent.postMessage({channel:'cms-design',type,text:String(text).slice(0,2000)},'*');};
for(const kind of ['log','warn','error']){const original=console[kind].bind(console);console[kind]=(...args)=>{original(...args);send(kind,args.map(a=>{try{return typeof a==='string'?a:JSON.stringify(a);}catch{return '[value]';}}).join(' '));};}
addEventListener('error',e=>send('error',e.message));addEventListener('unhandledrejection',e=>send('error',e.reason?.message||'Promise rejected'));
addEventListener('DOMContentLoaded',()=>send('ready','پیش‌نمایش آماده است.'));
})();\n`;
}
