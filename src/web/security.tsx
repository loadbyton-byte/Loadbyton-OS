import { Hono } from 'hono';
import { beginMfaEnrollment,verifyCompanyMfa } from '../platform/mfa.js';
import { revokeAllSessions } from '../platform/auth.js';
import { HttpError } from '../lib/util.js';
import { Csrf,PublicShell } from './ui.js';
import { formBody,str,type Env,clearSessionCookie } from './mw.js';

export const security=new Hono<Env>();
security.use('/account/*',async(c,next)=>{if(!c.get('session'))return c.redirect('/login');await next();});
security.get('/account/security',async c=>{
 const s=c.get('session')!,row=(await c.get('db').query<any>(`SELECT enabled FROM user_mfa WHERE user_id=$1`,[s.userId])).rows[0];
 const p={title:'Account security',csrf:c.get('csrf'),path:c.req.path,user:{name:s.name}};
 return c.html(<PublicShell p={p}><section class="block"><div class="wrap prose"><h1>Account security</h1>
 {c.req.query('err')?<p class="alert err">{c.req.query('err')}</p>:null}
 {row?.enabled?<form method="post" action="/account/security/verify"><Csrf t={p.csrf}/><label for="code">Authenticator code</label><input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code"/><button class="btn">Verify and continue</button></form>:<><p>Protect approvals and company data with an authenticator app.</p><form method="post" action="/account/security/enroll"><Csrf t={p.csrf}/><label for="password">Current password</label><input id="password" name="password" type="password" required autocomplete="current-password"/><button class="btn">Set up two-step verification</button></form></>}
 <form method="post" action="/account/security/revoke"><Csrf t={p.csrf}/><button class="btn ghost">Sign out all devices</button></form>
 </div></section></PublicShell>);
});
security.post('/account/security/enroll',async c=>{
 const s=c.get('session')!,b=await formBody(c);
 try {
  const secret=await beginMfaEnrollment(c.get('db'),s.userId,str(b.password));
  return c.html(<PublicShell p={{title:'Enable two-step verification',csrf:c.get('csrf'),path:c.req.path,user:{name:s.name}}}><section class="block"><div class="wrap prose"><h1>Connect your authenticator</h1><p>Add an account named LOADBYTON using this setup key. Store it securely for account recovery.</p><code>{secret}</code><form method="post" action="/account/security/enable"><Csrf t={c.get('csrf')}/><label for="code">First six-digit code</label><input name="code" id="code" required inputmode="numeric" autocomplete="one-time-code"/><button class="btn">Enable</button></form></div></section></PublicShell>);
 } catch(e) {if(e instanceof HttpError)return c.redirect('/account/security?err='+encodeURIComponent(e.message));throw e;}
});
for(const [path,enroll] of [['enable',true],['verify',false]] as const) security.post(`/account/security/${path}`,async c=>{
 try {await verifyCompanyMfa(c.get('db'),c.get('session')!.token,str((await formBody(c)).code),enroll);return c.redirect('/app');}
 catch(e){if(e instanceof HttpError)return c.redirect('/account/security?err='+encodeURIComponent(e.message));throw e;}
});
security.post('/account/security/revoke',async c=>{await revokeAllSessions(c.get('db'),c.get('session')!.userId);clearSessionCookie(c);return c.redirect('/login');});
