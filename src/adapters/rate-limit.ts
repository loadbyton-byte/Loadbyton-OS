import { config } from '../config.js';
import { hmac, HttpError } from '../lib/util.js';
import { providerJson, type Fetcher } from './http.js';

const SCRIPT = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`;
const local=new Map<string,{n:number;until:number}>();
export function resetRateLimits() { local.clear(); }
export async function rateLimit(key:string,limit=8,seconds=900,settings=config.upstash,fetcher:Fetcher=fetch) {
  const digest=hmac(config.sessionSecret,`rate:${key}`);
  let n:number;
  if(settings.url&&settings.token) {
    try {
      const result=await providerJson('Upstash',settings.url,{method:'POST',headers:{Authorization:`Bearer ${settings.token}`,'Content-Type':'application/json'},body:JSON.stringify(['EVAL',SCRIPT,'1',`lbt:rate:${digest}`,String(seconds)])},fetcher);
      if(result.error||!Number.isSafeInteger(result.result))throw new Error('Invalid rate-limit response');
      n=result.result;
    } catch { throw new HttpError(503,'Sign-in protection is temporarily unavailable. Please try again.'); }
  } else {
    if(config.isProd)throw new HttpError(503,'Sign-in protection unavailable');
    const now=Date.now(),old=local.get(digest);
    const value=old&&old.until>now?old:{n:0,until:now+seconds*1000};
    n=++value.n;local.set(digest,value);
    if(local.size>10000) for(const [k,v] of local)if(v.until<=now)local.delete(k);
  }
  if(n>limit) throw new HttpError(429,'Too many sign-in attempts. Try again in a few minutes.','throttled');
}
