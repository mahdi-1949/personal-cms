import { modules, contentPath } from './modules/registry.mjs';
export const escapeHTML = value => String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function siteURL(value) {
  const url=new URL(value);
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('CMS_PUBLIC_URL must be an HTTP(S) URL without credentials, query or fragment');
  return url.href.replace(/\/$/,'');
}
export function publicPath(path,base='') {
  return `${base}${path}`;
}
function layout({site,title,description,path,body,baseURL,basePath=''}) {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(title)}</title><meta name="description" content="${escapeHTML(description)}"><link rel="canonical" href="${escapeHTML(baseURL+path)}"><meta property="og:title" content="${escapeHTML(title)}"><meta property="og:description" content="${escapeHTML(description)}"><meta property="og:url" content="${escapeHTML(baseURL+path)}"><meta property="og:type" content="website"><link rel="stylesheet" href="${escapeHTML(basePath)}/assets/site.css"></head><body><header><a class="brand" href="${escapeHTML(basePath)}/">${escapeHTML(site.name)}</a><span>طراحی و محتوای اختصاصی</span></header><main>${body}</main><footer>${escapeHTML(site.name)} · ساخته‌شده با Core CMS</footer></body></html>`;
}
export function renderHome(site,items,options) {
  const home=items.find(item=>item.kind==='pages' && item.slug==='home');
  const groups=modules.filter(module=>site.enabledModules.includes(module.key)).map(module=>{
    const group=items.filter(item=>item.kind===module.key && item.id!==home?.id);
    if (!group.length) return '';
    return `<section><h2>${module.label}</h2><div class="cards">${group.map(item=>`<a class="card" href="${escapeHTML(publicPath(contentPath(item),options.basePath))}"><small>${module.singular}</small><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.excerpt)}</p><span>مشاهده ←</span></a>`).join('')}</div></section>`;
  }).join('');
  const intro=`<section class="hero"><small>وب‌سایت اختصاصی شما</small><h1>${escapeHTML(home?.title||site.name)}</h1><p>${escapeHTML(home?.excerpt||site.description)}</p>${home?.body?`<div class="prose">${escapeHTML(home.body)}</div>`:''}</section>`;
  return layout({site,title:home?.seo_title||home?.title||site.name,description:home?.seo_description||home?.excerpt||site.description,path:'/',body:intro+groups,...options});
}
export function renderContent(site,item,options) {
  return layout({site,title:item.seo_title||item.title,description:item.seo_description||item.excerpt||site.description,path:contentPath(item),body:`<article class="article"><a class="back" href="${escapeHTML(options.basePath||'')}/">← صفحه اصلی</a><h1>${escapeHTML(item.title)}</h1><p class="lead">${escapeHTML(item.excerpt)}</p><div class="prose">${escapeHTML(item.body)}</div></article>`,...options});
}
export function renderNotFound(site,options) {
  return layout({site,title:'صفحه پیدا نشد',description:'این صفحه در دسترس نیست.',path:'/404/',body:`<section class="hero"><h1>صفحه پیدا نشد</h1><a href="${escapeHTML(options.basePath||'')}/">بازگشت به صفحه اصلی</a></section>`,...options});
}
export function sitemap(items,baseURL) {
  const paths=[...new Set(['/',...items.map(contentPath)])];
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(path=>`<url><loc>${escapeHTML(baseURL+path)}</loc></url>`).join('')}</urlset>`;
}
