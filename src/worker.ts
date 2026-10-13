import {serve} from '@hono/node-server';
import {initSentry,flushSentry} from './platform/sentry.js';
import {openDb} from './db/client.js';
import {RuntimeMetrics} from './platform/runtime-metrics.js';
import {startWorkers} from './platform/workers.js';
import {config} from './config.js';
import {safeEqual} from './lib/util.js';
import {collectQueueMetrics} from './platform/health.js';
initSentry('worker');
const db=await openDb(),metrics=new RuntimeMetrics(),stop=startWorkers(db,metrics);
const server=serve({port:Number(process.env.WORKER_PORT??3001),fetch:async req=>{
 const path=new URL(req.url).pathname;
 if(path==='/healthz'){await db.query('SELECT 1');return Response.json({ok:true});}
 if(path==='/metrics'&&config.metricsToken.length>=32&&safeEqual(req.headers.get('authorization')??'',`Bearer ${config.metricsToken}`)){await collectQueueMetrics(db,metrics);return new Response(metrics.render(),{headers:{'Content-Type':'text/plain; version=0.0.4'}});}
 return new Response('Not found',{status:404});
}});
const shutdown=async()=>{await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),stop()]);await db.close();await flushSentry();process.exit(0);};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
