import {beforeAll,afterEach,it,expect,vi} from 'vitest';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {config} from '../src/config.js';
import {freshDb,newTenant,payFor} from './helpers.js';
import type {Db} from '../src/db/client.js';
import {scanWithClamav} from '../src/adapters/clamav.js';
import {cloudflareAdapters} from '../src/adapters/cloudflare.js';
import {hmac,totp} from '../src/lib/util.js';
import {createOrder,processPaymentEvent,buildMockEvent,applyDueSubscriptionChanges,scheduleDowngrade} from '../src/platform/billing.js';
import {beginMfaEnrollment,verifyCompanyMfa} from '../src/platform/mfa.js';
import {newSession,loadSession} from '../src/platform/auth.js';
import {drainOutbox} from '../src/platform/outbox.js';
import {buildApp} from '../src/app.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {encryptBackup,decryptBackup} from '../src/platform/backup.js';

it('valid production configuration uses provider webhook keys without a development mock secret',()=>{
 const fixture='test-only-not-a-live-credential-000000000000';
 const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"await import('./src/config.ts')"],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,NODE_ENV:'production',SESSION_SECRET:fixture,MFA_ENCRYPTION_KEY:fixture,PAYMENT_WEBHOOK_SECRET:'',PAYMENT_PROVIDER:'stripe',PAYMENT_PROVIDERS:'stripe',STRIPE_SECRET_KEY:'sk_live_'+fixture,STRIPE_WEBHOOK_SECRET:'whsec_'+fixture,DATABASE_URL:'postgres://fixture:fixture@db.example.com/db?sslmode=require',CHECKOUT_VAT_BPS:'0',CHECKOUT_TAX_NOTE:'Test fixture tax decision',SELLER_LEGAL_NAME:'Fixture freelancer',SELLER_ADDRESS:'India test fixture',SELLER_SUPPORT_EMAIL:'support@example.com',PUBLIC_BASE_URL:'https://app.example.com',ROOT_DOMAIN:'example.com',STORAGE_DRIVER:'s3',S3_ENDPOINT:'https://storage.example.com',S3_BUCKET:'fixture',S3_ACCESS_KEY_ID:'fixture',S3_SECRET_ACCESS_KEY:fixture,CLAMAV_HOST:'scanner',UPSTASH_REDIS_REST_URL:'https://redis.example.com',UPSTASH_REDIS_REST_TOKEN:fixture,MAIL_PROVIDER:'resend',RESEND_API_KEY:'re_fixture',MAIL_FROM:'support@example.com',CLOUDFLARE_API_TOKEN:fixture,CLOUDFLARE_ZONE_ID:'fixture',CLOUDFLARE_ORIGIN_HOSTNAME:'fixture.cfargotunnel.com',REQUIRE_COMPANY_MFA:'true',LEGAL_REVIEWED:'true',DATA_RETENTION_DAYS:'90',DEPLOYMENT_REGION:'Test fixture region'}});
 expect(result.status,result.stderr).toBe(0);
});

let db:Db;
const providers=[...config.paymentProviders],root=config.rootDomain,fx={...config.razorpayPresentment};
beforeAll(async()=>{db=await freshDb();});
afterEach(()=>{config.paymentProviders=providers;config.rootDomain=root;config.razorpayPresentment={...fx};vi.restoreAllMocks();});
const order={id:'11111111-1111-4111-8111-111111111111',reference:'LBT-TEST',total_minor:36540,currency:'AED'};
const meta={lbt_order_id:order.id,lbt_reference:order.reference};
const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

it('immutable orders reject repricing; a signed event from a different provider cannot grant entitlements',async()=>{
 const t=await newTenant(db),r=await createOrder(db,t.tenantId,t.userId,'starter');
 const o=(await db.query<any>(`SELECT * FROM orders WHERE id=$1`,[r.orderId])).rows[0];
 await expect(db.query(`UPDATE orders SET total_minor=1 WHERE id=$1`,[o.id])).rejects.toThrow(/immutable/);
 expect((await processPaymentEvent(db,'stripe',buildMockEvent(o))).outcome).toBe('rejected');
 expect((await db.query<any>(`SELECT status FROM orders WHERE id=$1`,[o.id])).rows[0].status).toBe('pending');
});
it('refund arriving before success prevents later activation and leaves a staff review',async()=>{
 const t=await newTenant(db),r=await createOrder(db,t.tenantId,t.userId,'starter'),o=(await db.query<any>(`SELECT * FROM orders WHERE id=$1`,[r.orderId])).rows[0];
 expect((await processPaymentEvent(db,'mock',buildMockEvent(o,'payment.refunded'))).outcome).toBe('applied');
 expect((await processPaymentEvent(db,'mock',buildMockEvent(o))).outcome).toBe('rejected');
 expect((await db.query(`SELECT 1 FROM provision_jobs WHERE tenant_id=$1`,[t.tenantId])).rows).toHaveLength(0);
});
it('paid downgrade does not grant another unpaid month',async()=>{
 const t=await newTenant(db);await payFor(db,t,'business');await scheduleDowngrade(db,t.tenantId,t.userId,'starter');
 await db.query(`UPDATE subscriptions SET period_end=now()-interval '1 day' WHERE tenant_id=$1`,[t.tenantId]);
 await applyDueSubscriptionChanges(db);await applyDueSubscriptionChanges(db);
 expect((await db.query<any>(`SELECT status FROM subscriptions WHERE tenant_id=$1`,[t.tenantId])).rows[0].status).toBe('grace');
});
it('a scheduled downgrade cannot purchase a more expensive plan without checkout',async()=>{
 const t=await newTenant(db);
 await expect(scheduleDowngrade(db,t.tenantId,t.userId,'business')).rejects.toThrow(/verified checkout/);
});
it('late success on an older order cannot overwrite a newer paid plan',async()=>{
 const t=await newTenant(db),one=await createOrder(db,t.tenantId,t.userId,'starter'),two=await createOrder(db,t.tenantId,t.userId,'business');
 const first=(await db.query<any>(`SELECT * FROM orders WHERE id=$1`,[one.orderId])).rows[0],second=(await db.query<any>(`SELECT * FROM orders WHERE id=$1`,[two.orderId])).rows[0];
 await processPaymentEvent(db,'mock',buildMockEvent(second));
 expect((await processPaymentEvent(db,'mock',buildMockEvent(first))).outcome).toBe('ignored');
 expect((await db.query<any>(`SELECT p.plan_code FROM subscriptions s JOIN plan_versions p ON p.id=s.plan_version_id WHERE s.tenant_id=$1`,[t.tenantId])).rows[0].plan_code).toBe('business');
 expect((await db.query(`SELECT 1 FROM outbox WHERE key=$1`,[`stale-payment:${first.id}`])).rows).toHaveLength(1);
});
it('encrypted backups round trip and reject altered data or the wrong key before extraction',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lbt-backup-test-')),secret='fixture-only-backup-encryption-key-32';
 try {
  const input=path.join(dir,'input'),encrypted=path.join(dir,'backup'),output=path.join(dir,'output');
  await fs.writeFile(input,Buffer.from('tenant data, immutable financial records and documents'));
  await encryptBackup(input,encrypted,secret);await decryptBackup(encrypted,output,secret);
  expect(await fs.readFile(output)).toEqual(await fs.readFile(input));
  await expect(decryptBackup(encrypted,path.join(dir,'wrong-key'),'wrong-fixture-backup-encryption-key-32')).rejects.toThrow(/authentication/);
  const buf=await fs.readFile(encrypted);buf[buf.length-1]^=1;await fs.writeFile(encrypted,buf);
  await expect(decryptBackup(encrypted,path.join(dir,'modified'),secret)).rejects.toThrow(/authentication/);
  await expect(fs.stat(path.join(dir,'modified'))).rejects.toThrow();
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
it('ClamAV INSTREAM passes clean evidence and rejects a positive malware finding',async()=>{
 for(const verdict of ['stream: OK\0','stream: Eicar-Test-Signature FOUND\0']) {
  const server=net.createServer(socket=>{
   let buf=Buffer.alloc(0);
   socket.on('data',chunk=>{buf=Buffer.concat([buf,Buffer.from(chunk)]);if(buf.length>=14&&buf.subarray(-4).equals(Buffer.alloc(4)))socket.end(verdict);});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
   const settings={host:'127.0.0.1',port:(server.address() as net.AddressInfo).port};
   if(verdict.includes('FOUND'))await expect(scanWithClamav(Buffer.from('EICAR fixture'),settings)).rejects.toThrow(/malware/);
   else await expect(scanWithClamav(Buffer.from('clean fixture'),settings)).resolves.toBeUndefined();
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }
});
it('Cloudflare provisioning verifies wildcard routing and HTTPS health rather than simulating readiness',async()=>{
 config.rootDomain='loadbyton.store';
 const request=vi.fn<typeof fetch>().mockResolvedValueOnce(json({success:true,result:[{proxied:true,content:'tunnel.cfargotunnel.com'}]})).mockResolvedValueOnce(json({ok:true}));
 const adapter=cloudflareAdapters({token:'fixture',zoneId:'zone',origin:'tunnel.cfargotunnel.com'},request);
 await adapter.attachRouting('acme.loadbyton.store');await adapter.verifyTls('acme.loadbyton.store');
 expect(request.mock.calls[1][0]).toBe('https://acme.loadbyton.store/healthz');
 await expect(adapter.attachRouting('attacker.example')).rejects.toThrow();
});
it('company MFA encrypts enrollment, fences app access and consumes each code once without granting staff MFA',async()=>{
 const t=await newTenant(db),session=await newSession(db,t.userId,t.tenantId);
 const secret=await beginMfaEnrollment(db,t.userId,'correct horse battery');
 expect((await db.query<any>(`SELECT secret_encrypted FROM user_mfa WHERE user_id=$1`,[t.userId])).rows[0].secret_encrypted).not.toContain(secret);
 await verifyCompanyMfa(db,session.token,totp(secret),true);
 const s=await loadSession(db,session.token);expect(s?.companyMfaOk).toBe(true);expect(s?.mfaOk).toBe(false);
 const second=await newSession(db,t.userId,t.tenantId),app=buildApp(db);
 expect((await app.request('/app',{headers:{cookie:`lbt_session=${second.token}`}})).headers.get('location')).toBe('/account/security');
 await expect(verifyCompanyMfa(db,second.token,totp(secret))).rejects.toThrow(/already used/);
 await expect(beginMfaEnrollment(db,t.userId,'wrong password')).rejects.toThrow(/incorrect/);
});
it('two outbox workers hold exclusive leases and retain deduplication keys',async()=>{
 const key=`fixture-${Date.now()}`;let calls=0;
 await db.query(`INSERT INTO outbox(topic,key,payload) VALUES('fixture',$1,'{}')`,[key]);
 const handler=async(row:any)=>{if(row.key===key)calls++;await new Promise(resolve=>setTimeout(resolve,5));return {externalId:'provider-fixture'};};
 await Promise.all([drainOutbox(db,{fixture:handler,email:async()=>{}}),drainOutbox(db,{fixture:handler,email:async()=>{}})]);
 expect(calls).toBe(1);
 expect((await db.query<any>(`SELECT status,lease_token,external_id FROM outbox WHERE key=$1`,[key])).rows[0]).toMatchObject({status:'sent',lease_token:null,external_id:'provider-fixture'});
});

it('Indian Razorpay INR quote is explicit, immutable and authenticated against the exact charged currency',async()=>{
 config.paymentProviders=['mock','razorpay'];config.razorpayPresentment={currency:'INR',aedToInr:23,note:'Test-only reviewed merchant quote'};
 const t=await newTenant(db),r=await createOrder(db,t.tenantId,t.userId,'starter','razorpay'),o=(await db.query<any>(`SELECT * FROM orders WHERE id=$1`,[r.orderId])).rows[0];
 expect(o.currency).toBe('AED');expect(o.payment_currency).toBe('INR');expect(Number(o.payment_total_minor)).toBe(Math.round(o.total_minor*23));
 config.razorpayPresentment.aedToInr=24;await expect(db.query(`UPDATE orders SET fx_rate=24 WHERE id=$1`,[o.id])).rejects.toThrow(/immutable/);
 expect((await processPaymentEvent(db,'razorpay',buildMockEvent(o))).outcome).toBe('rejected');
 expect((await processPaymentEvent(db,'razorpay',{...buildMockEvent(o),currency:'INR',amount_minor:Number(o.payment_total_minor)})).outcome).toBe('applied');
});
