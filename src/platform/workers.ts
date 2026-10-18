import type {Db} from '../db/client.js';
import {RuntimeMetrics} from './runtime-metrics.js';
import {processProvisioningQueue} from './provisioning.js';
import {drainOutbox,defaultHandlers} from './outbox.js';
import {accountingHandlers} from '../adapters/accounting.js';
import {mailHandlers} from '../adapters/mail.js';
import {inboxHandlers} from '../adapters/email.js';
import {deliveryNotifyHandlers} from '../adapters/delivery-notify.js';
import {markWorker} from './metrics.js';
import {processAutomaticStorage} from '../ops/fulfil-storage.js';
import {applyDueSubscriptionChanges} from './billing.js';
import {postAllLedgers} from '../ops/ledger.js';
import {pullDueFeeds} from '../ops/live-feeds.js';
import {processDataMinimisation} from '../ops/privacy-retention.js';
import {kycSmsHandlers} from '../adapters/kyc-sms.js';
import {acquireLease,releaseLease} from './worker-lease.js';
import {sendBrandReminders} from './requests.js';
import {pullDueOrders} from '../ops/order-pull.js';
import {pollSubmittedDocuments,processEInvoiceRetries} from '../ops/einvoice-sync.js';
import {expireLapsedGrants,reconcileFromCom} from './ecosystem.js';

export function startWorkers(db:Db,metrics:RuntimeMetrics) {
 const handlers={...defaultHandlers,...accountingHandlers(db),...mailHandlers(db),...inboxHandlers(db),...deliveryNotifyHandlers(db),...kycSmsHandlers()};
 const timers:NodeJS.Timeout[]=[],running=new Set<Promise<void>>(),active=new Set<string>();
 for(const [name,interval,work] of [
  ['provisioning',5000,()=>processProvisioningQueue(db)],['outbox',5000,()=>drainOutbox(db,handlers)],
  ['storage',60000,async()=>{const result=await processAutomaticStorage(db);if(result.failed)throw new Error('Storage accrual review needed');}],
  ['subscriptions',60000,()=>applyDueSubscriptionChanges(db)],
  ['reminders',3600000,()=>sendBrandReminders(db)],
  ['ledger',300000,async()=>{const r=await postAllLedgers(db);if(r.failed)throw new Error('Ledger posting review needed');}],
  ['feeds',300000,async()=>{const r=await pullDueFeeds(db);if(r.failed)throw new Error('Statement feed review needed');}],
  ['orders',300000,async()=>{const r=await pullDueOrders(db);if(r.failed)throw new Error('Order pull review needed');}],
  ['einvoice',60000,async()=>{const r=await processEInvoiceRetries(db);if(r.failed)throw new Error('E-invoice retry review needed');await pollSubmittedDocuments(db);}],
  ['privacy',3600000,async()=>{const r=await processDataMinimisation(db);if(r.failed)throw new Error('Data minimisation review needed');}],
  ['ecosystem',900000,async()=>{await expireLapsedGrants(db);await reconcileFromCom(db);}],
 ] as const) {
  const run=()=>{
   if(active.has(name))return;active.add(name);
   const p=(async()=>{try{if(await acquireLease(db,name,Math.max(30000,interval*3)))await work();metrics.worker(name);markWorker(name,true);}catch{metrics.worker(name,true);markWorker(name,false);console.error(`[worker:${name}] failed`);}finally{active.delete(name);}})();
   running.add(p);void p.finally(()=>running.delete(p));
  };
  run(); // Readiness must reflect real startup work, including the slow maintenance loops.
  timers.push(setInterval(run,interval));
 }
 return async()=>{timers.forEach(clearInterval);await Promise.allSettled([...running]);await Promise.allSettled(['provisioning','outbox','storage','subscriptions','reminders','ledger','feeds','orders','einvoice','privacy','ecosystem'].map((n)=>releaseLease(db,n)));};
}
