const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

const sqlitePath = path.join(__dirname, 'crm.sqlite');
const backupPath = path.join(__dirname, `crm.sqlite.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const schemaPath = path.join(__dirname, 'mysql', 'schema.sql');
const targetDatabase = String(process.env.DB_NAME || 'inpace_crm').trim();

if (!String(process.env.DB_HOST || '').trim()) throw new Error('DB_HOST is required for the MySQL migration.');
if (!String(process.env.DB_USER || '').trim()) throw new Error('DB_USER is required for the MySQL migration.');
if (!String(process.env.DB_PASSWORD || '').trim()) throw new Error('DB_PASSWORD is required for the MySQL migration.');
if (!targetDatabase) throw new Error('DB_NAME is required for the MySQL migration.');
if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite database not found at ${sqlitePath}. No data was changed.`);
if (!fs.existsSync(schemaPath)) throw new Error(`MySQL schema file not found at ${schemaPath}. No data was changed.`);

fs.copyFileSync(sqlitePath, backupPath);

const sqlite = new DatabaseSync(sqlitePath);
const quote = (identifier) => `\`${String(identifier).replace(/`/g, '``')}\``;

async function ensureDatabase() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        charset: 'utf8mb4',
        multipleStatements: true
    });

    try {
        await connection.execute(`CREATE DATABASE IF NOT EXISTS ${quote(targetDatabase)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } finally {
        await connection.end();
    }
}

async function migrate() {
    await ensureDatabase();

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: targetDatabase,
        charset: 'utf8mb4',
        multipleStatements: true
    });

    try {
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        await connection.query(schemaSql);

        const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);

        for (const table of tables) {
            const columns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all();
            if (!columns.length) continue;
            const rows = sqlite.prepare(`SELECT * FROM ${quote(table)}`).all();
            if (!rows.length) continue;

            const columnNames = columns.map((column) => `\`${column.name}\``);
            const placeholders = columns.map(() => '?').join(', ');
            const insertSql = `INSERT INTO ${quote(table)} (${columnNames.join(', ')}) VALUES (${placeholders})`;
            const values = rows.map((row) => columns.map((column) => {
                const value = row[column.name];
                if (value === undefined) return null;
                if (typeof value === 'number' && Number.isNaN(value)) return null;
                return value;
            }));

            for (const rowValues of values) {
                await connection.execute(insertSql, rowValues);
            }

            const [countResult] = await connection.execute(`SELECT COUNT(*) AS count FROM ${quote(table)}`);
            const destinationCount = Number(countResult[0]?.count || 0);
            if (destinationCount !== rows.length) {
                throw new Error(`${table}: source has ${rows.length} rows but MySQL has ${destinationCount}`);
            }

            console.log(`${table}: migrated ${destinationCount} rows`);
        }

        console.log(`Migration complete. SQLite backup created at: ${backupPath}`);
    } catch (error) {
        console.error('MySQL migration failed:', error.message);
        process.exitCode = 1;
        throw error;
    } finally {
        await connection.end();
        sqlite.close();
    }
}

migrate().catch(() => {
    // Intentionally left here to ensure the migration exits with a failing exit code.
});
