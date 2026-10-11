import type {Conn,Db} from '../db/client.js';
import {permsFor,require,type Ctx,actorOf} from '../lib/perms.js';
import {audit} from '../lib/audit.js';
import {randomToken,sha256,badRequest,HttpError} from '../lib/util.js';
import {reqStr,recordId} from '../ops/common.js';
export const API_SCOPES=['parties:read','enquiries:write','invoices:read','specialists:read','specialists:write','assistant:read','assistant:write'] as const;
export async function createApiKey(c:Conn,ctx:Ctx,name:string,scopes:string[],days:number) {
 require(ctx,'settings.manage');
 if(!scopes.length||scopes.some(x=>!API_SCOPES.includes(x as any)))throw badRequest('Choose supported API scopes');
 if(!Number.isInteger(days)||days<1||days>90)throw badRequest('API keys expire in 1–90 days');
 const token=`lbt_${randomToken(32)}`;
 const id=(await c.query<any>(`INSERT INTO api_keys(tenant_id,user_id,name,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,now()+($6||' days')::interval) RETURNING id`,[ctx.tenantId,ctx.userId,reqStr(name,'Name',100),sha256(token),scopes,String(days)])).rows[0].id;
 await audit(c,ctx.tenantId,actorOf(ctx),'api.key_created','api_key',id,{scopes,days});return {id,token};
}
export async function revokeApiKey(c:Conn,ctx:Ctx,id:string) {
 require(ctx,'settings.manage');await c.query(`UPDATE api_keys SET revoked_at=now() WHERE id=$1`,[recordId(id)]);await audit(c,ctx.tenantId,actorOf(ctx),'api.key_revoked','api_key',id);
}
export async function apiContext(db:Db,token:string) {
 const row=(await db.query<any>(`SELECT k.id,k.tenant_id,k.user_id,k.scopes,m.roles FROM api_keys k JOIN memberships m ON m.tenant_id=k.tenant_id AND m.user_id=k.user_id JOIN tenants t ON t.id=k.tenant_id WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND k.expires_at>now() AND m.active AND t.status='active'`,[sha256(token)])).rows[0];
 if(!row||row.roles.includes('portal')||row.roles.includes('driver'))throw new HttpError(401,'Invalid or expired API key');
 const ctx:Ctx={userId:row.user_id,tenantId:row.tenant_id,roles:row.roles,perms:permsFor(row.roles),partyId:null,driverId:null,readOnly:false,supportStaffId:null};
 return {ctx,keyId:row.id,scopes:row.scopes as string[]};
}
export async function apiMutation<T>(c:Conn,ctx:Ctx,keyId:string,path:string,idempotencyKey:string,payload:string,work:()=>Promise<T>):Promise<T> {
 const key=reqStr(idempotencyKey,'Idempotency-Key',120),hash=sha256(payload);
 await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${ctx.tenantId}:${keyId}:${path}:${key}`]);
 const old=(await c.query<any>(`SELECT * FROM api_mutations WHERE key_id=$1 AND path=$2 AND idempotency_key=$3`,[keyId,path,key])).rows[0];
 if(old){if(old.payload_hash!==hash)throw new HttpError(409,'Idempotency-Key was used with different input');return old.result as T;}
 const result=await work();
 await c.query(`INSERT INTO api_mutations(tenant_id,key_id,path,idempotency_key,payload_hash,result) VALUES($1,$2,$3,$4,$5,$6)`,[ctx.tenantId,keyId,path,key,hash,JSON.stringify(result)]);
 return result;
}
