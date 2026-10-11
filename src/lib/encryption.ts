import crypto from 'node:crypto';
import { config } from '../config.js';
const key=(secret:string)=>crypto.createHash('sha256').update(secret).digest();
export function encryptWithKey(value:string,secret:string) {
 if(secret.length<32)throw new Error('Encryption key requires at least 32 characters');
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key(secret),iv);
 const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
 return [iv,cipher.getAuthTag(),encrypted].map(x=>x.toString('base64url')).join('.');
}
export function decryptWithKey(value:string,secret:string) {
 try{
  if(secret.length<32||typeof value!=='string'||value.length>262144)throw new Error();
  const parts=value.split('.');if(parts.length!==3||!parts[0]||!parts[1]||parts.some(p=>!/^[A-Za-z0-9_-]*$/.test(p)))throw new Error();
  const [iv,tag,data]=parts.map(x=>Buffer.from(x,'base64url'));if(iv.length!==12||tag.length!==16)throw new Error();
  const cipher=crypto.createDecipheriv('aes-256-gcm',key(secret),iv);cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8');
 }catch{throw new Error('Encrypted secret authentication failed');}
}
export const encryptSecret=(value:string)=>encryptWithKey(value,config.encryptionSecret);
export function decryptSecret(value:string){try{return decryptWithKey(value,config.encryptionSecret);}catch{if(config.previousEncryptionSecret)return decryptWithKey(value,config.previousEncryptionSecret);throw new Error('Encrypted secret authentication failed');}}
