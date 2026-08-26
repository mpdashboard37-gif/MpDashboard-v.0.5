const { Pool } = require('pg');

function postgresPlaceholders(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
}

class PostgresAdapter {
    constructor(connectionString, ssl = false) {
        this.kind = 'postgresql';
        this.pool = new Pool({ connectionString, ssl: ssl ? { rejectUnauthorized: false } : undefined });
    }

    async query(sql, params = [], client = this.pool) {
        return client.query(postgresPlaceholders(sql), params);
    }

    async get(sql, params = []) {
        const result = await this.query(sql, params);
        return result.rows[0];
    }

    async all(sql, params = []) {
        const result = await this.query(sql, params);
        return result.rows;
    }

    async run(sql, params = []) {
        const result = await this.query(sql, params);
        return { changes: result.rowCount, lastInsertRowid: null };
    }

    async exec(sql) {
        await this.query(sql);
    }

    async transaction(work) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const transactionAdapter = {
                get: (sql, params) => this.getWithClient(client, sql, params),
                all: (sql, params) => this.allWithClient(client, sql, params),
                run: (sql, params) => this.runWithClient(client, sql, params),
                exec: (sql) => this.execWithClient(client, sql)
            };
            const result = await work(transactionAdapter);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async getWithClient(client, sql, params = []) {
        const result = await this.query(sql, params, client);
        return result.rows[0];
    }

    async allWithClient(client, sql, params = []) {
        const result = await this.query(sql, params, client);
        return result.rows;
    }

    async runWithClient(client, sql, params = []) {
        const result = await this.query(sql, params, client);
        return { changes: result.rowCount, lastInsertRowid: null };
    }

    async execWithClient(client, sql) {
        await this.query(sql, [], client);
    }

    async health() {
        await this.query('SELECT 1 AS connected');
        return { database: 'postgresql', connected: true };
    }

    async close() {
        await this.pool.end();
    }
}

module.exports = { PostgresAdapter };
