import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,scrypt as rawScrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { createUser,createSession,digest,verifyPassword } from '../src/auth.mjs';
import { base32,totp,encrypt,decrypt } from '../src/security-crypto.mjs';
import { consumeFactor } from '../src/account-security.mjs';
import { proxyList,clientIP } from '../src/proxy.mjs';
import { createBackup,restoreBackup } from '../src/backup.mjs';

const origin='http://cms.test',password='Security-test-only-123!',nextPassword='Changed-security-password-123!';
async function fixture(t,{requireAdminMfa=false,mailerEnabled=true}={}) {
  const dir=await mkdtemp(join(tmpdir(),'cms-security-')),dbPath=join(dir,'original/cms.sqlite'),key=randomBytes(32),sent=[];
  const app=await createApp({dbPath,origin,securityKey:key,requireAdminMfa,mailer:mailerEnabled?{send:async message=>sent.push(message)}:null});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const user=await createUser(app.db,{email:'admin@example.test',password});await createUser(app.db,{email:'editor@example.test',password,role:'editor'});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  async function req(path,{method='GET',body,session,csrf=true}={}){
    const headers={};if(method!=='GET')headers.Origin=origin;if(session){headers.Cookie=session.cookie;if(csrf)headers['X-CSRF-Token']=session.csrf;}if(body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(base+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:response.status,data,headers:response.headers};
  }
  async function login({email='admin@example.test',password:pwd=password,mfaCode}={}){const result=await req('/api/auth/login',{method:'POST',body:{email,password:pwd,mfaCode}});return {...result,session:result.status===200?{cookie:result.headers.get('set-cookie').split(';')[0],csrf:result.data.csrf}:null};}
  const admin=(await login()).session,editor=(await login({email:'editor@example.test'})).session;
  async function enroll(){
    const setup=await req('/api/auth/mfa/setup',{method:'POST',session:admin,body:{password}});assert.equal(setup.status,200,JSON.stringify(setup.data));
    const result=await req('/api/auth/mfa/confirm',{method:'POST',session:admin,body:{code:totp(setup.data.secret)}});assert.equal(result.status,200,JSON.stringify(result.data));return {secret:setup.data.secret,codes:result.data.recoveryCodes};
  }
  async function resetToken(email='admin@example.test'){
    const requested=await req('/api/auth/forgot-password',{method:'POST',body:{email}});assert.equal(requested.status,200);
    const hashes=app.db.prepare('SELECT token_hash FROM password_resets').all();
    while(app.db.prepare("SELECT id FROM mail_outbox WHERE status='waiting' AND next_attempt_at<=?").get(Date.now()))await app.flushMail();
    const mail=sent.filter(message=>message.subject==='بازیابی رمز Core CMS').at(-1);const token=mail?.text.match(/#token=([a-f0-9]{64})/)?.[1];return {requested,token,hashes};
  }
  return {dir,dbPath,app,key,user,sent,req,login,admin,editor,enroll,resetToken};
}

test('TOTP matches RFC 6238 SHA-1 vectors and encrypted secrets are bound to their context',()=>{
  const secret=base32(Buffer.from('12345678901234567890'));
  for(const [seconds,expected] of [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']])assert.equal(totp(secret,seconds*1000,8),expected);
  const key=randomBytes(32),cipher=encrypt(secret,key,'user-a');assert.equal(decrypt(cipher,key,'user-a'),secret);assert.doesNotMatch(cipher,new RegExp(secret));assert.throws(()=>decrypt(cipher,key,'user-b'));assert.throws(()=>decrypt(cipher,randomBytes(32),'user-a'));
});

test('MFA enrollment requires password/CSRF, encrypts its secret, revokes sessions and uses recovery codes once',async t=>{
  const f=await fixture(t);
  assert.equal((await f.req('/api/auth/mfa/setup',{method:'POST',session:f.admin,csrf:false,body:{password}})).status,403);
  assert.equal((await f.req('/api/auth/mfa/setup',{method:'POST',session:f.admin,body:{password:'wrong'}})).status,422);
  const {secret,codes}=await f.enroll();assert.equal(codes.length,10);assert.equal(new Set(codes).size,10);
  assert.equal((await f.req('/api/auth/me',{session:f.admin})).status,401);
  assert.equal((await f.login()).status,401);assert.equal((await f.login({mfaCode:totp(secret)})).status,401);
  const logged=await f.login({mfaCode:codes[0]});assert.equal(logged.status,200);
  assert.equal((await f.login({mfaCode:codes[0]})).status,401);
  const status=(await f.req('/api/auth/mfa',{session:logged.session})).data;assert.equal(status.enabled,true);assert.equal(status.recoveryRemaining,9);
  const row=f.app.db.prepare('SELECT * FROM users WHERE id=?').get(f.user.id);assert.notEqual(row.mfa_secret,secret);assert.equal(decrypt(row.mfa_secret,f.key,`mfa:${f.user.id}`),secret);
  assert.doesNotMatch(JSON.stringify((await f.req('/api/users',{session:logged.session})).data),/mfa_secret|code_hash|mfa_pending/);
});

test('MFA TOTP replay is rejected across sessions and factor replacement requires existing authentication',async t=>{
  const f=await fixture(t),{secret,codes}=await f.enroll();f.app.db.prepare('UPDATE users SET mfa_last_step=-1 WHERE id=?').run(f.user.id);
  const code=totp(secret),login=await f.login({mfaCode:code});assert.equal(login.status,200);assert.equal((await f.login({mfaCode:code})).status,401);
  const changed=await f.req('/api/auth/mfa/recovery-codes',{method:'POST',session:login.session,body:{password,code:codes[0]}});assert.equal(changed.status,200);assert.equal(changed.data.recoveryCodes.length,10);
  assert.equal((await f.req('/api/auth/me',{session:login.session})).status,401);assert.equal((await f.login({mfaCode:codes[1]})).status,401);
  const next=await f.login({mfaCode:changed.data.recoveryCodes[0]});assert.equal(next.status,200);
  const disabled=await f.req('/api/auth/mfa/disable',{method:'POST',session:next.session,body:{password,code:changed.data.recoveryCodes[1]}});assert.equal(disabled.status,200);assert.equal((await f.login()).status,200);
});

test('enforced admin MFA permits enrollment but blocks management until the factor is enabled',async t=>{
  const f=await fixture(t,{requireAdminMfa:true});const me=await f.req('/api/auth/me',{session:f.admin});assert.equal(me.data.user.mfaRequired,true);
  assert.equal((await f.req('/api/content',{session:f.admin})).status,403);assert.equal((await f.req('/api/settings',{session:f.admin})).status,403);assert.equal((await f.req('/api/content',{session:f.editor})).status,200);
  const {codes}=await f.enroll();const logged=await f.login({mfaCode:codes[0]});assert.equal((await f.req('/api/content',{session:logged.session})).status,200);
});

test('password recovery responds uniformly, encrypts queued mail, hashes tokens and resets only once',async t=>{
  const f=await fixture(t);
  const known=await f.req('/api/auth/forgot-password',{method:'POST',body:{email:'admin@example.test'}}),missing=await f.req('/api/auth/forgot-password',{method:'POST',body:{email:'missing@example.test'}});assert.deepEqual(known.data,missing.data);
  const row=f.app.db.prepare('SELECT * FROM mail_outbox').get();assert.ok(row.payload);assert.doesNotMatch(row.payload,/admin@example|token=|http:/);
  await f.app.flushMail();const token=f.sent[0].text.match(/#token=([a-f0-9]{64})/)[1];assert.equal(f.app.db.prepare('SELECT token_hash FROM password_resets').get().token_hash,digest(token));
  const reset=await f.req('/api/auth/reset-password',{method:'POST',body:{token,newPassword:nextPassword}});assert.equal(reset.status,200);assert.equal((await f.req('/api/auth/me',{session:f.admin})).status,401);
  assert.equal((await f.req('/api/auth/reset-password',{method:'POST',body:{token,newPassword:password}})).status,422);assert.equal((await f.login({password:nextPassword})).status,200);
  await f.app.flushMail();assert.ok(f.sent.some(message=>message.subject==='اطلاع امنیتی Core CMS'));
});

test('reset links cannot bypass MFA and account changes or expiry invalidate them',async t=>{
  const f=await fixture(t),{codes}=await f.enroll();let {token}=await f.resetToken();
  assert.equal((await f.req('/api/auth/reset-password',{method:'POST',body:{token,newPassword:nextPassword}})).status,422);
  assert.equal((await f.req('/api/auth/reset-password',{method:'POST',body:{token,newPassword:nextPassword,mfaCode:codes[0]}})).status,200);
  const logged=await f.login({password:nextPassword,mfaCode:codes[1]});assert.equal(logged.status,200);
  ({token}=await f.resetToken());f.app.db.prepare('UPDATE password_resets SET expires_at=?').run(Date.now()-1);
  assert.equal((await f.req('/api/auth/reset-password',{method:'POST',body:{token,newPassword:password,mfaCode:codes[2]}})).status,422);
  ({token}=await f.resetToken());const users=(await f.req('/api/users',{session:logged.session})).data.users,user=users.find(user=>user.id===f.user.id);
  assert.equal((await f.req(`/api/users/${user.id}`,{method:'PUT',session:logged.session,body:{...user,expected_updated_at:user.updated_at}})).status,200);
  assert.equal((await f.req('/api/auth/reset-password',{method:'POST',body:{token,newPassword:password,mfaCode:codes[2]}})).status,422);
});

test('password changes on MFA accounts require a factor and roll back failed recovery-code consumption',async t=>{
  const f=await fixture(t),{codes}=await f.enroll(),logged=await f.login({mfaCode:codes[0]});
  assert.equal((await f.req('/api/auth/password',{method:'PUT',session:logged.session,body:{currentPassword:password,newPassword:nextPassword}})).status,422);
  const changed=await f.req('/api/auth/password',{method:'PUT',session:logged.session,body:{currentPassword:password,newPassword:nextPassword,mfaCode:codes[1]}});assert.equal(changed.status,200);
  assert.equal((await f.login({password:nextPassword,mfaCode:codes[1]})).status,401);assert.equal((await f.login({password:nextPassword,mfaCode:codes[2]})).status,200);
});

test('audit is admin-only and excludes passwords, recovery secrets, tokens and mail bodies',async t=>{
  const f=await fixture(t),{token}=await f.resetToken();
  const created=await f.req('/api/content',{method:'POST',session:f.admin,body:{kind:'pages',title:'Page',slug:'audit-page',excerpt:'',body:'private body',status:'draft',seo_title:'',seo_description:''}});assert.equal(created.status,201);
  assert.equal((await f.req('/api/audit',{session:f.editor})).status,403);const audit=(await f.req('/api/audit',{session:f.admin})).data;
  assert.ok(audit.events.some(event=>event.event==='content.created'));assert.ok(audit.events.some(event=>event.event==='auth.password_reset_requested'));
  for(const secret of [password,token,'private body'])assert.ok(!JSON.stringify(audit).includes(secret));assert.equal((await f.req('/api/audit?page=0',{session:f.admin})).status,422);
});

test('legacy password hashes authenticate and upgrade without losing the account',async t=>{
  const f=await fixture(t),salt=randomBytes(16).toString('hex'),derived=await promisify(rawScrypt)(password,salt,64,{N:16384,r:8,p:1});const legacy=`scrypt$${salt}$${derived.toString('hex')}`;
  assert.equal(await verifyPassword(password,legacy),true);f.app.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(legacy,f.user.id);
  assert.equal((await f.login()).status,200);assert.match(f.app.db.prepare('SELECT password_hash FROM users WHERE id=?').get(f.user.id).password_hash,/^scrypt\$32768\$8\$3\$/);
});

test('trusted proxy handling ignores spoofed headers and selects the first untrusted hop from the right',()=>{
  const req=(peer,chain)=>({socket:{remoteAddress:peer},headers:{'x-forwarded-for':chain}});
  assert.equal(clientIP(req('203.0.113.5','1.2.3.4'),proxyList([])),'203.0.113.5');
  assert.equal(clientIP(req('::ffff:127.0.0.1','1.2.3.4, 203.0.113.5'),proxyList(['127.0.0.1'])),'203.0.113.5');
  assert.equal(clientIP(req('127.0.0.1','1.2.3.4, 203.0.113.5, 10.0.0.1'),proxyList(['127.0.0.1','10.0.0.1'])),'203.0.113.5');
  assert.throws(()=>clientIP(req('127.0.0.1','bad'),proxyList(['127.0.0.1'])));assert.throws(()=>proxyList(['0.0.0.0/0']));
});

test('backup preserves active MFA and recovery hashes but strips resets/mail/pending enrollment; original key is required',async t=>{
  const f=await fixture(t),{secret,codes}=await f.enroll();await f.resetToken();await f.app.close();const outputDir=join(f.dir,'backup');await createBackup({dbPath:f.dbPath,outputDir});
  const result=await restoreBackup({inputDir:outputDir,dbPath:join(f.dir,'restored/cms.sqlite')});
  await assert.rejects(createApp({dbPath:result.database,origin}),/SECURITY_KEY/);
  const restored=await createApp({dbPath:result.database,origin,securityKey:f.key});t.after(()=>restored.close());
  assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM password_resets').get().n,0);assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM mail_outbox').get().n,0);
  const user=restored.db.prepare('SELECT * FROM users WHERE id=?').get(f.user.id);assert.equal(decrypt(user.mfa_secret,f.key,`mfa:${f.user.id}`),secret);assert.equal(consumeFactor(restored.db,user,codes[0],f.key),true);await restored.close();
});

test('recovery is disabled without a mail service and token use is throttled',async t=>{
  const f=await fixture(t,{mailerEnabled:false});assert.equal((await f.req('/api/auth/options')).data.passwordRecovery,false);
  assert.equal((await f.req('/api/auth/forgot-password',{method:'POST',body:{email:'admin@example.test'}})).status,503);
  for(let i=0;i<5;i++)assert.equal((await f.req('/api/auth/reset-password',{method:'POST',body:{token:'a'.repeat(64),newPassword:nextPassword}})).status,422);
  assert.equal((await f.req('/api/auth/reset-password',{method:'POST',body:{token:'a'.repeat(64),newPassword:nextPassword}})).status,429);
});


test('password change accepts a current TOTP through the HTTP route',async t=>{
  const f=await fixture(t),{codes,secret}=await f.enroll(),logged=await f.login({mfaCode:codes[0]});
  f.app.db.prepare('UPDATE users SET mfa_last_step=-1 WHERE email=?').run('admin@example.test');
  const code=totp(secret);
  const changed=await f.req('/api/auth/password',{method:'PUT',session:logged.session,body:{currentPassword:password,newPassword:nextPassword,mfaCode:code}});
  assert.equal(changed.status,200);assert.equal((await f.login({password:nextPassword,mfaCode:code})).status,401);
  assert.equal((await f.login({password:nextPassword,mfaCode:codes[1]})).status,200);
});
