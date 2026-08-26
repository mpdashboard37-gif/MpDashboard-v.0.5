const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const sqlitePath = path.join(__dirname, 'crm.sqlite');
const backupPath = path.join(__dirname, `crm.sqlite.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required for migration. No data was changed.');
if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite database not found at ${sqlitePath}. No data was changed.`);
fs.copyFileSync(sqlitePath, backupPath);

const sqlite = new DatabaseSync(sqlitePath);
const pool = new Pool({ connectionString: databaseUrl, ssl: String(process.env.DATABASE_SSL).toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined });
const quote = (identifier) => `"${String(identifier).replace(/"/g, '""')}"`;
const pgType = (type) => {
    const normalized = String(type || '').toUpperCase();
    if (normalized.includes('INT')) return 'BIGINT';
    if (normalized.includes('REAL') || normalized.includes('FLOA') || normalized.includes('DOUB')) return 'DOUBLE PRECISION';
    if (normalized.includes('BLOB')) return 'BYTEA';
    return 'TEXT';
};
const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);

async function migrate() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const foreignKeys = [];
        const uniqueIndexes = [];
        for (const table of tables) {
            const columns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all();
            const definitions = columns.map((column) => `${quote(column.name)} ${pgType(column.type)}${column.pk ? ' PRIMARY KEY' : ''}`);
            await client.query(`CREATE TABLE IF NOT EXISTS ${quote(table)} (${definitions.join(', ')})`);
            sqlite.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all().forEach((key) => foreignKeys.push({ table, key }));
            sqlite.prepare(`PRAGMA index_list(${quote(table)})`).all().filter((index) => index.unique).forEach((index) => {
                const fields = sqlite.prepare(`PRAGMA index_info(${quote(index.name)})`).all().sort((a, b) => a.seqno - b.seqno).map((field) => quote(field.name));
                if (fields.length) uniqueIndexes.push({ table, name: index.name, fields });
            });
        }
        for (const table of tables) {
            const columns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all();
            const rows = sqlite.prepare(`SELECT * FROM ${quote(table)}`).all();
            if (!rows.length) continue;
            const names = columns.map((column) => quote(column.name));
            for (const row of rows) {
                const values = columns.map((column) => row[column.name] === undefined ? null : row[column.name]);
                const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
                await client.query(`INSERT INTO ${quote(table)} (${names.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, values);
            }
            const destinationCount = Number((await client.query(`SELECT COUNT(*)::bigint AS count FROM ${quote(table)}`)).rows[0].count);
            if (destinationCount !== rows.length) throw new Error(`${table}: source has ${rows.length} rows but PostgreSQL has ${destinationCount}`);
            console.log(`${table}: verified ${destinationCount} rows`);
        }
        for (const { table, key } of foreignKeys) {
            const constraintName = `${table}_${key.id}_fk`;
            await client.query(`DO $$ BEGIN ALTER TABLE ${quote(table)} ADD CONSTRAINT ${quote(constraintName)} FOREIGN KEY (${quote(key.from)}) REFERENCES ${quote(key.table)} (${quote(key.to)}); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        }
        for (const index of uniqueIndexes) {
            const safeName = `uq_${index.table}_${index.name}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60);
            await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${quote(safeName)} ON ${quote(index.table)} (${index.fields.join(', ')})`);
        }
        await client.query('COMMIT');
        console.log(`Migration complete. SQLite backup: ${backupPath}`);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
        await pool.end();
        sqlite.close();
    }
}

migrate().catch((error) => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
});
