import {Hono} from 'hono';
import {requestDataAction} from '../ops/privacy.js';
import {appPage,need,withT,act,PageHead} from './appkit.js';
import {Csrf,Table,Badge} from './ui.js';
import {formBody,str,type Env} from './mw.js';
export const privacy=new Hono<Env>();
privacy.get('/app/privacy',async c=>{
 need(c,'settings.manage');const rows=await withT(c,async cn=>(await cn.query<any>(`SELECT * FROM data_requests ORDER BY created_at DESC LIMIT 100`)).rows);
 return appPage(c,'Your data',<><PageHead title="Your data"/><p>Download your records on every plan. Document downloads retain membership and visibility checks. A deletion request is reviewed for financial retention and legal holds before erasure; submitting a request does not delete records.</p>
 <p><a class="btn" href="/app/export.json">Export data</a> <a class="btn ghost" href="/app/export/invoices.csv">Invoice CSV</a></p>
 <form method="post" action="/app/privacy"><Csrf t={c.get('csrf')}/><div class="field"><label for="kind">Request</label><select id="kind" name="kind">{['access','correction','deletion'].map(k=><option value={k}>{k}</option>)}</select></div><div class="field"><label for="reason">Scope and reason</label><textarea id="reason" name="reason" required maxlength={2000}/></div><button class="btn">Submit for review</button></form>
 <Table head={['Request','State','Decision']} empty={rows.length?undefined:'No requests'}>{rows.map(r=><tr><td>{r.kind}</td><td><Badge s={r.status}/></td><td>{r.decision_reason??'Awaiting review'}</td></tr>)}</Table></>);
});
privacy.post('/app/privacy',async c=>act(c,'/app/privacy',async()=>{const b=await formBody(c);await withT(c,(cn,ctx)=>requestDataAction(cn,ctx,str(b.kind),str(b.reason)));return {to:'/app/privacy',ok:'Request recorded for review.'};}));
