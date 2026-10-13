# Staging verification

## Isolation and browser regression

The staging API regression (`node .rbac-idOR-regression.js`) creates its SQLite database and upload directory under the operating system temporary directory, seeds only synthetic users and records, and removes the fixture afterward. The Playwright test (`npm run check:staging-e2e`) follows the same isolation rule. Neither test should be pointed at `crm.sqlite`, a staging/production database, or the normal CRM upload directory.

Install the browser dependency and Chromium in a controlled development environment:

```powershell
npm install
npx playwright install chromium
npm run check:staging-e2e
```

The browser test exercises the login form, invalid and valid login, cookie-only authentication, CRM page navigation, lead creation and editing, tasks, follow-ups, survey completion with evidence, permitted and denied file operations, cross-user access, logout, and session invalidation. It does not configure or access Google OAuth.

## Google OAuth staging configuration

Configure these server-side environment variables in the staging environment:

| Variable | Staging value |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client ID for the staging Google OAuth web client |
| `GOOGLE_CLIENT_SECRET` | Secret for that same OAuth client; store only in the staging secret manager |
| `GOOGLE_REDIRECT_URI` | `https://<staging-host>/api/auth/google/callback` |
| `SESSION_SECRET` | Random secret of at least 32 characters |
| `CORS_ORIGIN` | Exact HTTPS origin, `https://<staging-host>` |

Register the exact callback URL as an **Authorized redirect URI** in the Google Cloud OAuth client. Keep the client ID/secret out of source control, browser code, command output, and logs. The configured OAuth scopes are `openid email profile`.

Use a dedicated synthetic Google test account authorized for the OAuth consent screen. Before testing, ensure its verified email matches `google_email` on an **active and approved synthetic CRM staff account** in the isolated staging database. Do not associate a real employee account or a real Google account with the test fixture.

1. Configure the variables and callback above in staging, then restart only the staging service.
2. Confirm `/api/auth/google/config` reports configured without logging environment values.
3. Start Google sign-in from the staging login page and complete consent with the authorized synthetic account.
4. Confirm the browser returns to the login page, obtains an HttpOnly session cookie, and has no authentication token in browser storage or the URL.
5. Confirm the synthetic account can access only the role-appropriate CRM records; test logout and verify `/api/auth/me` returns 401 afterward.
6. Inspect sanitized application logs for absence of OAuth `code`, `state`, tokens, and client-secret markers.

OAuth state currently resides in an in-process map with a ten-minute lifetime. Run the start and callback on the same staging instance; multi-instance staging requires same-instance routing or shared state storage. Real OAuth remains unverified until the staging client and authorized synthetic account are configured and the interactive flow is completed.

## Separate Render staging service

The current `render.yaml` defines the Render web service named `mpdashboard-crm`; it does not declare the separate staging service or its hostname. Keep `mpdashboard-crm-staging` on the dedicated `staging` branch and do not treat the live service URL as staging.

Keep the staging service's environment, database, uploads, OAuth client, SMTP account, and synthetic identities separate from production. Never copy production database files, uploads, or customer records into staging. Do not change, redeploy, or edit the existing live service, and do not apply a blueprint change that targets it. Confirm the staging database and file-storage persistence behavior before use.

Attach a **staging-only persistent disk** to `mpdashboard-crm-staging`, mounted at a dedicated absolute path such as `/var/data`. Do not share the production disk. The application must be configured with separate SQLite and upload paths on that disk. Do not copy or seed production CRM data into these locations.

In the **new staging service only**, enter the following values in its Environment settings. Use the exact HTTPS origin and callback for the hostname assigned to the new service (or an approved staging custom domain); do not substitute the production hostname.

| Render key | Staging value / handling |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22.5.0` (as in the current blueprint) |
| `DATABASE_MODE` | `sqlite`; do not enable PostgreSQL or point to a production database |
| `SQLITE_DB_PATH` | `/var/data/staging/crm.sqlite` (absolute path on the staging-only persistent disk; creates missing parent directories) |
| `CRM_FILE_STORAGE_ROOT` | `/var/data/staging/crm-files` (separate directory on the staging-only persistent disk; created at application initialization) |
| `ADMIN_INITIAL_PASSWORD` | Strong, staging-only secret required to initialize the first Admin in an empty staging database; remove it from the service environment after initialization |
| `SESSION_SECRET` | Generate a staging-only random value with at least 32 characters; never reuse the live secret |
| `CORS_ORIGIN` | `https://<staging-host>` exactly, with no path or trailing slash |
| `GOOGLE_CLIENT_ID` | Client ID of a Google OAuth Web application dedicated to staging |
| `GOOGLE_CLIENT_SECRET` | Matching staging OAuth secret; enter only in Render's secret UI |
| `GOOGLE_REDIRECT_URI` | `https://<staging-host>/api/auth/google/callback` |
| `PASSWORD_RESET_BASE_URL` | `https://<staging-host>/login.html` |
| `EMAIL_HOST` | SMTP submission hostname from the test mail provider |
| `EMAIL_PORT` | `587` for STARTTLS, or `465` for implicit TLS |
| `EMAIL_SECURE` | `false` for port `587`; `true` for port `465` |
| `EMAIL_USER` | Staging SMTP user |
| `EMAIL_PASSWORD` | Staging SMTP credential; secret value only in Render |
| `EMAIL_FROM` | Verified sender address at the staging mail provider |
| `CRM_LOGIN_URL` | Optional; set to `https://<staging-host>/login.html` for access-decision email links |
| `PORT` | Leave platform-managed unless the new service's Render configuration explicitly requires a value |

In Google Cloud Console, create a separate OAuth client of type **Web application**. Add the exact `GOOGLE_REDIRECT_URI` above under **Authorized redirect URIs**. Add the staging origin to **Authorized JavaScript origins** only if the Google client configuration requests it; the CRM OAuth flow is server-side. Configure the OAuth consent screen for testing and add only the dedicated synthetic Google test account as an authorized test user. Do not use a production OAuth client or a real staff member's Google account.

### Approved synthetic CRM account and Google link

1. Sign in to the staging CRM as its staging Admin. Submit an access request using a synthetic staff identity controlled for this test, then approve that request in staging. Confirm its account is `Active`/`ACTIVE`; do not use a production staff record.
2. In the staging Google test account, verify the account email. As the staging Admin, link that exact email to the synthetic staff record using the existing Admin-only endpoint `PATCH /api/staff/<synthetic-staff-id>` with JSON `{"googleEmail":"<verified-synthetic-google-email>"}`. Send the request only to the staging host with the authenticated Admin session. Do not place the test address or request in production. The endpoint currently supports linking; the staff editor UI does not expose this field.
3. Confirm the account is approved and active before sign-in. The OAuth callback rejects unregistered and inactive users. Use the CRM's Google sign-in button for the actual test; do not consider `/api/auth/google/config` alone evidence that OAuth works.
4. Do not print response cookies, OAuth codes, state values, tokens, or secrets. Use a clean browser profile and inspect only cookie attributes and whether the session is present.

## Hosted staging browser checks

Use a real browser against only the confirmed staging URL, not the production URL. Use synthetic lead/task/follow-up/survey data created in staging. Prepare synthetic identities for Admin, Sales Manager, Sales Executive, and Telecaller, each with appropriate team ownership. Never test permanent deletion against a non-test record.

1. Test password login and Google login for the authorized synthetic account. Test an unlinked Google test identity and, if available, a disabled synthetic CRM account; both must be denied without a session.
2. For each role, verify lead-list visibility and direct/API access to a synthetic lead that belongs to another user or team. Verify unauthorized read/write/assignment requests are rejected and data remains unchanged.
3. Exercise task and follow-up create/view/update/complete/reschedule, survey assign/edit/complete with required fields and evidence, and upload/download/delete permissions using synthetic records and files.
4. Verify only Admin can permanently delete a disposable synthetic lead. Confirm non-Admin denial leaves the lead intact.
5. Log out, verify the session cookie is cleared, and verify `/api/auth/me` returns `401`. Confirm the browser URL and web storage do not contain an authentication token. Review sanitized server logs for OAuth code/state/token markers.
6. Record actual outcomes for each step. A local Playwright pass does not count as a hosted staging result.

## Actual SMTP delivery rehearsal

Use only a test SMTP account and a designated test inbox controlled by the project. Configure the `EMAIL_*` variables above on the staging service and set `PASSWORD_RESET_BASE_URL` to `https://<staging-host>/login.html`. Never use customer addresses or include credentials in source, tickets, screenshots, or logs.

1. Use an active, non-Admin synthetic CRM account whose registered email is the designated test inbox. From staging, submit its address to **Forgot password**.
2. Confirm the message actually arrives in that inbox and its link starts with the configured staging login URL. The reset token is placed in the URL fragment; do not copy it into logs or reports.
3. Follow the link in the browser, complete a synthetic password reset, and verify the resulting login works. Confirm the reset token cannot be reused and that an invalid/expired token is rejected.
4. Check provider delivery status and sanitized staging logs for errors. The forgot-password endpoint intentionally returns a generic response and logs only whether delivery was attempted; an HTTP success response alone is not proof of delivery.

Do not test password reset with the permanent Admin account; the application intentionally excludes it from this reset flow.

## Final staging regression and audit

Run these commands from the repository after dependencies are installed. The checked-in API, backup, security, adapter, and Playwright tests use disposable fixtures and synthetic data; keep them isolated from the staging service and real CRM data.

```powershell
npm run check:security
npm run check:backup-restore
npm run check:postgres-adapter
node .rbac-idOR-regression.js
npm run check:staging-e2e
npm run check
npm run check:integrations
npm audit
git diff --check
```

Record each exit code and the reported test count. Require `npm audit` to report zero vulnerabilities, investigate rather than suppress any regression failure, and review dependency compatibility before release. The local Playwright test validates the isolated local app only. Production review remains blocked until separate staging OAuth, hosted role/workflow browser tests, and actual SMTP delivery are performed and documented.

## Safe SQLite backup/restore rehearsal

The current CRM adapter defaults to SQLite, but verify the **running test/staging process configuration** before selecting a file; do not infer it from an old `.env` file. `database/config.js` exposes `mode` and `sqlitePath`. In the current source, the default SQLite path is the repository's `crm.sqlite`; never use that path for a rehearsal or restore test.

Use a separately initialized synthetic CRM-schema database in a private temporary directory as the source. Select a new destination in a private directory with restricted permissions, verify the destination does not exist, and pass both absolute paths explicitly:

```powershell
npm run backup:sqlite -- --source "C:\private\synthetic-source.sqlite" --destination "C:\private\backups\synthetic-backup.sqlite"
npm run restore:sqlite -- --source "C:\private\backups\synthetic-backup.sqlite" --destination "C:\private\restore-test\synthetic-restored.sqlite"
```

The commands require SQLite mode, require distinct source and destination files, and refuse an existing destination. They do not overwrite the source. The new file is protected with a Windows owner-only ACL and verified for SQLite integrity, required CRM tables, foreign-key violations, schema hash, and per-table row counts. The restore command creates a separate database file; it does not replace the running CRM database. Automated tests also verify a synthetic lead/staff/follow-up relationship.

Before a rehearsal, verify the source path is the disposable fixture and the destination parent is a restricted directory; do not place backups under the repository or web-served paths. On any failure, do not open or use the destination as a CRM database. Preserve the source and all pre-existing files; the utility will not overwrite a destination on retry, so choose a fresh destination name after investigating the failure. The tool does not back up uploaded files; those require a separately reviewed and rehearsed procedure.
