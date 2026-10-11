import {Hono} from 'hono';
import {holdFulfilLot} from '../ops/fulfilment.js';
import {lotWorkspace,traceLot} from '../ops/fulfil-lots.js';
import {act,appPage,can,PageHead,withT} from './appkit.js';
import {Badge,Csrf,Table} from './ui.js';
import {formBody,str,type Env} from './mw.js';
import {formatDay} from '../lib/util.js';
export const fulfilLots=new Hono<Env>();
const url='/app/fulfilment/lots';
fulfilLots.get(url,async c=>{
 const rows=await withT(c,cn=>lotWorkspace(cn)),csrf=c.get('csrf'),approve=can(c,'wh.approve');
 return appPage(c,'Lots & expiry',<><PageHead title="Lots & expiry" sub="Lot, batch and serial stock with issued source evidence. Expired and held lots are never allocated or shipped."/>
 <Table head={['Merchant SKU','Lot / serial','Expiry',['Days left','num'],['On hand','num'],['Reserved','num'],'Status','']} empty={rows.length?undefined:'No tracked stock yet. Mark a SKU as lot or serial tracked in the catalogue, then receive it with a lot and source evidence.'}>
 {rows.map((l:any)=><tr><td>{l.sku_code}<div class="small mute">{l.sku_name}</div></td><td><strong>{l.lot}</strong></td><td>{l.expires_at?formatDay(l.expires_at):'—'}</td><td class="num">{l.days_left===null?'—':l.days_left<=0?<Badge s="bad" label="expired"/>:l.days_left<=30?<Badge s="warn" label={String(l.days_left)}/>:l.days_left}</td><td class="num">{l.on_hand}</td><td class="num">{l.reserved}</td><td>{l.hold?<Badge s="bad" label="on hold"/>:<Badge s="ok" label="available"/>}</td>
 <td class="nowrap"><a class="btn ghost sm" href={`${url}/${l.id}`}>Trace</a>{approve?<form method="post" action={`${url}/${l.id}/${l.hold?'release':'hold'}`} class="inline-form"><Csrf t={csrf}/><input name="reason" type="text" placeholder="Quality decision evidence" required aria-label="Quality decision evidence"/><button class="btn ghost sm" type="submit">{l.hold?'Release':'Hold'}</button></form>:null}</td></tr>)}</Table></>);
});
for(const [action,hold] of [['hold',true],['release',false]] as const)
 fulfilLots.post(`${url}/:id/${action}`,async c=>{const id=c.req.param('id'),b=await formBody(c);return act(c,url,async()=>{const r=await withT(c,(cn,ctx)=>holdFulfilLot(cn,ctx,id,hold,str(b.reason)));return {to:url,ok:hold?`Lot held. ${r.released} reserved unit(s) were released for re-allocation.`:'Lot released.'};});});
fulfilLots.get(`${url}/:id`,async c=>{
 const id=c.req.param('id'),t=await withT(c,(cn,ctx)=>traceLot(cn,ctx,id));
 return appPage(c,`Lot ${t.lot.lot}`,<><PageHead title={`Lot ${t.lot.lot} · ${t.lot.sku_code}`} sub={`${t.lot.sku_name}${t.lot.expires_at?` · expires ${formatDay(t.lot.expires_at)}`:''}`}><a class="btn ghost sm" href={url}>Back to lots</a></PageHead>
 <h3>Where it is now</h3><Table head={['Location',['On hand','num'],['Reserved','num']]} empty="No stock of this lot on hand.">{t.where.map((w:any)=><tr><td>{w.code}</td><td class="num">{w.on_hand}</td><td class="num">{w.reserved}</td></tr>)}</Table>
 <h3 style="margin-top:22px">Recall trace — orders that received it</h3><Table head={['Order','Status',['Units','num'],'Carrier / tracking','Recipient']} empty="No units shipped yet.">{t.orders.map((o:any)=><tr><td><a href={`/app/fulfilment/orders/${o.id}`}>{o.no}</a></td><td>{o.status}</td><td class="num">{o.units}</td><td class="small">{o.carrier?`${o.carrier} ${o.tracking_no}`:'—'}</td><td class="small">{o.ship_to_name}{o.ship_to_city?`, ${o.ship_to_city}`:''}</td></tr>)}</Table>
 <h3 style="margin-top:22px">Quality decisions</h3><Table head={['When','Decision','Evidence']} empty="None recorded.">{t.decisions.map((d:any)=><tr><td class="small">{formatDay(d.decided_at)}</td><td>{d.hold?'Hold':'Release'}</td><td class="small">{d.reason}</td></tr>)}</Table></>);
});
