import {providerJson,type Fetcher} from './http.js';
import type {AccountingAdapter,AccountingInvoice} from './accounting.js';

export interface ZohoSettings {region:'com'|'in'|'eu'|'com.au'|'jp'|'ca'|'sa';clientId:string;clientSecret:string;refreshToken:string;organizationId:string;currencyIds:Record<string,string>;taxIds:Record<string,string>}
export function zohoBooksAdapter(settings:ZohoSettings,fetcher:Fetcher=fetch):AccountingAdapter {
 if(!['com','in','eu','com.au','jp','ca','sa'].includes(settings.region))throw new Error('Unsupported Zoho region');
 let token='',expires=0;
 const api=async(path:string,init:RequestInit={})=>{
  if(Date.now()>=expires) {
   const b=new URLSearchParams({grant_type:'refresh_token',client_id:settings.clientId,client_secret:settings.clientSecret,refresh_token:settings.refreshToken});
   const r=await providerJson('Zoho authorization',`https://accounts.zoho.${settings.region}/oauth/v2/token`,{method:'POST',body:b},fetcher);
   if(!r.access_token)throw new Error('Zoho authorization expired or revoked');token=r.access_token;expires=Date.now()+Math.max(0,Number(r.expires_in??3600)-60)*1000;
  }
  const u=new URL(`https://www.zohoapis.${settings.region}/books/v3/${path}`);u.searchParams.set('organization_id',settings.organizationId);
  const r=await providerJson('Zoho Books',u.toString(),{...init,headers:{Authorization:`Zoho-oauthtoken ${token}`,'Content-Type':'application/json',...init.headers}},fetcher);
  if(r.code!==0)throw new Error('Zoho Books rejected the accounting request');
  return r;
 };
 const check=(record:any,expected?:AccountingInvoice)=>{
  if(expected&&(record.currency_code!==expected.currency||Math.round(Number(record.total)*100)!==expected.totalMinor))throw new Error('Zoho invoice amount/currency differs; controller review required');
  return {externalId:String(record.invoice_id)};
 };
 return {
  async find(reference,expected) {
   const r=await api(`invoices?reference_number=${encodeURIComponent(reference)}`);
   const matches=(r.invoices??[]).filter((i:any)=>i.reference_number===reference);
   if(matches.length>1)throw new Error('Multiple Zoho invoices share the reference; controller review required');
   if(!matches.length)return null;
   const full=await api(`invoices/${encodeURIComponent(matches[0].invoice_id)}`);
   return check(full.invoice,expected);
  },
  async create(inv) {
   const currencyId=settings.currencyIds[inv.currency];if(!currencyId)throw new Error('Map this invoice currency in the accounting connection first');
   const contacts=await api(`contacts?contact_name=${encodeURIComponent(inv.customer)}`);
   const matches=(contacts.contacts??[]).filter((p:any)=>p.contact_name===inv.customer&&p.contact_type==='customer');
   if(matches.length>1)throw new Error('Ambiguous Zoho customer; reconcile customer master data');
   let customer=matches[0];
   if(!customer)customer=(await api('contacts',{method:'POST',body:JSON.stringify({contact_name:inv.customer,contact_type:'customer',currency_id:currencyId})})).contact;
   const line_items=inv.lines.map(l=>{
    const taxId=settings.taxIds[l.taxCode];if(!taxId)throw new Error(`Map accounting tax code ${l.taxCode} first`);
    return {name:l.description,description:l.description,quantity:l.qty,rate:l.unitMinor/100,tax_id:taxId};
   });
   // Create a DRAFT only. Sending/posting remains a controller's decision in the system of record.
   const r=await api('invoices',{method:'POST',body:JSON.stringify({customer_id:customer.contact_id,currency_id:currencyId,reference_number:inv.reference,date:inv.issuedAt.slice(0,10),due_date:inv.dueAt.slice(0,10),line_items})});
   return check(r.invoice,inv);
  },
 };
}
