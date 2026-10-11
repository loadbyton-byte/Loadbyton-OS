import {beforeAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Db,Conn} from '../src/db/client.js';
import {freshDb,newTenant,ctxFor} from './helpers.js';
import {createParty} from '../src/ops/crm.js';
import {createVehicle,createDriver,createOrder,createTrip,dispatchTrip,applyDriverEvent,decideExpense,getTrip,tripProfit} from '../src/ops/transport.js';
import {invite,acceptInvite} from '../src/ops/team.js';
import {uploadDocument} from '../src/ops/documents.js';
import {linkExpenseReceipt,uploadExpenseReceipt} from '../src/ops/expense-receipts.js';
import {verifyInvariants} from '../src/platform/invariants.js';
import {buildApp} from '../src/app.js';
import {newSession} from '../src/platform/auth.js';
import {SESSION_COOKIE} from '../src/web/mw.js';
let db:Db;beforeAll(async()=>{db=await freshDb();});
async function fixture(){
 const t=await newTenant(db,undefined,['road-transport']),run=<T>(work:(c:Conn)=>Promise<T>)=>db.tenant(t.tenantId,work);
 const f=await run(async c=>{const party=await createParty(c,t.ctx,{kind:'customer',name:'Receipt fixture customer'}),vehicle=await createVehicle(c,t.ctx,{reg_no:'DXB FIX',capacity_kg:5000}),driver=await createDriver(c,t.ctx,{name:'Fixture driver'}),token=await invite(c,t.ctx,{email:`receipt-driver-${randomUUID()}@example.com`,roles:['driver'],driver_id:driver});const order=await createOrder(c,t.ctx,{party_id:party,pickup_address:'Fixture pickup',delivery_address:'Fixture delivery',cargo_desc:'Fixture goods',weight_kg:100,rate:'500'}),trip=await createTrip(c,t.ctx,{planned_start:new Date(Date.now()+3600000).toISOString(),planned_end:new Date(Date.now()+5*3600000).toISOString(),vehicle_id:vehicle,driver_id:driver,order_ids:[order.id]});return {trip,driver,token};});
 const person=await acceptInvite(db,f.token,{name:'Fixture driver',password:'receipt-driver-password'}),driverCtx={...ctxFor(person.userId,t.tenantId,['driver']),driverId:f.driver},ev={client_event_id:randomUUID(),trip_id:f.trip.id,leg_id:null,kind:'expense' as const,device_time:new Date().toISOString(),payload:{kind:'fuel',amount:'50',note:'Actual fixture receipt required'}};
 await run(c=>dispatchTrip(c,t.ctx,f.trip.id));await run(c=>applyDriverEvent(c,driverCtx,ev));const expense=(await run(c=>getTrip(c,f.trip.id))).expenses[0];return {t,run,driverCtx,expense,...f};
}
const file={filename:'receipt.pdf',issuer:'Fixture fuel station',data:Buffer.from('%PDF-1.4 expense receipt fixture')};
it('requires an issued trip receipt, preserves immutable versions and freezes the approved source after independent review',async()=>{
 const s=await fixture();await expect(s.run(c=>decideExpense(c,s.t.ctx,s.expense.id,true))).rejects.toThrow(/issued expense receipt/);const ref=randomUUID(),first=await s.run(c=>uploadExpenseReceipt(c,s.driverCtx,s.expense.id,file,ref));expect(await s.run(c=>uploadExpenseReceipt(c,s.driverCtx,s.expense.id,file,ref))).toBe(first);
 await expect(s.run(c=>uploadExpenseReceipt(c,s.driverCtx,s.expense.id,{...file,data:Buffer.from('%PDF-1.4 changed')},ref))).rejects.toThrow(/different evidence/);
 const second=await s.run(c=>uploadExpenseReceipt(c,s.driverCtx,s.expense.id,{...file,issuer:'Fixture corrected merchant receipt'},randomUUID()));expect(second).not.toBe(first);await s.run(c=>decideExpense(c,s.t.ctx,s.expense.id,true));
 const x=(await s.run(c=>getTrip(c,s.trip.id))).expenses[0];expect(x.approved_receipt_id).toBe(second);expect((await s.run(c=>tripProfit(c,s.trip.id))).approvedExpenses).toBe(5000);
 await expect(s.run(c=>uploadExpenseReceipt(c,s.driverCtx,s.expense.id,file,randomUUID()))).rejects.toThrow(/already decided/);await expect(db.query(`UPDATE trip_expenses SET amount_minor=1 WHERE id=$1`,[s.expense.id])).rejects.toThrow(/immutable/);await expect(db.query(`DELETE FROM trip_expense_receipts WHERE id=$1`,[second])).rejects.toThrow(/immutable/);expect(await verifyInvariants(db)).toEqual([]);
});
it('does not fall back to an older receipt when the latest source is held, and serializes receipt versions in one transaction',async()=>{
 const s=await fixture();const docs=await s.run(async c=>{const a=await uploadExpenseReceipt(c,s.driverCtx,s.expense.id,file,randomUUID()),b=await uploadExpenseReceipt(c,s.driverCtx,s.expense.id,{...file,issuer:'Fixture replacement'},randomUUID());return {a,b};});
 const r=(await db.query<any>(`SELECT document_id,version FROM trip_expense_receipts WHERE id=$1`,[docs.b])).rows[0];expect(r.version).toBe(2);await db.query(`UPDATE documents SET hold=true WHERE id=$1`,[r.document_id]);await expect(s.run(c=>decideExpense(c,s.t.ctx,s.expense.id,true))).rejects.toThrow(/current receipt is unavailable/);expect((await s.run(c=>tripProfit(c,s.trip.id))).approvedExpenses).toBe(0);
 await expect(db.query(`UPDATE trip_expenses SET status='approved',decided_by=$2,approved_receipt_id=$3 WHERE id=$1`,[s.expense.id,s.t.userId,docs.a])).rejects.toThrow(/latest receipt/);await s.run(c=>decideExpense(c,s.t.ctx,s.expense.id,false));expect((await s.run(c=>getTrip(c,s.trip.id))).expenses[0].status).toBe('rejected');
});
it('rejects draft/wrong-trip receipts, another assigned driver, foreign companies, restricted and support sessions',async()=>{
 const s=await fixture(),other=await newTenant(db);const draft=await s.run(c=>uploadDocument(c,s.t.ctx,{trip_id:s.trip.id,kind:'other',title:'Draft source',filename:file.filename,data:file.data})),unrelated=await s.run(c=>uploadDocument(c,s.t.ctx,{kind:'other',issuer:'Fixture supplier',title:'Unrelated source',filename:file.filename,data:file.data}));
 for(const doc of [draft,unrelated])await expect(s.run(c=>linkExpenseReceipt(c,s.t.ctx,s.expense.id,doc,randomUUID()))).rejects.toThrow(/Issued receipt for this trip/);
 await expect(s.run(c=>uploadExpenseReceipt(c,{...s.driverCtx,driverId:randomUUID()},s.expense.id,file,randomUUID()))).rejects.toThrow(/not found/);await expect(db.tenant(other.tenantId,c=>uploadExpenseReceipt(c,other.ctx,s.expense.id,file,randomUUID()))).rejects.toThrow(/not selected/);
 await expect(s.run(c=>uploadExpenseReceipt(c,{...s.t.ctx,readOnly:true,supportStaffId:other.userId},s.expense.id,file,randomUUID()))).rejects.toThrow(/read-only/);await db.query(`UPDATE subscriptions SET status='restricted' WHERE tenant_id=$1`,[s.t.tenantId]);await expect(s.run(c=>uploadExpenseReceipt(c,s.driverCtx,s.expense.id,file,randomUUID()))).rejects.toThrow(/read-only/);
});
it('refuses self approval even when the recording driver also has owner rights',async()=>{
 const s=await fixture();await s.run(c=>uploadExpenseReceipt(c,s.driverCtx,s.expense.id,file,randomUUID()));await db.query(`UPDATE memberships SET roles=ARRAY['owner','driver'] WHERE tenant_id=$1 AND user_id=$2`,[s.t.tenantId,s.driverCtx.userId]);const ownerDriver={...ctxFor(s.driverCtx.userId,s.t.tenantId,['owner','driver']),driverId:s.driverCtx.driverId};await expect(s.run(c=>decideExpense(c,ownerDriver,s.expense.id,true))).rejects.toThrow(/person who recorded/);await s.run(c=>decideExpense(c,s.t.ctx,s.expense.id,true));
});
it('restricts limited-driver downloads to their assigned trip and shows the receipt/approval boundary in both interfaces',async()=>{
 const s=await fixture();await s.run(c=>uploadExpenseReceipt(c,s.driverCtx,s.expense.id,file,randomUUID()));const own=(await s.run(c=>getTrip(c,s.trip.id))).expenses[0].receipt_document_id,other=await s.run(c=>uploadDocument(c,s.t.ctx,{kind:'other',issuer:'Fixture office',title:'Unrelated confidential fixture',filename:file.filename,data:file.data}));
 const app=buildApp(db),driverSession=await newSession(db,s.driverCtx.userId,s.t.tenantId),office=await newSession(db,s.t.userId,s.t.tenantId),headers={cookie:`${SESSION_COOKIE}=${driverSession.token}`};
 expect((await app.request(`/app/documents/${other}/download`,{headers})).status).toBe(404);expect((await app.request(`/app/documents/${own}/download`,{headers})).status).toBe(302);
 const page=await app.request(`/app/driver/trips/${s.trip.id}`,{headers});expect(page.status).toBe(200);expect(await page.text()).toContain('Expense receipts');const desk=await app.request(`/app/transport/trips/${s.trip.id}`,{headers:{cookie:`${SESSION_COOKIE}=${office.token}`}});expect(desk.status).toBe(200);expect(await desk.text()).toContain('Receipt source');
});
