# Database operations

## Current application state

Local CRM operation is SQLite-backed. Most handlers in `server.js` use synchronous `node:sqlite` statements and SQLite-specific SQL, and `pipeline-api.js` also contains SQLite-specific behavior. The asynchronous lead repository is only one part of the API and does not make the whole application PostgreSQL-compatible.

The PostgreSQL adapter uses one managed `pg` pool per adapter instance, parameterized query conversion, verified TLS when enabled, bounded pool settings, and a health check. `database/config.js` validates PostgreSQL URLs without printing them and requires TLS in production. The PostgreSQL CRM routes are **not implemented**: the server deliberately refuses PostgreSQL mode before opening or initializing any database. This prevents a PostgreSQL selection from falling through to SQLite schema initialization or serving partially migrated routes.

The existing `supabase/schema.sql` is incomplete relative to the entities and columns initialized/used by `server.js`. Do not apply it to Supabase. A complete, ordered schema migration and the asynchronous route conversion are still required before enabling PostgreSQL.

## Local configuration

Keep `DATABASE_MODE=sqlite` for the existing local application. For a future PostgreSQL staging environment, configure `DATABASE_MODE=postgresql`, a server-only `DATABASE_URL`, and `DATABASE_SSL=true`. Do not put connection strings, Supabase service keys, or database credentials in browser code or source control. Production PostgreSQL requires TLS certificate verification.

The current PostgreSQL implementation has not been verified against a Supabase instance because this work does not connect to a configured database. A failed PostgreSQL connection must not trigger a SQLite fallback.

## Read-only source inspection

The only currently enabled SQLite-to-PostgreSQL utility mode is a read-only schema and row-count inspection. It does not read row values, connect to PostgreSQL, create a backup, or write to either database:

```text
npm run migrate:postgres -- --dry-run
```

To inspect an explicitly selected SQLite file:

```text
npm run migrate:postgres -- --dry-run --sqlite C:\path\to\source.sqlite
```

Without `--dry-run`, the utility stops. **A data-copy mode is intentionally disabled** until the full PostgreSQL schema, application route conversion, and migration verification are complete and reviewed. Do not treat local SQLite as authoritative production data.

## SQLite backup and restore

The currently supported CRM database is SQLite. The backup utility requires an explicit SQLite source and a separate, not-yet-existing destination. It reads the source without opening it for writes, creates a consistent snapshot with SQLite `VACUUM INTO`, applies owner-only file permissions, and verifies SQLite integrity, foreign keys, schema, and per-table row counts. Restore uses the same verified-copy procedure; it never overwrites the source or an existing destination.

Choose a destination directory that is already access-controlled and has enough free space. CRM backups contain sensitive business data; store them on encrypted storage and retain them according to the organization’s backup policy. Do not put backup files in the repository or web-served directories. The utility refuses PostgreSQL/MySQL mode; it does not back up or restore those databases.

Create a new backup (PowerShell):

```powershell
npm run backup:sqlite -- --source "C:\private\crm.sqlite" --destination "C:\private\backups\crm-20261012.sqlite"
```

Restore that backup to a separate new database file:

```powershell
npm run restore:sqlite -- --source "C:\private\backups\crm-20261012.sqlite" --destination "C:\private\restore-test\crm-restored.sqlite"
```

Review the sanitized PASS result before using a restored database. Select and verify the source and destination paths before running either command. This explicit SQLite utility restores database files only; use the automated snapshot procedure below to protect uploaded files as well. Backup/restore tests initialize the application schema only in a temporary directory and use synthetic records.

## Remaining work before a safe migration

1. Inventory and map every application table, column, constraint, index, and data semantic to an ordered, version-controlled PostgreSQL migration. The existing prototype schema is not complete.
2. Convert synchronous SQLite queries, SQL functions, insert-result handling, and transaction boundaries across all CRM routes to the shared asynchronous database interface. Preserve API contracts and backend authorization.
3. Add tests against a dedicated, explicitly configured PostgreSQL test database. Test migrations, rollback, uniqueness, foreign keys, and representative CRM workflows without production records.
4. Implement the explicit-confirmation data-copy utility with read-only source access, bounded batches, sanitized reporting, conflict detection, and repeat-run verification.
5. Configure and verify an isolated Supabase staging project before considering an authoritative source and an approved production data migration.

No PostgreSQL schema migration, source-data copy, hosting configuration change, or deployment has been run as part of this work.

## Render preparation (not deployment instructions)

Do not change a live Render service to PostgreSQL while the application rejects PostgreSQL mode. Once the items above are complete and staging is verified, the deployment plan should:

1. Create a dedicated Supabase project and record the project/environment identity.
2. Obtain the PostgreSQL connection string using the connection method compatible with the service's network and connection limits.
3. Add `DATABASE_MODE=postgresql`, `DATABASE_URL`, and `DATABASE_SSL=true` as protected Render environment variables. Never place credentials in `render.yaml`.
4. Apply the reviewed versioned schema migrations to the intended staging database, then verify the selected database and migration history.
5. Run staging workflow and authorization checks before scheduling any production change.
6. Select and explicitly approve the authoritative source before any data-copy operation; verify counts, constraints, and representative workflows without exposing personal data.
7. Preserve the original SQLite database and uploaded files throughout the change. Define and rehearse a rollback that does not discard writes made after cutover.
8. Do not restart or redeploy the live service until preservation, cutover, and rollback procedures are approved.

Connection limits, TLS verification, database backups, correct-environment selection, and rollback must be verified before deployment. Render and Supabase have not been contacted or modified.

## Render SQLite and uploaded-file persistence

The checked-in `render.yaml` currently declares a **free** web service and does not declare a persistent disk. Render persistent disks require a paid service plan. Until an operator approves that recurring cost and attaches a disk, the blueprint is **not production-durable**: the default `crm.sqlite` and `crm-files` paths are inside the service directory and can be lost when the service instance is replaced or redeployed.

For the current SQLite application, configure the production web service with a dedicated persistent disk mounted at `/var/data` and set these server-side environment variables in the Render service dashboard:

| Variable | Required production value or handling |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_MODE` | `sqlite`; PostgreSQL mode is not supported by all CRM routes yet |
| `SQLITE_DB_PATH` | `/var/data/crm.sqlite` |
| `CRM_FILE_STORAGE_ROOT` | `/var/data/crm-files` |
| `SESSION_SECRET` | Render-generated secret, at least 32 characters; keep stable across restarts and instances |
| `PORT` | Leave platform-managed; do not rely on a hardcoded local port |
| `CORS_ORIGIN` | Exact public HTTPS origin, with no trailing slash |
| `PASSWORD_RESET_BASE_URL` | `https://<production-host>/login.html` |
| `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_SECURE`, `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_FROM` | Production mail provider settings; credentials only in the secret manager |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Optional OAuth configuration; use the production callback and server-side secret storage |
| `ADMIN_INITIAL_PASSWORD` | Only for first initialization of an empty database; remove after the initial Admin account is provisioned |
| `CRM_BACKUP_ROOT` | Required to enable scheduled backups; dedicated directory outside the application and uploaded-file directories |
| `CRM_BACKUP_RETENTION_DAYS` | Optional; integer from 1 to 365, default 14 |

The application resolves `SQLITE_DB_PATH` to an absolute path and, outside production, the SQLite adapter can create a missing database; it also creates the upload directory during initialization. In production, startup now requires explicit `SQLITE_DB_PATH` and `CRM_FILE_STORAGE_ROOT` values, an existing database that passes a read-only integrity/schema preflight, and an existing non-symlink upload directory. A missing, empty, corrupt, or uninitialized database causes startup to fail before SQLite is opened for writes. These checks do **not** prove that the configured paths are mounted on persistent storage. Before starting or restarting a production service, verify the mounted disk is present at `/var/data`, both configured paths resolve beneath that mount, and the existing database and file directories are preserved. Never point these variables at the repository defaults or an unverified/empty mount for a service that already has customer data. Do not copy, replace, initialize, or migrate an existing production database as part of attaching storage.

The actual Render service, plan, mounted disks, and environment values are outside this repository and have not been inspected. This guidance does not configure the existing live service. Keep the service non-production until an authorized operator approves the paid disk and completes a preservation plan for any existing database and uploads.

## Automated SQLite and uploaded-file backups

When `NODE_ENV=production`, `DATABASE_MODE=sqlite`, and `CRM_BACKUP_ROOT` is configured, the server starts an isolated child process that checks for a verified snapshot at startup and every 15 minutes. It creates at most one snapshot per UTC day and retries after a failed attempt. Backups are not created if the destination variable is missing; the server emits a configuration warning instead of silently claiming coverage. The scheduled job only runs while the server is running and is intended for a single application instance.

Set `CRM_BACKUP_ROOT` to a dedicated directory separate from the database and upload trees (for example `/var/data/crm-backups` beside `/var/data/crm.sqlite` and `/var/data/crm-files`). Each published snapshot contains `crm.sqlite` and a `crm-files` directory. The database is copied with the existing SQLite integrity/schema/row-count checks; uploaded files are copied only if the source tree is stable for the duration of the copy. A snapshot is published atomically after verification, and its files/directories receive owner-only permissions. Retention defaults to 14 days; `CRM_BACKUP_RETENTION_DAYS` accepts 1–365 days. The manual command `npm run backup:automated` runs the same one-snapshot check and requires the same environment variables.

Restore only into a new isolated directory. Use the existing `restore:sqlite` command with the snapshot's `crm.sqlite` as source and a new destination file, then copy the snapshot's `crm-files` tree into a separate restored upload directory. Validate the restored database and files before changing any application paths. Never restore over the live database or upload directory. The automated test exercises both database and uploaded-file restore using synthetic records and temporary paths; it does not inspect or restore production data.

The snapshot destination should be on persistent, access-controlled, encrypted storage. Keeping backups on the same host disk protects against some logical errors but **does not** protect against disk loss, host loss, or account compromise. No off-host replication, Render disk, cron service, or external storage has been configured. An authorized operator must configure a durable destination and a separate encrypted off-host copy before treating automated backups as production recovery coverage. The checked-in Render blueprint remains on the free plan, so its current service does not have the persistent `/var/data` mount described above.

### Off-site recovery strategy (manual configuration required)

Use an encrypted object-storage destination in a separately administered account or cloud project, not the Render service disk or the same cloud account's only storage volume. Transfer each verified snapshot over TLS using a dedicated least-privilege service identity that can write snapshots but cannot read application secrets or alter the live CRM. Enable provider-side encryption, object versioning or immutable retention, and lifecycle retention aligned with the approved recovery-point and legal-retention requirements. Keep encryption-key administration separate from the storage identity, alert on missing or failed daily copies, and periodically restore a selected snapshot into a disposable isolated environment to verify both the database and uploaded files. Store credentials only in the hosting provider's secret manager.

No provider, bucket, credentials, lifecycle policy, recurring cost, or replication job is configured by this repository. Select the provider and approve any associated cost before implementation. Do not copy production data until the persistent source database and upload directories have been identified and preserved.
