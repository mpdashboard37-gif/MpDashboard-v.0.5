const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

const configuredMode = String(process.env.DATABASE_MODE || '').trim().toLowerCase();
const hasPostgresUrl = Boolean(String(process.env.DATABASE_URL || '').trim());
const mode = configuredMode === 'postgresql' || (!configuredMode && hasPostgresUrl) ? 'postgresql' : 'sqlite';

if (!['sqlite', 'postgresql'].includes(mode)) throw new Error('DATABASE_MODE must be sqlite or postgresql.');
if (mode === 'postgresql' && !hasPostgresUrl) throw new Error('DATABASE_URL is required when DATABASE_MODE=postgresql.');

module.exports = {
    mode,
    sqlitePath: path.join(__dirname, '..', 'crm.sqlite'),
    postgresUrl: String(process.env.DATABASE_URL || '').trim(),
    postgresSsl: String(process.env.DATABASE_SSL || '').toLowerCase() === 'true'
};
