import {Hono} from 'hono';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {apiContext,apiMutation,createApiKey,revokeApiKey,API_SCOPES} from '../platform/api.js';
import {rateLimit} from '../adapters/rate-limit.js';
import {HttpError} from '../lib/util.js';
import {require as requirePerm} from '../lib/perms.js';
import {createEnquiry} from '../ops/crm.js';
import {generateAssistantDraft,getAssistantDraft} from '../ops/assistant.js';
import {createSpecialistCase,getSpecialistCase,recordSpecialistEvent,specialistProfile,transitionSpecialistCase} from '../ops/specialists.js';
import {appPage,need,withT,act,PageHead,PostBtn} from './appkit.js';
import {Csrf,Table} from './ui.js';
import {formBody,str,arr,type Env} from './mw.js';

type ApiEnv=Env;
export const api=new Hono<ApiEnv>();
const TENANT_API=/^\/api\/v1\/(parties|invoices|enquiries|specialists|assistant)(\/|$)/;
api.use('/api/v1/*',async(c,next)=>{
 if(!TENANT_API.test(c.req.path))return next();   // merchant delivery keys (api-delivery.ts) authenticate themselves
 const trace=randomUUID();c.set('traceId',trace);c.header('X-Trace-Id',trace);
 try {
  const auth=c.req.header('authorization')??'';if(!auth.startsWith('Bearer lbt_'))throw new HttpError(401,'Bearer API key required');
  const context=await apiContext(c.get('db'),auth.slice(7));c.set('apiAuth',context);
  await rateLimit(`api:${context.keyId}`,120,60);
  await next();
 } catch(e){return c.json({error:e instanceof HttpError?e.message:'API request failed',trace_id:trace},(e instanceof HttpError?e.status:500) as any);}
});
const scope=(c:any,s:string)=>{const a=c.get('apiAuth');if(!a.scopes.includes(s))throw new HttpError(403,'API scope not granted');return a;};
const pagination=(c:any)=>{const limit=Number(c.req.query('limit')??50),offset=Number(c.req.query('offset')??0);if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>100000)throw new HttpError(400,'Invalid pagination');return {limit,offset};};
api.get('/api/v1/parties',async c=>{
 const a=scope(c,'parties:read'),p=pagination(c);requirePerm(a.ctx,'read');
 const rows=await c.get('db').tenant(a.ctx.tenantId,async cn=>(await cn.query<any>(`SELECT id,name,kind FROM parties ORDER BY created_at,id LIMIT $1 OFFSET $2`,[p.limit+1,p.offset])).rows);
 return c.json({data:rows.slice(0,p.limit),next_offset:rows.length>p.limit?p.offset+p.limit:null,trace_id:c.get('traceId')});
});
api.get('/api/v1/invoices',async c=>{
 const a=scope(c,'invoices:read'),p=pagination(c);requirePerm(a.ctx,'finance.write');
 const rows=await c.get('db').tenant(a.ctx.tenantId,async cn=>(await cn.query<any>(`SELECT id,no,currency,total_minor,paid_minor,status,sync_status FROM invoices ORDER BY issued_at,id LIMIT $1 OFFSET $2`,[p.limit+1,p.offset])).rows);
 return c.json({data:rows.slice(0,p.limit),next_offset:rows.length>p.limit?p.offset+p.limit:null,trace_id:c.get('traceId')});
});
api.post('/api/v1/enquiries',async c=>{
 const a=scope(c,'enquiries:write'),raw=await c.req.text();if(raw.length>64000)throw new HttpError(413,'API payload too large');
 let body:any;try{body=z.object({mode:z.enum(['air','ocean','road']),origin:z.string().max(120),destination:z.string().max(120),cargo_desc:z.string().max(2000),party_id:z.string().uuid().nullable().optional(),weight_kg:z.number().finite().nonnegative().optional(),source:z.string().max(80).optional(),external_ref:z.string().max(120).optional(),ready_date:z.iso.date().optional()}).parse(JSON.parse(raw));}catch{throw new HttpError(400,'Invalid enquiry payload');}
 const result=await c.get('db').tenant(a.ctx.tenantId,async cn=>{
  if(!(await cn.query(`SELECT 1 FROM tenant_sectors WHERE sector='freight-forwarding'`)).rows.length)throw new HttpError(403,'Freight forwarding is not selected');
  return apiMutation(cn,a.ctx,a.keyId,'enquiries',c.req.header('idempotency-key')??'',raw,()=>createEnquiry(cn,a.ctx,body));
 });
 return c.json({data:result,trace_id:c.get('traceId')},201);
});
api.get('/api/v1/specialists/:sector',async c=>{
 const a=scope(c,'specialists:read'),p=pagination(c),s=c.req.param('sector');specialistProfile(s);requirePerm(a.ctx,'read');
 const rows=await c.get('db').tenant(a.ctx.tenantId,async cn=>{
  if(!(await cn.query(`SELECT 1 FROM tenant_sectors WHERE sector=$1`,[s])).rows.length)throw new HttpError(403,'Sector not selected');
  return (await cn.query<any>(`SELECT id,no,external_ref,subject_ref,status,fee_minor,tax_code FROM specialist_cases WHERE sector=$1 ORDER BY created_at,id LIMIT $2 OFFSET $3`,[s,p.limit+1,p.offset])).rows;
 });return c.json({data:rows.slice(0,p.limit),next_offset:rows.length>p.limit?p.offset+p.limit:null,trace_id:c.get('traceId')});
});
for(const action of ['create','event','status']) {
 const path=action==='create'?'/api/v1/specialists/:sector':'/api/v1/specialists/:sector/:id/'+action;
 api.post(path,async c=>{
  const a=scope(c,'specialists:write'),s=c.req.param('sector')!;specialistProfile(s);const raw=await c.req.text();if(Buffer.byteLength(raw)>64000)throw new HttpError(413,'API payload too large');
  let body:Record<string,any>;try{body=z.record(z.string(),z.union([z.string().max(2000),z.number().finite(),z.boolean(),z.null()])).parse(JSON.parse(raw));}catch{throw new HttpError(400,'Invalid specialist payload');}
  const id=c.req.param('id');const result=await c.get('db').tenant(a.ctx.tenantId,async cn=>apiMutation(cn,a.ctx,a.keyId,`specialists:${s}:${action}:${id??''}`,c.req.header('idempotency-key')??'',raw,async()=>{
   if(action==='create')return createSpecialistCase(cn,a.ctx,s,body);
   const d=await getSpecialistCase(cn,id!);if(d.row.sector!==s)throw new HttpError(403,'Case belongs to a different sector');
   if(action==='event')return {id:await recordSpecialistEvent(cn,a.ctx,id!,String(body.kind??''),body,String(body.note??''),String(body.client_ref??''),body.document_id||undefined)};
   await transitionSpecialistCase(cn,a.ctx,id!,String(body.status??''),String(body.reason??''));return {id,status:String(body.status)};
  }));return c.json({data:result,trace_id:c.get('traceId')},201);
 });
}
api.post('/api/v1/assistant/drafts',async c=>{
 const a=scope(c,'assistant:write'),raw=await c.req.text();if(Buffer.byteLength(raw)>4096)throw new HttpError(413,'Assistant payload too large');
 let body:any;try{body=z.object({resource:z.enum(['enquiry','job']),source_id:z.uuid(),purpose:z.enum(['summary','reply','classification'])}).strict().parse(JSON.parse(raw));}catch{throw new HttpError(400,'Invalid assistant payload');}
 const reference=c.req.header('idempotency-key');if(!z.uuid().safeParse(reference).success)throw new HttpError(400,'Assistant Idempotency-Key must be a UUID');
 const data=await generateAssistantDraft(c.get('db'),a.ctx,{...body,reference});return c.json({data,trace_id:c.get('traceId')},201);
});
api.get('/api/v1/assistant/drafts/:id',async c=>{
 const a=scope(c,'assistant:read'),data=await c.get('db').tenant(a.ctx.tenantId,cn=>getAssistantDraft(cn,a.ctx,c.req.param('id')));return c.json({data,trace_id:c.get('traceId')});
});
api.get('/app/api-keys',async c=>{
 need(c,'settings.manage');const rows=await withT(c,async cn=>(await cn.query<any>(`SELECT id,name,scopes,expires_at,revoked_at FROM api_keys ORDER BY created_at DESC LIMIT 100`)).rows);
 return appPage(c as any,'API keys',<><PageHead title="API keys"/><p>Keys inherit the issuing user's current permissions and one company scope. Store a new key securely: it is shown once and expires within 90 days. The API requires bearer authorization and does not accept session cookies.</p>
 <form method="post" action="/app/api-keys"><Csrf t={c.get('csrf')}/><label for="name">Integration name</label><input name="name" id="name" required maxlength={100}/><label for="days">Expiry in days</label><input name="days" id="days" type="number" value="30" min="1" max="90" required/>{API_SCOPES.map(s=><label class="check"><input name="scope" value={s} type="checkbox"/>{s}</label>)}<button class="btn">Create key</button></form>
 <Table head={['Name','Scopes','Expires','']} empty={rows.length?undefined:'No keys'}>{rows.map(r=><tr><td>{r.name}</td><td>{r.scopes.join(', ')}</td><td>{new Date(r.expires_at).toISOString()}</td><td>{r.revoked_at?'Revoked':<PostBtn action={`/app/api-keys/${r.id}/revoke`} csrf={c.get('csrf')} label="Revoke"/>}</td></tr>)}</Table></>);
});
api.post('/app/api-keys',async c=>{
 const b=await formBody(c);const key=await withT(c,(cn,ctx)=>createApiKey(cn,ctx,str(b.name),arr(b.scope),Number(str(b.days))));
 return appPage(c as any,'Save your API key',<><PageHead title="Save your API key"/><p>This key is shown once. Use it only in your integration's secure credential store.</p><code>{key.token}</code><p><a href="/app/api-keys">Manage keys</a></p></>);
});
api.post('/app/api-keys/:id/revoke',async c=>act(c as any,'/app/api-keys',async()=>{await withT(c,(cn,ctx)=>revokeApiKey(cn,ctx,c.req.param('id')));return {to:'/app/api-keys',ok:'Key revoked.'};}));
