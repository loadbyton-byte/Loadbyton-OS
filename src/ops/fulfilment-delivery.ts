import type {Conn} from '../db/client.js';
import {actorOf,require,type Ctx} from '../lib/perms.js';
import {audit} from '../lib/audit.js';
import {badRequest,forbidden,HttpError} from '../lib/util.js';
import {assertWritable} from '../platform/entitlements.js';
import {must,recordId,reqStr} from './common.js';
import {createParcel,deliveryMoney} from './delivery.js';

/** One parcel per committed shipment; inventory remains in the fulfilment ledger and COD remains in Delivery. */
export async function handoffFulfilment(c:Conn,ctx:Ctx,orderId:string,f:Record<string,unknown>){
 require(ctx,'wh.write');require(ctx,'delivery.write');await assertWritable(c,ctx.tenantId);
 for(const sector of ['ecommerce-fulfilment','courier-last-mile'])if(!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector=$1`,[sector])).rows.length)throw forbidden('Select both E-commerce fulfilment and Courier / last mile within the purchased allowance.');
 const order=recordId(orderId,'Fulfilment order');
 await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${ctx.tenantId}:delivery`]);
 const o=await must(c.query<any>(`SELECT * FROM fulfil_orders WHERE id=$1 FOR UPDATE`,[order]),'Fulfilment order');
 if(o.status!=='shipped')throw badRequest('Complete picking, packing and shipment before delivery handover.');
 const s=await must(c.query<any>(`SELECT * FROM fulfil_shipments WHERE order_id=$1 FOR UPDATE`,[order]),'Shipment');
 if(s.carrier!=='Own fleet')throw badRequest('Only Own fleet shipments can be handed to the internal courier workspace.');
 if(String(o.ship_to_country).toUpperCase()!=='AE')throw badRequest('This courier handover supports UAE domestic shipments only.');
 const fee=deliveryMoney(f.fee),cod=deliveryMoney(f.cod??'0'),tax=reqStr(f.tax_code??'SR5','Tax code',20),phone=reqStr(o.ship_to_phone||f.recipient_phone,'Recipient phone',40);
 const evidence=reqStr(f.evidence,'Merchant-approved delivery fee and COD evidence',1000);
 if(s.delivery_parcel_id){
  const p=await must(c.query<any>(`SELECT * FROM delivery_parcels WHERE id=$1`,[s.delivery_parcel_id]),'Linked parcel');
  if(Number(p.fee_minor)!==fee||Number(p.cod_expected_minor)!==cod||p.tax_code!==tax||p.recipient_phone!==phone)throw new HttpError(409,'This shipment already has a parcel with different fee, COD or phone details.');
  return {id:p.id,no:p.no,duplicate:true};
 }
 const result=await createParcel(c,ctx,{party_id:o.party_id,external_ref:`FULFIL:${s.id}`,recipient_name:o.ship_to_name,recipient_phone:phone,address:[o.ship_to_address,o.ship_to_city,o.ship_to_country].filter(Boolean).join(', '),fee:f.fee,cod:f.cod??'0',tax_code:tax});
 await c.query(`UPDATE fulfil_shipments SET delivery_parcel_id=$2 WHERE id=$1`,[s.id,result.id]);
 await audit(c,ctx.tenantId,actorOf(ctx),'fulfilment.delivery_handover','fulfil_order',order,{shipment_id:s.id,parcel_id:result.id,tracking_no:s.tracking_no,merchant_reference:o.external_ref,evidence,fee_minor:fee,cod_expected_minor:cod});
 return result;
}
