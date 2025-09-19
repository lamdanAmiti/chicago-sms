// PostgreSQL adapter for Railway deployment
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
            // Convert MySQL-style ? placeholders to PostgreSQL $1, $2, etc.
            let pgQuery = query;
            let pgParams = params;
            
            if (params.length > 0) {
                let paramIndex = 1;
                pgQuery = query.replace(/\?/g, () => `$${paramIndex++}`);
            }
            
            const result = await client.query(pgQuery, pgParams);
            return [result.rows]; // Mimic MySQL format [rows]
        } finally {
            client.release();
        }
    }

    async close() {
        await this.pool.end();
    }
}

module.exports = PostgreSQLAdapter;
