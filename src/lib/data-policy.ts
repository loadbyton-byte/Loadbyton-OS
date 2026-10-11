import type {Ctx} from './perms.js';

/** Recipient contact is operational delivery data; financial/read-only roles do not need it. */
export const canReadFulfilmentRecipient=(ctx:Ctx)=>!ctx.supportStaffId&&(ctx.perms.has('wh.write')||ctx.perms.has('wh.floor')||(ctx.roles.length===1&&ctx.roles[0]==='portal'&&!!ctx.partyId));
export function redactFulfilmentRecipient<T extends Record<string,any>>(row:T,ctx:Ctx):T{
 if(canReadFulfilmentRecipient(ctx)&&(!ctx.partyId||row.party_id===ctx.partyId))return row;
 return {...row,ship_to_name:'Restricted recipient',ship_to_phone:null,ship_to_address:null};
}
export const listPage=(page:number)=>Math.min(100000,Math.max(1,Number.isSafeInteger(page)?page:1));

/**
 * Per-field authorisation for personal data in legacy modules. A role sees a field only if it holds one of the listed
 * permissions; otherwise the value is replaced by a marker (text) or null. Support-staff sessions never see these fields.
 */
export const FIELD_POLICY: Record<string, Record<string, import('./perms.js').Perm[]>> = {
 parties:{email:['party.write','finance.write'],phone:['party.write','finance.write'],tax_id:['party.write','finance.write']},
 dlv_shipments:{consignee_name:['dlv.write'],consignee_phone:['dlv.write'],address:['dlv.write'],delivered_to:['dlv.write']},
 drivers:{phone:['transport.write'],licence_no:['transport.write']},
 inbound_events:{sender:['inbox.write'],sender_norm:['inbox.write'],sender_name:['inbox.write'],subject:['inbox.write'],body:['inbox.write']},
 contact_identities:{address:['inbox.write','party.write']},
};
export const canReadField=(table:string,field:string,ctx:Ctx)=>{const need=FIELD_POLICY[table]?.[field];return !need||(!ctx.supportStaffId&&need.some(p=>ctx.perms.has(p)));};
export function redactFields<T extends Record<string,any>>(table:string,row:T,ctx:Ctx):T{
 const rules=FIELD_POLICY[table];if(!rules)return row;let out:Record<string,any>|null=null;
 for(const f of Object.keys(rules))if(f in row&&row[f]!==null&&!canReadField(table,f,ctx)){out??={...row};out[f]=typeof row[f]==='string'&&['consignee_name','delivered_to','address','sender','sender_name','subject','body'].includes(f)?'Restricted':null;}
 return (out??row) as T;
}
