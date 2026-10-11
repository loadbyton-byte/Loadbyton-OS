import type {Db} from '../db/client.js';
import {RuntimeMetrics} from './metrics.js';
import {processProvisioningQueue} from './provisioning.js';
import {drainOutbox,defaultHandlers} from './outbox.js';
import {accountingHandlers} from '../adapters/accounting.js';
import {emailHandlers,inboxHandlers} from '../adapters/email.js';
import {processAutomaticStorage} from '../ops/fulfil-storage.js';
import {applyDueSubscriptionChanges,reconcilePayments} from './billing.js';

export function startWorkers(db:Db,metrics:RuntimeMetrics) {
 const handlers={...defaultHandlers,...emailHandlers(db),...inboxHandlers(db),...accountingHandlers(db)};
 const timers:NodeJS.Timeout[]=[],running=new Set<Promise<void>>(),active=new Set<string>();
 for(const [name,interval,work] of [
  ['provisioning',5000,()=>processProvisioningQueue(db)],['outbox',5000,()=>drainOutbox(db,handlers)],
  ['storage',60000,async()=>{const result=await processAutomaticStorage(db);if(result.failed)throw new Error('Storage accrual review needed');}],
  ['subscriptions',60000,()=>applyDueSubscriptionChanges(db)],['payments',60000,()=>reconcilePayments(db)],
 ] as const) {
  const run=()=>{
   if(active.has(name))return;active.add(name);
   const p=(async()=>{try{await work();metrics.worker(name);}catch{metrics.worker(name,true);console.error(`[worker:${name}] failed`);}finally{active.delete(name);}})();
   running.add(p);void p.finally(()=>running.delete(p));
  };
  timers.push(setInterval(run,interval));
 }
 return async()=>{timers.forEach(clearInterval);await Promise.allSettled([...running]);};
}
