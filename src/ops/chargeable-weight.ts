import {z} from 'zod';
import type {Conn} from '../db/client.js';
import {actorOf,require,type Ctx} from '../lib/perms.js';
import {audit} from '../lib/audit.js';
import {badRequest,forbidden,HttpError} from '../lib/util.js';
import {assertWritable} from '../platform/entitlements.js';
import {must,recordId,reqStr,today} from './common.js';

export interface WeightRule {mode:string;formula:string;coefficient:number;increment:number;minimum:number}
const positive=z.coerce.number().finite().positive().max(1e9);
const schema=z.object({mode:z.enum(['air','road','ocean']),formula:z.enum(['volumetric_kg','weight_measure']),coefficient:positive,increment:positive,minimum:z.coerce.number().finite().min(0).max(1e9),valid_from:z.iso.date(),valid_until:z.iso.date()});
async function gate(c:Conn,ctx:Ctx,write=false){require(ctx,write?'quote.write':'read');if(write)await assertWritable(c,ctx.tenantId);if(!(await c.query(`SELECT 1 FROM tenant_sectors WHERE sector='freight-forwarding'`)).rows.length)throw forbidden('Freight forwarding is not selected.');}

/** No universal divisor or rounding defaults: every coefficient must come from reviewed provider evidence. */
export function calculateChargeable(rule:WeightRule,grossKg:number,volumeCbm:number){
 const parsed=schema.pick({mode:true,formula:true,coefficient:true,increment:true,minimum:true}).safeParse(rule);
 if(!parsed.success||!positive.safeParse(grossKg).success||!positive.safeParse(volumeCbm).success)throw badRequest('Use finite positive weight, volume, coefficient and increment values.');
 if((rule.formula==='weight_measure')!==(rule.mode==='ocean'))throw badRequest('Weight/measure is an ocean rule; volumetric kg is an air or road rule.');
 // coefficient = cm³ per kg for volumetric rules, kg per revenue tonne for ocean W/M.
 const dimensional=rule.formula==='volumetric_kg'?volumeCbm*1e6/rule.coefficient:volumeCbm;
 const weight=rule.formula==='volumetric_kg'?grossKg:grossKg/rule.coefficient;
 const unrounded=Math.max(weight,dimensional,rule.minimum),steps=unrounded/rule.increment;
 // Suppress floating-point noise at an exact increment, without rounding a real excess down.
 const nearest=Math.round(steps),roundedSteps=Math.abs(steps-nearest)<=Number.EPSILON*Math.max(1,Math.abs(steps))*8?nearest:Math.ceil(steps);
 const chargeable=Number((roundedSteps*rule.increment).toFixed(6));
 if(!Number.isFinite(chargeable)||chargeable<=0||chargeable>1e9||rule.increment<0.000001)throw badRequest('The calculated quantity or rounding precision is outside supported limits.');
 return {gross_kg:grossKg,volume_cbm:volumeCbm,weight_basis:weight,dimensional_basis:dimensional,minimum:rule.minimum,unrounded,increment:rule.increment,chargeable,unit:rule.formula==='volumetric_kg'?'kg':'revenue_tonne',formula:rule.formula,coefficient:rule.coefficient};
}

export async function createWeightRule(c:Conn,ctx:Ctx,f:Record<string,unknown>){
 require(ctx,'rate.write');require(ctx,'quote.approve');await gate(c,ctx);await assertWritable(c,ctx.tenantId);
 const parsed=schema.safeParse(f);if(!parsed.success)throw badRequest('Enter a valid provider rule, explicit coefficient, rounding and date range.');
 const v=parsed.data;if(v.valid_until<v.valid_from||v.valid_until<today()||v.increment<0.000001||v.coefficient<0.000001)throw badRequest('Check rule validity and numeric precision.');
 for(const value of [v.coefficient,v.increment,v.minimum])if(Math.abs(value*1e6-Math.round(value*1e6))>Number.EPSILON*Math.max(1,Math.abs(value*1e6))*8)throw badRequest('Provider coefficients, rounding and minimums support at most six decimal places.');
 calculateChargeable(v,1,1);
 const doc=recordId(f.document_id,'Issued provider rule document');await must(c.query(`SELECT id FROM documents WHERE id=$1 AND status='issued' AND NOT hold`,[doc]),'Issued provider rule evidence');
 const provider=reqStr(f.provider,'Provider',200),reviewer=reqStr(f.reviewer,'Qualified reviewer',200),scope=reqStr(f.scope,'Reviewed service, lane, equipment restrictions and exclusions',2000);
 const r=await c.query<{id:string}>(`INSERT INTO weight_rules(tenant_id,provider,mode,formula,coefficient,increment,minimum,valid_from,valid_until,document_id,reviewer,scope,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,[ctx.tenantId,provider,v.mode,v.formula,v.coefficient,v.increment,v.minimum,v.valid_from,v.valid_until,doc,reviewer,scope,ctx.userId]);
 await audit(c,ctx.tenantId,actorOf(ctx),'weight.rule_reviewed','weight_rule',r.rows[0].id,{provider,reviewer,document_id:doc});return r.rows[0].id;
}

export async function assessEnquiryWeight(c:Conn,ctx:Ctx,enquiryId:string,ruleId:string,reference:string,scopeConfirmed=false){
 await gate(c,ctx,true);const enquiry=recordId(enquiryId,'Enquiry'),rule=recordId(ruleId,'Provider rule'),ref=recordId(reference,'Calculation reference');
 if(scopeConfirmed!==true)throw badRequest('Confirm that the reviewed service, lane and cargo restrictions apply to this enquiry.');
 // Preserve the first assessment for a repeated submission; changed references are a conflict.
 const existing=(await c.query<any>(`SELECT * FROM weight_assessments WHERE reference=$1`,[ref])).rows[0];
 if(existing){if(existing.enquiry_id!==enquiry||existing.rule_id!==rule)throw new HttpError(409,'This calculation reference belongs to different inputs.');return existing.id;}
 const e=await must(c.query<any>(`SELECT * FROM enquiries WHERE id=$1`,[enquiry]),'Enquiry');
 const r=await must(c.query<any>(`SELECT r.* FROM weight_rules r JOIN documents d ON d.id=r.document_id WHERE r.id=$1 AND r.valid_from<=current_date AND r.valid_until>=current_date AND d.status='issued' AND NOT d.hold`,[rule]),'Current issued provider rule');
 if(e.mode!==r.mode)throw badRequest('The provider rule mode must match the enquiry.');
 const result=calculateChargeable({...r,coefficient:Number(r.coefficient),increment:Number(r.increment),minimum:Number(r.minimum)},Number(e.weight_kg),Number(e.volume_cbm));
 const explanation={...result,provider:r.provider,reviewer:r.reviewer,scope:r.scope,scope_confirmed:true,scope_confirmed_by:ctx.userId,source_document_id:r.document_id,rule_valid_from:r.valid_from,rule_valid_until:r.valid_until};
 const saved=await c.query<{id:string}>(`INSERT INTO weight_assessments(tenant_id,enquiry_id,rule_id,reference,gross_kg,volume_cbm,chargeable,unit,explanation,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,reference) DO NOTHING RETURNING id`,[ctx.tenantId,enquiry,rule,ref,result.gross_kg,result.volume_cbm,result.chargeable,result.unit,JSON.stringify(explanation),ctx.userId]);
 if(!saved.rows.length){const old=await must(c.query<any>(`SELECT * FROM weight_assessments WHERE reference=$1`,[ref]),'Calculation');if(old.enquiry_id!==enquiry||old.rule_id!==rule)throw new HttpError(409,'This calculation reference belongs to different inputs.');return old.id;}
 await audit(c,ctx.tenantId,actorOf(ctx),'weight.assessed','weight_assessment',saved.rows[0].id,{enquiry_id:enquiry,rule_id:rule,chargeable:result.chargeable,unit:result.unit});return saved.rows[0].id;
}

export async function weightWorkspace(c:Conn,ctx:Ctx,page=1){await gate(c,ctx);return {rules:(await c.query<any>(`SELECT r.*,d.title AS document_title,d.status AS document_status,d.hold FROM weight_rules r JOIN documents d ON d.id=r.document_id ORDER BY r.created_at DESC LIMIT 300`)).rows,assessments:(await c.query<any>(`SELECT a.*,e.no,r.provider FROM weight_assessments a JOIN enquiries e ON e.id=a.enquiry_id JOIN weight_rules r ON r.id=a.rule_id ORDER BY a.created_at DESC,a.id LIMIT 51 OFFSET $1`,[(page-1)*50])).rows,enquiries:(await c.query<any>(`SELECT id,no,mode,weight_kg,volume_cbm FROM enquiries ORDER BY created_at DESC LIMIT 300`)).rows,documents:(await c.query<any>(`SELECT id,title FROM documents WHERE status='issued' AND NOT hold ORDER BY created_at DESC LIMIT 300`)).rows};}
