import {beforeAll,it,expect} from 'vitest';
import type {Db,Conn} from '../src/db/client.js';
import {freshDb,newTenant,ctxFor,payFor} from './helpers.js';
import {setSectors} from '../src/platform/tenants.js';
import {createParty} from '../src/ops/crm.js';
import {createLocation,createSku,createInbound,getInbound,receiveInbound,createOrder,pickOrder,packScan,shipOrder,getFulfilOrder} from '../src/ops/fulfilment.js';
import {handoffFulfilment} from '../src/ops/fulfilment-delivery.js';
import {getParcel} from '../src/ops/delivery.js';
import {verifyInvariants} from '../src/platform/invariants.js';
import {buildApp} from '../src/app.js';
import {newSession} from '../src/platform/auth.js';
import {SESSION_COOKIE} from '../src/web/mw.js';
let db:Db;beforeAll(async()=>{db=await freshDb();});
const instruction={fee:'15.00',cod:'100.00',tax_code:'SR5',evidence:'Fixture merchant-approved delivery and COD instruction'};
async function prepared(opts:{both?:boolean;shipped?:boolean;carrier?:string;country?:string;phone?:string}={}){
 const t=await newTenant(db,undefined,['ecommerce-fulfilment']),run=<T>(fn:(c:Conn)=>Promise<T>)=>db.tenant(t.tenantId,fn);
 if(opts.both!==false){await payFor(db,t,'operations');await run(c=>setSectors(c,t.tenantId,['ecommerce-fulfilment','courier-last-mile'],t.userId));}
 const d=await run(async c=>{
  const merchant=await createParty(c,t.ctx,{kind:'customer',name:'Fixture merchant'}),loc=await createLocation(c,t.ctx,{code:'BIN-A'});
  const sku=await createSku(c,t.ctx,{party_id:merchant,code:'SKU-1',name:'Fixture product'}),inbound=await createInbound(c,t.ctx,{party_id:merchant,lines:'SKU-1, 2'}),source=await getInbound(c,inbound.id);
  await receiveInbound(c,t.ctx,inbound.id,{line_id:source.lines[0].id,good:2,damaged:0,location_id:loc,token:'fixture-receipt'});
  const order=await createOrder(c,t.ctx,{party_id:merchant,external_ref:'MERCHANT-ORDER-1',ship_to_name:'Fixture recipient',ship_to_phone:opts.phone??'0501234567',ship_to_address:'Marina Walk 12',ship_to_city:'Dubai',ship_to_country:opts.country??'AE',lines:'SKU-1, 1'});
  await pickOrder(c,t.ctx,order.id);await packScan(c,t.ctx,order.id,{code:'SKU-1',qty:1});
  if(opts.shipped!==false)await shipOrder(c,t.ctx,order.id,{carrier:opts.carrier??'Own fleet',tracking_no:'SHIPMENT-1'});
  return {merchant,sku,order};
 });return {t,run,...d};
}
it('creates one linked parcel for a shipped own-fleet order without another stock movement or cash entry',async()=>{
 const {t,run,merchant,order}=await prepared(),before=await run(c=>c.query(`SELECT * FROM stock_levels ORDER BY sku_id,location_id`)),moves=await run(c=>c.query(`SELECT id FROM stock_movements`));
 const ids=await Promise.all([1,2,3].map(()=>run(c=>handoffFulfilment(c,t.ctx,order.id,instruction))));expect(new Set(ids.map(p=>p.id)).size).toBe(1);
 const detail=await run(c=>getParcel(c,ids[0].id));expect(detail.p).toMatchObject({party_id:merchant,fulfilment_order_id:order.id,fulfilment_tracking:'SHIPMENT-1',recipient_phone:'0501234567',address:'Marina Walk 12, Dubai, AE',status:'ready'});
 expect(Number(detail.p.fee_minor)).toBe(1500);expect(Number(detail.p.cod_expected_minor)).toBe(10000);expect(detail.cash).toBeUndefined();expect(detail.attempts).toHaveLength(0);
 expect((await run(c=>c.query(`SELECT * FROM stock_levels ORDER BY sku_id,location_id`))).rows).toEqual(before.rows);expect((await run(c=>c.query(`SELECT id FROM stock_movements`))).rows).toHaveLength(moves.rows.length);
 expect((await run(c=>getFulfilOrder(c,order.id))).shipment.delivery_parcel_id).toBe(ids[0].id);
 expect(Number((await run(c=>c.query<any>(`SELECT used FROM usage_counters WHERE key='delivery_parcels_per_month'`))).rows[0].used)).toBe(1);
 expect(await verifyInvariants(db)).toEqual([]);
 await expect(run(c=>handoffFulfilment(c,t.ctx,order.id,{...instruction,cod:'200'}))).rejects.toThrow(/different/);
 await expect(db.query(`UPDATE fulfil_shipments SET delivery_parcel_id=NULL WHERE order_id=$1`,[order.id])).rejects.toThrow(/immutable/);
 await expect(db.query(`UPDATE fulfil_shipments SET tracking_no='altered' WHERE order_id=$1`,[order.id])).rejects.toThrow(/immutable/);
 await expect(db.query(`DELETE FROM fulfil_shipments WHERE order_id=$1`,[order.id])).rejects.toThrow(/immutable/);
});
it('requires both sectors, committed picking/packing, internal carrier and UAE domestic delivery',async()=>{
 const one=await prepared({both:false});await expect(one.run(c=>handoffFulfilment(c,one.t.ctx,one.order.id,instruction))).rejects.toThrow(/both/);
 const packed=await prepared({shipped:false});await expect(packed.run(c=>handoffFulfilment(c,packed.t.ctx,packed.order.id,instruction))).rejects.toThrow(/shipment/);
 const external=await prepared({carrier:'Aramex'});await expect(external.run(c=>handoffFulfilment(c,external.t.ctx,external.order.id,instruction))).rejects.toThrow(/Own fleet/);
 const overseas=await prepared({country:'IN'});await expect(overseas.run(c=>handoffFulfilment(c,overseas.t.ctx,overseas.order.id,instruction))).rejects.toThrow(/domestic/);
});
it('fences tenants, roles and restricted access; quota failure leaves the source unlinked and retries safe',async()=>{
 const {t,run,order}=await prepared(),other=await newTenant(db);await payFor(db,other,'operations');await db.tenant(other.tenantId,c=>setSectors(c,other.tenantId,['ecommerce-fulfilment','courier-last-mile'],other.userId));
 await expect(db.tenant(other.tenantId,c=>handoffFulfilment(c,other.ctx,order.id,instruction))).rejects.toThrow(/not found/);
 await expect(run(c=>handoffFulfilment(c,ctxFor(t.userId,t.tenantId,['warehouse']),order.id,instruction))).rejects.toThrow(/role/);
 await expect(run(c=>handoffFulfilment(c,{...t.ctx,readOnly:true},order.id,instruction))).rejects.toThrow(/read-only/);
 await run(c=>c.query(`INSERT INTO entitlements(tenant_id,key,int_limit,source) VALUES($1,'delivery_parcels_per_month',0,'test-zero')`,[t.tenantId]));
 await expect(run(c=>handoffFulfilment(c,t.ctx,order.id,instruction))).rejects.toThrow(/allowance|allows|limit/);
 expect((await run(c=>getFulfilOrder(c,order.id))).shipment.delivery_parcel_id).toBeNull();expect((await run(c=>c.query(`SELECT id FROM delivery_parcels`))).rows).toHaveLength(0);
 await run(c=>c.query(`INSERT INTO entitlements(tenant_id,key,int_limit,source) VALUES($1,'delivery_parcels_per_month',10,'test-restored')`,[t.tenantId]));
 await expect(run(c=>handoffFulfilment(c,t.ctx,order.id,{...instruction,evidence:''}))).rejects.toThrow(/evidence/);
 const parcel=await run(c=>handoffFulfilment(c,t.ctx,order.id,instruction));expect(parcel.id).toBeTruthy();
 await db.query(`UPDATE subscriptions SET status='restricted' WHERE tenant_id=$1`,[t.tenantId]);await expect(run(c=>handoffFulfilment(c,t.ctx,order.id,instruction))).rejects.toThrow(/read-only/);
});
it('renders the handover and reciprocal source links and preserves an explicit supplemental recipient phone',async()=>{
 const {t,run,order}=await prepared({phone:''}),app=buildApp(db),session=await newSession(db,t.userId,t.tenantId),headers={cookie:`${SESSION_COOKIE}=${session.token}`};
 const before=await app.request(`/app/fulfilment/orders/${order.id}`,{headers});expect(before.status).toBe(200);expect(await before.text()).toContain('Merchant fee/COD instruction');
 await expect(run(c=>handoffFulfilment(c,t.ctx,order.id,instruction))).rejects.toThrow(/Phone|phone/);
 const parcel=await run(c=>handoffFulfilment(c,t.ctx,order.id,{...instruction,recipient_phone:'0507654321'}));
 const after=await app.request(`/app/fulfilment/orders/${order.id}`,{headers});expect(await after.text()).toContain(`/app/delivery/parcels/${parcel.id}`);
 const target=await app.request(`/app/delivery/parcels/${parcel.id}`,{headers});expect(target.status).toBe(200);expect(await target.text()).toContain(`/app/fulfilment/orders/${order.id}`);
 expect((await run(c=>getParcel(c,parcel.id))).p.recipient_phone).toBe('0507654321');expect(await verifyInvariants(db)).toEqual([]);
});
