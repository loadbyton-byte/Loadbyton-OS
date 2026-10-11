import type {Db} from '../db/client.js';
import {decryptWithKey,encryptWithKey} from '../lib/encryption.js';
import {audit} from '../lib/audit.js';

/** Privileged maintenance operation, never exposed through tenant/API routes.
 * A single locked transaction verifies every ciphertext before committing changes.
 * Dual-key application readers remain required until every process has adopted the new primary.
 */
export async function rotateEncryptionKey(db:Db,current:string,previous:string,apply=false){
 if(current.length<32||previous.length<32||current===previous)throw new Error('Rotation requires distinct current and previous keys of at least 32 characters');
 return db.system(async c=>{
  // Prevent inserts/refresh/enrollment or claimed invitation payload changes during this maintenance snapshot.
  await c.query(`LOCK TABLE user_mfa,accounting_connections,outbox IN SHARE ROW EXCLUSIVE MODE`);
  const targets=[{table:'user_mfa',id:'user_id',value:'secret_encrypted',filter:'true',update:'secret_encrypted=$2'},
   {table:'accounting_connections',id:'tenant_id',value:"config->>'encrypted'",filter:"config ? 'encrypted'",update:"config=jsonb_set(config,'{encrypted}',to_jsonb($2::text))"},
   {table:'outbox',id:'id',value:"payload->>'tokenEncrypted'",filter:"payload ? 'tokenEncrypted'",update:"payload=jsonb_set(payload,'{tokenEncrypted}',to_jsonb($2::text))"}] as const;
  const counts:Record<string,{examined:number;pending:number;rotated:number}>={};
  const total=Number((await c.query<any>(`SELECT (SELECT count(*) FROM user_mfa)+(SELECT count(*) FROM accounting_connections WHERE config ? 'encrypted')+(SELECT count(*) FROM outbox WHERE payload ? 'tokenEncrypted') n`)).rows[0].n);
  if(total>10000)throw new Error('Rotation exceeds the bounded maintenance limit; use a reviewed larger-dataset migration');
  for(const target of targets){
   const count=counts[target.table]={examined:0,pending:0,rotated:0};let cursor:string|null=null;
   for(;;){const rows:{id:string;encrypted:string}[]=(await c.query<{id:string;encrypted:string}>(`SELECT ${target.id} AS id,${target.value} AS encrypted FROM ${target.table} WHERE ${target.filter} AND ($1::uuid IS NULL OR ${target.id}>$1) ORDER BY ${target.id} LIMIT 100`,[cursor])).rows;if(!rows.length)break;
    for(const row of rows){count.examined++;cursor=row.id;try{decryptWithKey(row.encrypted,current);continue;}catch{/* The old key must authenticate the ciphertext; never skip unknown/corrupted rows. */}
     let plaintext:string;try{plaintext=decryptWithKey(row.encrypted,previous);}catch{throw new Error('Rotation aborted: an encrypted record cannot be authenticated with either key');}
     count.pending++;if(apply){await c.query(`UPDATE ${target.table} SET ${target.update} WHERE ${target.id}=$1`,[row.id,encryptWithKey(plaintext,current)]);count.rotated++;}
    }
   }
  }
  if(apply)await audit(c,null,{kind:'system'},'security.encryption_key_rotated','platform',undefined,{counts});
  return {mode:apply?'applied':'dry_run',counts};
 });
}
