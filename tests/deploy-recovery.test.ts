import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the real deployment control flow using local command fakes. No AWS, Docker or production files are touched.
describe('deployment recovery', () => {
 for (const failure of ['backup','build','preflight','migrate','readiness','up','health']) it(`restores the previous revision after ${failure} fails`, () => {
  const dir=mkdtempSync(path.join(tmpdir(),'lbt-deploy-test-'));const bin=path.join(dir,'bin');mkdirSync(bin);mkdirSync(path.join(dir,'infra/aws'),{recursive:true});
  const prev='a'.repeat(40),next='b'.repeat(40);writeFileSync(path.join(dir,'current'),prev);writeFileSync(path.join(dir,'.env.production'),'SENTRY_RELEASE=fixture\n');
  const executable=(name:string,content:string)=>writeFileSync(path.join(bin,name),`#!/usr/bin/env bash\n${content}\n`,{mode:0o755});
  executable('git',`case "$1" in rev-parse) cat "$DEPLOY_TEST_DIR/current";; checkout) printf '%s' "\${@: -1}" > "$DEPLOY_TEST_DIR/current";; esac`);
  executable('sleep','exit 0');executable('docker','exit 0');
  writeFileSync(path.join(dir,'infra/aws/backup.sh'),'#!/usr/bin/env bash\n[[ "$FAIL_STAGE" != backup ]]\n');
  writeFileSync(path.join(dir,'infra/aws/compose.sh'),`#!/usr/bin/env bash
set -eu
current=$(cat "$DEPLOY_TEST_DIR/current")
printf '%s %s\\n' "$current" "$*" >> "$DEPLOY_TEST_DIR/commands"
if [[ "$current" = "${next}" ]]; then
 case "$FAIL_STAGE:$*" in build:build|preflight:*preflight*|migrate:*migrate*|readiness:*readiness*|up:up*|health:exec*) exit 1;; esac
fi
exit 0
`);
  const script=readFileSync('infra/aws/deploy.sh','utf8').replace('cd /opt/loadbyton','cd "$DEPLOY_TEST_DIR"');const target=path.join(dir,'deploy.sh');writeFileSync(target,script);
  const result=spawnSync('bash',[target,next],{env:{...process.env,DEPLOY_TEST_DIR:dir,FAIL_STAGE:failure,PATH:`${bin}:${process.env.PATH}`},timeout:10000,encoding:'utf8'});
  expect(result.status,result.stderr).toBe(1);expect(readFileSync(path.join(dir,'current'),'utf8')).toBe(prev);
  expect(readFileSync(path.join(dir,'commands'),'utf8')).toContain(`${prev} up -d --remove-orphans`);
 });
});
