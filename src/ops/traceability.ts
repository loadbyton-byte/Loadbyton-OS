import type {Conn} from '../db/client.js';
import {require,actorOf,type Ctx} from '../lib/perms.js';
import {audit} from '../lib/audit.js';
import {badRequest,HttpError} from '../lib/util.js';
import {assertWritable} from '../platform/entitlements.js';
import {must,recordId,reqStr,optStr,today} from './common.js';
const warehouseDay=()=>new Date(Date.now()+4*3600000).toISOString().slice(0,10);
import {z} from 'zod';
export async function registerLot(c:Conn,ctx:Ctx,f:Record<string,any>) {
 require(ctx,'wh.write');await assertWritable(c,ctx.tenantId);await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${ctx.tenantId}:wh-stock`]);
 const sku=await must(c.query<any>(`SELECT * FROM wh_skus WHERE id=$1`,[recordId(f.sku_id)]),'SKU'),lot=reqStr(f.lot,'Lot / serial',60).toUpperCase(),serial=optStr(f.serial_ref,120)?.toUpperCase()??null;
 const expires=f.expires_at||null;if(expires&&!z.iso.date().safeParse(expires).success)throw badRequest('Use a valid expiry date');
 if(sku.rotation==='fefo'&&!expires)throw badRequest('FEFO stock needs an expiry date');
 if(sku.tracking==='serial'&&(!serial||lot!==serial))throw badRequest('Use the serial number as both lot identifier and serial reference');
 if(sku.tracking!=='serial'&&serial)throw badRequest('Serial references require a serial-tracked SKU');
 const document=await must(c.query<any>(`SELECT id FROM documents WHERE id=$1 AND status='issued' AND NOT hold`,[recordId(f.document_id)]),'Issued source evidence');
 await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${ctx.tenantId}:lot-registration`]);
 const old=(await c.query<any>(`SELECT * FROM wh_lots WHERE owner_id=$1 AND sku_id=$2 AND lot=$3`,[sku.owner_id,sku.id,lot])).rows[0];
 if(old){if((old.expires_at?new Date(old.expires_at).toISOString().slice(0,10):null)!==expires||old.serial_ref!==serial||old.document_id!==document.id)throw new HttpError(409,'Lot identity already has different source evidence');return old.id;}
 if(serial&&(await c.query(`SELECT id FROM wh_lots WHERE owner_id=$1 AND serial_ref=$2`,[sku.owner_id,serial])).rows.length)throw new HttpError(409,'This owner already registered that serial number');
 const id=(await c.query<any>(`INSERT INTO wh_lots(tenant_id,owner_id,sku_id,lot,expires_at,serial_ref,document_id,hold,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[ctx.tenantId,sku.owner_id,sku.id,lot,expires,serial,document.id,!!expires&&expires<=warehouseDay(),ctx.userId])).rows[0].id;
 await audit(c,ctx.tenantId,actorOf(ctx),'warehouse.lot_registered','wh_lot',id,{lot,expires,serial});return id;
}
export async function holdLot(c:Conn,ctx:Ctx,id:string,hold:boolean,reason:string) {
 require(ctx,'wh.approve');await assertWritable(c,ctx.tenantId);await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${ctx.tenantId}:wh-stock`]);await must(c.query(`UPDATE wh_lots SET hold=$2 WHERE id=$1 RETURNING id`,[recordId(id),hold]),'Lot');await audit(c,ctx.tenantId,actorOf(ctx),hold?'warehouse.lot_held':'warehouse.lot_release_approved','wh_lot',id,{reason:reqStr(reason,'Quality decision evidence',2000)});
}
export async function validateTrackedStock(c:Conn,skuId:string,lot:string,delta:number,kind:string) {
 const sku=await must(c.query<any>(`SELECT * FROM wh_skus WHERE id=$1`,[skuId]),'SKU'),meta=(await c.query<any>(`SELECT m.*,d.status AS document_status,d.hold AS document_hold FROM wh_lots m JOIN documents d ON d.id=m.document_id WHERE m.sku_id=$1 AND m.lot=$2`,[skuId,lot])).rows[0];
 if((sku.tracking!=='none'||sku.rotation==='fefo')&&!meta)throw badRequest('Register issued lot/expiry/serial evidence before moving tracked stock');
 if(sku.tracking==='serial'){
  if(Math.abs(delta)!==1)throw badRequest('Serial-tracked movements contain exactly one unit');
  const held=Number((await c.query<any>(`SELECT coalesce(sum(qty_on_hand),0) n FROM wh_stock WHERE sku_id=$1 AND lot=$2`,[skuId,lot])).rows[0].n);
  if(delta>0&&held+delta>1)throw badRequest('That serial number is already in custody');
 }
 if(kind==='dispatch'&&meta&&(meta.hold||meta.document_hold||meta.document_status!=='issued'||meta.expires_at&&new Date(meta.expires_at).toISOString().slice(0,10)<=warehouseDay()))throw badRequest('Held, expired or unverified stock cannot be dispatched; cancel and re-allocate the order');
 return meta;
}
