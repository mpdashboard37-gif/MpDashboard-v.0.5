const { Pool } = require('pg');

function postgresPlaceholders(sql) {
    let index = 0;
    let result = '';
    let state = 'normal';
    let dollarQuote = '';

    for (let position = 0; position < sql.length; position += 1) {
        const character = sql[position];
        const next = sql[position + 1];

        if (state === 'single') {
            result += character;
            if (character === "'" && next === "'") {
                result += next;
                position += 1;
            } else if (character === "'") {
                state = 'normal';
            } else if (character === '\\' && next) {
                result += next;
                position += 1;
            }
            continue;
        }

        if (state === 'double') {
            result += character;
            if (character === '"' && next === '"') {
                result += next;
                position += 1;
            } else if (character === '"') {
                state = 'normal';
            }
            continue;
        }

        if (state === 'line-comment') {
            result += character;
            if (character === '\n') state = 'normal';
            continue;
        }

        if (state === 'block-comment') {
            result += character;
            if (character === '*' && next === '/') {
                result += next;
                position += 1;
                state = 'normal';
            }
            continue;
        }

        if (state === 'dollar-quote') {
            if (sql.startsWith(dollarQuote, position)) {
                result += dollarQuote;
                position += dollarQuote.length - 1;
                state = 'normal';
            } else {
                result += character;
            }
            continue;
        }

        if (character === "'") {
            state = 'single';
            result += character;
        } else if (character === '"') {
            state = 'double';
            result += character;
        } else if (character === '-' && next === '-') {
            state = 'line-comment';
            result += '--';
            position += 1;
        } else if (character === '/' && next === '*') {
            state = 'block-comment';
            result += '/*';
            position += 1;
        } else if (character === '$') {
            const delimiter = sql.slice(position).match(/^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/)?.[0];
            if (delimiter) {
                dollarQuote = delimiter;
                state = 'dollar-quote';
                result += delimiter;
                position += delimiter.length - 1;
            } else {
                result += character;
            }
        } else if (character === '?') {
            result += `$${++index}`;
        } else {
            result += character;
        }
    }

    return { sql: result, count: index };
}

class PostgresAdapter {
    constructor(connectionString, ssl = false) {
        this.kind = 'postgresql';
        this.pool = new Pool({
            connectionString,
            ssl: ssl ? { rejectUnauthorized: true } : undefined,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
            keepAlive: true,
            application_name: 'mpdashboard-crm'
        });
        this.closePromise = null;
        this.pool.on('error', (error) => {
            console.error('PostgreSQL idle client error:', error.code || error.name || 'unknown error');
        });
    }

    async query(sql, params = [], client = this.pool) {
        const converted = postgresPlaceholders(sql);
        if (converted.count !== params.length) {
            throw new Error(`PostgreSQL parameter count mismatch: expected ${converted.count}, received ${params.length}.`);
        }
        return client.query(converted.sql, params);
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
        let transactionStarted = false;
        try {
            await client.query('BEGIN');
            transactionStarted = true;
            const transactionAdapter = {
                get: (sql, params) => this.getWithClient(client, sql, params),
                all: (sql, params) => this.allWithClient(client, sql, params),
                run: (sql, params) => this.runWithClient(client, sql, params),
                exec: (sql) => this.execWithClient(client, sql)
            };
            const result = await work(transactionAdapter);
            await client.query('COMMIT');
            transactionStarted = false;
            return result;
        } catch (error) {
            if (transactionStarted) {
                try {
                    await client.query('ROLLBACK');
                } catch (rollbackError) {
                    if (error instanceof Error) {
                        error.rollbackError = rollbackError;
                    } else {
                        throw new AggregateError([error, rollbackError], 'PostgreSQL transaction and rollback both failed.');
                    }
                }
            }
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
        if (!this.closePromise) this.closePromise = this.pool.end();
        await this.closePromise;
    }
}

module.exports = { PostgresAdapter, postgresPlaceholders };
