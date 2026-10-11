import net from 'node:net';
import { config } from '../config.js';
import { badRequest } from '../lib/util.js';

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
