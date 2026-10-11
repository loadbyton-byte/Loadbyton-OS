import type {Db} from '../db/client.js';
import type {RuntimeMetrics} from './runtime-metrics.js';
export async function collectQueueMetrics(db:Db,metrics:RuntimeMetrics) {
 const row=(await db.query<any>(`SELECT
 (SELECT count(*) FROM outbox WHERE status='pending' AND topic<>'staff.review') outbox_pending,
 (SELECT count(*) FROM outbox WHERE status='dead') outbox_dead,
 (SELECT coalesce(extract(epoch FROM now()-min(created_at)),0) FROM outbox WHERE status='pending' AND topic<>'staff.review') outbox_oldest_age_seconds,
 (SELECT count(*) FROM provision_jobs WHERE state IN ('queued','provisioning','validation','ready')) provisioning_pending,
 (SELECT count(*) FROM provision_jobs WHERE state='failed') provisioning_failed,
 (SELECT coalesce(extract(epoch FROM now()-min(queued_at)),0) FROM provision_jobs WHERE state IN ('queued','provisioning','validation','ready')) provisioning_oldest_age_seconds,
 (SELECT count(*) FROM invoices WHERE sync_status='failed') invoice_sync_failed,
 (SELECT count(*) FROM wh_count_schedules WHERE active AND next_due<=(now() AT TIME ZONE 'Asia/Dubai')::date) warehouse_counts_due,
 (SELECT count(*) FROM assistant_drafts WHERE status='generating' AND created_at<now()-interval '60 seconds') assistant_pending,
 (SELECT count(*) FROM assistant_drafts WHERE cost_status='uncertain') assistant_uncertain,
 (SELECT count(*) FROM fulfil_storage_contracts p WHERE p.valid_from<(now() AT TIME ZONE 'Asia/Dubai')::date AND
 (SELECT count(*) FROM fulfil_storage_days a WHERE a.contract_id=p.id)<least(p.valid_until,(now() AT TIME ZONE 'Asia/Dubai')::date-1)-p.valid_from+1) fulfilment_storage_due`)).rows[0];
 for(const [name,value]of Object.entries(row))metrics.gauge(name as Parameters<RuntimeMetrics['gauge']>[0],Number(value));
}
