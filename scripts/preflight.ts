// Print missing setting names only. Credentials and database connection strings are never printed.
const env=process.env;
const providers=(env.PAYMENT_PROVIDERS||env.PAYMENT_PROVIDER||'').split(',');
const required=['DATABASE_URL','MIGRATION_DATABASE_URL','SESSION_SECRET','MFA_ENCRYPTION_KEY','PUBLIC_BASE_URL','ROOT_DOMAIN',
 'SELLER_LEGAL_NAME','SELLER_ADDRESS','SELLER_SUPPORT_EMAIL','CHECKOUT_VAT_BPS','CHECKOUT_TAX_NOTE',
 'S3_ENDPOINT','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','CLAMAV_HOST','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN',
 'CLOUDFLARE_API_TOKEN','CLOUDFLARE_ZONE_ID','CLOUDFLARE_ORIGIN_HOSTNAME','CLOUDFLARE_TUNNEL_TOKEN','RESEND_API_KEY','MAIL_FROM',
 'METRICS_TOKEN','DATA_RETENTION_DAYS','DEPLOYMENT_REGION'];
if(providers.includes('stripe'))required.push('STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET');
if(providers.includes('razorpay'))required.push('RAZORPAY_KEY_ID','RAZORPAY_KEY_SECRET','RAZORPAY_WEBHOOK_SECRET');
const failures=required.filter(k=>env[k]===undefined||env[k]==='').map(k=>`${k}: missing`);
if(!providers.length||providers.some(p=>!['stripe','razorpay'].includes(p)))failures.push('PAYMENT_PROVIDERS: use stripe and/or razorpay');
for(const name of ['SESSION_SECRET','MFA_ENCRYPTION_KEY','METRICS_TOKEN'])if(env[name]&&env[name]!.length<32)failures.push(`${name}: requires at least 32 characters`);
if(env.STORAGE_DRIVER!=='s3')failures.push('STORAGE_DRIVER: use s3 (private bucket) in production');
if(env.MAIL_PROVIDER!=='resend')failures.push('MAIL_PROVIDER: use resend in production');
if(['no-verify','disable'].includes((env.DATABASE_SSL||'').toLowerCase()))failures.push('DATABASE_SSL: certificate verification is required');
if(env.LEGAL_REVIEWED!=='true')failures.push('LEGAL_REVIEWED: approved legal copy and provider schedule required');
if(env.REQUIRE_COMPANY_MFA!=='true')failures.push('REQUIRE_COMPANY_MFA: must be true');
if(env.MIGRATE_ON_START!=='false')failures.push('MIGRATE_ON_START: use false with migrations run once before rollout');
if(env.CHECKOUT_VAT_BPS!==undefined&&(!/^\d+$/.test(env.CHECKOUT_VAT_BPS)||Number(env.CHECKOUT_VAT_BPS)>10000))failures.push('CHECKOUT_VAT_BPS: requires reviewed integer basis points');
for(const name of ['DATABASE_URL','MIGRATION_DATABASE_URL'])if(env[name])try{new URL(env[name]!);}catch{failures.push(`${name}: invalid URL`);}
if(env.RAZORPAY_PRESENTMENT_CURRENCY==='INR'&&(!Number.isFinite(Number(env.RAZORPAY_AED_TO_INR))||Number(env.RAZORPAY_AED_TO_INR)<=0||!env.RAZORPAY_FX_NOTE))failures.push('RAZORPAY_AED_TO_INR / RAZORPAY_FX_NOTE: reviewed quote required for INR');
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}else console.log('Deployment setting validation passed. Provider, restore and release acceptance must still be completed.');
