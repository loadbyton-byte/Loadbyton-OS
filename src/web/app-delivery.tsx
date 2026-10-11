import { Hono } from "hono";
import crypto from "node:crypto";
import { HttpError, TAX_CODES, formatDate } from "../lib/util.js";
import { createParcel, dispatchParcel, recordAttempt, cancelParcel, receiveCash, reconcileCod, remitCod, invoiceParcel, listParcels, getParcel } from "../ops/delivery.js";
import { invite } from "../ops/team.js";
import { config } from "../config.js";
import { listParties } from "../ops/crm.js";
import { createDriver, listDrivers } from "../ops/transport.js";
import {COD_ADJUSTMENT_KINDS,codBalance,listCodAdjustments,uploadCodEvidence,proposeCodAdjustment,decideCodAdjustment} from '../ops/cod-adjustments.js';
import { formBody, str, type Env } from "./mw.js";
import { act, appPage, can, ctxOf, need, PageHead, PostBtn, withT } from "./appkit.js";
import { Badge, Csrf, Money, Table } from "./ui.js";

export const delivery = new Hono<Env>();
const D="/app/delivery";
const field=(name:string,label:string,type="text",value="")=><div class="field"><label for={name}>{label}</label><input id={name} name={name} type={type} value={value} required step={type==='number' ? '0.01' : undefined} min={type==='number' ? '0' : undefined} /></div>;
const pageNumber=(v: string | undefined)=>Math.min(100000,Math.max(1,Number.parseInt(v ?? '1',10)||1));

for (const path of [D,`${D}/parcels`]) delivery.get(path,async c=>{
  need(c,'read');
  const page=pageNumber(c.req.query('page'));
  const rows=await withT(c,cn=>listParcels(cn,{page,status:c.req.query('status')}));
  return appPage(c,'Delivery',<>
    <PageHead title="Delivery & COD" sub="Parcel attempts, courier cash handover and merchant remittances.">{can(c,'delivery.write') ? <a class="btn red" href={`${D}/new`}>New parcel</a> : null}<a class="btn" href={`${D}/couriers`}>Couriers</a></PageHead>
    <form method="get" class="inline-form"><label for="status">Status</label><select id="status" name="status"><option value="">All</option>{['ready','out_for_delivery','failed','delivered','returned','cancelled'].map(s=><option selected={c.req.query('status')===s}>{s}</option>)}</select><button class="btn">Filter</button></form>
    <Table head={['Parcel','Merchant','Route / courier','Status',['Expected COD','num'],['Collected','num'],['Original handover','num'],['Approved cash change','num'],['Cash after changes','num'],['Remitted','num'],'Review']} empty={rows.length ? undefined : 'No parcels.'}>
      {rows.slice(0,50).map(p=><tr><td><a href={`${D}/parcels/${p.id}`}>{p.no}</a><div class="small">{p.external_ref}</div></td><td>{p.merchant}</td><td>{p.route_ref ?? '—'} / {p.courier ?? '—'}</td><td><Badge s={p.status} /></td><td class="num"><Money v={p.cod_expected_minor}/></td><td class="num">{p.cod_collected_minor==null ? '—' : <Money v={p.cod_collected_minor}/>}</td><td class="num">{p.received_minor==null ? '—' : <Money v={p.received_minor}/>}</td><td class="num"><Money v={p.cash_change_minor}/></td><td class="num">{p.adjusted_cash_minor==null?'—':<Money v={p.adjusted_cash_minor}/>}</td><td class="num"><Money v={p.remitted_minor}/></td><td>{p.decision_id ? 'Reconciled' : p.status==='delivered' && Number(p.cod_expected_minor)>0 ? 'Pending' : '—'}</td></tr>)}
    </Table>
    <nav aria-label="Parcel pages">{page>1 ? <a href={`${D}?page=${page-1}&status=${encodeURIComponent(c.req.query('status')??'')}`}>Previous</a> : null} <span>Page {page}</span> {rows.length>50 ? <a href={`${D}?page=${page+1}&status=${encodeURIComponent(c.req.query('status')??'')}`}>Next</a> : null}</nav>
  </>);
});
delivery.get(`${D}/new`,async c=>{
  need(c,'delivery.write');
  const parties=await withT(c,cn=>listParties(cn,'customer'));
  return appPage(c,'New parcel',<><PageHead title="New parcel"/><form method="post" action={`${D}/parcels`} class="card"><Csrf t={c.get('csrf')}/>
    <div class="field"><label for="party_id">Merchant</label><select id="party_id" name="party_id" required><option value="">Select</option>{parties.map(p=><option value={p.id}>{p.name}</option>)}</select></div>
    {field('external_ref','Merchant reference')}{field('recipient_name','Recipient')}{field('recipient_phone','Phone')}{field('address','Delivery address')}
    {field('fee','Service fee (AED)','number','0')}{field('cod','Expected COD (AED; zero for prepaid)','number','0')}
    <div class="field"><label for="tax_code">Service tax</label><select id="tax_code" name="tax_code">{Object.entries(TAX_CODES).map(([k,v])=><option value={k}>{v.label}</option>)}</select></div>
    <button class="btn red">Create parcel</button></form></>);
});
delivery.post(`${D}/parcels`,async c=>{
  need(c,'delivery.write');const b=await formBody(c);
  return act(c,`${D}/new`,async()=>{const p=await withT(c,(cn,ctx)=>createParcel(cn,ctx,b));return {to:`${D}/parcels/${p.id}`,ok:p.duplicate?'Already created.':'Parcel created.'};});
});
delivery.get(`${D}/couriers`,async c=>{
  need(c,'read');const rows=await withT(c,listDrivers);
  return appPage(c,'Couriers',<><PageHead title="Couriers" sub="Create a courier and invite an individual driver login before dispatching parcels."/>
    {c.req.query("link") ? <p class="alert info">Invitation link (expires in 7 days): <code>{config.baseUrl}/invite/{c.req.query("link")}</code></p> : null}
    <Table head={['Name','Phone','Login']} empty={rows.length ? undefined : 'No couriers.'}>{rows.map(d=><tr><td>{d.name}</td><td>{d.phone}</td><td>{d.login_email ?? (can(c,'team.manage') ? <form method="post" action={`${D}/couriers/${d.id}/invite`}><Csrf t={c.get('csrf')}/><input name="email" type="email" aria-label="Courier email" required/><button class="btn sm">Invite courier</button></form> : 'Ask an owner to invite this courier')}</td></tr>)}</Table>
    {can(c,'delivery.write') ? <form class="card" method="post" action={`${D}/couriers`}><Csrf t={c.get('csrf')}/>{field('name','Courier name')}{field('phone','Phone')}<button class="btn">Add courier</button></form> : null}</>);
});
delivery.post(`${D}/couriers`,async c=>{need(c,'delivery.write');const b=await formBody(c);return act(c,`${D}/couriers`,async()=>{await withT(c,(cn,ctx)=>createDriver(cn,ctx,b));return {to:`${D}/couriers`,ok:'Courier created. Invite a driver login here.'};});});

delivery.post(`${D}/couriers/:id/invite`,async c=>{need(c,'team.manage');const b=await formBody(c);return act(c,`${D}/couriers`,async()=>{const token=await withT(c,(cn,ctx)=>invite(cn,ctx,{email:str(b.email),roles:['driver'],driver_id:c.req.param('id')}));return {to:`${D}/couriers?link=${token}`,ok:'Invitation created.'};});});

// A limited driver seat can only see or act on parcels assigned to its linked driver record.
delivery.get('/app/driver/deliveries',async c=>{
  need(c,'driver.act');const ctx=ctxOf(c);if (!ctx.driverId) throw new HttpError(403,'No courier profile is linked.');
  const rows=await withT(c,cn=>listParcels(cn,{driverId:ctx.driverId!,page:pageNumber(c.req.query('page')),status:'out_for_delivery'}));
  return appPage(c,'My parcels',<><PageHead title="My parcels"/>{rows.slice(0,50).map(p=><a class="card driver-card" href={`/app/driver/deliveries/${p.id}`}><h2>{p.no}</h2><p>{p.route_ref} · {p.recipient_name}</p><p>Collect <Money v={p.cod_expected_minor}/></p></a>)}{!rows.length ? <p>No parcels assigned.</p> : null}{rows.length>50 ? <a href={`/app/driver/deliveries?page=${pageNumber(c.req.query('page'))+1}`}>Next</a> : null}</>);
});
async function detail(c: any, driverView: boolean) {
  need(c,driverView ? 'driver.act' : 'read');
  const id=c.req.param('id'),ctx=ctxOf(c),{p,attempts,cash,decision,remittances}=await withT(c,cn=>getParcel(cn,id));
  if (driverView && (!ctx.driverId || p.driver_id!==ctx.driverId)) throw new HttpError(404,'Parcel not found');
  const csrf=c.get('csrf'),base=driverView ? '/app/driver/deliveries' : `${D}/parcels`,url=`${base}/${id}`;
  const couriers=driverView ? [] : await withT(c,listDrivers);
  const finance=!driverView && can(c,'delivery.finance'),write=driverView || can(c,'delivery.write');
  const ledger=finance&&decision?await withT(c,async cn=>({balance:await codBalance(cn,id),adjustments:await listCodAdjustments(cn,id),documents:(await cn.query<any>(`SELECT id,title,issuer FROM documents WHERE delivery_parcel_id=$1 AND status='issued' AND NOT hold AND NOT EXISTS(SELECT 1 FROM delivery_cash_adjustments a WHERE a.document_id=documents.id) ORDER BY created_at DESC LIMIT 500`,[id])).rows})):null;
  return appPage(c,p.no,<>
    <PageHead title={`${p.no} · ${p.merchant}`} sub={`${p.external_ref} · ${p.route_ref ?? 'No route'}`}><Badge s={p.status}/></PageHead>
    {!driverView&&p.fulfilment_order_id?<p>Fulfilment source: <a href={`/app/fulfilment/orders/${p.fulfilment_order_id}`}>shipment {p.fulfilment_tracking}</a>. Handling fees remain in Fulfilment; this parcel tracks delivery service and COD.</p>:null}
    <section class="card">{write ? <><p>{p.recipient_name} · {p.recipient_phone}</p><p>{p.address}</p></> : <p>Recipient contact details are restricted to delivery operators.</p>}<p>Expected COD: <Money v={p.cod_expected_minor}/></p></section>
    {!driverView && can(c,'delivery.write') && ['ready','failed'].includes(p.status) ? <form class="card" method="post" action={`${url}/dispatch`}><Csrf t={csrf}/><div class="field"><label for="driver_id">Courier</label><select id="driver_id" name="driver_id" required>{couriers.filter(d=>d.login_email).map(d=><option value={d.id}>{d.name}</option>)}</select></div>{field('route_ref','Route reference')}<button class="btn red">Dispatch / retry</button></form> : null}
    {write && p.status==='out_for_delivery' ? <form class="card" method="post" action={`${url}/attempt`}><Csrf t={csrf}/><input type="hidden" name="client_ref" value={crypto.randomUUID()}/><div class="field"><label for="outcome">Outcome</label><select id="outcome" name="outcome"><option value="delivered">Delivered</option><option value="failed">Failed attempt</option></select></div><div class="field"><label for="pod_name">Received by (required on delivery)</label><input id="pod_name" name="pod_name"/></div><div class="field"><label for="reason">Failure reason</label><input id="reason" name="reason"/></div>{field('collected','Actual COD collected (AED)','number','0')}<button class="btn red big">Record attempt</button></form> : null}
    {!driverView && can(c,'delivery.write') && ['failed','ready'].includes(p.status) ? <form method="post" action={`${url}/attempt`} class="card"><Csrf t={csrf}/><input type="hidden" name="outcome" value="returned"/><input type="hidden" name="client_ref" value={crypto.randomUUID()}/>{field('reason','Return-to-merchant reason')}<button class="btn">Record return</button></form> : null}
    {!driverView && can(c,'delivery.write') && p.status==='ready' ? <form method="post" action={`${url}/cancel`} class="card"><Csrf t={csrf}/>{field('reason','Cancellation reason')}<button class="btn danger">Cancel parcel</button></form> : null}
    <Table caption="Attempts (immutable)" head={['Time','Outcome','Evidence / reason',['Collected','num']]}>{attempts.map(a=><tr><td>{formatDate(a.occurred_at)}</td><td>{a.outcome}</td><td>{a.pod_name ?? a.reason}</td><td class="num"><Money v={a.cod_collected_minor}/></td></tr>)}</Table>
    {finance && p.status==='delivered' && Number(p.cod_expected_minor)>0 ? <section class="card"><h2>COD reconciliation</h2><p>COD is merchant cash, separate from the service invoice. Variance decisions preserve the original figures; they do not create extra cash or erase shortages.</p>
      {!cash ? <form method="post" action={`${url}/cash`}><Csrf t={csrf}/>{field('amount','Cash received from courier (AED)','number','0')}{field('reference','Cash handover reference')}<button class="btn">Record handover</button></form> : <p>Cash handed over: <Money v={cash.amount_minor}/></p>}
      {cash && !decision ? <form method="post" action={`${url}/reconcile`}><Csrf t={csrf}/>{field('reason','Reconciliation explanation (different approver required for a mismatch)')}<button class="btn">Confirm reconciliation</button></form> : null}
      {decision ? <><p>Reviewed: {decision.reason}. Collection variance: <Money v={Number(decision.collected_minor)-Number(decision.expected_minor)}/>; handover variance: <Money v={Number(decision.received_minor)-Number(decision.collected_minor)}/>.</p><form method="post" action={`${url}/remit`}><Csrf t={csrf}/>{field('amount','Amount remitted to merchant (AED)','number')}{field('reference','Bank/payment reference')}<button class="btn">Record merchant remittance</button></form></> : null}
      <Table head={['Reference',['Remitted','num']]}>{remittances.map(r=><tr><td>{r.reference}</td><td class="num"><Money v={r.amount_minor}/></td></tr>)}</Table></section> : null}
    {ledger?<section class="card"><h2>COD cash adjustments</h2><p>Record evidenced cash recovery, refunds and corrections with a second finance approver. These records do not make bank payments, erase original collections or handovers, or approve a merchant-liability write-off.</p><p>Original merchant entitlement: <Money v={ledger.balance.expected}/> · Outstanding to merchant: <Money v={ledger.balance.merchantOutstanding}/> · Approved cash change: <Money v={ledger.balance.delta}/> · Available to remit: <Money v={ledger.balance.remittable}/> · Unresolved shortage: <Money v={ledger.balance.shortage}/> · Surplus cash: <Money v={ledger.balance.surplus}/></p>
      <Table head={['Kind / amount','Evidence / explanation','Decision']}>{ledger.adjustments.map(a=><tr><td>{a.kind} · <Money v={a.amount_minor}/></td><td><a href={`/app/documents/${a.document_id}/download`}>Issued cash evidence</a><p>{a.reason}</p>{a.evidence_hold||a.evidence_status!=='issued'?<p class="alert warn">Evidence is currently unavailable; review this record.</p>:null}</td><td>{a.decision_id?<>{a.approved?'Approved':'Rejected'}: {a.review_reason}</>:a.requested_by===ctx.userId?'Awaiting another finance approver':<form method="post" action={`${url}/adjustments/${a.id}/decide`}><Csrf t={csrf}/><input name="reason" aria-label="Independent cash review explanation" required maxlength={1000}/><button class="btn sm" name="approved" value="true">Approve cash evidence</button><button class="btn ghost sm" name="approved" value="false">Reject</button></form>}</td></tr>)}</Table>
      <form method="post" action={`${url}/cash-evidence`} enctype="multipart/form-data"><Csrf t={csrf}/><h3>Upload issued cash evidence</h3><label>Actual external issuer<input name="issuer" required maxlength={200}/></label><label>Receipt/payment proof file<input name="file" type="file" required/></label><button class="btn">Upload cash evidence</button></form>
      {ledger.documents.length?<form method="post" action={`${url}/adjustments`}><Csrf t={csrf}/><input type="hidden" name="reference" value={crypto.randomUUID()}/><h3>Propose an immutable cash adjustment</h3><label>Kind<select name="kind">{COD_ADJUSTMENT_KINDS.map(k=><option value={k}>{k.replace(/_/g,' ')}</option>)}</select></label><label>Amount (AED)<input name="amount" type="number" min="0.01" step="0.01" required/></label><label>Issued evidence for this parcel<select name="document_id">{ledger.documents.map(d=><option value={d.id}>{d.title} · {d.issuer}</option>)}</select></label><label>Cash explanation and external reference<textarea name="reason" required maxlength={1000}/></label><button class="btn">Submit for second-person review</button></form>:null}
    </section>:null}
    {!driverView && can(c,'finance.write') && ['delivered','returned'].includes(p.status) ? p.invoice_id ? <a href={`/app/invoices/${p.invoice_id}`}>Service invoice</a> : <PostBtn action={`${url}/invoice`} csrf={csrf} label="Invoice service fee"/> : null}
  </>);
}
delivery.get(`${D}/parcels/:id`,c=>detail(c,false));
delivery.get('/app/driver/deliveries/:id',c=>detail(c,true));
delivery.post(`${D}/parcels/:id/cash-evidence`,async c=>{const id=c.req.param('id'),b=await formBody(c),url=`${D}/parcels/${id}`;return act(c,url,async()=>{const file=b.file;if(!(file instanceof File))throw new HttpError(400,'Select cash evidence.');if(file.size>config.maxUploadBytes)throw new HttpError(413,'File too large');const data=Buffer.from(await file.arrayBuffer());await withT(c,(cn,ctx)=>uploadCodEvidence(cn,ctx,id,{filename:file.name,data,issuer:str(b.issuer)}));return {to:url,ok:'Issued evidence uploaded. No cash balance changed.'};});});
delivery.post(`${D}/parcels/:id/adjustments`,async c=>{const id=c.req.param('id'),b=await formBody(c),url=`${D}/parcels/${id}`;return act(c,url,async()=>{await withT(c,(cn,ctx)=>proposeCodAdjustment(cn,ctx,id,b));return {to:url,ok:'Cash adjustment awaiting a second finance approver.'};});});
delivery.post(`${D}/parcels/:id/adjustments/:adjustment/decide`,async c=>{const id=c.req.param('id'),b=await formBody(c),url=`${D}/parcels/${id}`;return act(c,url,async()=>{if(!['true','false'].includes(str(b.approved)))throw new HttpError(400,'Choose approve or reject');await withT(c,async(cn,ctx)=>{const found=(await cn.query(`SELECT 1 FROM delivery_cash_adjustments WHERE id=$1 AND parcel_id=$2`,[c.req.param('adjustment'),id])).rows.length;if(!found)throw new HttpError(404,'Adjustment not found');await decideCodAdjustment(cn,ctx,c.req.param('adjustment'),str(b.approved)==='true',str(b.reason));});return {to:url,ok:'Independent cash decision recorded.'};});});
for (const base of [`${D}/parcels`,'/app/driver/deliveries']) delivery.post(`${base}/:id/attempt`,async c=>{
  const id=c.req.param('id'),b=await formBody(c);return act(c,`${base}/${id}`,async()=>{const r=await withT(c,(cn,ctx)=>recordAttempt(cn,ctx,id,b));return {to:`${base}/${id}`,ok:r.duplicate ? 'Already recorded.' : 'Attempt recorded.'};});
});
for (const action of ['dispatch','cancel','cash','reconcile','remit','invoice']) delivery.post(`${D}/parcels/:id/${action}`,async c=>{
  const id=c.req.param('id'),b=await formBody(c),url=`${D}/parcels/${id}`;
  return act(c,url,async()=>{
    const result=await withT(c,async(cn,ctx)=>{
      if(action==='dispatch') return dispatchParcel(cn,ctx,id,str(b.driver_id),str(b.route_ref));
      if(action==='cancel') return cancelParcel(cn,ctx,id,str(b.reason));
      if(action==='cash') return receiveCash(cn,ctx,id,b.amount,str(b.reference));
      if(action==='reconcile') return reconcileCod(cn,ctx,id,str(b.reason));
      if(action==='remit') return remitCod(cn,ctx,id,b.amount,str(b.reference));
      return invoiceParcel(cn,ctx,id);
    });
    return {to:action==='invoice' && result && 'id' in result ? `/app/invoices/${result.id}` : url,ok:'Recorded.'};
  });
});
