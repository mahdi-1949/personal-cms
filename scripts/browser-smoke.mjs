import assert from 'node:assert/strict';
import { mkdtemp,rm,mkdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createApp } from '../src/server.mjs';
import { createUser } from '../src/auth.mjs';
import { listContent } from '../src/content.mjs';
import { getSite,saveSite } from '../src/database.mjs';
import { totp } from '../src/security-crypto.mjs';

const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://127.0.0.1:${port}`,dir=await mkdtemp(join(tmpdir(),'cms-browser-')),password='Browser-fixture-password-123!',newPassword='Changed-browser-password-456!',sent=[];
const app=await createApp({dbPath:join(dir,'cms.sqlite'),origin,securityKey:randomBytes(32),mailer:{send:async message=>sent.push(message)}});
let browser;
try {
  await createUser(app.db,{email:'admin@example.test',password});await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,...(process.env.CMS_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.CMS_TEST_BROWSER_EXECUTABLE}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  function watch(target){target.on('pageerror',error=>errors.push(error.message));target.on('console',message=>{if(/violates.*Content Security Policy|Refused to.*Content Security Policy/i.test(message.text()))errors.push(message.text());});}
  watch(page);
  const screenshot=async(target,name)=>{if(process.env.CMS_TEST_SCREENSHOTS){await mkdir(process.env.CMS_TEST_SCREENSHOTS,{recursive:true});await target.screenshot({path:join(process.env.CMS_TEST_SCREENSHOTS,`${name}.png`),fullPage:true});}};
  async function submit(form,path,method='POST') {
    const response=page.waitForResponse(res=>new URL(res.url()).pathname===path && res.request().method()===method);
    await form.locator('button[type=submit]').click();const res=await response;if(!res.ok())throw new Error(`Browser request failed: ${res.status()} ${await res.text().catch(()=>'response unavailable')}`);
  }
  async function login(pwd=password,code='') {
    const form=page.locator('#login-form');await form.locator('[name=email]').fill('admin@example.test');await form.locator('[name=password]').fill(pwd);await form.locator('[name=mfaCode]').fill(code);
    await submit(form,'/api/auth/login');await page.locator('#workspace').waitFor({state:'visible'});await page.locator('[data-view=templates]').waitFor({state:'visible'});
  }
  await page.goto(origin+'/admin/');await login();
  await page.locator('[data-view=templates]').click();await page.locator('#theme-form [value=services]').check();await page.locator('#theme-form [name=primaryColor]').fill('#267651');await page.locator('#theme-form [name=corners]').selectOption('square');await submit(page.locator('#theme-form'),'/api/settings','PUT');
  await page.getByText('ظاهر سایت ذخیره شد.',{exact:true}).waitFor({state:'visible'});await screenshot(page,'theme-panel-desktop');
  await page.locator('[data-view=media]').click();const imageFile=join(dir,'browser.png');await writeFile(imageFile,await sharp({create:{width:600,height:400,channels:3,background:'#d3b18a'}}).png().toBuffer());
  await page.locator('#upload-form [type=file]').setInputFiles(imageFile);await submit(page.locator('#upload-form'),'/api/media');await page.locator('.media-card').waitFor({state:'visible'});
  await page.locator('[data-view=services]').click();await page.locator('#new-content').click();const form=page.locator('#editor-form');
  await form.locator('[name=title]').fill('خدمات طراحی وب');await form.locator('[name=slug]').fill('web-design');await form.locator('[name=excerpt]').fill('طراحی سایت برای معرفی دقیق خدمات کسب‌وکار شما.');await form.locator('[name=body]').fill('متن قدیمی حفظ می‌شود.');
  await form.locator('[data-add-block=hero]').click();const hero=form.locator('[data-block][data-type=hero]');await hero.locator('[data-field=title]').fill('شروع یک همکاری تازه');await hero.locator('[data-field=text]').fill('از شناخت برند تا طراحی و توسعه سایت، مراحل کار روشن و قابل پیگیری است.');await hero.locator('[data-field=mediaId]').selectOption({index:1});await hero.locator('[data-field=alt]').fill('نمونه تصویر معرفی خدمات');
  await form.locator('[data-add-block=cards]').click();let cards=form.locator('[data-block][data-type=cards]');await cards.locator(':scope > label [data-field=title]').fill('مسیر کار');await cards.locator('[data-entry-add]').click();await cards.locator('[data-entry="0"] [data-field=title]').fill('شناخت نیازها');await cards.locator('[data-entry="0"] [data-field=text]').fill('هدف سایت و نیاز مخاطب را مشخص می‌کنیم.');await cards.locator('[data-entry="1"] [data-field=title]').fill('طراحی و توسعه');await cards.locator('[data-entry="1"] [data-field=text]').fill('طرح تأییدشده را با پنل مدیریت پیاده می‌کنیم.');await cards.locator('[data-field=variant]').selectOption('list');await cards.locator('[data-entry-move="1"][data-step="-1"]').click();
  await form.locator('[data-add-block=faq]').click();const faq=form.locator('[data-block][data-type=faq]');await faq.locator(':scope > label [data-field=title]').fill('پرسش‌های متداول');await faq.locator('[data-entry="0"] [data-field=question]').fill('محتوا را می‌توانم تغییر بدهم؟');await faq.locator('[data-entry="0"] [data-field=answer]').fill('بله، صفحات و تصاویر از پنل مدیریت قابل ویرایش‌اند.');
  await submit(form,'/api/content');await page.locator('#editor-dialog').waitFor({state:'hidden'});
  let item=listContent(app.db).find(item=>item.slug==='web-design');assert.equal(item.template,'landing');assert.equal(item.blocks[1].items[0].title,'طراحی و توسعه');assert.equal(item.body,'متن قدیمی حفظ می‌شود.');
  const preview=await context.newPage();watch(preview);await preview.goto(origin+`/api/content/${item.id}/preview`);assert.match(await preview.title(),/خدمات طراحی وب/);assert.equal(await preview.locator('.preview-banner').count(),1);assert.equal(await preview.locator('.section-faq details').count(),1);assert.equal((await fetch(origin+'/services/web-design/')).status,404);await screenshot(preview,'private-preview-desktop');await preview.close();
  await page.locator(`[data-edit="${item.id}"]`).click();await form.locator('[name=template]').selectOption('standard');await form.locator('[name=status]').selectOption('published');await submit(form,`/api/content/${item.id}`,'PUT');await page.locator('#editor-dialog').waitFor({state:'hidden'});
  item=listContent(app.db).find(current=>current.id===item.id);assert.equal(item.template,'standard');assert.equal(item.blocks.length,3);
  const publicPage=await context.newPage();watch(publicPage);await publicPage.goto(origin+'/services/web-design/');assert.equal(await publicPage.locator('body.site-template-services').count(),1);await publicPage.locator('.section-faq summary').click();assert.equal(await publicPage.locator('.section-faq details').getAttribute('open'),'');
  for(const width of [1440,390]){await publicPage.setViewportSize({width,height:1000});assert.ok(await publicPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Public page has horizontal overflow');assert.ok(await publicPage.locator('img').evaluate(image=>image.complete&&image.naturalWidth>0));await screenshot(publicPage,`service-${width}`);}
  await page.locator('[data-view=templates]').click();await page.locator('#theme-form [value=corporate]').check();await submit(page.locator('#theme-form'),'/api/settings','PUT');await publicPage.reload();assert.equal(await publicPage.locator('body.site-template-corporate').count(),1);await screenshot(publicPage,'corporate-mobile');
  await page.setViewportSize({width:390,height:844});await page.locator('[data-view=services]').click();await page.locator(`[data-edit="${item.id}"]`).click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Editor has horizontal overflow');await screenshot(page,'editor-mobile');await page.locator('#cancel-editor').click();
  await page.setViewportSize({width:1440,height:1000});await page.locator('[data-view=security]').click();await page.locator('#mfa-start [name=password]').fill(password);await submit(page.locator('#mfa-start'),'/api/auth/mfa/setup');await page.locator('#mfa-enrollment').waitFor({state:'visible'});const secret=await page.locator('#mfa-secret').inputValue();await page.locator('#mfa-confirm [name=code]').fill(totp(secret));await submit(page.locator('#mfa-confirm'),'/api/auth/mfa/confirm');await page.locator('#recovery-dialog').waitFor({state:'visible'});const codes=(await page.locator('#recovery-codes').inputValue()).split('\n');assert.equal(codes.length,10);await page.locator('#save-codes').click();await login(password,codes[0]);
  await page.locator('[data-view=security]').click();await page.getByText('ورود دومرحله‌ای فعال است',{exact:true}).waitFor({state:'visible'});await page.locator('#logout').click();await page.locator('#login-form').waitFor({state:'visible'});await page.locator('#forgot-password').click();await page.locator('#forgot-form [name=email]').fill('admin@example.test');await submit(page.locator('#forgot-form'),'/api/auth/forgot-password');
  while(app.db.prepare("SELECT id FROM mail_outbox WHERE status='waiting' AND next_attempt_at<=?").get(Date.now()))await app.flushMail();const token=sent.findLast(message=>message.subject==='بازیابی رمز Core CMS').text.match(/#token=([a-f0-9]{64})/)[1];
  await page.goto(origin+`/admin/reset-password/#token=${token}`);await page.locator('#reset-form').waitFor({state:'visible'});assert.equal(page.url(),origin+'/admin/reset-password/');assert.equal(await page.locator('#login-form').isVisible(),false);
  const reset=page.locator('#reset-form');await reset.locator('[name=newPassword]').fill(newPassword);await reset.locator('[name=repeatPassword]').fill(newPassword);await reset.locator('[name=mfaCode]').fill(codes[1]);await submit(reset,'/api/auth/reset-password');await page.waitForURL(origin+'/admin/');await login(newPassword,codes[2]);
  const site=getSite(app.db);saveSite(app.db,{...site,name:'A'.repeat(100)});app.db.prepare('UPDATE content SET title=? WHERE id=?').run('B'.repeat(200),item.id);await publicPage.reload();assert.ok(await publicPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Long brand/title must wrap on mobile');saveSite(app.db,site);
  assert.deepEqual(errors,[]);console.log(`Browser smoke passed (${await browser.version()}): theme, image upload, sections/reordering, draft preview, publication, desktop/mobile, MFA and password recovery. SMTP used a mock sender.`);
}finally{await browser?.close();await app.close();await rm(dir,{recursive:true,force:true});}
