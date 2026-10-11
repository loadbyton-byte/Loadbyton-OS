import type {Conn} from '../db/client.js';
import {actorOf,require,type Ctx} from '../lib/perms.js';
import {audit} from '../lib/audit.js';
import {badRequest,forbidden,HttpError,sha256} from '../lib/util.js';
import {assertWritable} from '../platform/entitlements.js';
import {must,recordId,reqStr} from './common.js';
import {storeDocument} from './documents.js';
async function expense(c:Conn,ctx:Ctx,id:string){
 if(ctx.perms.has('driver.act')&&!ctx.perms.has('read'))require(ctx,'driver.act');else require(ctx,ctx.perms.has('doc.write')?'doc.write':'transport.expense');await assertWritable(c,ctx.tenantId);
 if(!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='road-transport'`)).rows.length)throw forbidden('Road transport is not selected.');
 const x=await must(c.query<any>(`SELECT x.*,t.driver_id FROM trip_expenses x JOIN trips t ON t.id=x.trip_id WHERE x.id=$1 FOR UPDATE OF x`,[recordId(id,'Expense')]),'Expense');
 if(!ctx.perms.has('read')&&(!ctx.driverId||x.driver_id!==ctx.driverId||x.recorded_by!==ctx.userId))throw new HttpError(404,'Expense not found');return x;
}
export async function linkExpenseReceipt(c:Conn,ctx:Ctx,expenseId:string,documentId:string,reference:string){
 const x=await expense(c,ctx,expenseId),docId=recordId(documentId,'Receipt document'),ref=recordId(reference,'Receipt reference');
 const old=(await c.query<any>(`SELECT id,document_id FROM trip_expense_receipts WHERE expense_id=$1 AND reference=$2`,[x.id,ref])).rows[0];if(old){if(old.document_id!==docId)throw new HttpError(409,'Receipt reference belongs to different evidence.');return old.id;}
 if(x.status!=='recorded')throw badRequest('Decided expenses retain their approved receipt; no replacement is allowed.');
 await must(c.query(`SELECT id FROM documents WHERE id=$1 AND trip_id=$2 AND status='issued' AND NOT hold AND kind IN ('supplier_invoice','other')`,[docId,x.trip_id]),'Issued receipt for this trip');
 const id=(await c.query<any>(`INSERT INTO trip_expense_receipts(tenant_id,expense_id,document_id,reference,linked_by,version) VALUES($1,$2,$3,$4,$5,(SELECT coalesce(max(version),0)+1 FROM trip_expense_receipts WHERE expense_id=$2)) RETURNING id`,[ctx.tenantId,x.id,docId,ref,ctx.userId])).rows[0].id;
 await audit(c,ctx.tenantId,actorOf(ctx),'expense.receipt_linked','trip_expense',x.id,{receipt_id:id,document_id:docId});return id;
}
/** Assigned drivers upload their OWN pending expense evidence when connected. Their identity is preserved;
 * this permission-free storage helper does not grant them general document upload or approval rights. */
export async function uploadExpenseReceipt(c:Conn,ctx:Ctx,expenseId:string,file:{filename:string;data:Buffer;issuer:string},reference:string){
 const x=await expense(c,ctx,expenseId);const ref=recordId(reference,'Receipt reference'),issuer=reqStr(file.issuer,'Actual receipt issuer',200);
 const old=(await c.query<any>(`SELECT r.id,d.sha256,d.issuer FROM trip_expense_receipts r JOIN documents d ON d.id=r.document_id WHERE r.expense_id=$1 AND r.reference=$2`,[x.id,ref])).rows[0];if(old){if(old.sha256!==sha256(file.data)||old.issuer!==issuer)throw new HttpError(409,'Receipt reference belongs to different evidence.');return old.id;}
 if(x.status!=='recorded')throw badRequest('Expense is already decided.');
 const doc=await storeDocument(c,ctx,{trip_id:x.trip_id,kind:'other',title:`Expense receipt ${x.kind}`,issuer,filename:file.filename,data:file.data});return linkExpenseReceipt(c,ctx,x.id,doc,ref);
}
