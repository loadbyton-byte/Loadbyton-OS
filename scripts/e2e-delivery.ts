// Run against a disposable development database: BASE=... CHROME=... npm run e2e:delivery
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const base=process.env.BASE??'http://localhost:3000';
const browser=await chromium.launch({executablePath:process.env.CHROME,args:process.env.CHROME_NO_SANDBOX==='true'?['--no-sandbox']:[]});
try {
 const owner=await (await browser.newContext()).newPage(),errors:string[]=[];
 const observe=(page:typeof owner)=>{page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=500)errors.push(`HTTP ${r.status()} ${r.url()}`);});};observe(owner);
 const stamp=Date.now();
 await owner.goto(`${base}/start?sector=courier-last-mile`);
 await owner.fill('#company',`Delivery browser ${stamp}`);await owner.fill('#contact','Owner');await owner.fill('#email',`delivery-owner-${stamp}@example.com`);await owner.fill('#pw','browser-password-123');
 await owner.click('form[action="/start"] button[type=submit]');await owner.waitForURL(/\/app/);
 await owner.goto(`${base}/app/parties`);await owner.fill('#pn','Merchant');await owner.selectOption('#pk','customer');await owner.fill('#pc','0');await owner.click('form[action="/app/parties"] button[type=submit]');
 await owner.goto(`${base}/app/delivery/couriers`);await owner.fill('#name','Courier');await owner.fill('#phone','0501234567');await owner.click('form[action="/app/delivery/couriers"] button');
 const invite=owner.locator('form[action$="/invite"]');await invite.locator('[name=email]').fill(`delivery-courier-${stamp}@example.com`);await invite.locator('button').click();
 const token=new URL(owner.url()).searchParams.get('link');assert.ok(token,'Courier invitation link missing');
 const courier=await (await browser.newContext()).newPage();observe(courier);
 await courier.goto(`${base}/invite/${token}`);await courier.fill('#n','Courier');await courier.fill('#pw','browser-password-123');await courier.click('form[action^="/invite/"] button');await courier.waitForURL(/\/app\/driver/);
 await owner.goto(`${base}/app/team`);const financeInvite=owner.locator('form[action="/app/team/invite"]');await financeInvite.locator('[name=email]').fill(`delivery-finance-${stamp}@example.com`);await financeInvite.locator('[name=roles][value=finance]').check();await financeInvite.locator('button').click();const financeToken=new URL(owner.url()).searchParams.get('link');assert.ok(financeToken);const finance=await (await browser.newContext()).newPage();observe(finance);await finance.goto(`${base}/invite/${financeToken}`);await finance.fill('#n','Independent finance');await finance.fill('#pw','browser-password-123');await finance.click('form[action^="/invite/"] button');await finance.waitForURL(/\/app/);
 await owner.goto(`${base}/app/delivery/new`);await owner.selectOption('#party_id',{label:'Merchant'});await owner.fill('#external_ref',`ORDER-${stamp}`);await owner.fill('#recipient_name','Amira');await owner.fill('#recipient_phone','0501234567');await owner.fill('#address','Dubai delivery address');await owner.fill('#fee','15');await owner.fill('#cod','100');await owner.click('form[action="/app/delivery/parcels"] button');
 await owner.waitForURL(/\/app\/delivery\/parcels\/[^/?]+/);const parcelPath=new URL(owner.url()).pathname,parcelId=parcelPath.split('/').pop();assert.ok(parcelId);
 await owner.fill('#route_ref','DXB-1');await owner.click('form[action$="/dispatch"] button');
 await courier.goto(`${base}/app/driver/deliveries/${parcelId}`);await courier.fill('#pod_name','Amira');await courier.fill('#collected','100');await courier.click('form[action$="/attempt"] button');
 assert.match(await courier.locator('body').innerText(),/Attempt recorded/);
 await owner.goto(`${base}${parcelPath}`);await owner.locator('form[action$="/cash"] [name=amount]').fill('75');await owner.locator('form[action$="/cash"] [name=reference]').fill(`CASH-${stamp}`);await owner.locator('form[action$="/cash"] button').click();
 await owner.locator('form[action$="/reconcile"] [name=reason]').fill('Original recorder must not approve shortage');await owner.locator('form[action$="/reconcile"] button').click();assert.match(await owner.locator('body').innerText(),/different finance approver/);
 await finance.goto(`${base}${parcelPath}`);await finance.locator('form[action$="/reconcile"] [name=reason]').fill('Independent review: collected 100, original handover 75, shortage 25 remains visible');await finance.locator('form[action$="/reconcile"] button').click();
 await owner.goto(`${base}${parcelPath}`);const evidence=owner.locator('form[action$="/cash-evidence"]');await evidence.locator('[name=issuer]').fill('Verification recovery signatory');await evidence.locator('input[type=file]').setInputFiles({name:'cash-recovery.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 browser-only actual cash recovery fixture')});await evidence.locator('button').click();const adjustment=owner.locator('form[action$="/adjustments"]');await adjustment.locator('[name=kind]').selectOption('recovery');await adjustment.locator('[name=amount]').fill('25');await adjustment.locator('[name=reason]').fill(`Actual additional handover verified, recovery reference RECOVERY-${stamp}`);await adjustment.locator('button').click();assert.match(await owner.locator('body').innerText(),/Awaiting another finance approver/);
 await finance.goto(`${base}${parcelPath}`);const review=finance.locator('form[action$="/decide"]');await review.locator('[name=reason]').fill('Independent proof and additional cash verified');await review.locator('button[value=true]').click();assert.match(await finance.locator('body').innerText(),/Approved: Independent proof/);await owner.goto(`${base}${parcelPath}`);
 await owner.locator('form[action$="/remit"] [name=amount]').fill('100');await owner.locator('form[action$="/remit"] [name=reference]').fill(`BANK-${stamp}`);await owner.locator('form[action$="/remit"] button').click();
 assert.match(await owner.locator('body').innerText(),new RegExp(`BANK-${stamp}`));
 await owner.locator('form[action$="/invoice"] button').click();await owner.waitForURL(/\/app\/invoices\//);
 assert.match(await owner.locator('body').innerText(),/15\.00/);assert.match(await owner.locator('body').innerText(),/15\.75/);
 await owner.goto(`${base}/app/management-reports`);assert.match(await owner.locator('tr').filter({hasText:'Original cash handovers'}).innerText(),/75\.00/);assert.match(await owner.locator('tr').filter({hasText:'Cash received after adjustments'}).innerText(),/100\.00/);assert.match(await owner.locator('tr').filter({hasText:'Outstanding expected merchant entitlement'}).innerText(),/0\.00/);
 assert.deepEqual(errors,[]);console.log('Delivery browser acceptance passed: signup → individual courier/finance invites → parcel → dispatch → POD/COD → shortage/self-review refusal → independent reconciliation → issued recovery evidence → second-person cash approval → bounded remittance → service invoice.');
} finally {await browser.close();}
