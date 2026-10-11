import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { config } from '../config.js';
import { HttpError, badRequest } from '../lib/util.js';
import type { Fetcher } from './http.js';

export interface ObjectStorage {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}
export function validateStorageKey(key: string, tenantId?: string) {
  if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/i.test(key) || (tenantId && key.split('/')[0] !== tenantId)) throw new HttpError(403,'Not permitted');
}
export function supabaseStorage(settings = config.supabase, fetcher: Fetcher = fetch): ObjectStorage {
  const request = async (key: string, init: RequestInit = {}) => {
    validateStorageKey(key);
    const url = `${settings.url.replace(/\/$/,'')}/storage/v1/object/${encodeURIComponent(settings.bucket)}/${key}`;
    const r = await fetcher(url,{...init,signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${settings.key}`,apikey:settings.key,...init.headers}});
    if(!r.ok) throw new Error(`Supabase storage request failed (HTTP ${r.status})`);
    return r;
  };
  return {
    async put(key,data,mime) { await request(key,{method:'POST',body:new Uint8Array(data),headers:{'Content-Type':mime,'x-upsert':'false'}}); },
    async get(key) { return Buffer.from(await (await request(key)).arrayBuffer()); },
  };
}
export const localStorage: ObjectStorage = {
  async put(key,data) { validateStorageKey(key); const file=path.join(config.storageDir,key);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data,{mode:0o600,flag:'wx'}); },
  async get(key) { validateStorageKey(key);return fs.readFile(path.join(config.storageDir,key)); },
};
export const objectStorage = () => config.storageProvider === 'supabase' ? supabaseStorage() : localStorage;

/** ClamAV INSTREAM; fail closed on timeout, daemon error or a malware finding. Keep port 3310 private. */
export async function scanWithClamav(data: Buffer, settings = config.clamav) {
  if(!settings.host) { if(config.isProd) throw new Error('Malware scanner unavailable'); return; }
  await new Promise<void>((resolve,reject)=>{
    const socket=net.createConnection({host:settings.host,port:settings.port});
    let response='';
    socket.setTimeout(15000,()=>socket.destroy(new Error('Malware scanner timeout')));
    socket.on('error',()=>reject(new Error('Malware scanner unavailable')));
    socket.on('connect',()=>{
      socket.write('zINSTREAM\0');
      for(let offset=0;offset<data.length;offset+=65536) {
        const chunk=data.subarray(offset,offset+65536),size=Buffer.alloc(4);size.writeUInt32BE(chunk.length);
        socket.write(size);socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    socket.on('data',chunk=>{
      response+=chunk.toString();
      if(response.length>4096) socket.destroy(new Error('Invalid scanner response'));
      if(!response.includes('\0')&&!response.includes('\n')) return;
      socket.destroy();
      if(response.trim().replace(/\0/g,'')==='stream: OK') resolve();
      else if(response.includes('FOUND')) reject(badRequest('This file failed malware scanning.'));
      else reject(new Error('Malware scanner did not approve the file'));
    });
    socket.on('end',()=>{if(!response.includes('OK')&&!response.includes('FOUND'))reject(new Error('Incomplete scanner response'));});
  });
}
