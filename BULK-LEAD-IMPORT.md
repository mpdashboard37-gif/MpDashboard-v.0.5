# Bulk Lead Import

Bulk Lead Import is available to authenticated Admin/Owner users from the CRM app menu or the lead navigation.

## Spreadsheet format

The first worksheet (or CSV header row) must start at cell A1 and contain these columns:

`Customer Name`, `Contact Number`, `Email ID`, `Customer Address`, `Pincode`

Email, address, and pincode may be blank. Customer name and contact number are required. Indian mobile numbers use the CRM's existing 10-digit normalization; supplied `+91` prefixes are accepted. Pincodes must contain six digits and start with 1-9.

Supported formats are `.xlsx`, `.xls`, and `.csv`. Files are limited to 5 MB and 10,000 data rows. Uploading only creates a validation preview. Starting the import queues a persistent SQLite job and commits at most 500 leads per transaction. Leads use the CRM's configured default source and standard `New` stage. Active sales roles are Sales Executive, Sales Manager, GM/AGM, and Telecaller; inactive or disabled staff are excluded. Assignment starts at the lexicographically lowest eligible staff ID and continues across committed batches.

## Local validation

Run:

```sh
npm run test:lead-import
npm run check
```

Start the CRM using its normal local configuration, sign in as an Admin/Owner, open **Bulk Lead Import**, download the sample CSV template, add synthetic customer rows, upload it, inspect the preview, and start the import. Do not use real customer data in a disposable test database.

The server exposes authenticated endpoints under `/api/lead-imports`: `POST /preview`, `POST /:id/start`, `GET /:id`, `GET /:id/errors`, and `DELETE /:id` (preview cancellation only). Jobs and progress persist in the existing SQLite database; startup resumes queued or interrupted jobs. Terminal import details older than 30 days are purged the next time a valid preview is saved.

This feature follows the current SQLite runtime. The existing server explicitly does not support PostgreSQL API routes, and its other adapter paths do not expose the synchronous database operations used by the current CRM API. Do not deploy lead importing in a non-SQLite mode until the core API is migrated to that adapter.
