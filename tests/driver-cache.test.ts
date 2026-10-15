import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

describe('shared-phone driver privacy',()=>{
 it('serves only the anonymous offline shell after a network failure and removes legacy personal caches',async()=>{
  const handlers:Record<string,Function>={},deleted:string[]=[],lookups:string[]=[];
  runInNewContext(readFileSync('public/driver-sw.js','utf8'),{
   URL, self:{location:{origin:'https://fixture.test'},clients:{claim:async()=>{}},addEventListener:(name:string,fn:Function)=>handlers[name]=fn},
   fetch:async()=>{throw new Error('offline');},
   caches:{keys:async()=>['unrelated-app-cache','lbt-driver-pages-v2','lbt-driver-shell-v2'],delete:async(key:string)=>{deleted.push(key);return true;},match:async(key:string)=>{lookups.push(key);return key==='/app/driver/offline'?'anonymous shell':'OTHER DRIVER DATA';}}
  });
  let activation:Promise<unknown>;handlers.activate({waitUntil:(p:Promise<unknown>)=>activation=p});await activation!;
  expect(deleted).toEqual(['lbt-driver-pages-v2','lbt-driver-shell-v2']);
  let response:Promise<unknown>;handlers.fetch({request:{method:'GET',mode:'navigate',url:'https://fixture.test/app/driver/trips/private-trip'},respondWith:(p:Promise<unknown>)=>response=p});
  expect(await response!).toBe('anonymous shell');expect(lookups).toEqual(['/app/driver/offline']);
 });
});
