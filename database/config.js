const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

const configuredMode = String(process.env.DATABASE_MODE || '').trim().toLowerCase();
const hasPostgresUrl = Boolean(String(process.env.DATABASE_URL || '').trim());
const hasMysqlEnv = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].some((key) => String(process.env[key] || '').trim() !== '');

let mode = 'sqlite';
if (configuredMode === 'mysql' || configuredMode === 'postgresql') {
    mode = configuredMode;
} else if (!configuredMode && hasMysqlEnv) {
    mode = 'mysql';
} else if (!configuredMode && hasPostgresUrl) {
    mode = 'postgresql';
}

if (!['sqlite', 'mysql', 'postgresql'].includes(mode)) throw new Error('DATABASE_MODE must be sqlite, mysql, or postgresql.');
if (mode === 'postgresql' && !hasPostgresUrl) throw new Error('DATABASE_URL is required when DATABASE_MODE=postgresql.');
if (mode === 'mysql') {
    const port = Number(process.env.DB_PORT || 3306);
    if (!String(process.env.DB_HOST || '').trim()) throw new Error('DB_HOST is required when DATABASE_MODE=mysql or DB_* variables are provided.');
    if (!String(process.env.DB_USER || '').trim()) throw new Error('DB_USER is required when MySQL mode is enabled.');
    if (!String(process.env.DB_NAME || '').trim()) throw new Error('DB_NAME is required when MySQL mode is enabled.');
    if (!Number.isInteger(port) || port <= 0) throw new Error('DB_PORT must be a valid port number.');
}

module.exports = {
    mode,
    sqlitePath: path.join(__dirname, '..', 'crm.sqlite'),
    postgresUrl: String(process.env.DATABASE_URL || '').trim(),
    postgresSsl: String(process.env.DATABASE_SSL || '').toLowerCase() === 'true',
    mysql: {
        host: String(process.env.DB_HOST || '127.0.0.1').trim(),
        port: Number(process.env.DB_PORT || 3306),
        user: String(process.env.DB_USER || '').trim(),
        password: String(process.env.DB_PASSWORD || '').trim(),
        database: String(process.env.DB_NAME || 'inpace_crm').trim(),
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        multipleStatements: false
    }
};
