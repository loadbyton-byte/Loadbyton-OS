import type {Ctx} from './perms.js';

/** Recipient contact is operational delivery data; financial/read-only roles do not need it. */
export const canReadFulfilmentRecipient=(ctx:Ctx)=>!ctx.supportStaffId&&(ctx.perms.has('wh.write')||ctx.perms.has('wh.floor')||(ctx.roles.length===1&&ctx.roles[0]==='portal'&&!!ctx.partyId));
export function redactFulfilmentRecipient<T extends Record<string,any>>(row:T,ctx:Ctx):T{
 if(canReadFulfilmentRecipient(ctx)&&(!ctx.partyId||row.party_id===ctx.partyId))return row;
 return {...row,ship_to_name:'Restricted recipient',ship_to_phone:null,ship_to_address:null};
}
export const listPage=(page:number)=>Math.min(100000,Math.max(1,Number.isSafeInteger(page)?page:1));
