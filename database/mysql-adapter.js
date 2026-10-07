const mysql = require('mysql2/promise');

function normalizeParams(params = []) {
    return Array.isArray(params) ? params : [params];
}

class MySqlAdapter {
    constructor(config = {}) {
        this.kind = 'mysql';
        this.pool = mysql.createPool({
            host: config.host || '127.0.0.1',
            port: config.port || 3306,
            user: config.user,
            password: config.password || '',
            database: config.database || 'inpace_crm',
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            charset: 'utf8mb4',
            decimalNumbers: true,
            multipleStatements: false,
            ...config
        });

        this.pool.on('error', (error) => {
            console.error('MySQL pool error:', error.message);
        });
    }

    async query(sql, params = []) {
        const normalized = normalizeParams(params);
        const [rows, fields] = await this.pool.execute(sql, normalized);
        return { rows, fields, rowCount: Array.isArray(rows) ? rows.length : 0 };
    }

    async get(sql, params = []) {
        const result = await this.query(sql, params);
        return result.rows[0] || null;
    }

    async all(sql, params = []) {
        const result = await this.query(sql, params);
        return result.rows;
    }

    async run(sql, params = []) {
        const normalized = normalizeParams(params);
        const [result] = await this.pool.execute(sql, normalized);
        return {
            changes: Number(result.affectedRows || 0),
            lastInsertRowid: result.insertId ?? null
        };
    }

    async exec(sql) {
        await this.pool.execute(sql, []);
    }

    prepare(sql) {
        return {
            get: (...params) => this.get(sql, params.flat()),
            all: (...params) => this.all(sql, params.flat()),
            run: (...params) => this.run(sql, params.flat())
        };
    }

    async transaction(work) {
        const connection = await this.pool.getConnection();
        try {
            await connection.beginTransaction();
            const transactionAdapter = {
                get: (statement, params = []) => this.getWithClient(connection, statement, params),
                all: (statement, params = []) => this.allWithClient(connection, statement, params),
                run: (statement, params = []) => this.runWithClient(connection, statement, params),
                exec: (statement) => this.execWithClient(connection, statement)
            };

            const result = await work(transactionAdapter);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async getWithClient(connection, sql, params = []) {
        const [rows] = await connection.execute(sql, normalizeParams(params));
        return rows[0] || null;
    }

    async allWithClient(connection, sql, params = []) {
        const [rows] = await connection.execute(sql, normalizeParams(params));
        return rows;
    }

    async runWithClient(connection, sql, params = []) {
        const [result] = await connection.execute(sql, normalizeParams(params));
        return { changes: Number(result.affectedRows || 0), lastInsertRowid: result.insertId ?? null };
    }

    async execWithClient(connection, sql) {
        await connection.execute(sql, []);
    }

    async health() {
        const [rows] = await this.pool.execute('SELECT 1 AS connected');
        return { database: 'mysql', connected: !!rows && rows.length > 0 };
    }

    async close() {
        await this.pool.end();
    }
}

module.exports = { MySqlAdapter };
