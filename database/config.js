const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
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

function assertProductionStorage(environment = process.env) {
    const configuredMode = String(environment.DATABASE_MODE || '').trim().toLowerCase();
    if (String(environment.NODE_ENV || '').toLowerCase() !== 'production'
        || (configuredMode && configuredMode !== 'sqlite')) return;

    const configuredDatabasePath = String(environment.SQLITE_DB_PATH || '').trim();
    const configuredFileStorageRoot = String(environment.CRM_FILE_STORAGE_ROOT || '').trim();
    if (!configuredDatabasePath || !configuredFileStorageRoot) {
        throw new Error('Production SQLite requires explicit SQLITE_DB_PATH and CRM_FILE_STORAGE_ROOT paths.');
    }

    const databasePath = path.resolve(configuredDatabasePath);
    const fileStorageRoot = path.resolve(configuredFileStorageRoot);
    let databaseStat;
    let fileStorageStat;
    try {
        databaseStat = fs.lstatSync(databasePath);
        fileStorageStat = fs.lstatSync(fileStorageRoot);
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error('Production SQLite database and uploaded-file storage must already exist; refusing to initialize missing storage.');
        }
        throw error;
    }
    if (!databaseStat.isFile() || databaseStat.isSymbolicLink() || databaseStat.size === 0
        || !fileStorageStat.isDirectory() || fileStorageStat.isSymbolicLink()) {
        throw new Error('Production SQLite requires an existing database file and uploaded-file directory.');
    }

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
        const integrity = database.prepare('PRAGMA quick_check').all();
        const requiredTables = ['staff', 'leads', 'sessions', 'lead_documents', 'survey_files'];
        const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${requiredTables.map(() => '?').join(', ')})`).all(...requiredTables);
        if (integrity.length !== 1 || integrity[0].quick_check !== 'ok' || tables.length !== requiredTables.length) {
            throw new Error('Production SQLite database is not a valid initialized CRM database.');
        }
    } finally {
        database.close();
    }
    return true;
}

module.exports = {
    mode,
    sqlitePath,
    assertProductionStorage,
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
