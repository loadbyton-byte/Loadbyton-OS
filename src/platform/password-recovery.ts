import type { Db } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { encryptSecret } from '../lib/encryption.js';
import { HttpError, checkPasswordStrength, hashPassword, randomToken, sha256 } from '../lib/util.js';
import { rateLimit } from '../lib/ratelimit.js';

const invalid = () => new HttpError(410, 'This reset link is invalid or has expired. Request a new link.');

/** Always returns the same result. Raw tokens only enter the encrypted mail queue. */
export async function requestPasswordRecovery(db: Db, email: string, ip: string) {
  const normalized = email.trim().toLowerCase();
  await rateLimit(`recovery-ip:${ip}`, 20, 900, 'Too many requests. Try again in a few minutes.');
  await rateLimit(`recovery:${sha256(normalized)}:${ip}`, 3, 900, 'Too many requests. Try again in a few minutes.');
  await db.system(async c => {
    const user = (await c.query<{ id: string }>('SELECT id FROM users WHERE email=$1 FOR UPDATE', [normalized])).rows[0];
    if (!user) return;
    const token = randomToken(32), hash = sha256(token);
    // A later request replaces earlier links. Serializing on the user also
    // prevents concurrent successful resets from creating multiple passwords.
    await c.query('DELETE FROM password_recoveries WHERE user_id=$1', [user.id]);
    await c.query(`INSERT INTO password_recoveries(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')`, [hash, user.id]);
    await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES (NULL,'email',$1,$2)`,
      [`password-recovery:${hash}`, JSON.stringify({ template: 'password_recovery', userId: user.id, tokenEncrypted: encryptSecret(token) })]);
    await audit(c, null, { kind: 'system' }, 'auth.recovery_requested', 'user', user.id);
  });
}

export async function recoverPassword(db: Db, token: string, password: string, ip: string) {
  await rateLimit(`recovery-reset:${ip}`, 20, 900, 'Too many requests. Try again in a few minutes.');
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw invalid();
  checkPasswordStrength(password);
  const passwordHash = await hashPassword(password), tokenHash = sha256(token);
  await db.system(async c => {
    const recovery = (await c.query<{ user_id: string }>(`SELECT user_id FROM password_recoveries WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now()`, [tokenHash])).rows[0];
    if (!recovery) throw invalid();
    await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [recovery.user_id]);
    const consumed = await c.query(`UPDATE password_recoveries SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING user_id`, [tokenHash]);
    if (!consumed.rows.length) throw invalid();
    await c.query('UPDATE users SET password_hash=$2 WHERE id=$1', [recovery.user_id, passwordHash]);
    await c.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [recovery.user_id]);
    await c.query('UPDATE password_recoveries SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [recovery.user_id]);
    // MFA settings and staff privileges are preserved; recovery never signs in.
    await audit(c, null, { kind: 'user', userId: recovery.user_id }, 'auth.password_recovered', 'user', recovery.user_id);
  });
}
