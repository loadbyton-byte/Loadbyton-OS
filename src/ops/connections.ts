import type {Conn} from '../db/client.js';
import {require,type Ctx,actorOf} from '../lib/perms.js';
import {audit} from '../lib/audit.js';
import {encryptSecret} from '../lib/encryption.js';
import {badRequest} from '../lib/util.js';
import {reqStr} from './common.js';
import type {ZohoSettings} from '../adapters/zoho.js';

export async function saveZohoConnection(c:Conn,ctx:Ctx,f:Record<string,any>) {
 require(ctx,'settings.manage');
 let currencyIds:Record<string,string>,taxIds:Record<string,string>;
 try {currencyIds=JSON.parse(f.currency_ids);taxIds=JSON.parse(f.tax_ids);}catch{throw badRequest('Currency and tax mappings must be JSON objects');}
 for(const map of [currencyIds,taxIds])if(!map||Array.isArray(map)||typeof map!=='object'||Object.values(map).some(v=>typeof v!=='string'||!/^[0-9]{1,40}$/.test(v)))throw badRequest('Map codes to Zoho numeric record IDs');
 if(!['com','in','eu','com.au','jp','ca','sa'].includes(f.region))throw badRequest('Choose the Zoho data region');
 const settings:ZohoSettings={region:f.region,clientId:reqStr(f.client_id,'Client ID',200),clientSecret:reqStr(f.client_secret,'Client secret',500),refreshToken:reqStr(f.refresh_token,'Refresh token',1000),organizationId:reqStr(f.organization_id,'Organization ID',40),currencyIds,taxIds};
 if(!/^\d+$/.test(settings.organizationId))throw badRequest('Organization ID must be numeric');
 await c.query(`INSERT INTO accounting_connections(tenant_id,provider,status,config) VALUES($1,'zoho','validating',$2) ON CONFLICT(tenant_id) DO UPDATE SET provider='zoho',status='validating',config=$2`,[ctx.tenantId,JSON.stringify({encrypted:encryptSecret(JSON.stringify(settings)),organizationId:settings.organizationId,region:settings.region})]);
 await audit(c,ctx.tenantId,actorOf(ctx),'accounting.configured','connection',ctx.tenantId,{provider:'zoho',status:'validating'});
}
export async function disconnectAccounting(c:Conn,ctx:Ctx) {
 require(ctx,'settings.manage');
 await c.query(`UPDATE accounting_connections SET status='disconnected',config='{}' WHERE tenant_id=$1`,[ctx.tenantId]);
 await audit(c,ctx.tenantId,actorOf(ctx),'accounting.disconnected','connection',ctx.tenantId);
}
