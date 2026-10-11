import { performance } from 'node:perf_hooks';
import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

// No tenant, user, URL, query-string or parcel identifiers are included in metric labels.
const buckets=[0.005,0.025,0.1,0.5,1,5,10];
const label=(s:string)=>s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n');
export class RuntimeMetrics {
 private requests=new Map<string,{count:number;sum:number;buckets:number[]}>();
 private workers=new Map<string,{runs:number;errors:number}>();
 private active=0;
 private started=Date.now()/1000;
 private gauges=new Map<string,number>();
 gauge(name:'outbox_pending'|'outbox_dead'|'outbox_oldest_age_seconds'|'provisioning_pending'|'provisioning_failed'|'provisioning_oldest_age_seconds'|'invoice_sync_failed'|'warehouse_counts_due'|'assistant_pending'|'assistant_uncertain'|'fulfilment_storage_due',value:number){if(Number.isFinite(value))this.gauges.set(name,value);}
 middleware():MiddlewareHandler{return async(c,next)=>{
  this.active++;const start=performance.now();
  try{await next();}finally{
   this.active--;
   const method=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(c.req.method)?c.req.method:'OTHER';
   const registered=routePath(c) || 'unmatched';
   const labels=`method="${method}",route="${label(registered)}",status="${c.res.status}"`;
   const elapsed=(performance.now()-start)/1000;
   const sample=this.requests.get(labels)??{count:0,sum:0,buckets:buckets.map(()=>0)};
   sample.count++;sample.sum+=elapsed;for(let i=0;i<buckets.length;i++)if(elapsed<=buckets[i])sample.buckets[i]++;
   this.requests.set(labels,sample);
  }
 };}
 worker(name:'provisioning'|'outbox'|'subscriptions'|'payments'|'storage',failed=false){const sample=this.workers.get(name)??{runs:0,errors:0};sample.runs++;if(failed)sample.errors++;this.workers.set(name,sample);}
 render(){
  const lines=['# TYPE lbt_process_start_time_seconds gauge',`lbt_process_start_time_seconds ${this.started}`,
   '# TYPE lbt_http_active_requests gauge',`lbt_http_active_requests ${this.active}`,
   '# TYPE lbt_http_requests_total counter','# TYPE lbt_http_request_duration_seconds histogram'];
  for(const [labels,s]of this.requests){
   lines.push(`lbt_http_requests_total{${labels}} ${s.count}`);
   buckets.forEach((b,i)=>lines.push(`lbt_http_request_duration_seconds_bucket{${labels},le="${b}"} ${s.buckets[i]}`));
   lines.push(`lbt_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${s.count}`,`lbt_http_request_duration_seconds_sum{${labels}} ${s.sum}`,`lbt_http_request_duration_seconds_count{${labels}} ${s.count}`);
  }
  lines.push('# TYPE lbt_worker_runs_total counter','# TYPE lbt_worker_errors_total counter');
  for(const [name,s]of this.workers)lines.push(`lbt_worker_runs_total{worker="${name}"} ${s.runs}`,`lbt_worker_errors_total{worker="${name}"} ${s.errors}`);
  for(const [name,value]of this.gauges)lines.push(`# TYPE lbt_${name} gauge`,`lbt_${name} ${value}`);
  return lines.join('\n')+'\n';
 }
}
