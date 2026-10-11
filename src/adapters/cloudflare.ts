import { config } from '../config.js';
import type { ProvisionAdapters } from '../platform/provisioning.js';
import { providerJson, type Fetcher } from './http.js';

/** Standard branded subdomains use the preconfigured Cloudflare wildcard and origin tunnel. */
export function cloudflareAdapters(settings=config.cloudflare,fetcher:Fetcher=fetch): ProvisionAdapters {
  return {
    async attachRouting(hostname) {
      if(!config.rootDomain||!hostname.endsWith(`.${config.rootDomain}`)||hostname.split('.').length!==config.rootDomain.split('.').length+1)throw new Error('Invalid standard tenant hostname');
      if(!settings.token||!settings.zoneId||!settings.origin)throw new Error('Cloudflare routing is not configured');
      const data=await providerJson('Cloudflare',`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(settings.zoneId)}/dns_records?name=${encodeURIComponent(`*.${config.rootDomain}`)}&type=CNAME`,{headers:{Authorization:`Bearer ${settings.token}`}},fetcher);
      if(!data.success||!data.result?.some((r:any)=>r.proxied&&r.content===settings.origin))throw new Error('Proxied wildcard DNS does not point to the configured origin');
    },
    async verifyTls(hostname) {
      // Native fetch verifies certificate chain and hostname. Never accept an insecure TLS override.
      const r=await fetcher(`https://${hostname}/healthz`,{signal:AbortSignal.timeout(15000),redirect:'error'});
      if(!r.ok||(await r.json()).ok!==true)throw new Error('Branded hostname HTTPS health validation failed');
    },
  };
}

/** Custom domains are provisioned by the operator in Cloudflare for SaaS before activation. */
export async function verifyCloudflareCustomDomain(hostname:string,settings=config.cloudflare,fetcher:Fetcher=fetch) {
 if(!settings.token||!settings.zoneId)throw new Error('Cloudflare custom-hostname access is not configured');
 const data=await providerJson('Cloudflare',`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(settings.zoneId)}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,{headers:{Authorization:`Bearer ${settings.token}`}},fetcher);
 if(!data.success||!data.result?.some((r:any)=>r.hostname===hostname&&r.status==='active'&&r.ssl?.status==='active'))throw new Error('Custom hostname routing and certificate are not active in Cloudflare');
 const response=await fetcher(`https://${hostname}/healthz`,{signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!response.ok||(await response.json()).ok!==true)throw new Error('Custom hostname HTTPS health validation failed');
}
