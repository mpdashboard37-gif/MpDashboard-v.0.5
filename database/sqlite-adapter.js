const { DatabaseSync } = require('node:sqlite');

class SqliteAdapter {
    constructor(filePath) {
        this.kind = 'sqlite';
        this.connection = new DatabaseSync(filePath);
        this.connection.exec('PRAGMA foreign_keys = ON');
        this.connection.exec('PRAGMA busy_timeout = 5000');
        this.transactionQueue = Promise.resolve();
    }

    prepare(sql) {
        return this.connection.prepare(sql);
    }

    async get(sql, params = []) {
        return this.connection.prepare(sql).get(...params);
    }

    async all(sql, params = []) {
        return this.connection.prepare(sql).all(...params);
    }

    async run(sql, params = []) {
        return this.connection.prepare(sql).run(...params);
    }

    async exec(sql) {
        return this.connection.exec(sql);
    }

    transaction(work) {
        const execute = async () => {
            this.connection.exec('BEGIN IMMEDIATE');
            try {
                const result = await work(this);
                this.connection.exec('COMMIT');
                return result;
            } catch (error) {
                this.connection.exec('ROLLBACK');
                throw error;
            }
        };
        const transaction = this.transactionQueue.then(execute, execute);
        this.transactionQueue = transaction.catch(() => { });
        return transaction;
    }

    async health() {
        await this.get('SELECT 1 AS connected');
        return { database: 'sqlite', connected: true };
    }

    close() {
        this.connection.close();
    }
}

module.exports = { SqliteAdapter };
