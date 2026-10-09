import { modules, contentPath } from './modules/registry.mjs';
import { categoryPath } from './categories.mjs';
import { defaultTheme,validateTheme } from './templates.mjs';
export const escapeHTML = value => String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function siteURL(value) {
  const url=new URL(value);
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('CMS_PUBLIC_URL must be an HTTP(S) URL without credentials, query or fragment');
  return url.href.replace(/\/$/,'');
}
export function publicPath(path,base='') {
  return `${base}${path}`;
}
function layout({site,title,description,path,body,baseURL,basePath='',menu=[],scripts=[],preview=false}) {
  const theme=validateTheme(site.theme||defaultTheme);
  const links=[...menu,...(site.contactEnabled?[{path:'/contact/',label:'تماس با ما'}]:[])].map(link=>`<a href="${escapeHTML(basePath+link.path)}">${escapeHTML(link.label)}</a>`).join('');
  const meta=preview?'<meta name="robots" content="noindex,nofollow,noarchive">':`<link rel="canonical" href="${escapeHTML(baseURL+path)}"><meta property="og:title" content="${escapeHTML(title)}"><meta property="og:description" content="${escapeHTML(description)}"><meta property="og:url" content="${escapeHTML(baseURL+path)}"><meta property="og:type" content="website">`;
  const banner=preview?'<div class="preview-banner" role="status">پیش‌نمایش خصوصی آخرین نسخه ذخیره‌شده؛ این نمایش وضعیت انتشار صفحه را تغییر نمی‌دهد.</div>':'';
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(title)}</title><meta name="description" content="${escapeHTML(description)}">${meta}<link rel="stylesheet" href="${escapeHTML(basePath)}/assets/site.css"><link rel="stylesheet" href="${escapeHTML(basePath)}/assets/theme.css">${scripts.map(script=>`<script type="module" src="${escapeHTML(basePath+script)}"></script>`).join('')}</head><body class="site-template-${theme.template}"><a class="skip-link" href="#main-content">رفتن به محتوای اصلی</a>${banner}<header class="site-header"><a class="brand" href="${escapeHTML(basePath)}/">${escapeHTML(site.name)}</a>${links?`<nav aria-label="منوی اصلی">${links}</nav>`:''}</header><main id="main-content">${body}</main><footer>${escapeHTML(site.name)}</footer></body></html>`;
}
function imageHTML(mediaId,alt,options,{eager=false}={}) {
  const image=options.media?.find(image=>image.id===mediaId);if(!image)return '';
  const path=`/media/${image.id}.${image.mime==='image/png'?'png':'jpg'}`;
  return `<img loading="${eager?'eager':'lazy'}" decoding="async" src="${escapeHTML((options.basePath||'')+path)}" width="${image.width}" height="${image.height}" alt="${escapeHTML(alt||image.alt)}">`;
}
function buttonHTML(contentId,label,options) {
  const target=options.items?.find(item=>item.id===contentId);
  return target?`<a class="cta" href="${escapeHTML((options.basePath||'')+contentPath(target))}">${escapeHTML(label)}</a>`:'';
}
export function renderBlocks(item,options) {
  if(!item.blocks?.length)return `<div class="prose">${escapeHTML(item.body)}</div>`;
  return item.blocks.map(block=>{
    if(block.type==='heading')return `<h${block.level}>${escapeHTML(block.text)}</h${block.level}>`;
    if(block.type==='paragraph')return `<div class="prose block-paragraph">${escapeHTML(block.text)}</div>`;
    if(block.type==='image') {
      const image=imageHTML(block.mediaId,block.alt,options);if(!image)return '';
      return `<figure>${image}${block.caption?`<figcaption>${escapeHTML(block.caption)}</figcaption>`:''}</figure>`;
    }
    if(block.type==='cta')return `<p>${buttonHTML(block.contentId,block.label,options)}</p>`;
    if(block.type==='hero') {
      const image=imageHTML(block.mediaId,block.alt,options);
      return `<section class="section-hero section-hero-${block.variant}${image?' has-image':''}"><div><h2>${escapeHTML(block.title)}</h2><p class="prose">${escapeHTML(block.text)}</p>${buttonHTML(block.contentId,block.label,options)}</div>${image?`<figure>${image}</figure>`:''}</section>`;
    }
    if(block.type==='cards')return `<section class="section-cards">${block.title?`<h2>${escapeHTML(block.title)}</h2>`:''}<div class="cards cards-${block.variant}">${block.items.map(card=>`<article class="card">${imageHTML(card.mediaId,card.alt,options)}<h3>${escapeHTML(card.title)}</h3><p class="prose">${escapeHTML(card.text)}</p>${buttonHTML(card.contentId,'مشاهده',options)}</article>`).join('')}</div></section>`;
    if(block.type==='faq')return `<section class="section-faq">${block.title?`<h2>${escapeHTML(block.title)}</h2>`:''}${block.items.map(item=>`<details><summary>${escapeHTML(item.question)}</summary><div class="prose">${escapeHTML(item.answer)}</div></details>`).join('')}</section>`;
    return '';
  }).join('');
}
export function renderHome(site,items,options) {
  const home=items.find(item=>item.kind==='pages' && item.slug==='home');
  const groups=modules.filter(module=>site.enabledModules.includes(module.key)).map(module=>{
    const group=items.filter(item=>item.kind===module.key && item.id!==home?.id);
    if (!group.length) return '';
    return `<section><h2>${module.label}</h2><div class="cards">${group.map(item=>`<a class="card" href="${escapeHTML(publicPath(contentPath(item),options.basePath))}"><small>${module.singular}</small><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.excerpt)}</p><span>مشاهده ←</span></a>`).join('')}</div></section>`;
  }).join('');
  const intro=`<section class="home-intro page-template-${escapeHTML(home?.template||'standard')}"><div class="hero page-intro"><h1>${escapeHTML(home?.title||site.name)}</h1><p class="lead">${escapeHTML(home?.excerpt||site.description)}</p></div>${home?`<div class="page-body">${renderBlocks(home,options)}</div>`:''}</section>`;
  return layout({site,title:home?.seo_title||home?.title||site.name,description:home?.seo_description||home?.excerpt||site.description,path:'/',body:intro+groups,...options});
}
export function renderContent(site,item,options) {
  const categories=(options.categories||[]).filter(category=>item.categoryIds?.includes(category.id)).map(category=>`<a href="${escapeHTML((options.basePath||'')+categoryPath(category))}">${escapeHTML(category.name)}</a>`).join(' · ');
  const template=item.template||'standard';
  const metadata=template==='article'?`<p class="article-date">آخرین ویرایش: <time datetime="${escapeHTML(item.updated_at)}">${escapeHTML(new Date(item.updated_at).toLocaleDateString('fa-IR'))}</time></p>`:'';
  const heading=`<div class="page-intro"><a class="back" href="${escapeHTML(options.basePath||'')}/">← صفحه اصلی</a><h1>${escapeHTML(item.title)}</h1><p class="lead">${escapeHTML(item.excerpt)}</p>${metadata}${categories?`<nav class="categories" aria-label="دسته‌های مقاله">${categories}</nav>`:''}</div>`;
  const body=`<article class="article page-template-${escapeHTML(template)}">${heading}<div class="page-body">${renderBlocks(item,options)}</div></article>`;
  return layout({site,title:item.seo_title||item.title,description:item.seo_description||item.excerpt||site.description,path:contentPath(item),body,...options});
}
export function renderCategory(site,category,items,options) {
  const posts=items.filter(item=>item.kind==='posts' && item.categoryIds.includes(category.id));
  const cards=posts.map(item=>`<a class="card" href="${escapeHTML((options.basePath||'')+contentPath(item))}"><h2>${escapeHTML(item.title)}</h2><p>${escapeHTML(item.excerpt)}</p></a>`).join('');
  return layout({site,title:`${category.name} | ${site.name}`,description:`مقالات ${category.name}`,path:categoryPath(category),body:`<section class="hero"><h1>${escapeHTML(category.name)}</h1></section><section class="cards">${cards}</section>`,...options});
}
export function renderContact(site,options) {
  const body='<section class="article"><h1>تماس با ما</h1><p>پیام شما برای مدیر سایت ثبت می‌شود. پاسخ خودکار ایمیلی ارسال نمی‌شود.</p><form id="contact-form"><label>نام<input name="name" required maxlength="100" autocomplete="name"></label><label>ایمیل<input name="email" type="email" dir="ltr" required maxlength="254" autocomplete="email"></label><label>موضوع<input name="subject" required maxlength="200"></label><label>پیام<textarea name="message" required maxlength="5000" rows="7"></textarea></label><div class="contact-trap" aria-hidden="true"><label>وب‌سایت<input name="website" tabindex="-1" autocomplete="off"></label></div><button type="submit" disabled>ارسال پیام</button><p id="contact-feedback" role="status" aria-live="polite">در حال آماده‌سازی فرم…</p><button type="button" id="contact-retry" hidden>آماده‌سازی دوباره فرم</button><noscript>برای ارسال فرم، جاوااسکریپت را فعال کنید.</noscript></form></section>';
  return layout({site,title:`تماس با ما | ${site.name}`,description:'فرم ارسال پیام به مدیر سایت',path:'/contact/',body,scripts:['/assets/contact.js'],...options});
}
export function renderRedirect(destination,basePath='') {
  const path=escapeHTML(basePath+destination);
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${path}"><title>انتقال به آدرس جدید</title></head><body><a href="${path}">رفتن به آدرس جدید</a></body></html>`;
}
export function renderNotFound(site,options) {
  return layout({site,title:'صفحه پیدا نشد',description:'این صفحه در دسترس نیست.',path:'/404/',body:`<section class="hero"><h1>صفحه پیدا نشد</h1><a href="${escapeHTML(options.basePath||'')}/">بازگشت به صفحه اصلی</a></section>`,...options});
}
export function sitemap(items,baseURL,extraPaths=[]) {
  const paths=[...new Set(['/',...items.map(contentPath),...extraPaths])];
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(path=>`<url><loc>${escapeHTML(baseURL+path)}</loc></url>`).join('')}</urlset>`;
}
