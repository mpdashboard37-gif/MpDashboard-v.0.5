# Database Operations

## Current runtime

Local development currently uses `crm.sqlite` through Node's synchronous `node:sqlite` API. The existing CRM routes, authentication, dashboard, lead, follow-up, activity, task, opportunity, proposal, survey, inventory, and notification operations continue to use this local database.

The schema is initialized and migrated by `initializeDatabase()` in `server.js`. Existing tables include `staff`, `leads`, `follow_ups`, `lead_activities`, `lead_stage_history`, `opportunities`, `proposals`, `surveys`, `notifications`, inventory tables, project/payment tables, authentication tables, and file metadata tables. Foreign keys are enabled in SQLite.

## PostgreSQL preparation

Production configuration is represented by `DATABASE_URL` and `DATABASE_SSL`. Database selection is centralized in `database/config.js`, and `database/index.js` creates either the Promise-based `SqliteAdapter` or `PostgresAdapter`. Both adapters expose `get`, `all`, `run`, `exec`, `transaction`, and `health` methods.

The Supabase-specific PostgreSQL schema is in [supabase/schema.sql](supabase/schema.sql). It is intended for a new Supabase database and must not be run against `crm.sqlite`. `DATABASE_URL` remains server-only; Supabase publishable keys are not used by the browser or API client.

The current request handlers remain synchronous and SQLite-backed. PostgreSQL mode intentionally fails fast in `server.js` until those handlers are moved behind the async repository contract. This prevents a partial deployment where health checks pass against PostgreSQL while CRM writes still go to SQLite.

Run `npm.cmd run check:database` to validate the SQLite adapter against the existing database without changing CRM records. The server logs `Database mode: SQLite` when `DATABASE_URL` is absent.

The planned production topology is Node.js/Express on phoenixNAP with Supabase PostgreSQL. Render remains unchanged until the phoenixNAP environment is verified. Zapier preparation is documented in [integrations/ZAPIER.md](integrations/ZAPIER.md); no webhook is called unless `ZAPIER_WEBHOOK_URL` is configured server-side.

## Migration

1. Back up the SQLite file before migration. The migration script also creates a timestamped backup automatically.
2. Set `DATABASE_URL` and, when required by the provider, `DATABASE_SSL=true`.
3. Run:

```text
npm.cmd run migrate:postgres
```

The script introspects all existing SQLite tables, columns, primary keys, unique indexes, foreign keys, and rows. It creates equivalent PostgreSQL tables, copies rows with `ON CONFLICT DO NOTHING`, restores relationships, and prints row counts. It never deletes or modifies the source SQLite file.

For production, the remaining application step is to move the synchronous `database.prepare()` calls in `server.js` behind an async repository interface, then select the PostgreSQL repository when `DATABASE_URL` is configured. That refactor must be tested route-by-route because there are hundreds of existing synchronous call sites and transaction boundaries.

## Environment

Copy `.env.example` to `.env` for local work. Never commit `.env` or real credentials.

```text
NODE_ENV=development
PORT=3000
DATABASE_MODE=sqlite
DATABASE_URL=
DATABASE_SSL=false
SESSION_SECRET=
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
ZAPIER_WEBHOOK_URL=
```

Local startup:

```text
npm.cmd install
npm.cmd run check
npm.cmd start
```

Health check:

```text
http://localhost:3000/api/health/database
```
