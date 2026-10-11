import {openDb} from '../src/db/client.js';
import {rotateEncryptionKey} from '../src/platform/key-rotation.js';
// Dry run by default. Secret values, plaintext, row identifiers and SQL errors are never logged.
const args=process.argv.slice(2),apply=args.includes('--apply');let db;
try{
 if(args.some(a=>a!=='--apply'))throw new Error('Use no arguments for a dry run or --apply for the atomic migration');
 if(!process.env.MFA_ENCRYPTION_KEY||!process.env.MFA_ENCRYPTION_PREVIOUS_KEY)throw new Error('Set MFA_ENCRYPTION_KEY and MFA_ENCRYPTION_PREVIOUS_KEY explicitly');
 const url=process.env.MIGRATION_DATABASE_URL||process.env.DATABASE_URL;
 if(!url)throw new Error('A direct privileged database URL is required');
 db=await openDb({url,migrate:false});const result=await rotateEncryptionKey(db,process.env.MFA_ENCRYPTION_KEY,process.env.MFA_ENCRYPTION_PREVIOUS_KEY,apply);console.log(JSON.stringify(result));
}catch{console.error('Encryption key rotation failed; no migration transaction was committed. Check configuration and ciphertext integrity using the reviewed runbook.');process.exitCode=1;}finally{await db?.close();}
