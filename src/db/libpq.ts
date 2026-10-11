/** Feed libpq individual connection fields; PGDATABASE alone does not expand a URI as conninfo. */
export function libpqEnv(url:string):NodeJS.ProcessEnv {
 const u=new URL(url);
 return {...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGSSLMODE:u.searchParams.get('sslmode')??'prefer',PGSSLROOTCERT:u.searchParams.get('sslrootcert')??process.env.PGSSLROOTCERT??(u.searchParams.get('sslmode')==='verify-full'?'system':undefined)};
}
