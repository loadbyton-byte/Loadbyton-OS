import {Hono} from 'hono';
import {acceptSetup,scheduleSetup,submitSetupEvidence} from '../ops/service.js';
import {decideDataRequest} from '../ops/privacy.js';
import {approveErasurePlan,executeErasure,prepareErasurePlan} from '../ops/privacy-retention.js';
import {appPage,need,withT,act,PageHead,PostBtn} from './appkit.js';
import {Csrf,Table,Badge,AdminShell} from './ui.js';
import {formBody,str,type Env} from './mw.js';
import {HttpError} from '../lib/util.js';
export const service=new Hono<Env>();
service.get('/app/onboarding',async c=>{
 need(c,'settings.manage');const rows=await withT(c,async cn=>(await cn.query<any>(`SELECT * FROM setup_orders ORDER BY created_at DESC LIMIT 100`)).rows);
 return appPage(c,'Setup and onboarding',<><PageHead title="Setup and onboarding"/><p>Review the agreed setup scope and evidence. An appointment alone does not establish that the purchased workflow works. Customer data access uses a separate owner-approved support grant.</p>
 {rows.map(r=><section class="card"><h2><Badge s={r.status}/></h2><p>{r.scope}</p><p>Appointment (UTC): {r.appointment_at?new Date(r.appointment_at).toISOString():'To be scheduled'}</p><p>{r.evidence??'Evidence pending'}</p>{r.unresolved?<p class="alert warn">{r.unresolved}</p>:null}{r.status==='review'?<PostBtn action={`/app/onboarding/${r.id}/accept`} csrf={c.get('csrf')} label="Accept completed workflow"/>:null}</section>)}</>);
});
service.post('/app/onboarding/:id/accept',async c=>act(c,'/app/onboarding',async()=>{await withT(c,(cn,ctx)=>acceptSetup(cn,ctx,c.req.param('id')));return {to:'/app/onboarding',ok:'Setup accepted. Technician appointment access has ended.'};}));
service.get('/admin/service',async c=>{
 const db=c.get('db'),session=c.get('session')!;
 const [orders,staff,requests]=await Promise.all([
  db.query<any>(`SELECT s.*,t.name FROM setup_orders s JOIN tenants t ON t.id=s.tenant_id ORDER BY s.created_at DESC LIMIT 100`),
  db.query<any>(`SELECT u.id,u.name FROM platform_staff p JOIN users u ON u.id=p.user_id WHERE p.active AND p.role IN ('support','engineer')`),
  db.query<any>(`SELECT d.*,t.name FROM data_requests d JOIN tenants t ON t.id=d.tenant_id WHERE d.status NOT IN ('rejected','completed') ORDER BY d.created_at LIMIT 100`),
 ]);
 const csrf=c.get('csrf');
 return c.html(<AdminShell p={{title:'Service operations',csrf,path:c.req.path,user:{name:session.name}}}><h1>Service operations</h1><p>Scope, appointment, acceptance and unresolved work. These records do not grant access to operational tenant data.</p>
 {orders.rows.map(r=><section class="card"><h2>{r.name} <Badge s={r.status}/></h2><p>{r.scope}</p>
 {['requested','scheduled'].includes(r.status)?<form method="post" action={`/admin/service/${r.id}/schedule`}><Csrf t={csrf}/><div class="field"><label for={`tech-${r.id}`}>Technician</label><select name="technician_id" id={`tech-${r.id}`}>{staff.rows.map(s=><option value={s.id}>{s.name}</option>)}</select></div><div class="field"><label for={`at-${r.id}`}>Appointment (UTC)</label><input id={`at-${r.id}`} name="appointment_at" type="datetime-local" required/></div><div class="field"><label for={`scope-${r.id}`}>Agreed scope and prerequisites</label><textarea id={`scope-${r.id}`} name="scope" required>{r.scope}</textarea></div><button class="btn">Schedule</button></form>:null}
 {r.technician_id===session.userId&&['scheduled','working'].includes(r.status)?<form method="post" action={`/admin/service/${r.id}/evidence`}><Csrf t={csrf}/><div class="field"><label for={`ev-${r.id}`}>Workflow acceptance evidence</label><textarea id={`ev-${r.id}`} name="evidence" required maxlength={4000}/></div><div class="field"><label for={`issues-${r.id}`}>Unresolved issues</label><textarea id={`issues-${r.id}`} name="unresolved" maxlength={2000}/></div><button class="btn">Submit for customer review</button></form>:null}
 <p>{r.evidence??''} {r.unresolved??''}</p></section>)}
 <h2>Privacy requests</h2><Table head={['Company','Request','Status','Decision']} empty={requests.rows.length?undefined:'No pending requests'}>{requests.rows.map(r=><tr><td>{r.name}</td><td>{r.kind}: {r.reason}</td><td>{r.status}</td><td>{r.kind==='deletion'&&r.status==='approved'?<div><p class="small">Erasure anonymises personal contact data only; invoices and audit records are retained. It needs a plan, a second person's approval, and a workspace with no open work or legal hold.</p>{['plan','approve','execute'].map(a=><form method="post" action={`/admin/privacy/${r.id}/erasure/${a}`} class="inline-form"><Csrf t={csrf}/><button class="btn ghost sm">{a==='plan'?'Prepare / refresh plan':a==='approve'?'Approve plan (second person)':'Execute erasure'}</button></form>)}</div>:null}<form method="post" action={`/admin/privacy/${r.id}`}><Csrf t={csrf}/><select name="next">{(r.status==='requested'?['reviewing','rejected']:r.status==='reviewing'?['approved','rejected']:r.kind==='deletion'?[]:['completed']).map(n=><option value={n}>{n}</option>)}</select><input name="reason" aria-label="Decision evidence" required/><button class="btn sm">Record decision</button></form></td></tr>)}</Table></AdminShell>);
});
service.post('/admin/service/:id/schedule',async c=>act(c,'/admin/service',async()=>{
 if(!['commercial_admin','support','engineer'].includes(c.get('session')!.staffRole!))throw new HttpError(403,'Service scheduling requires a service operator');
 const b=await formBody(c);await scheduleSetup(c.get('db'),c.get('session')!.userId,c.req.param('id'),str(b.technician_id),str(b.appointment_at)+'Z',str(b.scope));return {to:'/admin/service',ok:'Scheduled. Customer approval of a data-access grant remains separate.'};
}));
service.post('/admin/service/:id/evidence',async c=>act(c,'/admin/service',async()=>{const b=await formBody(c);await submitSetupEvidence(c.get('db'),c.get('session')!.userId,c.req.param('id'),str(b.evidence),str(b.unresolved));return {to:'/admin/service',ok:'Evidence submitted for customer acceptance.'};}));
service.post('/admin/privacy/:id',async c=>act(c,'/admin/service',async()=>{
 if(!['commercial_admin','support'].includes(c.get('session')!.staffRole!))throw new HttpError(403,'Privacy review requires an authorized service operator');
 const b=await formBody(c);await decideDataRequest(c.get('db'),c.get('session')!.userId,c.req.param('id'),str(b.next),str(b.reason));return {to:'/admin/service',ok:'Decision recorded.'};
}));
for(const [action,fn] of [['plan',prepareErasurePlan],['approve',approveErasurePlan],['execute',executeErasure]] as const)
 service.post(`/admin/privacy/:id/erasure/${action}`,async c=>act(c,'/admin/service',async()=>{
  if(!['commercial_admin','support'].includes(c.get('session')!.staffRole!))throw new HttpError(403,'Erasure requires an authorized service operator');
  const r:any=await fn(c.get('db'),c.get('session')!.userId,c.req.param('id'));
  return {to:'/admin/service',ok:action==='plan'?(r.blockers?.length?`Plan prepared with blockers: ${r.blockers.join('; ')}.`:'Plan prepared. A second person must approve it.'):action==='approve'?'Plan approved.':'Erasure executed; the request is completed.'};
 }));
