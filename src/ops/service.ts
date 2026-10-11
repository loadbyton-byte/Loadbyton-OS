import type {Db,Conn} from '../db/client.js';
import {require,type Ctx,actorOf} from '../lib/perms.js';
import {audit} from '../lib/audit.js';
import {badRequest,HttpError} from '../lib/util.js';
import {recordId,reqStr} from './common.js';
export async function scheduleSetup(db:Db,staffId:string,id:string,technicianId:string,at:string,scope:string) {
 return db.system(async c=>{
  const row=(await c.query<any>(`SELECT * FROM setup_orders WHERE id=$1 FOR UPDATE`,[recordId(id)])).rows[0];if(!row)throw new HttpError(404,'Setup order not found');
  if(!['requested','scheduled'].includes(row.status))throw badRequest('Setup order is not schedulable');
  if(!(await c.query(`SELECT 1 FROM platform_staff WHERE user_id=$1 AND active AND role IN ('engineer','support')`,[recordId(technicianId)])).rows.length)throw badRequest('Assign an active support technician or engineer');
  const appointment=new Date(at);if(!Number.isFinite(appointment.getTime())||appointment.getTime()<Date.now())throw badRequest('Choose a future appointment');
  await c.query(`UPDATE setup_orders SET technician_id=$2,appointment_at=$3,access_expires_at=$3::timestamptz+interval '8 hours',scope=$4,status='scheduled' WHERE id=$1`,[id,technicianId,appointment.toISOString(),reqStr(scope,'Scope',2000)]);
  await audit(c,row.tenant_id,{kind:'platform_staff',userId:staffId},'setup.scheduled','setup_order',id);
 });
}
export async function submitSetupEvidence(db:Db,staffId:string,id:string,evidence:string,unresolved:string) {
 return db.system(async c=>{
  const row=(await c.query<any>(`SELECT * FROM setup_orders WHERE id=$1 FOR UPDATE`,[recordId(id)])).rows[0];if(!row)throw new HttpError(404,'Setup order not found');
  if(row.technician_id!==staffId||!['scheduled','working'].includes(row.status)||new Date(row.appointment_at).getTime()>Date.now()||new Date(row.access_expires_at).getTime()<Date.now())throw new HttpError(403,'Only the assigned technician can submit evidence during the appointment access window');
  await c.query(`UPDATE setup_orders SET status='review',evidence=$2,unresolved=$3 WHERE id=$1`,[id,reqStr(evidence,'Acceptance evidence',4000),String(unresolved).slice(0,2000)]);
  await audit(c,row.tenant_id,{kind:'platform_staff',userId:staffId},'setup.evidence_submitted','setup_order',id);
 });
}
export async function acceptSetup(c:Conn,ctx:Ctx,id:string) {
 require(ctx,'settings.manage');
 const row=(await c.query<any>(`SELECT * FROM setup_orders WHERE id=$1 FOR UPDATE`,[recordId(id)])).rows[0];if(!row)throw new HttpError(404,'Setup order not found');
 if(row.status!=='review'||!row.evidence||row.unresolved?.trim())throw badRequest('Setup requires acceptance evidence and resolution of recorded issues');
 if(row.technician_id===ctx.userId)throw new HttpError(403,'The customer owner must accept technician work independently');
 await c.query(`UPDATE setup_orders SET status='accepted',accepted_by=$2,accepted_at=now(),access_expires_at=now() WHERE id=$1`,[id,ctx.userId]);
 await audit(c,ctx.tenantId,actorOf(ctx),'setup.accepted','setup_order',id);
}
