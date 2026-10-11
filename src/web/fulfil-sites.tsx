import {Hono} from 'hono';
import {assignLocationSite,cancelSiteTransfer,closeSiteTransferShort,createSite,dispatchSiteTransfer,getSiteTransfer,listSites,listSiteTransfers,receiveSiteTransferLine,requestSiteTransfer,setSiteActive} from '../ops/fulfil-sites.js';
import {listLocations,stockOverview} from '../ops/fulfilment.js';
import {act,appPage,can,Confirm,PageHead,PostBtn,withT} from './appkit.js';
import {Badge,Csrf,Table} from './ui.js';
import {formBody,str,type Env} from './mw.js';
export const fulfilSites=new Hono<Env>();
const url='/app/fulfilment/sites';
fulfilSites.get(url,async c=>{
 const d=await withT(c,async cn=>({sites:await listSites(cn),locs:(await listLocations(cn)).filter((l:any)=>l.kind==='bin'),transfers:await listSiteTransfers(cn)})),csrf=c.get('csrf'),w=can(c,'wh.write');
 const siteOpts=d.sites.filter((s:any)=>s.active).map((s:any)=><option value={s.id}>{s.code} · {s.name}</option>);
 return appPage(c,'Sites & transfers',<><PageHead title="Sites & transfers" sub="Fulfilment sites own bins. Orders can be pinned to a site; stock reaches another site only through a dispatched, received transfer."/>
 <Table head={['Site','Name',['Bins','num'],['Units','num'],'Status','']} empty="No sites yet. Without sites every bin serves every order.">{d.sites.map((s:any)=><tr><td><strong>{s.code}</strong></td><td>{s.name}</td><td class="num">{s.locations}</td><td class="num">{s.units}</td><td><Badge s={s.active?'ok':'info'} label={s.active?'active':'off'}/></td><td>{w?<PostBtn action={`${url}/${s.id}/${s.active?'off':'on'}`} csrf={csrf} label={s.active?'Switch off':'Switch on'} cls="ghost sm"/>:null}</td></tr>)}</Table>
 {w?<div class="grid g2" style="margin-top:20px"><form method="post" action={url} class="card"><Csrf t={csrf}/><h3>Add a site</h3><div class="row"><div class="field"><label for="sc">Code</label><input id="sc" name="code" required/></div><div class="field"><label for="sn">Name</label><input id="sn" name="name" required/></div></div><button class="btn sm" type="submit">Save site</button></form>
 <form method="post" action={`${url}/assign`} class="card"><Csrf t={csrf}/><h3>Assign a bin to a site</h3><div class="field"><label for="al">Bin</label><select id="al" name="location_id">{d.locs.map((l:any)=><option value={l.id}>{l.code}</option>)}</select></div><div class="field"><label for="as">Site</label><select id="as" name="site_id"><option value="">— none —</option>{siteOpts}</select></div><button class="btn ghost sm" type="submit">Assign</button></form></div>:null}
 <h3 style="margin-top:26px">Transfers</h3><Table head={['No','From','To',['Units','num'],['Received','num'],'Status']} empty="No transfers.">{d.transfers.map((t:any)=><tr><td><a href={`${url}/transfers/${t.id}`}>{t.no}</a></td><td>{t.from_code}</td><td>{t.to_code}</td><td class="num">{t.units}</td><td class="num">{t.received}</td><td><Badge s={t.variance?'warn':t.status==='received'?'ok':'info'} label={t.variance?'short':t.status}/></td></tr>)}</Table>
 {w&&d.sites.filter((s:any)=>s.active).length>1?<p style="margin-top:12px"><a class="btn red sm" href={`${url}/transfers/new`}>New site transfer</a></p>:null}</>);
});
fulfilSites.post(url,async c=>{const b=await formBody(c);return act(c,url,async()=>{await withT(c,(cn,ctx)=>createSite(cn,ctx,b));return {to:url,ok:'Site saved.'};});});
fulfilSites.post(`${url}/assign`,async c=>{const b=await formBody(c);return act(c,url,async()=>{await withT(c,(cn,ctx)=>assignLocationSite(cn,ctx,str(b.location_id),str(b.site_id)||null));return {to:url,ok:'Bin assigned.'};});});
for(const [a,on] of [['on',true],['off',false]] as const)fulfilSites.post(`${url}/:id/${a}`,async c=>{const id=c.req.param('id');return act(c,url,async()=>{await withT(c,(cn,ctx)=>setSiteActive(cn,ctx,id,on));return {to:url,ok:on?'Site switched on.':'Site switched off.'};});});
fulfilSites.get(`${url}/transfers/new`,async c=>{
 const d=await withT(c,async cn=>({sites:(await listSites(cn)).filter((s:any)=>s.active),locs:(await listLocations(cn)).filter((l:any)=>l.kind==='bin'&&l.site_id),skus:(await stockOverview(cn)).filter((s:any)=>s.active)})),csrf=c.get('csrf');
 return appPage(c,'New site transfer',<><PageHead title="New site transfer" sub="One line per bin and SKU. Nothing moves until the transfer is dispatched."/>
 <form method="post" action={`${url}/transfers`} class="card" style="max-width:640px"><Csrf t={csrf}/>
 <div class="row"><div class="field"><label for="f">From site</label><select id="f" name="from_site">{d.sites.map((s:any)=><option value={s.id}>{s.code}</option>)}</select></div><div class="field"><label for="t">To site</label><select id="t" name="to_site">{d.sites.map((s:any)=><option value={s.id}>{s.code}</option>)}</select></div></div>
 <div class="row"><div class="field"><label for="l">Bin</label><select id="l" name="location_id">{d.locs.map((l:any)=><option value={l.id}>{l.code}</option>)}</select></div><div class="field"><label for="k">SKU</label><select id="k" name="sku_id">{d.skus.map((s:any)=><option value={s.id}>{s.code}</option>)}</select></div><div class="field"><label for="q">Qty</label><input id="q" name="qty" type="number" min="1" required/></div><div class="field"><label for="lo">Lot / serial</label><input id="lo" name="lot"/></div></div>
 <div class="field"><label for="n">Notes</label><input id="n" name="notes"/></div><button class="btn red" type="submit">Request transfer</button></form></>);
});
fulfilSites.post(`${url}/transfers`,async c=>{const b=await formBody(c);return act(c,`${url}/transfers/new`,async()=>{const r=await withT(c,(cn,ctx)=>requestSiteTransfer(cn,ctx,{from_site:str(b.from_site),to_site:str(b.to_site),notes:str(b.notes),lines:[{location_id:str(b.location_id),sku_id:str(b.sku_id),qty:str(b.qty),lot:str(b.lot)}]}));return {to:`${url}/transfers/${r.id}`,ok:`Transfer ${r.no} requested.`};});});
fulfilSites.get(`${url}/transfers/:id`,async c=>{
 const id=c.req.param('id'),d=await withT(c,async cn=>({...(await getSiteTransfer(cn,id)),locs:(await listLocations(cn)).filter((l:any)=>l.kind==='bin'&&l.active)})),csrf=c.get('csrf'),t=d.t;
 const dest=d.locs.filter((l:any)=>l.site_id===t.to_site);
 return appPage(c,t.no,<><PageHead title={`${t.no} · ${t.from_code} → ${t.to_code}`} sub={t.notes??''}><Badge s={t.variance?'warn':t.status==='received'?'ok':'info'} label={t.variance?'received short':t.status}/>
 {can(c,'wh.floor')&&t.status==='requested'?<PostBtn action={`${url}/transfers/${id}/dispatch`} csrf={csrf} label="Dispatch" cls="red sm"/>:null}
 {can(c,'wh.write')&&t.status==='requested'?<Confirm action={`${url}/transfers/${id}/cancel`} csrf={csrf} label="Cancel" confirm="Cancel this transfer?"/>:null}</PageHead>
 <Table head={['SKU','Lot / serial','From bin',['Sent','num'],['Received','num'],t.status==='dispatched'?'Receive':'']}>{d.lines.map((l:any)=><tr><td>{l.sku_code}</td><td>{l.lot??'—'}</td><td>{l.from_code}</td><td class="num">{l.qty}</td><td class="num">{l.received_qty}</td>
 <td>{t.status==='dispatched'&&can(c,'wh.floor')&&l.received_qty<l.qty?<form method="post" action={`${url}/transfers/${id}/receive`} class="inline-form"><Csrf t={csrf}/><input type="hidden" name="line_id" value={l.id}/><input name="qty" type="number" min="1" max={l.qty-l.received_qty} value={l.qty-l.received_qty} style="max-width:80px" aria-label="Quantity received"/><select name="location_id" aria-label="Into bin">{dest.map((x:any)=><option value={x.id}>{x.code}</option>)}</select><button class="btn sm" type="submit">Receive</button></form>:null}</td></tr>)}</Table>
 {t.variance?<div class="alert warn">Closed short: {t.variance_reason}. The missing units stay in TRANSIT until a count adjustment is approved.</div>:null}
 {t.status==='dispatched'&&can(c,'wh.approve')?<form method="post" action={`${url}/transfers/${id}/short`} class="card" style="max-width:560px;margin-top:14px"><Csrf t={csrf}/><h3>Accept a shortfall</h3><div class="field"><label for="r">Reason</label><input id="r" name="reason" required/></div><button class="btn ghost sm" type="submit">Close short</button></form>:null}</>);
});
const tr=(a:string,fn:(cn:any,ctx:any,id:string,b:any)=>Promise<any>,msg:string)=>fulfilSites.post(`${url}/transfers/:id/${a}`,async c=>{const id=c.req.param('id'),b=await formBody(c);return act(c,`${url}/transfers/${id}`,async()=>{await withT(c,(cn,ctx)=>fn(cn,ctx,id,b));return {to:`${url}/transfers/${id}`,ok:msg};});});
tr('dispatch',(cn,ctx,id)=>dispatchSiteTransfer(cn,ctx,id),'Dispatched.');
tr('cancel',(cn,ctx,id)=>cancelSiteTransfer(cn,ctx,id),'Cancelled.');
tr('receive',(cn,ctx,id,b)=>receiveSiteTransferLine(cn,ctx,id,{line_id:str(b.line_id),qty:str(b.qty),location_id:str(b.location_id)}),'Received.');
tr('short',(cn,ctx,id,b)=>closeSiteTransferShort(cn,ctx,id,str(b.reason)),'Closed with the shortfall recorded.');
