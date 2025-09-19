// PostgreSQL migration for Railway
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function runMigrations() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    try {
        console.log('🔄 Running PostgreSQL migrations...');
        
        const schemaSQL = fs.readFileSync(
            path.join(__dirname, '../database/postgres-schema.sql'), 
            'utf8'
        );
        
        await pool.query(schemaSQL);
        console.log('✅ Database migrations completed');
        
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    runMigrations();
}

module.exports = runMigrations;
