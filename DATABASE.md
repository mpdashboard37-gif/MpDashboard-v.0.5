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

Review the sanitized PASS result before using a restored database. Select and verify the source and destination paths before running either command. The workflow does not restore uploaded files; protect and back them up separately using a matching, verified procedure. Automated backup/restore tests initialize the real application schema only in a temporary directory and use synthetic records.

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
