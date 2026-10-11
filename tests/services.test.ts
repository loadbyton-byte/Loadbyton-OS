import {beforeAll,it,expect,vi} from 'vitest';
import type {Db} from '../src/db/client.js';
import {freshDb,newTenant,payFor,ctxFor} from './helpers.js';
import {createApiKey,revokeApiKey} from '../src/platform/api.js';
import {createParty} from '../src/ops/crm.js';
import {buildApp} from '../src/app.js';
import {newSession} from '../src/platform/auth.js';
import {requestDataAction,decideDataRequest} from '../src/ops/privacy.js';
import {saveZohoConnection} from '../src/ops/connections.js';
import {zohoBooksAdapter} from '../src/adapters/zoho.js';
import {decryptSecret} from '../src/lib/encryption.js';
import {createStaff} from '../src/platform/admin.js';
import {scheduleSetup,submitSetupEvidence,acceptSetup} from '../src/ops/service.js';
import {invite,acceptInvite,setRoles} from '../src/ops/team.js';

let db:Db;beforeAll(async()=>{db=await freshDb();});
const json=(x:any)=>new Response(JSON.stringify(x),{status:200,headers:{'Content-Type':'application/json'}});
it('API keys isolate tenant records, restrict scopes, expire and revoke immediately',async()=>{
 const a=await newTenant(db),b=await newTenant(db),app=buildApp(db);
 await db.tenant(a.tenantId,c=>createParty(c,a.ctx,{kind:'customer',name:'Visible customer'}));
 await db.tenant(b.tenantId,c=>createParty(c,b.ctx,{kind:'customer',name:'Private other tenant'}));
 const key=await db.tenant(a.tenantId,c=>createApiKey(c,a.ctx,'Read integration',['parties:read'],30));
 const headers={authorization:`Bearer ${key.token}`};
 const r=await app.request('/api/v1/parties?limit=1',{headers}),body=await r.json() as any;
 expect(r.status).toBe(200);expect(body.data[0].name).toBe('Visible customer');expect(JSON.stringify(body)).not.toContain('Private other tenant');expect(r.headers.get('X-Trace-Id')).toBe(body.trace_id);
 expect((await app.request('/api/v1/invoices',{headers})).status).toBe(403);
 const session=await newSession(db,a.userId,a.tenantId);
 expect((await app.request('/api/v1/parties',{headers:{cookie:`lbt_session=${session.token}`}})).status).toBe(401);
 await db.tenant(a.tenantId,c=>revokeApiKey(c,a.ctx,key.id));
 expect((await app.request('/api/v1/parties',{headers})).status).toBe(401);
});
it('API enquiry retries create one business result; altered payloads conflict and cookies cannot authorize mutations',async()=>{
 const t=await newTenant(db),app=buildApp(db),key=await db.tenant(t.tenantId,c=>createApiKey(c,t.ctx,'Intake',['enquiries:write'],30));
 const headers={authorization:`Bearer ${key.token}`,'Content-Type':'application/json','Idempotency-Key':'customer-source-1'};
 const body=JSON.stringify({mode:'air',origin:'DXB',destination:'LHR',cargo_desc:'Parts',tenant_id:'untrusted-other-tenant'});
 const one=await app.request('/api/v1/enquiries',{method:'POST',headers,body}),two=await app.request('/api/v1/enquiries',{method:'POST',headers,body});
 expect(one.status).toBe(201);expect(two.status).toBe(201);
 expect((await one.json() as any).data.id).toBe((await two.json() as any).data.id);
 expect((await app.request('/api/v1/enquiries',{method:'POST',headers,body:body.replace('Parts','Cars')})).status).toBe(409);
 expect((await db.query(`SELECT id FROM enquiries WHERE tenant_id=$1`,[t.tenantId])).rows).toHaveLength(1);
 expect((await app.request('/api/v1/enquiries',{method:'POST',headers:{'Content-Type':'application/json'},body})).status).toBe(401);
});
it('API keys inherit current roles; deactivating membership removes access',async()=>{
 const t=await newTenant(db),key=await db.tenant(t.tenantId,c=>createApiKey(c,t.ctx,'Finance',['invoices:read'],30)),app=buildApp(db);
 await db.query(`UPDATE memberships SET roles='{sales}' WHERE tenant_id=$1 AND user_id=$2`,[t.tenantId,t.userId]);
 expect((await app.request('/api/v1/invoices',{headers:{authorization:`Bearer ${key.token}`}})).status).toBe(403);
 await db.query(`UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2`,[t.tenantId,t.userId]);
 expect((await app.request('/api/v1/parties',{headers:{authorization:`Bearer ${key.token}`}})).status).toBe(401);
});
it('privacy requests deduplicate, enforce role/tenant boundaries and require an actual reviewed erasure process',async()=>{
 const a=await newTenant(db),b=await newTenant(db);
 const id=await db.tenant(a.tenantId,c=>requestDataAction(c,a.ctx,'deletion','Delete the workspace after reviewing retention and legal holds.'));
 expect(await db.tenant(a.tenantId,c=>requestDataAction(c,a.ctx,'deletion','Duplicate request'))).toBe(id);
 expect((await db.tenant(b.tenantId,c=>c.query(`SELECT * FROM data_requests WHERE id=$1`,[id]))).rows).toHaveLength(0);
 await expect(db.tenant(a.tenantId,c=>requestDataAction(c,ctxFor(a.userId,a.tenantId,['sales']),'access','Need an export'))).rejects.toThrow(/role/);
 await decideDataRequest(db,a.userId,id,'reviewing','Identity and retention review opened');await decideDataRequest(db,a.userId,id,'approved','Owner confirmed; retention schedule and holds documented');
 await expect(decideDataRequest(db,a.userId,id,'completed','Pretend completed')).rejects.toThrow(/erasure/);
});
it('Zoho settings are tenant-scoped and encrypted; invalid tax IDs and arbitrary data-centre hosts are rejected',async()=>{
 const t=await newTenant(db),settings={region:'com',client_id:'fixture-client',client_secret:'fixture-secret',refresh_token:'fixture-refresh',organization_id:'123',currency_ids:'{"AED":"42"}',tax_ids:'{"SR5":"99"}'};
 await db.tenant(t.tenantId,c=>saveZohoConnection(c,t.ctx,settings));
 const row=(await db.query<any>(`SELECT config FROM accounting_connections WHERE tenant_id=$1`,[t.tenantId])).rows[0];
 expect(JSON.stringify(row.config)).not.toContain('fixture-refresh');expect(decryptSecret(row.config.encrypted)).toContain('fixture-refresh');
 await expect(db.tenant(t.tenantId,c=>saveZohoConnection(c,t.ctx,{...settings,region:'evil.example'}))).rejects.toThrow(/region/);
 await expect(db.tenant(t.tenantId,c=>saveZohoConnection(c,t.ctx,{...settings,tax_ids:'{"SR5":"arbitrary"}'}))).rejects.toThrow(/numeric/);
});
it('Zoho finds the existing invoice after an ambiguous timeout and verifies amount/currency before accepting it',async()=>{
 const request=vi.fn<typeof fetch>().mockResolvedValueOnce(json({access_token:'fixture',expires_in:3600})).mockResolvedValueOnce(json({code:0,invoices:[{invoice_id:'11',reference_number:'LBT-ref'}]})).mockResolvedValueOnce(json({code:0,invoice:{invoice_id:'11',currency_code:'AED',total:105}}));
 const adapter=zohoBooksAdapter({region:'com',clientId:'id',clientSecret:'secret',refreshToken:'token',organizationId:'1',currencyIds:{AED:'2'},taxIds:{SR5:'3'}},request);
 const inv={reference:'LBT-ref',customer:'Customer',issuedAt:'2026-10-11',dueAt:'2026-11-11',currency:'AED',subtotalMinor:10000,taxMinor:500,totalMinor:10500,lines:[]};
 expect(await adapter.find('LBT-ref',inv)).toEqual({externalId:'11'});expect(request.mock.calls.every(([,i])=>i?.method!=='POST'||i?.body instanceof URLSearchParams)).toBe(true);
 const mismatch=vi.fn<typeof fetch>().mockResolvedValueOnce(json({access_token:'fixture',expires_in:3600})).mockResolvedValueOnce(json({code:0,invoices:[{invoice_id:'11',reference_number:'LBT-ref'}]})).mockResolvedValueOnce(json({code:0,invoice:{invoice_id:'11',currency_code:'USD',total:105}}));
 await expect(zohoBooksAdapter({region:'com',clientId:'id',clientSecret:'secret',refreshToken:'token',organizationId:'1',currencyIds:{AED:'2'},taxIds:{SR5:'3'}},mismatch).find('LBT-ref',inv)).rejects.toThrow(/amount\/currency/);
});
it('paid provisioning creates one bounded setup order; scheduled technician work requires independent customer acceptance',async()=>{
 const t=await newTenant(db);await db.query(`UPDATE entities SET legal_name='Customer LLC' WHERE tenant_id=$1`,[t.tenantId]);await payFor(db,t);
 const rows=(await db.query<any>(`SELECT * FROM setup_orders WHERE tenant_id=$1`,[t.tenantId])).rows;expect(rows).toHaveLength(1);const id=rows[0].id;
 const staff=await createStaff(db,`tech-${id}@example.com`,'Technician','safe technician password','engineer');
 await scheduleSetup(db,staff.userId,id,staff.userId,new Date(Date.now()+60000).toISOString(),'Remote import and training; owner reviews invoice workflow.');
 await expect(submitSetupEvidence(db,staff.userId,id,'Acceptance evidence','')).rejects.toThrow(/window/);
 await db.query(`UPDATE setup_orders SET appointment_at=now()-interval '1 minute' WHERE id=$1`,[id]);
 await submitSetupEvidence(db,staff.userId,id,'Owner created real quote, converted job, recorded supplier cost and issued invoice.','');
 await db.tenant(t.tenantId,c=>acceptSetup(c,t.ctx,id));
 expect((await db.query<any>(`SELECT status,accepted_by FROM setup_orders WHERE id=$1`,[id])).rows[0]).toMatchObject({status:'accepted',accepted_by:t.userId});
 expect((await buildApp(db).request('/admin/service')).status).toBe(302);
});
it('an inviter cannot use an existing account invitation to bypass its password or overwrite an existing membership',async()=>{
 const a=await newTenant(db),b=await newTenant(db),email=(await db.query<any>(`SELECT email FROM users WHERE id=$1`,[b.userId])).rows[0].email;
 const token=await db.tenant(a.tenantId,c=>invite(c,a.ctx,{email,roles:['sales']}));
 await expect(acceptInvite(db,token,{name:'Untrusted inviter',password:'wrong password'})).rejects.toThrow(/existing account password/);
 expect((await db.query(`SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2`,[a.tenantId,b.userId])).rows).toHaveLength(0);
 await acceptInvite(db,token,{name:'Owner',password:'correct horse battery'});
 await expect(acceptInvite(db,token,{name:'Owner',password:'correct horse battery'})).rejects.toThrow(/invalid|accepted|expired/);
 await expect(db.tenant(a.tenantId,c=>invite(c,a.ctx,{email,roles:['owner']}))).rejects.toThrow(/already belongs/);
});
it('HR cannot grant owner permissions or mix portal and staff seats to evade quotas',async()=>{
 const t=await newTenant(db);
 await expect(db.tenant(t.tenantId,c=>setRoles(c,ctxFor(t.userId,t.tenantId,['hr']),t.userId,['owner']))).rejects.toThrow(/Only an owner/);
 await expect(db.tenant(t.tenantId,c=>invite(c,t.ctx,{email:'mixed@example.test',roles:['portal','finance'],party_id:t.tenantId}))).rejects.toThrow(/cannot be combined/);
});
