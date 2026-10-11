// Reserved fixture data and mock checkout against a disposable development database.
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
const base=process.env.BASE??'http://localhost:3000';
const browser=await chromium.launch({executablePath:process.env.CHROME,args:process.env.CHROME_NO_SANDBOX==='true'?['--no-sandbox']:[]});
try{
 const page=await (await browser.newContext()).newPage(),errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=500)errors.push(`HTTP ${r.status()} ${r.url()}`);});
 const go=(path:string)=>page.goto(base+path),stamp=Date.now();
 await go('/start?sector=ecommerce-fulfilment');await page.fill('#company',`Handover fixture ${stamp}`);await page.fill('#contact','Fixture owner');await page.fill('#email',`handover-${stamp}@example.com`);await page.fill('#pw','browser-password-123');await page.click('form[action="/start"] button');await page.waitForURL(/\/app/);
 await go('/app/settings');await page.fill('#ln','Fixture fulfilment company');await page.click('form[action="/app/settings/entity"] button');
 await go('/app/billing');await page.locator('form[action="/app/billing/checkout"]').filter({has:page.locator('input[name=plan][value=operations]')}).locator('button').click();await page.click('button:has-text("Simulate successful payment")');
 await go('/app/settings');await page.check('input[name=sector][value=courier-last-mile]');await page.click('form[action="/app/settings/sectors"] button');
 await go('/app/parties');await page.fill('#pn','Fixture merchant');await page.selectOption('#pk','customer');await page.fill('#pc','0');await page.click('form[action="/app/parties"] button');
 await go('/app/fulfilment/locations');await page.fill('form[action="/app/fulfilment/locations"] [name=code]','BIN-A');await page.click('form[action="/app/fulfilment/locations"] button');
 await go('/app/fulfilment/catalog');await page.selectOption('#sm',{label:'Fixture merchant'});await page.fill('#sc2','SKU-1');await page.fill('#sn2','Fixture product');await page.click('form[action="/app/fulfilment/catalog"] button');
 await go('/app/fulfilment/inbound/new');await page.selectOption('#ip',{label:'Fixture merchant'});await page.fill('#il','SKU-1, 2');await page.click('form[action="/app/fulfilment/inbound"] button');
 await page.locator('form[action$="/receive"] [name=good]').fill('2');await page.locator('form[action$="/receive"] [name=damaged]').fill('0');await page.locator('form[action$="/receive"] [name=location_id]').selectOption({label:'BIN-A'});await page.locator('form[action$="/receive"] button').click();
 await go('/app/fulfilment/orders/new');await page.selectOption('#mp',{label:'Fixture merchant'});await page.fill('#er',`ORDER-${stamp}`);await page.fill('#ln','SKU-1, 1');await page.fill('#sn','Fixture recipient');await page.fill('#sp','0501234567');await page.fill('#sa','Marina Walk 12');await page.fill('#sc','Dubai');await page.click('form[action="/app/fulfilment/orders"] button');
 const orderPath=new URL(page.url()).pathname;
 await page.locator('form[action$="/pick"] button').click();await page.locator('form[action$="/pack"] [name=code]').fill('SKU-1');await page.locator('form[action$="/pack"] button').click();await page.selectOption('#ca','Own fleet');await page.fill('#tn',`TRACK-${stamp}`);await page.locator('form[action$="/ship"] button').click();
 await page.fill('#handover-fee','15');await page.fill('#handover-cod','100');await page.fill('#handover-evidence','Fixture merchant-approved fee and COD instruction');await page.locator('form[action$="/delivery-handover"] button').click();
 assert.match(new URL(page.url()).pathname,/\/app\/delivery\/parcels\//);const parcelPath=new URL(page.url()).pathname;
 assert.match(await page.locator('body').innerText(),/Expected COD: AED 100\.00/);assert.ok(await page.locator(`a[href="${orderPath}"]`).count());
 await go(orderPath);assert.ok(await page.locator(`a[href="${parcelPath}"]`).count());assert.equal(await page.locator('form[action$="/delivery-handover"]').count(),0);
 await go('/app/documents');const docForm=page.locator('form[action="/app/documents"]');await docForm.locator('[name=title]').fill('Fixture agreed daily storage contract');await docForm.locator('[name=kind]').selectOption('other');await page.fill('#external-issuer','Fixture merchant signed terms');await docForm.locator('input[type=file]').setInputFiles({name:'storage-contract.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 browser storage fixture')});await docForm.locator('button').click();
 await go('/app/fulfilment/daily-storage');await page.selectOption('#storage-merchant',{label:'Fixture merchant'});await page.selectOption('#storage-document',{label:'Fixture agreed daily storage contract'});
 const first=new Date();first.setUTCMonth(first.getUTCMonth()+1,1);const last=new Date(first);last.setUTCDate(last.getUTCDate()+27);await page.fill('#storage-start',first.toISOString().slice(0,10));await page.fill('#storage-end',last.toISOString().slice(0,10));await page.fill('#storage-rate','2.50');await page.selectOption('#storage-tax','ZR0');await page.fill('#storage-reviewer','Fixture contract reviewer');await page.fill('#storage-scope','Fixture agreed occupied bin, receiving and quarantine locations at Dubai midnight, staging excluded, reviewed zero-rated treatment.');await page.locator('form[action="/app/fulfilment/daily-storage"] button').click();
 assert.match(await page.locator('body').innerText(),/Agreed daily terms recorded/);assert.ok(await page.locator('form[action$="/accrue"]').count());
 const automation=page.locator('form[action$="/automation"]');await automation.locator('[name=reason]').fill('Fixture finance approves automatic accrual under issued agreed terms');await automation.locator('button').click();assert.match(await page.locator('body').innerText(),/Automatic closed-day accrual approved/);
 await page.locator('form[action$="/automation"] [name=reason]').fill('Pause fixture automation after browser acceptance');await page.locator('form[action$="/automation"] button').click();assert.match(await page.locator('body').innerText(),/Automatic accrual paused/);
 assert.deepEqual(errors,[]);console.log('Fulfilment/Delivery browser acceptance passed: paid two-sector workspace → stock receipt → reserve/pick/pack/ship → linked COD parcel → reciprocal source links → issued reviewed future daily-storage contract.');
}finally{await browser.close();}
