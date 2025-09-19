// PostgreSQL adapter for Railway
const { Pool } = require('pg');

class PostgreSQLAdapter {
    constructor() {
        this.pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
        });
    }

    async execute(query, params = []) {
        const client = await this.pool.connect();
        try {
            const result = await client.query(query, params);
            return [result.rows]; // Mimic MySQL format
        } finally {
            client.release();
        }
    }

    async close() {
        await this.pool.end();
    }
}

module.exports = PostgreSQLAdapter;
