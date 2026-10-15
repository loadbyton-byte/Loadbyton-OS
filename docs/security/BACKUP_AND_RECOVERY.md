# Backup and recovery

**Objectives (to be proven, not promised):** RPO 1 hour, RTO 8 hours.

- Database: provider point-in-time recovery plus the nightly encrypted logical backup (`npm run backup`), copied to the backups bucket in R2 by cron (see DEPLOY_AWS_LEAN.md).
- Files: R2 with versioning on the files bucket; the backup job also records an object manifest.
- Keys: the backup key is held offline, separate from the backups.

## Drill schedule
- **Quarterly:** restore the latest backup into an isolated database and object prefix, run `npm run verify` (must print "All invariants hold"), sign in as a test tenant, open documents, compare balances. Follow `docs/RUNBOOKS.md`.
- **Before any schema release:** restore the previous night's backup, apply the new migrations, run `npm run verify`.
- **Yearly:** rebuild the whole stack from the Terraform and the backup in a scratch account to measure real RTO.

## Evidence to keep
Date, who ran it, backup file used, time taken, verify output, problems found, fixes. A backup that has not been restored in the last quarter is treated as unproven.
