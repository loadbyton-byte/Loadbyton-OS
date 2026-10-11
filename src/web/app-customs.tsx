import { Hono } from 'hono';
import { createCase,invoiceCase,attachEvidence,transitionCase,recordDeposit,listCases,getCase } from '../ops/customs.js';
import { listParties } from '../ops/crm.js';
import { formBody,str,type Env } from './mw.js';
import { act,appPage,can,need,PageHead,withT } from './appkit.js';
import { Badge,Csrf,Money,Table } from './ui.js';
import {TAX_CODES} from "../lib/util.js";
import { formatDate } from '../lib/util.js';
export const customs=new Hono<Env>();
const C='/app/customs';
const field=(name:string,label:string)=><div class="field"><label for={name}>{label}</label><input id={name} name={name} required/></div>;
customs.get(C,async c=>{
 need(c,'read');const page=Math.min(100000,Math.max(1,parseInt(c.req.query('page')??'1',10)||1)),rows=await withT(c,cn=>listCases(cn,page));
 const parties=can(c,'customs.write')?await withT(c,cn=>listParties(cn,'customer')):[];
 return appPage(c,'Customs',<><PageHead title="Customs cases" sub="Evidence and controlled handover. This application does not submit declarations or grant official clearance."/>
  <Table head={['Case','Customer','Reference','Type','Status','Official / agent reference']} empty={rows.length?undefined:'No cases.'}>{rows.slice(0,50).map(p=><tr><td><a href={`${C}/${p.id}`}>{p.no}</a></td><td>{p.customer}</td><td>{p.external_ref}</td><td>{p.declaration_type}</td><td><Badge s={p.status}/></td><td>{p.official_ref??'—'}</td></tr>)}</Table>
  <nav aria-label="Case pages">{page>1?<a href={`${C}?page=${page-1}`}>Previous</a>:null} Page {page} {rows.length>50?<a href={`${C}?page=${page+1}`}>Next</a>:null}</nav>
  {can(c,'customs.write')?<form class="card" method="post" action={C}><Csrf t={c.get('csrf')}/><h2>New case</h2><div class="field"><label for="party_id">Customer</label><select id="party_id" name="party_id" required><option value="">Select</option>{parties.map(p=><option value={p.id}>{p.name}</option>)}</select></div>{field('external_ref','Customer reference')}<div class="field"><label for="declaration_type">Declaration type</label><select id="declaration_type" name="declaration_type">{['import','export','transit'].map(t=><option>{t}</option>)}</select></div>{field('fee','Agreed service fee (AED; zero if no fee)')}<div class="field"><label for="tax_code">Tax code</label><select id="tax_code" name="tax_code">{Object.entries(TAX_CODES).map(([k,v])=><option value={k}>{v.label}</option>)}</select></div><label class="check"><input name="permit_required" type="checkbox"/>Goods-specific permit required by qualified review</label><button class="btn red">Create case</button></form>:null}</>);
});
customs.post(C,async c=>{const b=await formBody(c);return act(c,C,async()=>{const p=await withT(c,(cn,ctx)=>createCase(cn,ctx,b));return {to:`${C}/${p.id}`,ok:'Case created.'};});});
customs.get(`${C}/:id`,async c=>{
 need(c,'read');const id=c.req.param('id'),d=await withT(c,cn=>getCase(cn,id)),url=`${C}/${id}`,csrf=c.get('csrf');
 const docs=can(c,'customs.write')?(await withT(c,cn=>cn.query<any>(`SELECT id,title FROM documents ORDER BY created_at DESC LIMIT 300`))).rows:[];
 const transitions:Record<string,string[]>={draft:['ready','cancelled'],ready:['handed_over','draft','cancelled'],handed_over:['inspection','cleared'],inspection:['cleared']};
 return appPage(c,d.p.no,<><PageHead title={`${d.p.no} · ${d.p.customer}`} sub={`${d.p.declaration_type} · ${d.p.external_ref}`}><Badge s={d.p.status}/></PageHead>
  <p class="alert info">Attach authentic evidence from the authorised broker/authority. Recording a status here does not perform an official submission. Permits and specialist review must be checked for the goods involved.</p>
  <Table caption="Evidence" head={['Kind','Document']} empty={d.evidence.length?undefined:'No evidence attached.'}>{d.evidence.map(e=><tr><td>{e.kind}</td><td><a href={`/app/documents/${e.document_id}/download`}>{e.title}</a></td></tr>)}</Table>
  {can(c,'customs.write')&&!['cleared','cancelled'].includes(d.p.status)?<>
   <form class="card" method="post" action={`${url}/evidence`}><Csrf t={csrf}/><h2>Attach evidence</h2><p>Upload files under <a href="/app/documents">Documents</a>, then attach them here.</p><div class="field"><label for="document_id">Document (latest 300)</label><select id="document_id" name="document_id" required>{docs.map(x=><option value={x.id}>{x.title}</option>)}</select></div><div class="field"><label for="kind">Evidence type</label><select id="kind" name="kind">{['commercial_invoice','packing_list','transport_document','permit','clearance','inspection'].map(t=><option>{t}</option>)}</select></div><button class="btn">Attach</button></form>
   <form class="card" method="post" action={`${url}/status`}><Csrf t={csrf}/><h2>Record a decision</h2><div class="field"><label for="status">Next status</label><select id="status" name="status" required>{(transitions[d.p.status]??[]).filter(s=>!['ready','handed_over','cleared'].includes(s)||can(c,'customs.approve')).map(s=><option>{s}</option>)}</select></div>{field('reason','Decision and evidence explanation')}<div class="field"><label for="official_ref">Official / authorised-agent reference (required at handover)</label><input id="official_ref" name="official_ref"/></div><button class="btn red">Record decision</button></form>
  </>:null}
  <p>Service fee: <Money v={d.p.fee_minor}/> · Financial status: {d.p.financial_status}. {d.p.invoice_id?<a href={`/app/invoices/${d.p.invoice_id}`}>View service invoice</a>:null}</p>{can(c,'finance.write')&&d.p.status==='cleared'&&Number(d.p.fee_minor)>0&&!d.p.invoice_id?<form method="post" action={`${url}/invoice`}><Csrf t={csrf}/><button class="btn">Issue service invoice</button></form>:null}
  <Table caption="History (immutable)" head={['Time','Status','Reason']}>{d.events.map(e=><tr><td>{formatDate(e.created_at)}</td><td>{e.status}</td><td>{e.reason}</td></tr>)}</Table>
  {can(c,'finance.write')?<section class="card"><h2>Customer deposits</h2><p>Deposit balance: <Money v={d.deposits.reduce((n,e)=>n+(e.kind==='received'?1:-1)*Number(e.amount_minor),0)}/>. Deposits are separate from service revenue. Authority disbursements and duty assessment are not implemented.</p>
   <Table head={['Reference','Kind',['Amount','num']]}>{d.deposits.map(e=><tr><td>{e.reference}</td><td>{e.kind}</td><td class="num"><Money v={e.amount_minor}/></td></tr>)}</Table>
   <form method="post" action={`${url}/deposit`}><Csrf t={csrf}/><div class="field"><label for="deposit_kind">Entry type</label><select id="deposit_kind" name="kind"><option value="received">Received</option><option value="refunded">Refunded (closed cases only)</option></select></div>{field('amount','Amount (AED)')}{field('reference','Payment reference')}<button class="btn">Record deposit entry</button></form></section>:null}
 </>);
});
for(const action of ['evidence','status','deposit'])customs.post(`${C}/:id/${action}`,async c=>{
 const id=c.req.param('id'),b=await formBody(c),url=`${C}/${id}`;
 return act(c,url,async()=>{await withT(c,(cn,ctx)=>action==='evidence'?attachEvidence(cn,ctx,id,str(b.document_id),str(b.kind)):action==='status'?transitionCase(cn,ctx,id,str(b.status),str(b.reason),str(b.official_ref)):recordDeposit(cn,ctx,id,str(b.kind),b.amount,str(b.reference)));return {to:url,ok:'Recorded.'};});
});

customs.post(`${C}/:id/invoice`,async c=>act(c,`${C}/${c.req.param('id')}`,async()=>{const inv=await withT(c,(cn,ctx)=>invoiceCase(cn,ctx,c.req.param('id')));return {to:`/app/invoices/${inv.id}`,ok:'Service invoice issued. Deposits remain separate from service revenue.'};}));
