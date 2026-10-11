import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {openDb} from '../src/db/client.js';
import {storage} from '../src/lib/storage.js';
import {sha256} from '../src/lib/util.js';
import {encryptBackup} from '../src/platform/backup.js';
import {libpqEnv} from '../src/db/libpq.js';

async function command(program:string,args:string[],env:NodeJS.ProcessEnv=process.env) {
 await new Promise<void>((resolve,reject)=>{const child=spawn(program,args,{env,stdio:['ignore','ignore','ignore']});child.on('error',()=>reject(new Error(`${path.basename(program)} unavailable`)));child.on('exit',code=>code===0?resolve():reject(new Error(`${path.basename(program)} failed`)));});
}
const url=process.env.MIGRATION_DATABASE_URL||process.env.DATABASE_URL;
const secret=process.env.BACKUP_ENCRYPTION_KEY??'';
if(!url||secret.length<32)throw new Error('Set the direct database endpoint and BACKUP_ENCRYPTION_KEY');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lbt-backup-'));await fs.chmod(dir,0o700);
const db=await openDb({url,migrate:false});
try {
 const manifest:any={version:1,started_at:new Date().toISOString(),objects:[]};
 await db.system(async c=>{
  await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  const snapshot=(await c.query<any>('SELECT pg_export_snapshot() id')).rows[0].id;
  await command(process.env.PG_DUMP_BINARY??'pg_dump',['--format=custom','--no-owner',`--snapshot=${snapshot}`,`--file=${path.join(dir,'database.dump')}`],libpqEnv(url));
  manifest.objects=(await c.query<any>('SELECT storage_key,sha256,size_bytes FROM documents ORDER BY storage_key')).rows;
  manifest.counts={};
  const tables=(await c.query<any>(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows.map(r=>r.tablename);
  for(const table of tables){if(!/^[a-z_]+$/.test(table))throw new Error('Unexpected backup table name');manifest.counts[table]=Number((await c.query<any>(`SELECT count(*) n FROM ${table}`)).rows[0].n);}
 });
 for(const doc of manifest.objects) {
  const data=await storage.get(doc.storage_key);
  if(sha256(data)!==doc.sha256||data.length!==Number(doc.size_bytes))throw new Error('Backup document integrity check failed');
  const file=path.join(dir,'objects',doc.storage_key);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,data,{mode:0o600});
 }
 manifest.completed_at=new Date().toISOString();
 await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
 const tar=path.join(dir,'archive.tar');
 await command('tar',['-cf',tar,'-C',dir,'database.dump','manifest.json',...(manifest.objects.length?['objects']:[])]);
 const output=path.resolve(process.env.BACKUP_OUTPUT_DIR??'backups');await fs.mkdir(output,{recursive:true,mode:0o700});
 const filename=path.join(output,`loadbyton-${Date.now()}-${crypto.randomUUID().slice(0,8)}.lbt`);
 await encryptBackup(tar,filename,secret);console.log(`Encrypted backup created: ${filename}. Store a verified copy outside the Oracle instance.`);
}finally{await db.close();await fs.rm(dir,{recursive:true,force:true});}
