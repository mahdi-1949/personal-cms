import { HttpError } from './content.mjs';

export const siteTemplates=[
  {key:'corporate',label:'شرکتی',description:'سربرگ روشن، معرفی گسترده و شبکه منظم خدمات و مقالات.'},
  {key:'services',label:'خدماتی',description:'سربرگ تیره، معرفی برجسته و فهرست واضح خدمات.'},
];
export const pageTemplates=[
  {key:'standard',label:'صفحه معمولی',kinds:['pages','services','posts','portfolio']},
  {key:'landing',label:'صفحه معرفی',kinds:['pages','services']},
  {key:'article',label:'مقاله',kinds:['posts']},
  {key:'case-study',label:'معرفی نمونه‌کار',kinds:['portfolio']},
];
export const defaultPageTemplate=kind=>({posts:'article',portfolio:'case-study',services:'landing'}[kind]||'standard');
export function validatePageTemplate(kind,value=defaultPageTemplate(kind)) {
  if(!pageTemplates.some(item=>item.key===value && item.kinds.includes(kind)))throw new HttpError(422,'طرح انتخاب‌شده برای این نوع محتوا معتبر نیست.');
  return value;
}
export const defaultTheme={template:'corporate',primaryColor:'#245c73',corners:'rounded'};
export function validateTheme(value=defaultTheme) {
  if(!value || typeof value!=='object' || Array.isArray(value) || !siteTemplates.some(item=>item.key===value.template) || typeof value.primaryColor!=='string' || !/^#[a-fA-F0-9]{6}$/.test(value.primaryColor) || !['rounded','square'].includes(value.corners))throw new HttpError(422,'تنظیمات قالب معتبر نیست.');
  return {template:value.template,primaryColor:value.primaryColor.toLowerCase(),corners:value.corners};
}
export function themeCSS(value) {
  const theme=validateTheme(value||defaultTheme),channels=theme.primaryColor.slice(1).match(/../g).map(hex=>parseInt(hex,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);
  const luminance=channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
  // Pick the higher-contrast text color for colored buttons.
  const ink=luminance>.179?'#000000':'#ffffff';
  return `:root{--brand:${theme.primaryColor};--on-brand:${ink};--radius:${theme.corners==='rounded'?'18px':'4px'};}\n`;
}
