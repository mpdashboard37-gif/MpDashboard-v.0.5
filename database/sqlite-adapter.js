const { DatabaseSync } = require('node:sqlite');

class SqliteAdapter {
    constructor(filePath) {
        this.kind = 'sqlite';
        this.connection = new DatabaseSync(filePath);
        this.connection.exec('PRAGMA foreign_keys = ON');
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

    async transaction(work) {
        this.connection.exec('BEGIN');
        try {
            const result = await work(this);
            this.connection.exec('COMMIT');
            return result;
        } catch (error) {
            this.connection.exec('ROLLBACK');
            throw error;
        }
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
