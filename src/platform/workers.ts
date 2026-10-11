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
import {processDataMinimisation} from '../ops/privacy-retention.js';

export function startWorkers(db:Db,metrics:RuntimeMetrics) {
 const handlers={...defaultHandlers,...accountingHandlers(db),...mailHandlers(db),...inboxHandlers(db),...deliveryNotifyHandlers(db)};
 const timers:NodeJS.Timeout[]=[],running=new Set<Promise<void>>(),active=new Set<string>();
 for(const [name,interval,work] of [
  ['provisioning',5000,()=>processProvisioningQueue(db)],['outbox',5000,()=>drainOutbox(db,handlers)],
  ['storage',60000,async()=>{const result=await processAutomaticStorage(db);if(result.failed)throw new Error('Storage accrual review needed');}],
  ['subscriptions',60000,()=>applyDueSubscriptionChanges(db)],
  ['privacy',3600000,async()=>{const r=await processDataMinimisation(db);if(r.failed)throw new Error('Data minimisation review needed');}],
 ] as const) {
  const run=()=>{
   if(active.has(name))return;active.add(name);
   const p=(async()=>{try{await work();metrics.worker(name);markWorker(name,true);}catch{metrics.worker(name,true);markWorker(name,false);console.error(`[worker:${name}] failed`);}finally{active.delete(name);}})();
   running.add(p);void p.finally(()=>running.delete(p));
  };
  timers.push(setInterval(run,interval));
 }
 return async()=>{timers.forEach(clearInterval);await Promise.allSettled([...running]);};
}
