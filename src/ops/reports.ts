import type {Conn} from '../db/client.js';
import {require,type Ctx} from '../lib/perms.js';
export async function managementReports(c:Conn,ctx:Ctx) {
 require(ctx,'dashboard.owner');
 const sales=(await c.query<any>(`SELECT status,count(*)::int AS records FROM enquiries GROUP BY status ORDER BY status`)).rows;
 const lost=(await c.query<any>(`SELECT coalesce(lost_reason,'Unrecorded') AS reason,count(*)::int AS records FROM enquiries WHERE status='lost' GROUP BY 1 ORDER BY 2 DESC`)).rows;
 const finance=(await c.query<any>(`SELECT currency,count(*)::int AS invoices,sum(total_minor)::text AS issued,sum(paid_minor)::text AS collected,sum(total_minor-paid_minor)::text AS outstanding,sum(CASE WHEN due_at<now() THEN total_minor-paid_minor ELSE 0 END)::text AS overdue,count(*) FILTER(WHERE sync_status<>'synced')::int AS unsynchronized FROM invoices WHERE status<>'void' GROUP BY currency ORDER BY currency`)).rows;
 const transport=(await c.query<any>(`SELECT status,count(*)::int AS trips,sum(coalesce(actual_km,0)) AS actual_km,count(*) FILTER(WHERE actual_km IS NULL)::int AS distance_missing FROM trips GROUP BY status ORDER BY status`)).rows;
 const warehouse=(await c.query<any>(`SELECT p.name AS owner,sum(s.qty_on_hand) AS stock,sum(s.qty_reserved) AS reserved,sum(CASE WHEN s.first_received_at<now()-interval '90 days' THEN s.qty_on_hand ELSE 0 END) AS over_90_days FROM wh_stock s JOIN parties p ON p.id=s.owner_id WHERE s.qty_on_hand>0 GROUP BY p.id,p.name ORDER BY p.name`)).rows;
 const utilization=(await c.query<any>(`SELECT w.name,l.code,l.capacity_units,coalesce(sum(s.qty_on_hand),0) AS used FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id LEFT JOIN wh_stock s ON s.location_id=l.id WHERE l.active GROUP BY w.name,l.id,l.code,l.capacity_units ORDER BY w.name,l.code`)).rows;
 const accuracy=(await c.query<any>(`SELECT count(*)::int AS approved_lines,count(*) FILTER(WHERE counted_qty=system_qty)::int AS exact_lines,coalesce(sum(abs(counted_qty-system_qty)),0) AS absolute_variance FROM wh_count_lines WHERE status='approved'`)).rows[0];
 const service=(await c.query<any>(`SELECT count(*) FILTER(WHERE status='open')::int AS open,count(*) FILTER(WHERE status='open' AND accepted_at IS NULL)::int AS unaccepted,count(*) FILTER(WHERE status='open' AND due_at<now())::int AS overdue FROM conversations`)).rows[0];
 const specialist=(await c.query<any>(`SELECT sector,status,count(*)::int AS cases FROM specialist_cases GROUP BY sector,status ORDER BY sector,status`)).rows;
 const cod=(await c.query<any>(`WITH adjusted AS(SELECT a.parcel_id,sum(CASE WHEN a.kind IN ('recovery','correction_in') THEN a.amount_minor ELSE -a.amount_minor END) delta,sum(CASE WHEN a.kind='recovery' THEN a.amount_minor ELSE 0 END) recovered FROM delivery_cash_adjustments a JOIN delivery_cash_adjustment_decisions x ON x.adjustment_id=a.id AND x.approved GROUP BY a.parcel_id),paid AS(SELECT parcel_id,sum(amount_minor) amount FROM delivery_remittances GROUP BY parcel_id)
 SELECT count(*)::int AS delivered,count(*) FILTER(WHERE d.id IS NULL)::int AS awaiting_review,
 coalesce(sum(p.cod_expected_minor),0) AS expected,coalesce(sum(cr.amount_minor),0) AS original_handover,
 coalesce(sum(a.delta),0) AS cash_change,coalesce(sum(cr.amount_minor+coalesce(a.delta,0)),0) AS current_cash,
 coalesce(sum(r.amount),0) AS remitted,coalesce(sum(greatest(0,p.cod_expected_minor-coalesce(r.amount,0))),0) AS outstanding,
 coalesce(sum(CASE WHEN d.id IS NOT NULL THEN greatest(0,d.expected_minor-least(d.collected_minor+coalesce(a.recovered,0),d.received_minor+coalesce(a.delta,0))) ELSE 0 END),0) AS reviewed_shortage,
 coalesce(sum(CASE WHEN d.id IS NOT NULL THEN greatest(0,least(d.expected_minor,d.collected_minor+coalesce(a.recovered,0),d.received_minor+coalesce(a.delta,0))-coalesce(r.amount,0)) ELSE 0 END),0) AS remittable
 FROM delivery_parcels p LEFT JOIN delivery_cod_decisions d ON d.parcel_id=p.id LEFT JOIN delivery_cash_receipts cr ON cr.parcel_id=p.id LEFT JOIN adjusted a ON a.parcel_id=p.id LEFT JOIN paid r ON r.parcel_id=p.id WHERE p.status='delivered' AND p.cod_expected_minor>0`)).rows[0];
 return {asOf:new Date().toISOString(),sales,lost,finance,transport,warehouse,utilization,accuracy,service,specialist,cod};
}
