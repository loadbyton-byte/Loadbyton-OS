import { describe,expect,it } from 'vitest';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

describe('offsite backup success reporting',()=>{
 for(const failure of ['none','no-new-file','upload','verify'])it(`requires a fresh artifact and verified upload (${failure})`,()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'lbt-backup-test-')),bin=path.join(dir,'bin'),out=path.join(dir,'backups');mkdirSync(bin);mkdirSync(out);
  const executable=(name:string,body:string)=>writeFileSync(path.join(bin,name),`#!/usr/bin/env bash\n${body}\n`,{mode:0o755});
  executable('chown','exit 0');
  executable('docker',`if [[ "$1" = run && "$FAIL_STAGE" != no-new-file ]]; then printf fixture > "$BACKUP_TEST_OUTPUT/fresh.lbt"; fi`);
  executable('aws',`case "$FAIL_STAGE:$*" in upload:s3\\ cp*|verify:s3\\ ls*) exit 1;; esac\nexit 0`);
  writeFileSync(path.join(dir,'.env.production'),'# fixture\n');writeFileSync(path.join(dir,'config'),'R2_ACCOUNT_ID=fixture\nR2_BUCKET=fixture\n');
  const script=readFileSync('infra/aws/backup.sh','utf8').replace(/ROOT=".*?"; cd "\$ROOT"/,'ROOT="$BACKUP_TEST_ROOT"; cd "$ROOT"').replace('CFG=/etc/loadbyton-backup.env','CFG="$BACKUP_TEST_ROOT/config"').replace('OUT=/var/backups/loadbyton','OUT="$BACKUP_TEST_OUTPUT"');
  writeFileSync(path.join(dir,'backup.sh'),script);
  const result=spawnSync('bash',[path.join(dir,'backup.sh')],{env:{...process.env,PATH:`${bin}:${process.env.PATH}`,BACKUP_TEST_ROOT:dir,BACKUP_TEST_OUTPUT:out,FAIL_STAGE:failure},encoding:'utf8',timeout:10000});
  if(failure==='none'){expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('backup OK');}
  else{expect(result.status,result.stderr).not.toBe(0);expect(result.stdout).not.toContain('backup OK');}
 });
});
