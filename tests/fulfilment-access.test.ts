import {beforeAll,it,expect} from 'vitest';
import type {Db,Conn} from '../src/db/client.js';
import {freshDb,newTenant,ctxFor} from './helpers.js';
import {createParty} from '../src/ops/crm.js';
import {listFulfilOrders,getFulfilOrder,listInbound,listReturns} from '../src/ops/fulfilment.js';
import {exportTenantData} from '../src/ops/exporter.js';
import {buildApp} from '../src/app.js';
import {newSession} from '../src/platform/auth.js';
import {SESSION_COOKIE} from '../src/web/mw.js';
let db:Db;beforeAll(async()=>{db=await freshDb();});
async function fixture(count=1){
 const t=await newTenant(db,undefined,['ecommerce-fulfilment']),run=<T>(fn:(c:Conn)=>Promise<T>)=>db.tenant(t.tenantId,fn),party=await run(c=>createParty(c,t.ctx,{kind:'customer',name:'Fixture merchant'}));
 await run(c=>c.query(`INSERT INTO fulfil_orders(tenant_id,no,party_id,external_ref,ship_to_name,ship_to_phone,ship_to_address) SELECT $1,'FO-'||n,$2,'REF-'||n,'PrivateRecipientMarker','0509876543','PrivateStreetMarker' FROM generate_series(1,$3::int) n`,[t.tenantId,party,count]));
 const orders=(await run(c=>c.query<any>(`SELECT * FROM fulfil_orders ORDER BY no`))).rows;return {t,run,party,orders};
}
it('restricts recipient contacts in records, name searches and exports to fulfilment operators',async()=>{
 const {t,run,orders}=await fixture(),finance=ctxFor(t.userId,t.tenantId,['finance']);
 expect((await run(c=>getFulfilOrder(c,orders[0].id,finance))).order).toMatchObject({ship_to_name:'Restricted recipient',ship_to_phone:null,ship_to_address:null});
 expect((await run(c=>getFulfilOrder(c,orders[0].id,t.ctx))).order.ship_to_phone).toBe('0509876543');
 expect(await run(c=>listFulfilOrders(c,{ctx:finance,q:'PrivateRecipientMarker'}))).toEqual([]);expect(await run(c=>listFulfilOrders(c,{ctx:t.ctx,q:'PrivateRecipientMarker'}))).toHaveLength(1);
 const exported=await run(c=>exportTenantData(c,finance));expect(JSON.stringify(exported.fulfil_orders)).not.toContain('PrivateRecipientMarker');expect(JSON.stringify(exported.fulfil_orders)).not.toContain('PrivateStreetMarker');
 const support={...t.ctx,readOnly:true,supportStaffId:t.userId};expect((await run(c=>getFulfilOrder(c,orders[0].id,support))).order.ship_to_address).toBeNull();
});
it('keeps merchant visibility within the bound party and paginates all three record lists with stable ordering',async()=>{
 const {t,run,party,orders}=await fixture(55),other=await run(c=>createParty(c,t.ctx,{kind:'customer',name:'Another merchant'}));
 await run(c=>c.query(`INSERT INTO fulfil_orders(tenant_id,no,party_id,external_ref,ship_to_name,ship_to_address) VALUES($1,'OTHER',$2,'OTHER','OtherPrivateRecipient','Other address')`,[t.tenantId,other]));
 const portal={...ctxFor(t.userId,t.tenantId,['portal']),partyId:party},first=await run(c=>listFulfilOrders(c,{ctx:portal,page:1})),second=await run(c=>listFulfilOrders(c,{ctx:portal,page:2}));
 expect(first).toHaveLength(51);expect(second).toHaveLength(5);expect(new Set([...first.slice(0,50),...second].map(r=>r.id)).size).toBe(55);expect(first.every(r=>r.party_id===party&&r.ship_to_name==='PrivateRecipientMarker')).toBe(true);
 expect(await run(c=>listFulfilOrders(c,{ctx:portal,partyId:other,q:'OtherPrivateRecipient'}))).toEqual([]);
 const otherId=(await run(c=>c.query<any>(`SELECT id FROM fulfil_orders WHERE party_id=$1`,[other]))).rows[0].id;await expect(run(c=>getFulfilOrder(c,otherId,portal))).rejects.toThrow(/not found/);
 await run(c=>c.query(`INSERT INTO inbound_shipments(tenant_id,no,party_id) SELECT $1,'IN-'||n,$2 FROM generate_series(1,55) n`,[t.tenantId,party]));
 await run(c=>c.query(`INSERT INTO fulfil_returns(tenant_id,no,party_id,reason) SELECT $1,'RT-'||n,$2,'Fixture reason' FROM generate_series(1,55) n`,[t.tenantId,party]));
 for(const listing of [listInbound,listReturns]){const a=await run(c=>listing(c,party,1)),b=await run(c=>listing(c,party,2));expect(a).toHaveLength(51);expect(b).toHaveLength(5);expect(new Set([...a.slice(0,50),...b].map(r=>r.id)).size).toBe(55);}
 expect((await run(c=>listFulfilOrders(c,{ctx:t.ctx,page:-5}))).map(r=>r.id)).toEqual((await run(c=>listFulfilOrders(c,{ctx:t.ctx,page:1}))).map(r=>r.id));
 expect(orders).toHaveLength(55);
});
it('does not send private recipient fields in finance HTML or packing slips and renders navigation beyond the first page',async()=>{
 const {t,run,orders}=await fixture(55),user=await newTenant(db);await db.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES($1,$2,ARRAY['finance'])`,[t.tenantId,user.userId]);
 const app=buildApp(db),s=await newSession(db,user.userId,t.tenantId),headers={cookie:`${SESSION_COOKIE}=${s.token}`};
 for(const path of ['/app/fulfilment/orders',`/app/fulfilment/orders/${orders[0].id}`,`/app/fulfilment/orders/${orders[0].id}/slip`]){const r=await app.request(path,{headers});expect(r.status).toBe(200);const html=await r.text();for(const secret of ['PrivateRecipientMarker','0509876543','PrivateStreetMarker'])expect(html).not.toContain(secret);}
 const page=await app.request('/app/fulfilment/orders',{headers});expect(await page.text()).toContain('page=2');const next=await app.request('/app/fulfilment/orders?page=2',{headers});expect(next.status).toBe(200);expect(await next.text()).toContain('Previous');
 const visible=await run(c=>getFulfilOrder(c,orders[0].id,t.ctx));expect(visible.order.ship_to_address).toBe('PrivateStreetMarker');
});
