import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, newTenant } from './helpers.js';
import type { Db } from '../src/db/client.js';
import { requestPasswordRecovery, recoverPassword } from '../src/platform/password-recovery.js';
import { loadSession, login, newSession } from '../src/platform/auth.js';
import { decryptSecret } from '../src/lib/encryption.js';
import { resetRateLimits } from '../src/lib/ratelimit.js';
import { mailHandlers, type MailMessage } from '../src/adapters/mail.js';
import { drainOutbox } from '../src/platform/outbox.js';
import { sha256 } from '../src/lib/util.js';
import { buildApp } from '../src/app.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
beforeEach(() => resetRateLimits());
async function account() {
  const tenant = await newTenant(db);
  const email = (await db.query<{ email: string }>('SELECT email FROM users WHERE id=$1', [tenant.userId])).rows[0].email;
  return { ...tenant, email };
}
async function queued(userId: string) {
  return (await db.query<any>(`SELECT * FROM outbox WHERE payload->>'userId'=$1 AND topic='email' ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0];
}

describe('password recovery', () => {
  it('delivers a bounded single-use credential, revokes sessions and preserves MFA and membership', async () => {
    const t = await account(), session = await newSession(db, t.userId, t.tenantId);
    await db.query(`INSERT INTO user_mfa(user_id,secret_encrypted,enabled) VALUES ($1,$2,true)`, [t.userId, 'fixture-encrypted-secret']);
    await requestPasswordRecovery(db, ` ${t.email.toUpperCase()} `, 'fixture-one');
    const row = await queued(t.userId), raw = decryptSecret(row.payload.tokenEncrypted);
    expect(JSON.stringify(row)).not.toContain(raw);
    const stored = (await db.query<any>('SELECT * FROM password_recoveries WHERE user_id=$1', [t.userId])).rows[0];
    expect(stored.token_hash).toBe(sha256(raw));
    expect(new Date(stored.expires_at).getTime() - new Date(stored.created_at).getTime()).toBe(3600000);
    const mail: MailMessage[] = [];
    await drainOutbox(db, mailHandlers(db, { async send(m) { mail.push(m); return {}; } }));
    expect(mail.some(m => m.to === t.email && m.text.includes(`/reset-password?token=${raw}`))).toBe(true);
    expect((await queued(t.userId)).payload.tokenEncrypted).toBeUndefined();
    await recoverPassword(db, raw, 'a-new-secure-password-456', 'fixture-one');
    expect(await loadSession(db, session.token)).toBeNull();
    await expect(login(db, t.email, 'correct horse battery', 'fixture-one')).rejects.toMatchObject({ status: 401 });
    expect((await login(db, t.email, 'a-new-secure-password-456', 'fixture-one')).userId).toBe(t.userId);
    expect((await db.query<any>('SELECT enabled FROM user_mfa WHERE user_id=$1', [t.userId])).rows[0].enabled).toBe(true);
    expect((await db.query<any>('SELECT active FROM memberships WHERE user_id=$1', [t.userId])).rows[0].active).toBe(true);
    await expect(recoverPassword(db, raw, 'another-secure-password-789', 'fixture-one')).rejects.toMatchObject({ status: 410 });
  });

  it('replaces old requests, rejects expiry and weak passwords, and allows only one racing reset', async () => {
    const t = await account();
    await requestPasswordRecovery(db, t.email, 'fixture-two');
    const first = decryptSecret((await queued(t.userId)).payload.tokenEncrypted);
    await requestPasswordRecovery(db, t.email, 'fixture-two');
    const second = decryptSecret((await queued(t.userId)).payload.tokenEncrypted);
    await expect(recoverPassword(db, first, 'valid-password-123456', 'fixture-two')).rejects.toMatchObject({ status: 410 });
    await expect(recoverPassword(db, second, 'short', 'fixture-two')).rejects.toMatchObject({ status: 400 });
    const results = await Promise.allSettled([recoverPassword(db, second, 'valid-password-123456', 'fixture-two'), recoverPassword(db, second, 'valid-password-abcdef', 'fixture-two')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await requestPasswordRecovery(db, t.email, 'fixture-two');
    const expired = decryptSecret((await queued(t.userId)).payload.tokenEncrypted);
    await db.query(`UPDATE password_recoveries SET expires_at=now()-interval '1 second' WHERE user_id=$1`, [t.userId]);
    await expect(recoverPassword(db, expired, 'valid-password-123456', 'fixture-two')).rejects.toMatchObject({ status: 410 });
  });

  it('does not enumerate accounts, rate limits requests, and enforces CSRF on both endpoints', async () => {
    const t = await account(), app = buildApp(db);
    const get = await app.request('/forgot-password');
    const cookie = get.headers.getSetCookie().find(c => c.startsWith('lbt_csrf='))!.split(';')[0];
    const csrf = cookie.slice(cookie.indexOf('=') + 1);
    const post = (email: string) => app.request('/forgot-password', { method: 'POST', body: new URLSearchParams({ email, _csrf: csrf }), headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });
    const known = await post(t.email), unknown = await post('absent@example.com');
    expect(known.status).toBe(302); expect(unknown.headers.get('location')).toBe(known.headers.get('location'));
    for (const path of ['/forgot-password', '/reset-password']) expect((await app.request(path, { method: 'POST', body: new URLSearchParams({ email:t.email }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(403);
    await post(t.email); await post(t.email);
    expect((await post(t.email)).headers.get('location')).toContain('Too%20many%20requests');
    const resetPage = await app.request('/reset-password?token=fixture');
    expect(resetPage.headers.get('referrer-policy')).toBe('no-referrer'); expect(resetPage.headers.get('cache-control')).toBe('no-store');
    await db.tenant(t.tenantId, async c => { await expect(c.query('SELECT * FROM password_recoveries')).rejects.toThrow(/permission denied/i); });
  });
});
