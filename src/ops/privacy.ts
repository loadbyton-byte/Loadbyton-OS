import type {Conn,Db} from '../db/client.js';
import {require,actorOf,type Ctx} from '../lib/perms.js';
import {audit} from '../lib/audit.js';
import {badRequest,HttpError} from '../lib/util.js';
import {recordId,reqStr} from './common.js';

/** A deletion request starts a human-reviewed retention process; posted books are never silently erased. */
export async function requestDataAction(c:Conn,ctx:Ctx,kind:string,reason:string) {
 require(ctx,'settings.manage');
 if(!['access','correction','deletion'].includes(kind))throw badRequest('Choose access, correction or deletion');
 const why=reqStr(reason,'Request details',2000);
 const open=(await c.query<any>(`SELECT id FROM data_requests WHERE kind=$1 AND status IN ('requested','reviewing','approved')`,[kind])).rows[0];
 if(open)return open.id;
 const id=(await c.query<any>(`INSERT INTO data_requests(tenant_id,requested_by,kind,reason) VALUES($1,$2,$3,$4) RETURNING id`,[ctx.tenantId,ctx.userId,kind,why])).rows[0].id;
 await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES($1,'staff.review',$2,$3) ON CONFLICT(key) DO NOTHING`,[ctx.tenantId,`privacy:${id}`,JSON.stringify({requestId:id,kind,note:'Review request identity, scope, retention and legal holds with the workspace owner.'})]);
 await audit(c,ctx.tenantId,actorOf(ctx),'privacy.requested','data_request',id,{kind});return id;
}
export async function decideDataRequest(db:Db,staffId:string,id:string,next:string,reason:string) {
 return db.system(async c=>{
  const row=(await c.query<any>(`SELECT * FROM data_requests WHERE id=$1 FOR UPDATE`,[recordId(id)])).rows[0];if(!row)throw new HttpError(404,'Request not found');
  const allowed:Record<string,string[]>={requested:['reviewing','rejected'],reviewing:['approved','rejected'],approved:['completed']};
  if(!allowed[row.status]?.includes(next))throw badRequest('Invalid data-request decision');
  const why=reqStr(reason,'Decision and evidence',2000);
  if(next==='completed'&&row.kind==='deletion')throw badRequest('Deletion requires the deployment retention/hold and database/object erasure runbook. Record completion through the reviewed erasure process, not this generic button.');
  await c.query(`UPDATE data_requests SET status=$2,decision_by=$3,decision_reason=$4,completed_at=CASE WHEN $2='completed' THEN now() ELSE NULL END WHERE id=$1`,[id,next,staffId,why]);
  await audit(c,row.tenant_id,{kind:'platform_staff',userId:staffId},`privacy.${next}`,'data_request',id,{reason:why});
 });
}
