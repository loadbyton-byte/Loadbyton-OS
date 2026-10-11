import {Hono} from 'hono';
import {saveZohoConnection,disconnectAccounting,setReceiptPosting} from '../ops/connections.js';
import {appPage,need,withT,act,PageHead} from './appkit.js';
import {formBody,type Env} from './mw.js';
import {Csrf} from './ui.js';
export const connections=new Hono<Env>();
connections.get('/app/connections',async c=>{
 need(c,'settings.manage');
 const row=await withT(c,async cn=>(await cn.query<any>(`SELECT provider,status,(config->>'post_receipts')='true' AS post_receipts FROM accounting_connections`)).rows[0]);
 const csrf=c.get('csrf');
 return appPage(c,'Accounting connection',<><PageHead title="Accounting connection"/><p>Zoho Books is the ledger system of record. Approved operational invoices create or reconcile external drafts. Your controller reviews posting, corrections and tax treatment in Zoho. Matching a draft does not establish reconciled statutory books.</p>
 <p>Current connection: {row?`${row.provider} — ${row.status}`:'Not connected'}. Credentials are encrypted and never displayed.</p>
 <form method="post" action="/app/connections/zoho" class="card"><Csrf t={csrf}/>
 {[['organization_id','Zoho organization ID'],['client_id','OAuth client ID'],['client_secret','OAuth client secret'],['refresh_token','OAuth refresh token']].map(([name,label])=><div class="field"><label for={name}>{label}</label><input id={name} name={name} type={name.includes('secret')||name.includes('token')?'password':'text'} required autocomplete="off"/></div>)}
 <div class="field"><label for="region">Zoho region</label><select id="region" name="region">{['com','in','eu','com.au','jp','ca','sa'].map(r=><option value={r}>{r}</option>)}</select></div>
 <div class="field"><label for="currency_ids">Currency IDs (JSON object, e.g. AED mapped to your Zoho currency ID)</label><textarea id="currency_ids" name="currency_ids" required>{'{}'}</textarea></div>
 <div class="field"><label for="tax_ids">Tax codes mapped to your Zoho tax IDs (SR5, ZR0, EX0, OOS as used)</label><textarea id="tax_ids" name="tax_ids" required>{'{}'}</textarea></div>
 <button class="btn">Save for validation</button></form>
 {row&&["connected","validating","live"].includes(row.status)?<form method="post" action="/app/connections/receipts" class="card"><Csrf t={csrf}/><h2>Receipts</h2><p>Payments cannot be created as drafts in the ledger. When off (the default) receipts are listed for your controller to record; when on, each receipt is posted to Zoho against its synchronized invoice. Reversing a posted receipt asks the controller to reverse it there.</p><label class="check"><input type="checkbox" name="enabled" value="1" checked={!!row.post_receipts}/>Post receipts to Zoho Books</label><button class="btn sm">Save</button></form>:null}
 <form method="post" action="/app/connections/disconnect"><Csrf t={csrf}/><button class="btn ghost">Disconnect and remove stored credentials</button></form></>);
});
connections.post('/app/connections/zoho',async c=>act(c,'/app/connections',async()=>{const b=await formBody(c);await withT(c,(cn,ctx)=>saveZohoConnection(cn,ctx,b));return {to:'/app/connections',ok:'Saved. Run a representative invoice and controller reconciliation before using this connection commercially.'};}));
connections.post('/app/connections/receipts',async c=>act(c,'/app/connections',async()=>{const b=await formBody(c);await withT(c,(cn,ctx)=>setReceiptPosting(cn,ctx,!!b.enabled));return {to:'/app/connections',ok:'Receipt posting updated.'};}));
connections.post('/app/connections/disconnect',async c=>act(c,'/app/connections',async()=>{await withT(c,(cn,ctx)=>disconnectAccounting(cn,ctx));return {to:'/app/connections',ok:'Disconnected.'};}));
