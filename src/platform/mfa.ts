import type { Db } from '../db/client.js';
import { newTotpSecret, totp, sha256, verifyPassword, HttpError } from '../lib/util.js';
import { encryptSecret, decryptSecret } from '../lib/encryption.js';
import { audit } from '../lib/audit.js';
import { rateLimit } from '../adapters/rate-limit.js';
import { loadSession } from './auth.js';

export async function beginMfaEnrollment(db:Db,userId:string,password:string) {
 await rateLimit(`mfa-enroll:${userId}`);
 return db.system(async c=>{
  const u=(await c.query<any>(`SELECT password_hash FROM users WHERE id=$1 FOR UPDATE`,[userId])).rows[0];
  if(!u||!await verifyPassword(password,u.password_hash))throw new HttpError(401,'Password is incorrect');
  const old=(await c.query<any>(`SELECT enabled FROM user_mfa WHERE user_id=$1`,[userId])).rows[0];
  if(old?.enabled)throw new HttpError(409,'Two-step verification is already enabled');
  const secret=newTotpSecret();
  await c.query(`INSERT INTO user_mfa(user_id,secret_encrypted) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET secret_encrypted=$2,last_step=-1`,[userId,encryptSecret(secret)]);
  await audit(c,null,{kind:'user',userId},'mfa.enrollment_started','user',userId);
  return secret;
 });
}
export async function verifyCompanyMfa(db:Db,token:string,code:string,enroll=false) {
 const s=await loadSession(db,token);if(!s)throw new HttpError(401,'Sign in first');
 await rateLimit(`mfa-verify:${s.userId}`);
 await db.system(async c=>{
  const row=(await c.query<any>(`SELECT * FROM user_mfa WHERE user_id=$1 FOR UPDATE`,[s.userId])).rows[0];
  if(!row||(!enroll&&!row.enabled)||(enroll&&row.enabled))throw new HttpError(409,'Enroll in two-step verification first');
  const secret=decryptSecret(row.secret_encrypted),now=Math.floor(Date.now()/30000);
  const step=[now-1,now,now+1].find(n=>totp(secret,n*30000)===code.trim());
  if(step===undefined||step<=Number(row.last_step))throw new HttpError(401,'Invalid or already used code. Wait for the next code.');
  await c.query(`UPDATE user_mfa SET enabled=true,last_step=$2 WHERE user_id=$1`,[s.userId,step]);
  if(enroll)await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND token_hash<>$2 AND revoked_at IS NULL`,[s.userId,sha256(token)]);
  await c.query(`UPDATE sessions SET company_mfa_ok=true WHERE token_hash=$1`,[sha256(token)]);
  await audit(c,s.tenantId,{kind:'user',userId:s.userId},enroll?'mfa.enabled':'mfa.verified','user',s.userId);
 });
}
