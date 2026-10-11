import {z} from 'zod';
import type {Conn} from '../db/client.js';
import {actorOf,require,type Ctx} from '../lib/perms.js';
import {audit} from '../lib/audit.js';
import {badRequest,forbidden,HttpError} from '../lib/util.js';
import {assertWritable} from '../platform/entitlements.js';
import {must,recordId,reqStr} from './common.js';
import {dubaiDay,startCount} from './warehouse.js';

async function gate(c:Conn,ctx:Ctx,write=false){require(ctx,write?'wh.write':'read');if(write)await assertWritable(c,ctx.tenantId);if(!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='contract-warehouse-3pl'`)).rows.length)throw forbidden('Contract warehouse / 3PL is not selected.');}
const lock=(c:Conn,ctx:Ctx)=>c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${ctx.tenantId}:wh-stock`]);
const operator=(c:Conn,id:string)=>must(c.query(`SELECT user_id FROM memberships WHERE user_id=$1 AND active AND roles&&ARRAY['owner','warehouse','coordinator']::text[]`,[id]),'Active count operator');
const fields=z.object({tier:z.enum(['high_value','standard','low_value']),interval_days:z.coerce.number().int().min(1).max(365),next_due:z.iso.date(),valid_until:z.iso.date()});
const day=(d:any)=>typeof d==='string'?d.slice(0,10):new Date(d).toISOString().slice(0,10);

export async function createCountSchedule(c:Conn,ctx:Ctx,f:Record<string,unknown>){
 require(ctx,'wh.approve');await gate(c,ctx);await assertWritable(c,ctx.tenantId);await lock(c,ctx);
 const parsed=fields.safeParse(f);if(!parsed.success)throw badRequest('Choose a value/risk tier, interval of 1–365 days and valid dates.');
 const v=parsed.data;if(v.valid_until<dubaiDay()||v.next_due>v.valid_until)throw badRequest('The reviewed policy must remain valid through its first due day.');
 const warehouse=recordId(f.warehouse_id,'Warehouse'),location=f.location_id?recordId(f.location_id,'Location'):null,counter=recordId(f.counter_id,'Count operator'),doc=recordId(f.document_id,'Policy evidence'),reference=recordId(f.reference,'Schedule reference');
 await must(c.query(`SELECT id FROM warehouses WHERE id=$1 AND active`,[warehouse]),'Active warehouse');if(location)await must(c.query(`SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND active`,[location,warehouse]),'Active location in the selected warehouse');
 await operator(c,counter);await must(c.query(`SELECT id FROM documents WHERE id=$1 AND status='issued' AND NOT hold`,[doc]),'Issued value/risk policy evidence');
 const reviewer=reqStr(f.reviewer,'Policy reviewer',200),scope=reqStr(f.scope,'Reviewed valuation, risk, frequency and scope evidence',2000);
 const previous=(await c.query<any>(`SELECT * FROM wh_count_schedules WHERE reference=$1`,[reference])).rows[0];
 if(previous){if(previous.warehouse_id!==warehouse||previous.location_id!==location||previous.tier!==v.tier||Number(previous.interval_days)!==v.interval_days||day(previous.first_due)!==v.next_due||previous.counter_id!==counter||previous.document_id!==doc||previous.scope!==scope||previous.reviewer!==reviewer||day(previous.valid_until)!==v.valid_until)throw new HttpError(409,'The schedule reference belongs to a different reviewed contract.');return previous.id;}
 if((await c.query(`SELECT id FROM wh_count_schedules WHERE active AND warehouse_id=$1 AND location_id IS NOT DISTINCT FROM $2::uuid`,[warehouse,location])).rows.length)throw badRequest('Disable the existing schedule for this scope before approving a replacement.');
 const r=await c.query<{id:string}>(`INSERT INTO wh_count_schedules(tenant_id,reference,warehouse_id,location_id,tier,interval_days,first_due,next_due,valid_until,counter_id,document_id,reviewer,scope,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,[ctx.tenantId,reference,warehouse,location,v.tier,v.interval_days,v.next_due,v.valid_until,counter,doc,reviewer,scope,ctx.userId]);
 await audit(c,ctx.tenantId,actorOf(ctx),'wh_count.schedule_approved','wh_count_schedule',r.rows[0].id,{tier:v.tier,interval_days:v.interval_days,counter_id:counter,document_id:doc});return r.rows[0].id;
}
export async function disableCountSchedule(c:Conn,ctx:Ctx,id:string,reason:string){require(ctx,'wh.approve');await gate(c,ctx);await assertWritable(c,ctx.tenantId);await lock(c,ctx);const why=reqStr(reason,'Policy replacement/disable reason',1000);await must(c.query(`UPDATE wh_count_schedules SET active=false WHERE id=$1 RETURNING id`,[recordId(id)]),'Count schedule');await audit(c,ctx.tenantId,actorOf(ctx),'wh_count.schedule_disabled','wh_count_schedule',id,{reason:why});}

export async function startScheduledCount(c:Conn,ctx:Ctx,id:string,dueOn:string){
 await gate(c,ctx,true);await lock(c,ctx);const scheduleId=recordId(id,'Count schedule');if(!z.iso.date().safeParse(dueOn).success)throw badRequest('The scheduled due date is invalid.');
 const existing=(await c.query<any>(`SELECT k.id,k.no FROM wh_count_schedule_runs r JOIN wh_counts k ON k.id=r.count_id WHERE r.schedule_id=$1 AND r.due_on=$2`,[scheduleId,dueOn])).rows[0];if(existing)return {...existing,duplicate:true};
 const p=await must(c.query<any>(`SELECT p.* FROM wh_count_schedules p JOIN documents d ON d.id=p.document_id WHERE p.id=$1 AND p.active AND p.valid_until>=current_date AND d.status='issued' AND NOT d.hold FOR UPDATE OF p`,[scheduleId]),'Current issued count schedule');
 const today=dubaiDay();if(day(p.valid_until)<today)throw badRequest('The count policy review has expired.');if(day(p.next_due)!==dueOn)throw new HttpError(409,'The schedule due date changed; refresh before starting a count.');if(dueOn>today)throw badRequest('This count is not due yet.');await operator(c,p.counter_id);
 if(p.location_id)await must(c.query(`SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND active`,[p.location_id,p.warehouse_id]),'Active scheduled location');
 const count=await startCount(c,ctx,{warehouse_id:p.warehouse_id,location_id:p.location_id??undefined});
 await c.query(`UPDATE wh_counts SET assigned_to=$2 WHERE id=$1`,[count.id,p.counter_id]);
 await c.query(`INSERT INTO wh_count_schedule_runs(tenant_id,schedule_id,due_on,count_id,created_by) VALUES($1,$2,$3,$4,$5)`,[ctx.tenantId,scheduleId,dueOn,count.id,ctx.userId]);
 const next=new Date(`${today}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+Number(p.interval_days));await c.query(`UPDATE wh_count_schedules SET next_due=$2 WHERE id=$1`,[scheduleId,next.toISOString().slice(0,10)]);
 await audit(c,ctx.tenantId,actorOf(ctx),'wh_count.scheduled_started','wh_count',count.id,{schedule_id:scheduleId,planned_due_on:dueOn,counter_id:p.counter_id,tier:p.tier});return {...count,duplicate:false};
}
export async function countSchedules(c:Conn,ctx:Ctx){await gate(c,ctx);return {policies:(await c.query<any>(`SELECT p.*,w.code AS warehouse,l.code AS location,m.name AS counter,m.active AS counter_active,d.status AS document_status,d.hold FROM wh_count_schedules p JOIN warehouses w ON w.id=p.warehouse_id LEFT JOIN warehouse_locations l ON l.id=p.location_id LEFT JOIN team_members m ON m.user_id=p.counter_id JOIN documents d ON d.id=p.document_id ORDER BY p.active DESC,p.next_due,p.id LIMIT 300`)).rows,runs:(await c.query<any>(`SELECT r.*,k.no,k.status,k.assigned_to FROM wh_count_schedule_runs r JOIN wh_counts k ON k.id=r.count_id ORDER BY r.created_at DESC LIMIT 100`)).rows,operators:(await c.query<any>(`SELECT user_id,name FROM team_members WHERE active AND roles&&ARRAY['owner','warehouse','coordinator']::text[] ORDER BY name`)).rows,documents:(await c.query<any>(`SELECT id,title FROM documents WHERE status='issued' AND NOT hold ORDER BY created_at DESC LIMIT 300`)).rows};}
