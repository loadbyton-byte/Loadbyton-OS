import type {Conn} from '../db/client.js';
import {actorOf,require,type Ctx} from '../lib/perms.js';
import {audit} from '../lib/audit.js';
import {badRequest,forbidden,HttpError,sha256} from '../lib/util.js';
import {assertWritable,getLimit} from '../platform/entitlements.js';
import {must,recordId,reqStr} from './common.js';
const field=(key:string,label:string,type='text')=>({key,label,type});
export const DRAFT_FORMS={
 commercial_invoice:{name:'Goods commercial invoice draft',fields:[field('seller','Seller name and address'),field('buyer','Buyer name and address'),field('goods','Goods description and quantity/unit breakdown'),field('currency','Goods currency (ISO 3 letters)','currency'),field('goods_value','Declared total goods value, including explicit zero','money'),field('origin_country','Country of origin'),field('terms','Reviewed delivery/payment/tax terms')]},
 packing_list:{name:'Packing list draft',fields:[field('shipper','Shipper name and address'),field('consignee','Consignee name and address'),field('contents','Contents and package breakdown'),field('packages','Number of packages','integer'),field('gross_kg','Gross kg','decimal'),field('net_kg','Net kg','decimal'),field('volume_cbm','Volume cbm','decimal'),field('marks','Shipping marks, including explicit none')]},
 booking_confirmation:{name:'Booking confirmation draft',fields:[field('carrier','Carrier/booking provider'),field('booking_ref','Provider booking reference'),field('origin','Place of receipt/origin'),field('destination','Destination/place of delivery'),field('equipment','Equipment/service booked'),field('schedule','Schedule and time zones exactly as supplied by the provider'),field('restrictions','Reviewed booking conditions and restrictions')]},
 transport_document:{name:'Transport document draft',fields:[field('issuer_capacity','Proposed carrier/agent/forwarder issuer and capacity'),field('shipper','Shipper name and address'),field('consignee','Consignee/notify party'),field('transport_ref','Transport/master/house references'),field('route','Route and vessel/flight/vehicle as supplied'),field('cargo','Goods, package and gross weight particulars'),field('terms','Reviewed document terms and authority boundary')]},
 delivery_order:{name:'Delivery order draft',fields:[field('issuer','Proposed issuing carrier/agent'),field('receiver','Intended receiver'),field('transport_ref','Bill/AWB/consignment reference'),field('depot','Pickup terminal/depot and cargo location'),field('goods','Goods and package particulars'),field('release_conditions','Required release evidence and restrictions')]},
 shipment_instructions:{name:'Shipment instructions draft',fields:[field('shipper','Shipper'),field('consignee','Consignee/notify party'),field('booking_ref','Booking reference'),field('route','Origin, destination and intended service'),field('cargo','Goods, package and weight particulars'),field('instructions','Customer-approved instructions and restrictions')]},
} as const;
export type DraftKind=keyof typeof DRAFT_FORMS;
export const canReadGeneratedDrafts=(ctx:Ctx)=>!ctx.supportStaffId&&!ctx.partyId&&ctx.perms.has('read')&&(ctx.perms.has('job.write')||ctx.perms.has('job.cost'));
const canonical=(v:any):string=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
async function gate(c:Conn,ctx:Ctx,write=false){
 if(!canReadGeneratedDrafts(ctx))throw forbidden('Generated drafts require an authorized operating company session.');require(ctx,'read');
 if(!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='freight-forwarding'`)).rows.length)throw forbidden('Freight forwarding is not selected.');
 if(write){require(ctx,'doc.write');require(ctx,'job.write');await assertWritable(c,ctx.tenantId);}
}
export async function publishDocumentTemplate(c:Conn,ctx:Ctx,f:Record<string,unknown>){
 require(ctx,'settings.manage');await gate(c,ctx,true);const kind=String(f.kind) as DraftKind;if(!Object.hasOwn(DRAFT_FORMS,kind))throw badRequest('Choose a supported document draft.');
 const title=reqStr(f.title,'Template title',200),footer=reqStr(f.footer,'Reviewed template footer',1000),reference=recordId(f.reference,'Template reference');
 await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`${ctx.tenantId}:document-templates`]);const old=(await c.query<any>(`SELECT * FROM document_templates WHERE reference=$1`,[reference])).rows[0];if(old){if(old.kind!==kind||old.title!==title||old.footer!==footer)throw new HttpError(409,'Template reference belongs to different published content.');return old.id;}
 const version=Number((await c.query<any>(`SELECT coalesce(max(version),0)+1 n FROM document_templates WHERE kind=$1`,[kind])).rows[0].n);if(version>1000)throw badRequest('Review template version retention before publishing more versions.');
 const id=(await c.query<any>(`INSERT INTO document_templates(tenant_id,reference,kind,version,title,footer,fields,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[ctx.tenantId,reference,kind,version,title,footer,JSON.stringify(DRAFT_FORMS[kind].fields),ctx.userId])).rows[0].id;await audit(c,ctx.tenantId,actorOf(ctx),'document.template_published','document_template',id,{kind,version});return id;
}
const schemaHash=(fields:unknown)=>sha256(canonical(fields));
/** A draft may only be generated from the newest published version of its kind, and only while that version's fields still match the platform's standard form. */
async function assertTemplateUsable(c:Conn,template:any){
 const latest=Number((await c.query<any>(`SELECT max(version) n FROM document_templates WHERE kind=$1`,[template.kind])).rows[0].n);
 if(template.version<latest)throw badRequest(`A newer reviewed version (v${latest}) of this template exists. Use it so drafts follow the current reviewed wording.`);
 if(Object.hasOwn(DRAFT_FORMS,template.kind)&&schemaHash(template.fields)!==schemaHash(DRAFT_FORMS[template.kind as DraftKind].fields))throw badRequest('This template predates a change to the standard form fields. An owner must republish it (re-confirming the reviewed footer) before new drafts are generated.');
}
export async function templateStatus(c:Conn,ctx:Ctx){
 await gate(c,ctx);
 const rows=(await c.query<any>(`SELECT t.id,t.kind,t.version,t.title,t.footer,t.fields,t.created_at,(SELECT count(*) FROM generated_documents g WHERE g.template_id=t.id)::int AS drafts FROM document_templates t ORDER BY t.kind,t.version DESC`)).rows;
 return (Object.keys(DRAFT_FORMS) as DraftKind[]).map(kind=>{
  const versions=rows.filter(r=>r.kind===kind),latest=versions[0]??null;
  return {kind,name:DRAFT_FORMS[kind].name,latest:latest&&{id:latest.id,version:latest.version,title:latest.title,created_at:latest.created_at},outdated:!!latest&&schemaHash(latest.fields)!==schemaHash(DRAFT_FORMS[kind].fields),
   versions:versions.map(v=>({id:v.id,version:v.version,drafts:v.drafts,superseded:v.version<(latest?.version??0),current_fields:schemaHash(v.fields)===schemaHash(DRAFT_FORMS[kind].fields)}))};
 });
}
/** The owner re-confirms the already-reviewed wording against the changed form; a new immutable version is created and the old one is superseded. */
export async function republishTemplate(c:Conn,ctx:Ctx,f:Record<string,unknown>){
 require(ctx,'settings.manage');await gate(c,ctx,true);
 const kind=String(f.kind) as DraftKind;if(!Object.hasOwn(DRAFT_FORMS,kind))throw badRequest('Choose a supported document draft.');
 if(f.confirm_reviewed!==true&&f.confirm_reviewed!=='1'&&f.confirm_reviewed!=='on')throw badRequest('Confirm that you re-read the reviewed footer against the changed fields.');
 await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`${ctx.tenantId}:document-templates`]);
 const latest=(await c.query<any>(`SELECT * FROM document_templates WHERE kind=$1 ORDER BY version DESC LIMIT 1`,[kind])).rows[0];
 if(!latest)throw badRequest('Publish the reviewed template first.');
 if(schemaHash(latest.fields)===schemaHash(DRAFT_FORMS[kind].fields))throw badRequest('This template already matches the current form fields.');
 if(latest.version>=1000)throw badRequest('Review template version retention before publishing more versions.');
 const reference=recordId(f.reference,'Template reference'),dup=(await c.query<any>(`SELECT id FROM document_templates WHERE reference=$1`,[reference])).rows[0];if(dup)return dup.id;
 const id=(await c.query<any>(`INSERT INTO document_templates(tenant_id,reference,kind,version,title,footer,fields,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[ctx.tenantId,reference,kind,latest.version+1,latest.title,latest.footer,JSON.stringify(DRAFT_FORMS[kind].fields),ctx.userId])).rows[0].id;
 await audit(c,ctx.tenantId,actorOf(ctx),'document.template_republished','document_template',id,{kind,from:latest.version,to:latest.version+1});return id;
}
export async function diffTemplates(c:Conn,ctx:Ctx,fromId:string,toId:string){
 await gate(c,ctx);
 const a=await must(c.query<any>(`SELECT * FROM document_templates WHERE id=$1`,[recordId(fromId,'Template')]),'Template'),b=await must(c.query<any>(`SELECT * FROM document_templates WHERE id=$1`,[recordId(toId,'Template')]),'Template');
 if(a.kind!==b.kind)throw badRequest('Compare two versions of the same document kind.');
 const fa=new Map<string,any>(a.fields.map((x:any)=>[x.key,x])),fb=new Map<string,any>(b.fields.map((x:any)=>[x.key,x]));
 return {kind:a.kind,from:a.version,to:b.version,title_changed:a.title!==b.title,footer_changed:a.footer!==b.footer,
  added:[...fb.keys()].filter(k=>!fa.has(k)),removed:[...fa.keys()].filter(k=>!fb.has(k)),changed:[...fb.keys()].filter(k=>fa.has(k)&&canonical(fa.get(k))!==canonical(fb.get(k)))};
}
async function source(c:Conn,id:string){return must(c.query<any>(`SELECT j.id,j.no,j.mode,j.status,j.origin,j.destination,j.pieces,j.weight_kg,j.volume_cbm,e.name AS entity_name,e.legal_name,p.name AS customer FROM jobs j JOIN entities e ON e.id=j.entity_id JOIN parties p ON p.id=j.party_id WHERE j.id=$1`,[id]),'Job');}
export async function generateDocumentDraft(c:Conn,ctx:Ctx,f:Record<string,unknown>){
 await gate(c,ctx,true);const jobId=recordId(f.job_id,'Job'),templateId=recordId(f.template_id,'Published template'),docId=recordId(f.source_document_id,'Issued customer/provider evidence'),reference=recordId(f.reference,'Draft reference');
 const template=await must(c.query<any>(`SELECT * FROM document_templates WHERE id=$1`,[templateId]),'Published template'),snapshot=await source(c,jobId);
 await assertTemplateUsable(c,template);
 const values:Record<string,string>={};for(const spec of template.fields){const value=reqStr(f[spec.key],spec.label,1000);if(['integer','decimal','money'].includes(spec.type)){
  const pattern=spec.type==='integer'?/^\d{1,8}$/:spec.type==='money'?/^\d{1,12}(\.\d{1,2})?$/:/^\d{1,10}(\.\d{1,6})?$/;if(!pattern.test(value)||!Number.isFinite(Number(value))||spec.type==='integer'&&Number(value)<1)throw badRequest(`${spec.label} requires an exact non-negative quantity${spec.type==='integer'?' of at least one':''}.`);
 }if(spec.type==='currency'&&!/^[A-Z]{3}$/.test(value))throw badRequest('Choose a three-letter uppercase goods currency.');values[spec.key]=value;}
 if(template.kind==='packing_list'&&Number(values.net_kg)>Number(values.gross_kg))throw badRequest('Net kg cannot exceed gross kg.');
 await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`document-storage:${ctx.tenantId}`]);
 const old=(await c.query<any>(`SELECT * FROM generated_documents WHERE reference=$1`,[reference])).rows[0];if(old){if(old.job_id!==jobId||old.template_id!==templateId||old.source_document_id!==docId||canonical(old.fields)!==canonical(values))throw new HttpError(409,'Draft reference belongs to different content.');return old.id;}
 const doc=await must(c.query<any>(`SELECT id,sha256,issuer FROM documents WHERE id=$1 AND job_id=$2 AND status='issued' AND NOT hold FOR SHARE`,[docId,jobId]),'Issued source evidence for this job');
 const frozen={job:snapshot,evidence:{id:doc.id,sha256:doc.sha256,issuer:doc.issuer}},bytes=Buffer.byteLength(JSON.stringify({fields:values,source_snapshot:frozen}));if(bytes>65536)throw badRequest('Draft content is too large.');
 const limit=(await getLimit(c,ctx.tenantId,'storage_mb'))*1048576,used=Number((await c.query<any>(`SELECT (SELECT coalesce(sum(size_bytes),0) FROM documents)+(SELECT coalesce(sum(size_bytes),0) FROM generated_documents) n`)).rows[0].n);if(used+bytes>limit)throw new HttpError(402,'Document storage allowance reached. Existing drafts remain readable and exportable.');
 const version=Number((await c.query<any>(`SELECT coalesce(max(version),0)+1 n FROM generated_documents WHERE job_id=$1 AND kind=$2`,[jobId,template.kind])).rows[0].n);
 const id=(await c.query<any>(`INSERT INTO generated_documents(tenant_id,reference,job_id,template_id,source_document_id,kind,version,fields,source_snapshot,source_hash,size_bytes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,[ctx.tenantId,reference,jobId,templateId,docId,template.kind,version,JSON.stringify(values),JSON.stringify(frozen),sha256(canonical(frozen)),bytes,ctx.userId])).rows[0].id;await audit(c,ctx.tenantId,actorOf(ctx),'document.draft_generated','generated_document',id,{kind:template.kind,version,template_id:templateId,source_document_id:docId});return id;
}
export async function getDocumentDraft(c:Conn,ctx:Ctx,id:string){await gate(c,ctx);const row=await must(c.query<any>(`SELECT g.*,t.version AS template_version,t.title,t.footer,t.fields AS field_schema,d.status AS source_status,d.hold AS source_hold,d.sha256 AS current_source_hash FROM generated_documents g JOIN document_templates t ON t.id=g.template_id JOIN documents d ON d.id=g.source_document_id WHERE g.id=$1`,[recordId(id)]),'Generated draft');await source(c,row.job_id);if(sha256(canonical(row.source_snapshot))!==row.source_hash)throw new HttpError(409,'Draft snapshot integrity failed.');return row;}
export async function documentDraftWorkspace(c:Conn,ctx:Ctx,page=1){await gate(c,ctx);return {drafts:(await c.query<any>(`SELECT g.id,g.job_id,g.kind,g.version,g.created_at,j.no,t.title,t.version AS template_version FROM generated_documents g JOIN jobs j ON j.id=g.job_id JOIN document_templates t ON t.id=g.template_id ORDER BY g.created_at DESC,g.id LIMIT 51 OFFSET $1`,[(Math.min(100000,Math.max(1,page))-1)*50])).rows,templates:(await c.query<any>(`SELECT * FROM document_templates ORDER BY kind,version DESC LIMIT 300`)).rows,jobs:(await c.query<any>(`SELECT id,no,mode FROM jobs ORDER BY created_at DESC LIMIT 300`)).rows,documents:(await c.query<any>(`SELECT d.id,d.job_id,d.title,j.no FROM documents d JOIN jobs j ON j.id=d.job_id WHERE d.status='issued' AND NOT d.hold ORDER BY d.created_at DESC LIMIT 300`)).rows};}
