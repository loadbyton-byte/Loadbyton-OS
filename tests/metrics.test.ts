import { spawnSync } from 'node:child_process';
import {beforeAll,it,expect} from 'vitest';
import {RuntimeMetrics} from '../src/platform/runtime-metrics.js';
import {buildApp} from '../src/app.js';
import {freshDb} from './helpers.js';
import type {Db} from '../src/db/client.js';
let db:Db;beforeAll(async()=>{db=await freshDb();});
it('requires a configured metrics token and hides credentials and dynamic identifiers',async()=>{
 const metrics=new RuntimeMetrics(),token='test-only-metrics-token-with-32-characters',app=buildApp(db,{metrics,metricsToken:token});
 expect((await app.request('/metrics')).status).toBe(404);   // the endpoint does not reveal itself without the exact token
 expect((await app.request('/metrics',{headers:{authorization:'Bearer wrong'}})).status).toBe(404);
 await app.request('/healthz');await app.request('/never-a-route/private-customer-identifier?phone=0501234567');
 metrics.worker('outbox');metrics.worker('outbox',true);
 const response=await app.request('/metrics',{headers:{authorization:`Bearer ${token}`}}),text=await response.text();
 expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/plain');
 expect(text).toContain('lbt_http_requests_total{method="GET",route="/healthz",status="200"} 1');
 expect(text).toContain('lbt_worker_runs_total{worker="outbox"} 2');expect(text).toContain('lbt_worker_errors_total{worker="outbox"} 1');
 expect(text).not.toContain(token);expect(text).not.toContain('private-customer-identifier');expect(text).not.toContain('0501234567');
 expect((await buildApp(db,{metricsToken:''}).request('/metrics')).status).toBe(404);
});

it('fails startup for an unimplemented payment provider instead of silently accepting it',()=>{
 const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"await import('./src/config.ts')"],{
  cwd:process.cwd(),encoding:'utf8',timeout:10000,
  env:{...process.env,NODE_ENV:'development',PAYMENT_PROVIDER:'not-implemented'},
 });
 expect(result.status).not.toBe(0);expect(result.stderr).toContain('unknown payment provider');
});
