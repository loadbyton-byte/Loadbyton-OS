import {Hono} from 'hono';
import {feedWorkspace,importFeed,latestPositions,optimiseTrip,postFeedExpenses,resolveFeedLine,setLegCoordinates} from '../ops/transport-live.js';
import {getTrip} from '../ops/transport.js';
import {act,appPage,can,need,PageHead,PostBtn,withT} from './appkit.js';
import {Badge,Csrf,Money,Table} from './ui.js';
import {formBody,str,type Env} from './mw.js';
import {formatDate} from '../lib/util.js';
export const transportLive=new Hono<Env>();
const T='/app/transport';
const osm=(lat:any,lng:any)=>`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;

transportLive.get(`${T}/live`,async c=>{
 need(c,'transport.write');const rows=await withT(c,(cn,ctx)=>latestPositions(cn,ctx));
 return appPage(c,'Live trips',<><PageHead title="Live trips" sub="Latest reported position of each live trip. Positions exist only while the driver has location sharing switched on, are kept for the workspace's retention period, and are straight coordinates, not a tracking guarantee."/>
 <Table head={['Trip','Driver / vehicle','Last seen','Speed','Position']} empty="No live trip is sharing its location.">{rows.map((r:any)=><tr><td><a href={`${T}/trips/${r.trip_id}`}>{r.no}</a></td><td>{r.driver}<div class="small mute">{r.reg_no}</div></td><td>{r.age_s<120?'just now':r.age_s<3600?`${Math.round(r.age_s/60)} min ago`:<Badge s="warn" label={`${Math.round(r.age_s/3600)} h ago`}/>}</td><td>{r.speed_kmh??'—'}</td><td><a href={osm(r.lat,r.lng)} rel="noopener noreferrer" target="_blank">{Number(r.lat).toFixed(4)}, {Number(r.lng).toFixed(4)}</a>{r.accuracy_m?<span class="small mute"> ±{r.accuracy_m} m</span>:null}</td></tr>)}</Table></>);
});

transportLive.get(`${T}/trips/:id/route`,async c=>{
 need(c,'transport.write');const id=c.req.param('id'),csrf=c.get('csrf'),d=await withT(c,cn=>getTrip(cn,id));
 const plan=await withT(c,(cn,ctx)=>optimiseTrip(cn,ctx,id,false)).catch((e:any)=>({error:String(e.message)} as any));
 const byId=new Map<string,any>(d.legs.map((l:any)=>[l.id,l]));
 return appPage(c,'Route',<><PageHead title={`Route · ${d.trip.no}`} sub="Straight-line distances between stop coordinates; pickups always stay before their deliveries. Completed stops never move."><a class="btn ghost sm" href={`${T}/trips/${id}`}>Back to trip</a></PageHead>
 <Table head={['#','Stop','Order','Status','Coordinates']}>{d.legs.map((l:any)=><tr><td>{l.seq}</td><td><strong>{l.kind}</strong><div class="small mute">{l.address}</div></td><td>{l.order_no}</td><td>{l.status}</td><td>{l.status==='pending'?<form method="post" action={`${T}/trips/${id}/legs/${l.id}/coords`} class="inline-form"><Csrf t={csrf}/><input name="lat" value={l.lat??''} placeholder="Lat" style="max-width:100px" required aria-label="Latitude"/><input name="lng" value={l.lng??''} placeholder="Lng" style="max-width:100px" required aria-label="Longitude"/><button class="btn ghost sm">Save</button></form>:(l.lat?`${l.lat}, ${l.lng}`:'—')}</td></tr>)}</Table>
 {plan.error?<div class="alert warn">{plan.error}</div>:<><h3>Proposed order</h3><p>Current plan {plan.before_km} km → proposed {plan.after_km} km{plan.saved_km>0?<> (saves {plan.saved_km} km)</>:' (already best)'}.</p><ol>{plan.sequence.map((sid:string)=>{const l=byId.get(sid);return <li>{l.kind} · {l.address} <span class="small mute">({l.order_no})</span></li>;})}</ol>{plan.saved_km>0?<PostBtn action={`${T}/trips/${id}/route/apply`} csrf={csrf} label="Apply this order" cls="red sm"/>:null}</>}</>);
});
transportLive.post(`${T}/trips/:id/legs/:leg/coords`,async c=>{const b=await formBody(c),id=c.req.param('id');return act(c,`${T}/trips/${id}/route`,async()=>{await withT(c,(cn,ctx)=>setLegCoordinates(cn,ctx,c.req.param('leg'),str(b.lat),str(b.lng)));return {to:`${T}/trips/${id}/route`,ok:'Coordinates saved.'};});});
transportLive.post(`${T}/trips/:id/route/apply`,async c=>{const id=c.req.param('id');return act(c,`${T}/trips/${id}/route`,async()=>{await withT(c,(cn,ctx)=>optimiseTrip(cn,ctx,id,true));return {to:`${T}/trips/${id}`,ok:'Stop order updated.'};});});

transportLive.get(`${T}/feeds`,async c=>{
 need(c,'transport.expense');const d=await withT(c,cn=>feedWorkspace(cn)),csrf=c.get('csrf');
 return appPage(c,'Fuel & Salik statements',<><PageHead title="Fuel-card and Salik statements" sub="Import the provider's CSV. Lines match a vehicle by plate and a trip by time; matched lines become unapproved trip expenses that still need receipt evidence and a second person's approval."/>
 <form method="post" action={`${T}/feeds`} enctype="multipart/form-data" class="card" style="max-width:640px"><Csrf t={csrf}/><div class="row"><div class="field"><label for="fk">Statement</label><select id="fk" name="kind"><option value="fuel">Fuel card</option><option value="salik">Salik</option></select></div><div class="field"><label for="fl">Label</label><input id="fl" name="label" required/></div></div><p class="small mute">Header: <code>reference,date,plate,amount</code> (optional <code>litres,description</code>). Dates are Dubai time unless they carry an offset. Provider references make overlapping statements safe.</p><div class="field"><input type="file" name="file" accept=".csv,text/csv" required/></div><button class="btn sm">Import</button></form>
 {d.open.some((l:any)=>l.status==='matched')?<PostBtn action={`${T}/feeds/post`} csrf={csrf} label="Create expenses from matched lines" cls="red sm"/>:null}
 <Table head={['When','Kind','Plate','Amount','Reference','Status','']} empty="Nothing waiting.">{d.open.map((l:any)=><tr><td class="small">{formatDate(l.occurred_at)}</td><td>{l.kind}</td><td>{l.plate}{l.reg_no?<div class="small mute">{l.reg_no}</div>:null}</td><td class="num"><Money v={l.amount_minor}/></td><td class="small">{l.reference}</td><td><Badge s={l.status==='matched'?'ok':'warn'} label={l.status.replace('_',' ')}/></td>
 <td>{l.status!=='matched'?<form method="post" action={`${T}/feeds/lines/${l.id}`} class="inline-form"><Csrf t={csrf}/><select name="trip_id" aria-label="Trip"><option value="">Assign to trip…</option>{d.trips.map((t:any)=><option value={t.id}>{t.no} · {t.reg_no}</option>)}</select><input name="ignore" placeholder="or reason to set aside" aria-label="Reason to set aside"/><button class="btn ghost sm">Resolve</button></form>:null}</td></tr>)}</Table></>);
});
transportLive.post(`${T}/feeds`,async c=>act(c,`${T}/feeds`,async()=>{
 const form=await c.req.formData(),file=form.get('file');if(!(file instanceof File))throw new Error('Choose a CSV file.');
 const text=Buffer.from(await file.arrayBuffer()).toString('utf8');
 const r=await withT(c,(cn,ctx)=>importFeed(cn,ctx,String(form.get('kind')),String(form.get('label')??''),text));
 return {to:`${T}/feeds`,ok:`${r.added} line(s) imported, ${r.matched} matched to trips${r.duplicates?`, ${r.duplicates} already known`:''}.`};
}));
transportLive.post(`${T}/feeds/post`,async c=>act(c,`${T}/feeds`,async()=>{const n=await withT(c,(cn,ctx)=>postFeedExpenses(cn,ctx));return {to:`${T}/feeds`,ok:`${n} expense(s) created for approval.`};}));
transportLive.post(`${T}/feeds/lines/:id`,async c=>{const b=await formBody(c);return act(c,`${T}/feeds`,async()=>{await withT(c,(cn,ctx)=>resolveFeedLine(cn,ctx,c.req.param('id'),{trip_id:str(b.trip_id)||undefined,ignore:str(b.ignore)||undefined}));return {to:`${T}/feeds`,ok:'Line resolved.'};});});
