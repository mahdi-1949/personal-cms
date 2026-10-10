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
export const defaultTheme={template:'corporate',primaryColor:'#245c73',corners:'rounded',font:'system',density:'normal',typeScale:'normal',header:'inline'};
export function validateTheme(value=defaultTheme) {
  if(!value || typeof value!=='object' || Array.isArray(value) || !siteTemplates.some(item=>item.key===value.template) || typeof value.primaryColor!=='string' || !/^#[a-fA-F0-9]{6}$/.test(value.primaryColor) || !['rounded','square'].includes(value.corners))throw new HttpError(422,'تنظیمات قالب معتبر نیست.');
  const options={font:['system','tahoma','serif'],density:['compact','normal','airy'],typeScale:['normal','large'],header:['inline','centered']};
  const extra={};for(const [key,allowed] of Object.entries(options)){const option=value[key]??defaultTheme[key];if(!allowed.includes(option))throw new HttpError(422,'تنظیمات سیستم طراحی معتبر نیست.');extra[key]=option;}
  return {template:value.template,primaryColor:value.primaryColor.toLowerCase(),corners:value.corners,...extra};
}
export function themeCSS(value) {
  const theme=validateTheme(value||defaultTheme),channels=theme.primaryColor.slice(1).match(/../g).map(hex=>parseInt(hex,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);
  const luminance=channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
  // Pick the higher-contrast text color for colored buttons.
  const ink=luminance>.179?'#000000':'#ffffff';
  return `:root{--brand:${theme.primaryColor};--on-brand:${ink};--radius:${theme.corners==='rounded'?'18px':'4px'};--site-font:${{system:'system-ui, sans-serif',tahoma:'Tahoma, Arial, sans-serif',serif:'Georgia, serif'}[theme.font]};--section-space:${{compact:'28px',normal:'45px',airy:'72px'}[theme.density]};--site-size:${theme.typeScale==='large'?'17px':'15px'};}\n`;
}

const hero=(title,text)=>({type:'hero',variant:'split',title,text,mediaId:'',alt:'',contentId:'',label:''});
const cards=(title,variant,titles)=>({type:'cards',title,variant,items:titles.map(title=>({title,text:'توضیح واقعی کسب‌وکار را اینجا بنویسید.',mediaId:'',alt:'',contentId:''}))});
const paragraph=text=>({type:'paragraph',text});
export const templateLibrary={
  sectionPresets:[
    {key:'intro',label:'معرفی کسب‌وکار',blocks:[hero('معرفی کسب‌وکار شما','مزیت و پیشنهاد اصلی کسب‌وکار را بنویسید.')]},
    {key:'services',label:'خدمات',blocks:[cards('خدمات ما','grid',['خدمت اول','خدمت دوم','خدمت سوم'])]},
    {key:'process',label:'مراحل همکاری',blocks:[cards('مراحل همکاری','process',['شناخت نیاز','طراحی و اجرا','تحویل و پشتیبانی'])]},
    {key:'portfolio',label:'نمونه‌کارها',blocks:[cards('نمونه‌کارها','grid',['پروژه اول','پروژه دوم'])]},
    {key:'testimonials',label:'نظر مشتریان',blocks:[cards('نظر مشتریان','testimonials',['نام مشتری'])]},
    {key:'stats',label:'آمار و دستاوردها',blocks:[cards('دستاوردهای ما','stats',['عدد و عنوان دستاورد'])]},
    {key:'faq',label:'پرسش‌های متداول',blocks:[{type:'faq',title:'پرسش‌های متداول',items:[{question:'پرسش مشتری را وارد کنید.',answer:'پاسخ دقیق و واقعی را بنویسید.'}]}]},
  ],
  pagePresets:[
    {key:'home',label:'صفحه اصلی',kinds:['pages'],template:'landing',blocks:[hero('معرفی برند شما','پیشنهاد اصلی شما به مشتری چیست؟'),cards('خدمات ما','grid',['خدمت اول','خدمت دوم','خدمت سوم']),cards('مراحل همکاری','process',['شناخت نیاز','اجرای پروژه','تحویل'])]},
    {key:'about',label:'درباره ما',kinds:['pages'],template:'standard',blocks:[hero('درباره کسب‌وکار','داستان، هدف و مزیت کسب‌وکار را بنویسید.'),cards('ارزش‌های ما','grid',['کیفیت','شفافیت']),paragraph('اعضای تیم و تجربه واقعی آن‌ها را معرفی کنید.')]},
    {key:'services',label:'فهرست خدمات',kinds:['pages'],template:'landing',blocks:[hero('خدمات ما','نیازهایی که خدمات شما برطرف می‌کنند.'),cards('خدمات','list',['خدمت اول','خدمت دوم'])]},
    {key:'service',label:'جزئیات خدمت',kinds:['services'],template:'landing',blocks:[hero('معرفی خدمت','نتیجه و دامنه خدمت را بنویسید.'),cards('روند اجرا','process',['مشاوره','اجرا','پشتیبانی'])]},
    {key:'project',label:'معرفی پروژه',kinds:['portfolio'],template:'case-study',blocks:[{type:'heading',level:2,text:'مسئله مشتری'},paragraph('مسئله واقعی این پروژه را توضیح دهید.'),{type:'heading',level:2,text:'راهکار و نتیجه'},paragraph('راهکار، تصاویر و نتیجه قابل اثبات پروژه را اضافه کنید.')]},
    {key:'article',label:'مقاله',kinds:['posts'],template:'article',blocks:[{type:'heading',level:2,text:'مقدمه'},paragraph('متن مقدمه مقاله را بنویسید.'),{type:'heading',level:2,text:'موضوع اصلی'},paragraph('متن و منابع مقاله را بنویسید.')]},
    {key:'contact',label:'اطلاعات تماس',kinds:['pages'],template:'standard',blocks:[hero('ارتباط با ما','راه‌های تماس واقعی کسب‌وکار را بنویسید.'),cards('اطلاعات تماس','list',['آدرس','شماره تماس','ساعت کاری'])]},
  ],
};
