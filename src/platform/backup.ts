import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import crypto from 'node:crypto';
import {pipeline} from 'node:stream/promises';
const MAGIC=Buffer.from('LBTBKP1\n');
const key=(secret:string)=>{if(secret.length<32)throw new Error('BACKUP_ENCRYPTION_KEY requires at least 32 characters');return crypto.createHash('sha256').update(secret).digest();};
export async function encryptBackup(input:string,output:string,secret:string) {
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key(secret),iv);
 await fs.writeFile(output,Buffer.concat([MAGIC,iv,Buffer.alloc(16)]),{mode:0o600,flag:'wx'});
 try {
  await pipeline(createReadStream(input),cipher,createWriteStream(output,{flags:'a',mode:0o600}));
  const file=await fs.open(output,'r+');try{await file.write(cipher.getAuthTag(),0,16,20);}finally{await file.close();}
 } catch(e){await fs.unlink(output);throw e;}
}
export async function decryptBackup(input:string,output:string,secret:string) {
 const file=await fs.open(input,'r'),header=Buffer.alloc(36);
 try{const r=await file.read(header,0,36,0);if(r.bytesRead!==36||!header.subarray(0,8).equals(MAGIC))throw new Error('Invalid backup header');}finally{await file.close();}
 const cipher=crypto.createDecipheriv('aes-256-gcm',key(secret),header.subarray(8,20));cipher.setAuthTag(header.subarray(20,36));
 try{await pipeline(createReadStream(input,{start:36}),cipher,createWriteStream(output,{mode:0o600,flags:'wx'}));}
 catch{await fs.unlink(output).catch(()=>{});throw new Error('Backup authentication failed; use the correct key and an intact backup');}
}
