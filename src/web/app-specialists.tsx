import {Hono} from 'hono';
import {randomUUID} from 'node:crypto';
import {SPECIALIST_PROFILES,type Field} from '../ops/specialist-profiles.js';
import {approveSpecialistReview,createSpecialistCase,getSpecialistCase,invoiceSpecialistCase,listSpecialistCases,recordSpecialistEvent,specialistProfile,transitionSpecialistCase} from '../ops/specialists.js';
import {sectorBySlug} from '../platform/catalog.js';
import {forbidden,formatDate} from '../lib/util.js';
import {formBody,str,type Env,type C} from './mw.js';
import {act,appPage,can,need,PageHead,withT} from './appkit.js';
import {Badge,Csrf,Money,Table} from './ui.js';
import {identifierChecks} from '../ops/identifiers.js';
export const specialists=new Hono<Env>();
const S='/app/specialists';
const fields=(items:Field[],prefix:string)=>items.map(f=><div class="field"><label for={`${prefix}-${f.key}`}>{f.label}</label>{f.options?<select id={`${prefix}-${f.key}`} name={f.key} required>{f.options.map(o=><option value={o}>{o.replaceAll('_',' ')}</option>)}</select>:<input id={`${prefix}-${f.key}`} name={f.key} required type={f.type==='number'||f.type==='money'?'number':f.type==='datetime'?'datetime-local':f.type} step={f.type==='money'?'0.01':f.type==='number'?'any':undefined} min={f.type==='money'?'0':undefined}/>}</div>);
const text=(key:string,label:string,prefix:string)=>fields([{key,label,type:'text'}],prefix);
function sector(c:C){const s=c.req.param('sector')!;specialistProfile(s);if(!c.get('tenant')!.sectors.includes(s))throw forbidden('This sector is not selected');return s;}
const docs=async(c:C)=>(await withT(c,cn=>cn.query<any>(`SELECT id,title FROM documents WHERE status='issued' AND NOT hold ORDER BY created_at DESC LIMIT 300`))).rows;
const documentSelect=(rows:any[],prefix:string,required=true)=><div class="field"><label for={`${prefix}-document`}>Issued evidence (latest 300)</label><select id={`${prefix}-document`} name="document_id" required={required}><option value="">Select evidence</option>{rows.map(d=><option value={d.id}>{d.title}</option>)}</select></div>;
specialists.get(`${S}/:sector`,async c=>{
 need(c,'read');const s=sector(c),profile=SPECIALIST_PROFILES[s],page=Math.min(100000,Math.max(1,Number(c.req.query('page'))||1)),url=`${S}/${s}`,csrf=c.get('csrf');
 const data=await withT(c,async cn=>({rows:await listSpecialistCases(cn,s,page),review:(await cn.query<any>(`SELECT reviewer,valid_until FROM specialist_reviews WHERE sector=$1`,[s])).rows[0],parties:(await cn.query<any>(`SELECT id,name FROM parties WHERE kind='customer' ORDER BY name`)).rows}));
 const documents=can(c,'specialist.write')||can(c,'settings.manage')?await docs(c):[];
 return appPage(c,sectorBySlug(s)!.name,<><PageHead title={sectorBySlug(s)!.name} sub="Controlled manual workflow; reviewed evidence is required before operational release."/>
 <p class="alert info">These records support your qualified staff and authorised partners. Regulatory submissions and certifications require separate approved access. Signed temperature-logger feeds are available for cold chain; other device and carrier feeds are not built.</p>
 <p>Subject-matter review: {data.review?`${data.review.reviewer}, valid until ${formatDate(data.review.valid_until)}`:'Required before the first case.'}</p>
 {can(c,'settings.manage')?<details class="card"><summary>Record readiness review</summary><form method="post" action={`${url}/review`}><Csrf t={csrf}/>{text('reviewer','Qualified reviewer / organisation','review')}{documentSelect(documents,'review')}{fields([{key:'valid_until',label:'Review valid until',type:'date'}],'review')}<button class="btn">Record reviewed evidence</button></form></details>:null}
 <Table head={['Case','Customer','Subject','Status',['Service fee','num']]}>{data.rows.slice(0,50).map(r=><tr><td><a href={`${url}/${r.id}`}>{r.no}</a></td><td>{r.customer}</td><td>{r.subject_ref}</td><td><Badge s={r.status}/></td><td class="num"><Money v={r.fee_minor}/></td></tr>)}</Table>
 <nav aria-label="Case pages">{page>1?<a href={`${url}?page=${page-1}`}>Previous</a>:null} Page {page} {data.rows.length>50?<a href={`${url}?page=${page+1}`}>Next</a>:null}</nav>
 {can(c,'specialist.write')?<form class="card" method="post" action={url}><Csrf t={csrf}/><h2>Create reviewed case</h2><div class="field"><label for="customer">Customer</label><select id="customer" name="party_id" required>{data.parties.map(p=><option value={p.id}>{p.name}</option>)}</select></div>{text('external_ref','Customer reference','create')}{text('subject_ref','Equipment / case subject','create')}{fields(profile.fields,'create')}{fields([{key:'fee',label:'Agreed service fee (AED)',type:'money'}],'create')}<div class="field"><label for="tax">Transaction tax code</label><select id="tax" name="tax_code"><option value="SR5">Standard 5%</option><option value="ZR0">Zero-rated</option><option value="EX0">Exempt</option><option value="OOS">Outside scope</option></select></div><button class="btn red">Create case</button></form>:null}</>);
});
specialists.post(`${S}/:sector`,async c=>{const s=sector(c),b=await formBody(c),url=`${S}/${s}`;return act(c,url,async()=>{const r=await withT(c,(cn,ctx)=>createSpecialistCase(cn,ctx,s,b));return {to:`${url}/${r.id}`,ok:'Case created.'};});});
specialists.post(`${S}/:sector/review`,async c=>{const s=sector(c),b=await formBody(c),url=`${S}/${s}`;return act(c,url,async()=>{await withT(c,(cn,ctx)=>approveSpecialistReview(cn,ctx,s,str(b.reviewer),str(b.document_id),str(b.valid_until)));return {to:url,ok:'Review evidence recorded.'};});});
specialists.get(`${S}/:sector/:id`,async c=>{
 need(c,'read');const s=sector(c),d=await withT(c,cn=>getSpecialistCase(cn,c.req.param('id')));if(d.row.sector!==s)throw forbidden('Case belongs to a different profile');
 const profile=SPECIALIST_PROFILES[s],url=`${S}/${s}/${d.row.id}`,csrf=c.get('csrf'),documents=can(c,'specialist.write')?await docs(c):[];
 const next:Record<string,string[]>={draft:['ready','cancelled'],ready:['active','cancelled'],active:['hold','completed'],hold:['ready','active'],completed:['closed']};
 return appPage(c,d.row.no,<><PageHead title={`${d.row.no} · ${d.row.subject_ref}`}><Badge s={d.row.status}/></PageHead>
 <dl>{profile.fields.map(f=><><dt>{f.label}</dt><dd>{f.type==='money'?<Money v={d.row.attributes[f.key]}/>:String(d.row.attributes[f.key])}</dd></>)}</dl>
 {identifierChecks(s,d.row.attributes).map(k=><p class={k.valid?'small':'alert warn'}>{k.label} <code>{k.value}</code>: {k.valid?`passes its ${k.rule} check`:`fails its ${k.rule} check — confirm it against the source document`}.</p>)}
 {s==='cold-chain'?<p><a href={`/app/cold-chain/cases/${d.row.id}`}>Temperature monitoring</a> · <a href="/app/cold-chain/devices">Loggers</a></p>:null}
 <p>Ready evidence: {profile.readyEvidence.join(', ')}. Completion evidence: {profile.completionEvidence.join(', ')}.</p>
 {can(c,'specialist.write')&&!['completed','closed','cancelled'].includes(d.row.status)?Object.entries(profile.events).filter(([,e])=>!e.approval||can(c,'specialist.approve')).map(([kind,e])=><details class="card"><summary>{e.label}</summary><form method="post" action={`${url}/event`}><Csrf t={csrf}/><input type="hidden" name="kind" value={kind}/><input type="hidden" name="client_ref" value={randomUUID()}/>{fields(e.fields,kind)}{text('note','Evidence / explanation',kind)}{documentSelect(documents,kind,!!e.evidence)}<button class="btn">Record {e.label.toLowerCase()}</button></form></details>):null}
 {can(c,'specialist.write')&&next[d.row.status]?.length?<form class="card" method="post" action={`${url}/status`}><Csrf t={csrf}/><h2>Review case status</h2><div class="field"><label for="status">Decision</label><select id="status" name="status">{next[d.row.status].filter(n=>can(c,'specialist.approve')||['hold','cancelled'].includes(n)).map(n=><option>{n}</option>)}</select></div>{text('reason','Decision evidence','status')}<button class="btn red">Record decision</button></form>:null}
 <Table caption="Immutable history" head={['Time','Event','Details','Evidence']}>{d.events.map(e=><tr><td>{formatDate(e.created_at)}</td><td>{e.kind}</td><td>{Object.entries(e.attributes).map(([k,v])=><div>{k.replaceAll('_',' ')}: {String(v)}</div>)}<p>{e.note}</p></td><td>{e.document_id?<a href={`/app/documents/${e.document_id}/download`}>Evidence</a>:'—'}</td></tr>)}</Table>
 <p>Agreed service fee: <Money v={d.row.fee_minor}/>. {d.row.invoice_id?<a href={`/app/invoices/${d.row.invoice_id}`}>View invoice</a>:null}</p>
 {can(c,'finance.write')&&d.row.status==='completed'&&!d.row.invoice_id&&Number(d.row.fee_minor)>0?<form method="post" action={`${url}/invoice`}><Csrf t={csrf}/><button class="btn">Issue service invoice</button></form>:null}</>);
});
for(const action of ['event','status','invoice'])specialists.post(`${S}/:sector/:id/${action}`,async c=>{
 const s=sector(c),id=c.req.param('id'),url=`${S}/${s}/${id}`,b=await formBody(c);
 return act(c,url,async()=>{await withT(c,async(cn,ctx)=>{const d=await getSpecialistCase(cn,id);if(d.row.sector!==s)throw forbidden('Case belongs to a different profile');if(action==='event')await recordSpecialistEvent(cn,ctx,id,str(b.kind),b,str(b.note),str(b.client_ref),str(b.document_id)||undefined);else if(action==='status')await transitionSpecialistCase(cn,ctx,id,str(b.status),str(b.reason));else await invoiceSpecialistCase(cn,ctx,id);});return {to:url,ok:'Recorded.'};});
});
