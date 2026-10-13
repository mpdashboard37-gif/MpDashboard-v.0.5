const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

const configuredMode = String(process.env.DATABASE_MODE || '').trim().toLowerCase();
const hasPostgresUrl = Boolean(String(process.env.DATABASE_URL || '').trim());
const hasMysqlEnv = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].some((key) => String(process.env[key] || '').trim() !== '');

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
let postgresUrl = '';
if (mode === 'postgresql') {
    postgresUrl = String(process.env.DATABASE_URL || '').trim();
    let parsedUrl;
    try {
        parsedUrl = new URL(postgresUrl);
    } catch (error) {
        throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
    }
    if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol) || !parsedUrl.hostname) {
        throw new Error('DATABASE_URL must use the postgres:// or postgresql:// scheme and include a host.');
    }
}
const configuredPostgresSsl = String(process.env.DATABASE_SSL || '').trim().toLowerCase();
if (configuredPostgresSsl && !['true', 'false'].includes(configuredPostgresSsl)) {
    throw new Error('DATABASE_SSL must be true or false.');
}
const postgresSsl = mode === 'postgresql' ? configuredPostgresSsl !== 'false' : false;
if (mode === 'postgresql' && String(process.env.NODE_ENV || '').toLowerCase() === 'production' && !postgresSsl) {
    throw new Error('DATABASE_SSL must be enabled for PostgreSQL in production.');
}
const configuredSqlitePath = String(process.env.SQLITE_DB_PATH || '').trim();
const sqlitePath = configuredSqlitePath
    ? path.resolve(configuredSqlitePath)
    : path.join(__dirname, '..', 'crm.sqlite');
if (mode === 'mysql') {
    const port = Number(process.env.DB_PORT || 3306);
    if (!String(process.env.DB_HOST || '').trim()) throw new Error('DB_HOST is required when DATABASE_MODE=mysql or DB_* variables are provided.');
    if (!String(process.env.DB_USER || '').trim()) throw new Error('DB_USER is required when MySQL mode is enabled.');
    if (!String(process.env.DB_NAME || '').trim()) throw new Error('DB_NAME is required when MySQL mode is enabled.');
    if (!Number.isInteger(port) || port <= 0) throw new Error('DB_PORT must be a valid port number.');
}

module.exports = {
    mode,
    sqlitePath,
    postgresUrl,
    postgresSsl,
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
