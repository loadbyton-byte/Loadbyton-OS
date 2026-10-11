import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {config} from '../src/config.js';
import {openDb} from '../src/db/client.js';
import {fsStorage,s3Storage,type Storage} from '../src/lib/storage.js';
import {sha256} from '../src/lib/util.js';
import {decryptBackup} from '../src/platform/backup.js';
import {verifyInvariants} from '../src/platform/invariants.js';
import {libpqEnv} from '../src/db/libpq.js';

const command=async(program:string,args:string[],env:NodeJS.ProcessEnv=process.env)=>new Promise<void>((resolve,reject)=>{const child=spawn(program,args,{env,stdio:['ignore','ignore','ignore']});child.on('error',()=>reject(new Error(`${path.basename(program)} unavailable`)));child.on('exit',code=>code===0?resolve():reject(new Error(`${path.basename(program)} failed`)));});
const target=process.env.RESTORE_DATABASE_URL,file=process.argv[2],secret=process.env.BACKUP_ENCRYPTION_KEY??'';
if(!target||!file||process.env.RESTORE_CONFIRM_ISOLATED!=='true')throw new Error('Set RESTORE_DATABASE_URL and RESTORE_CONFIRM_ISOLATED=true for an isolated empty database; pass the backup path');
const parsed=new URL(target),source=config.databaseUrl?new URL(config.databaseUrl):null;
if(source&&source.hostname===parsed.hostname&&source.pathname===parsed.pathname)throw new Error('Restore target must differ from the active database');
if(config.isProd&&parsed.searchParams.get('sslmode')!=='verify-full')throw new Error('Restore database requires verified TLS');
const validateStorageKey=(key:string)=>{if(!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/i.test(key))throw new Error('Unexpected storage key');};
const bucket=process.env.RESTORE_S3_BUCKET,localDir=process.env.RESTORE_STORAGE_DIR;
let storage:Storage;
if(config.storage.driver==='s3') {
 if(!bucket||bucket===config.storage.s3.bucket)throw new Error('Set RESTORE_S3_BUCKET to a separate private bucket for the restore drill');
 storage=s3Storage({...config.storage.s3,bucket});
}else{
 if(!localDir||path.resolve(localDir)===config.storageDir)throw new Error('Set a separate RESTORE_STORAGE_DIR');
 storage=fsStorage(path.resolve(localDir));
}
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lbt-restore-'));await fs.chmod(dir,0o700);
let db:Awaited<ReturnType<typeof openDb>>|undefined;
try {
 await decryptBackup(file,path.join(dir,'archive.tar'),secret);
 await command('tar',['-xf',path.join(dir,'archive.tar'),'-C',dir]);
 const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));if(manifest.version!==1)throw new Error('Unsupported backup version');
 const client=new pg.Client({connectionString:target});await client.connect();
 try {
  if((await client.query(`SELECT 1 FROM pg_tables WHERE schemaname='public' LIMIT 1`)).rows.length)throw new Error('Restore target is not empty');
  await client.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lbt_app') THEN CREATE ROLE lbt_app NOLOGIN; END IF; EXECUTE format('GRANT lbt_app TO %I',current_user); END $$`);
 }finally{await client.end();}
 // An empty explicit dbname enables direct restore; libpq takes the connection from PGDATABASE.
 await command(process.env.PG_RESTORE_BINARY??'pg_restore',['--dbname','','--no-owner','--exit-on-error','--single-transaction',path.join(dir,'database.dump')],libpqEnv(target));
 db=await openDb({url:target,migrate:false});
 const docs=(await db.query<any>('SELECT storage_key,sha256,size_bytes FROM documents ORDER BY storage_key')).rows;
 if(docs.length!==manifest.objects.length)throw new Error('Restored document catalogue differs from the backup');
 for(const doc of docs) {
  validateStorageKey(doc.storage_key);
  const match=manifest.objects.find((x:any)=>x.storage_key===doc.storage_key);if(!match||match.sha256!==doc.sha256)throw new Error('Restored document metadata mismatch');
  const data=await fs.readFile(path.join(dir,'objects',doc.storage_key));if(sha256(data)!==doc.sha256||data.length!==Number(doc.size_bytes))throw new Error('Restored document integrity failed');
  await storage.put(doc.storage_key,data);if(sha256(await storage.get(doc.storage_key))!==doc.sha256)throw new Error('Restored storage verification failed');
 }
 for(const table of Object.keys(manifest.counts)) {
  if(!/^[a-z_]+$/.test(table))throw new Error('Unexpected restore table name');
  const n=Number((await db.query<any>(`SELECT count(*) n FROM ${table}`)).rows[0].n);if(n!==manifest.counts[table])throw new Error(`Restored ${table} count mismatch`);
 }
 const violations=await verifyInvariants(db);if(violations.length)throw new Error('Restored financial/stock/platform invariants failed');
 const tenantTables=(await db.query<any>(`SELECT tablename FROM pg_tables t JOIN pg_class c ON c.relname=t.tablename JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=t.schemaname WHERE t.schemaname='public' AND c.relrowsecurity AND EXISTS(SELECT 1 FROM information_schema.columns x WHERE x.table_schema='public' AND x.table_name=t.tablename AND x.column_name='tenant_id')`)).rows.map(r=>r.tablename);
 for(const tenant of (await db.query<any>('SELECT id FROM tenants')).rows)await db.tenant(tenant.id,async c=>{for(const table of tenantTables){if(!/^[a-z_]+$/.test(table))throw new Error('Unexpected tenant table name');if((await c.query(`SELECT 1 FROM ${table} WHERE tenant_id<>$1 LIMIT 1`,[tenant.id])).rows.length)throw new Error('Restored tenant isolation failed');}});
 console.log(`Restore drill passed: database, ${docs.length} private documents, membership, audit counts, tenant isolation and business invariants. Original snapshot: ${manifest.started_at}. Record measured RPO/RTO in the release evidence.`);
}finally{if(db)await db.close();await fs.rm(dir,{recursive:true,force:true});}
