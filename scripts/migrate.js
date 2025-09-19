// scripts/migrate.js - Database Migration Script
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

class DatabaseMigrator {
    constructor() {
        this.connection = null;
    }

    async connect() {
        try {
            // First connect without database to create it if needed
            this.connection = await mysql.createConnection({
                host: process.env.DB_HOST || 'localhost',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                timezone: '+00:00'
            });

            console.log('Connected to MySQL server');
        } catch (error) {
            console.error('Failed to connect to MySQL:', error);
            throw error;
        }
    }

    async createDatabase() {
        const dbName = process.env.DB_NAME || 'sms_system';
        
        try {
            await this.connection.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
            console.log(`Database '${dbName}' created or already exists`);
            
            await this.connection.execute(`USE \`${dbName}\``);
            console.log(`Using database '${dbName}'`);
        } catch (error) {
            console.error('Failed to create database:', error);
            throw error;
        }
    }

    async runMigrations() {
        console.log('Running database migrations...');
        
        const migrations = [
            this.createSystemConfigTable,
            this.createGroupsTable,
            this.createContactsTable,
            this.createContactGroupsTable,
            this.createAgentsTable,
            this.createProgramsTable,
            this.createProgramAssignmentsTable,
            this.createProgramStatesTable,
            this.createChatSessionsTable,
            this.createMessagesTable,
            this.createBroadcastsTable,
            this.createBroadcastRecipientsTable,
            this.createRateLimitsTable,
            this.createVirtualMessagesTable,
            this.createSystemLogsTable,
            this.createBridgeStatusTable,
            this.createViews,
            this.insertDefaultConfig,
            this.insertDefaultGroups
        ];

        for (const migration of migrations) {
            try {
                await migration.call(this);
            } catch (error) {
                console.error(`Migration failed: ${migration.name}`, error);
                throw error;
            }
        }

        console.log('All migrations completed successfully!');
    }

    async createSystemConfigTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS system_config (
                id INT PRIMARY KEY AUTO_INCREMENT,
                config_key VARCHAR(100) UNIQUE NOT NULL,
                config_value TEXT,
                config_type ENUM('string', 'number', 'boolean', 'json') DEFAULT 'string',
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        console.log('✓ Created system_config table');
    }

    async createGroupsTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS groups (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                is_default BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name)
            )
        `);
        console.log('✓ Created groups table');
    }

    async createContactsTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS contacts (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(20) UNIQUE NOT NULL,
                email VARCHAR(255),
                notes TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_phone (phone),
                INDEX idx_name (name),
                INDEX idx_active (is_active)
            )
        `);
        console.log('✓ Created contacts table');
    }

    async createContactGroupsTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS contact_groups (
                id INT PRIMARY KEY AUTO_INCREMENT,
                contact_id INT NOT NULL,
                group_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
                FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
                UNIQUE KEY unique_contact_group (contact_id, group_id),
                INDEX idx_contact (contact_id),
                INDEX idx_group (group_id)
            )
        `);
        console.log('✓ Created contact_groups table');
    }

    async createAgentsTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS agents (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(20) UNIQUE NOT NULL,
                is_available BOOLEAN DEFAULT TRUE,
                is_active BOOLEAN DEFAULT TRUE,
                trigger_words JSON,
                max_concurrent_chats INT DEFAULT 3,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_phone (phone),
                INDEX idx_available (is_available, is_active)
            )
        `);
        console.log('✓ Created agents table');
    }

    async createProgramsTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS programs (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                program_data JSON NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                is_base_program BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_active (is_active),
                INDEX idx_base (is_base_program)
            )
        `);
        console.log('✓ Created programs table');
    }

    async createProgramAssignmentsTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS program_assignments (
                id INT PRIMARY KEY AUTO_INCREMENT,
                program_id INT NOT NULL,
                contact_id INT NULL,
                group_id INT NULL,
                assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NULL,
                is_active BOOLEAN DEFAULT TRUE,
                FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
                FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
                INDEX idx_program (program_id),
                INDEX idx_contact (contact_id),
                INDEX idx_group (group_id),
                INDEX idx_active (is_active),
                CHECK (contact_id IS NOT NULL OR group_id IS NOT NULL)
            )
        `);
        console.log('✓ Created program_assignments table');
    }

    async createProgramStatesTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS program_states (
                id INT PRIMARY KEY AUTO_INCREMENT,
                program_id INT NOT NULL,
                contact_id INT NOT NULL,
                current_step INT DEFAULT 0,
                step_data JSON,
                next_action_at TIMESTAMP NULL,
                is_paused BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
                UNIQUE KEY unique_program_contact (program_id, contact_id),
                INDEX idx_next_action (next_action_at),
                INDEX idx_program (program_id),
                INDEX idx_contact (contact_id)
            )
        `);
        console.log('✓ Created program_states table');
    }

    async createChatSessionsTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id INT PRIMARY KEY AUTO_INCREMENT,
                contact_id INT NOT NULL,
                agent_id INT NOT NULL,
                session_key VARCHAR(50) UNIQUE NOT NULL,
                status ENUM('active', 'ended', 'abandoned') DEFAULT 'active',
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ended_at TIMESTAMP NULL,
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
                FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
                INDEX idx_contact (contact_id),
                INDEX idx_agent (agent_id),
                INDEX idx_status (status),
                INDEX idx_session_key (session_key)
            )
        `);
        console.log('✓ Created chat_sessions table');
    }

    async createMessagesTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS messages (
                id INT PRIMARY KEY AUTO_INCREMENT,
                direction ENUM('inbound', 'outbound') NOT NULL,
                from_phone VARCHAR(20) NOT NULL,
                to_phone VARCHAR(20) NOT NULL,
                message_content TEXT NOT NULL,
                message_type ENUM('sms', 'system', 'broadcast', 'program', 'chat') DEFAULT 'sms',
                status ENUM('pending', 'sent', 'delivered', 'failed', 'received') DEFAULT 'pending',
                
                contact_id INT NULL,
                program_id INT NULL,
                chat_session_id INT NULL,
                broadcast_id INT NULL,
                
                bridge_message_id VARCHAR(100) NULL,
                delivery_attempts INT DEFAULT 0,
                error_message TEXT NULL,
                
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
                FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE SET NULL,
                FOREIGN KEY (chat_session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL,
                
                INDEX idx_direction (direction),
                INDEX idx_from_phone (from_phone),
                INDEX idx_to_phone (to_phone),
                INDEX idx_contact (contact_id),
                INDEX idx_status (status),
                INDEX idx_type (message_type),
                INDEX idx_created (created_at),
                INDEX idx_bridge_id (bridge_message_id)
            )
        `);
        console.log('✓ Created messages table');
    }

    async createBroadcastsTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS broadcasts (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(255) NOT NULL,
                message_content TEXT NOT NULL,
                scheduled_at TIMESTAMP NULL,
                sent_at TIMESTAMP NULL,
                status ENUM('draft', 'scheduled', 'sending', 'sent', 'failed') DEFAULT 'draft',
                total_recipients INT DEFAULT 0,
                sent_count INT DEFAULT 0,
                delivered_count INT DEFAULT 0,
                failed_count INT DEFAULT 0,
                created_by VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_status (status),
                INDEX idx_scheduled (scheduled_at),
                INDEX idx_created (created_at)
            )
        `);
        console.log('✓ Created broadcasts table');
    }

    async createBroadcastRecipientsTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS broadcast_recipients (
                id INT PRIMARY KEY AUTO_INCREMENT,
                broadcast_id INT NOT NULL,
                contact_id INT NULL,
                group_id INT NULL,
                phone VARCHAR(20) NOT NULL,
                status ENUM('pending', 'sent', 'delivered', 'failed') DEFAULT 'pending',
                sent_at TIMESTAMP NULL,
                delivered_at TIMESTAMP NULL,
                error_message TEXT NULL,
                FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id) ON DELETE CASCADE,
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
                FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL,
                INDEX idx_broadcast (broadcast_id),
                INDEX idx_status (status),
                INDEX idx_phone (phone)
            )
        `);
        console.log('✓ Created broadcast_recipients table');
    }

    async createRateLimitsTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS rate_limits (
                id INT PRIMARY KEY AUTO_INCREMENT,
                phone VARCHAR(20) NOT NULL,
                time_window ENUM('minute', 'hour', 'day') NOT NULL,
                window_start TIMESTAMP NOT NULL,
                message_count INT DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_phone_window (phone, time_window, window_start),
                INDEX idx_phone (phone),
                INDEX idx_window (time_window, window_start)
            )
        `);
        console.log('✓ Created rate_limits table');
    }

    async createVirtualMessagesTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS virtual_messages (
                id INT PRIMARY KEY AUTO_INCREMENT,
                direction ENUM('inbound', 'outbound') NOT NULL,
                from_phone VARCHAR(20) NOT NULL,
                to_phone VARCHAR(20) NOT NULL,
                message_content TEXT NOT NULL,
                status ENUM('pending', 'sent', 'delivered', 'read') DEFAULT 'pending',
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_direction (direction),
                INDEX idx_phones (from_phone, to_phone),
                INDEX idx_status (status),
                INDEX idx_created (created_at)
            )
        `);
        console.log('✓ Created virtual_messages table');
    }

    async createSystemLogsTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS system_logs (
                id INT PRIMARY KEY AUTO_INCREMENT,
                level ENUM('info', 'warning', 'error', 'debug') NOT NULL,
                component ENUM('admin', 'server', 'bridge', 'program_engine') NOT NULL,
                message TEXT NOT NULL,
                metadata JSON NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_level (level),
                INDEX idx_component (component),
                INDEX idx_created (created_at)
            )
        `);
        console.log('✓ Created system_logs table');
    }

    async createBridgeStatusTable() {
        await this.connection.execute(`
            CREATE TABLE IF NOT EXISTS bridge_status (
                id INT PRIMARY KEY AUTO_INCREMENT,
                is_connected BOOLEAN DEFAULT FALSE,
                last_heartbeat TIMESTAMP NULL,
                modem_status VARCHAR(100) NULL,
                signal_strength INT NULL,
                error_count INT DEFAULT 0,
                last_error TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_connected (is_connected),
                INDEX idx_heartbeat (last_heartbeat)
            )
        `);
        console.log('✓ Created bridge_status table');
    }

    async createViews() {
        // Active contacts view
        await this.connection.execute(`
            CREATE OR REPLACE VIEW active_contacts AS
            SELECT c.*, GROUP_CONCAT(g.name) as group_names
            FROM contacts c
            LEFT JOIN contact_groups cg ON c.id = cg.contact_id
            LEFT JOIN groups g ON cg.group_id = g.id
            WHERE c.is_active = TRUE
            GROUP BY c.id
        `);

        // Message stats view
        await this.connection.execute(`
            CREATE OR REPLACE VIEW message_stats AS
            SELECT 
                DATE(created_at) as date,
                direction,
                message_type,
                status,
                COUNT(*) as count
            FROM messages
            GROUP BY DATE(created_at), direction, message_type, status
        `);

        // Rate limit status view
        await this.connection.execute(`
            CREATE OR REPLACE VIEW rate_limit_status AS
            SELECT 
                phone,
                time_window,
                SUM(message_count) as total_messages,
                MAX(window_start) as latest_window
            FROM rate_limits
            WHERE window_start >= DATE_SUB(NOW(), INTERVAL 1 DAY)
            GROUP BY phone, time_window
        `);

        console.log('✓ Created database views');
    }

    async insertDefaultConfig() {
        const configs = [
            ['environment', 'development', 'string', 'Environment mode: development or production'],
            ['rate_limit_per_phone_per_minute', '10', 'number', 'Maximum messages per phone number per minute'],
            ['rate_limit_per_phone_per_hour', '100', 'number', 'Maximum messages per phone number per hour'],
            ['rate_limit_per_phone_per_day', '500', 'number', 'Maximum messages per phone number per day'],
            ['bridge_connection_url', 'ws://localhost:3001', 'string', 'Bridge WebSocket connection URL'],
            ['bridge_retry_interval', '5000', 'number', 'Bridge reconnection interval in milliseconds'],
            ['virtual_phone_number', '+1234567890', 'string', 'Virtual phone number for development'],
            ['com_port', 'COM3', 'string', 'COM port for production SMS modem'],
            ['com_baud_rate', '115200', 'number', 'Baud rate for COM port communication'],
            ['global_rate_limit_per_minute', '100', 'number', 'Global system rate limit per minute'],
            ['global_rate_limit_per_hour', '1000', 'number', 'Global system rate limit per hour'],
            ['global_rate_limit_per_day', '5000', 'number', 'Global system rate limit per day']
        ];

        for (const [key, value, type, description] of configs) {
            await this.connection.execute(`
                INSERT IGNORE INTO system_config (config_key, config_value, config_type, description)
                VALUES (?, ?, ?, ?)
            `, [key, value, type, description]);
        }

        console.log('✓ Inserted default configuration');
    }

    async insertDefaultGroups() {
        const groups = [
            ['Shiur Alef', 'First study group', true],
            ['Shiur Beis', 'Second study group', true],
            ['Shiur Gimmel', 'Third study group', true],
            ['Yeshiva', 'General Yeshiva group', true]
        ];

        for (const [name, description, isDefault] of groups) {
            await this.connection.execute(`
                INSERT IGNORE INTO groups (name, description, is_default)
                VALUES (?, ?, ?)
            `, [name, description, isDefault]);
        }

        console.log('✓ Inserted default groups');
    }

    async close() {
        if (this.connection) {
            await this.connection.end();
            console.log('Database connection closed');
        }
    }
}

// scripts/seed.js - Database Seeding Script
class DatabaseSeeder {
    constructor() {
        this.connection = null;
    }

    async connect() {
        try {
            this.connection = await mysql.createConnection({
                host: process.env.DB_HOST || 'localhost',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: process.env.DB_NAME || 'sms_system',
                timezone: '+00:00'
            });

            console.log('Connected to database for seeding');
        } catch (error) {
            console.error('Failed to connect for seeding:', error);
            throw error;
        }
    }

    async seedDatabase() {
        console.log('Seeding database with sample data...');

        await this.seedContacts();
        await this.seedAgents();
        await this.seedPrograms();
        await this.seedSampleMessages();

        console.log('Database seeding completed!');
    }

    async seedContacts() {
        const contacts = [
            ['יהודה כהן', '+972501234567', 'yehuda@example.com', 'תלמיד שיעור א'],
            ['משה לוי', '+972502345678', 'moshe@example.com', 'תלמיד שיעור ב'],
            ['אברהם גולדברג', '+972503456789', 'avraham@example.com', 'תלמיד שיעור ג'],
            ['דוד רוזן', '+972504567890', null, 'תלמיד ישיבה כללי'],
            ['שמואל קליין', '+972505678901', 'shmuel@example.com', 'תלמיד שיעור א'],
            ['אליעזר שוורץ', '+972506789012', null, 'תלמיד שיעור ב'],
        ];

        for (const [name, phone, email, notes] of contacts) {
            const [result] = await this.connection.execute(`
                INSERT IGNORE INTO contacts (name, phone, email, notes)
                VALUES (?, ?, ?, ?)
            `, [name, phone, email, notes]);

            if (result.insertId) {
                // Assign to random groups
                const groupIds = [1, 2, 3, 4]; // Default group IDs
                const randomGroupId = groupIds[Math.floor(Math.random() * groupIds.length)];
                
                await this.connection.execute(`
                    INSERT IGNORE INTO contact_groups (contact_id, group_id)
                    VALUES (?, ?)
                `, [result.insertId, randomGroupId]);
            }
        }

        console.log('✓ Seeded contacts');
    }

    async seedAgents() {
        const agents = [
            ['רבי יצחק', '+972507890123', ['עזרה', 'שליח', 'help'], 3],
            ['רבי משה', '+972508901234', ['תמיכה', 'סיוע', 'support'], 2],
            ['רבי אברהם', '+972509012345', ['agent', 'שליח'], 5]
        ];

        for (const [name, phone, triggerWords, maxChats] of agents) {
            await this.connection.execute(`
                INSERT IGNORE INTO agents (name, phone, trigger_words, max_concurrent_chats)
                VALUES (?, ?, ?, ?)
            `, [name, phone, JSON.stringify(triggerWords), maxChats]);
        }

        console.log('✓ Seeded agents');
    }

    async seedPrograms() {
        // Sample welcome program
        const welcomeProgram = {
            steps: [
                {
                    id: 1,
                    type: 'message',
                    content: 'ברוך הבא לישיבה! {{name}}, אנחנו שמחים שאתה איתנו.',
                    next_step_id: 2
                },
                {
                    id: 2,
                    type: 'delay',
                    delay: 5,
                    next_step_id: 3
                },
                {
                    id: 3,
                    type: 'message',
                    content: 'לעזרה נוספת, שלח "שליח" ונחבר אותך לאדם.',
                    next_step_id: null
                }
            ]
        };

        await this.connection.execute(`
            INSERT IGNORE INTO programs (name, description, program_data, is_active, is_base_program)
            VALUES (?, ?, ?, ?, ?)
        `, [
            'ברוכים הבאים',
            'תוכנית קבלת פנים לתלמידים חדשים',
            JSON.stringify(welcomeProgram),
            true,
            false
        ]);

        // Sample base program for agent connections
        const baseProgram = {
            steps: [
                {
                    id: 1,
                    type: 'condition',
                    conditions: [
                        {
                            type: 'contains',
                            value: 'שליח',
                            next_step_id: 2
                        },
                        {
                            type: 'contains',
                            value: 'help',
                            next_step_id: 2
                        }
                    ],
                    default_next_step_id: null
                },
                {
                    id: 2,
                    type: 'agent_connect',
                    message: 'מבקש עזרה מהמערכת',
                    next_step_id: null
                }
            ]
        };

        await this.connection.execute(`
            INSERT IGNORE INTO programs (name, description, program_data, is_active, is_base_program)
            VALUES (?, ?, ?, ?, ?)
        `, [
            'מערכת בסיס - חיבור לשליח',
            'תוכנית תמיד פעילה לחיבור עם שליחים',
            JSON.stringify(baseProgram),
            true,
            true
        ]);

        console.log('✓ Seeded programs');
    }

    async seedSampleMessages() {
        // Add some sample virtual messages for development
        if (process.env.NODE_ENV === 'development') {
            const sampleMessages = [
                ['inbound', '+972501234567', '+1234567890', 'שלום, אני חדש בישיבה'],
                ['outbound', '+1234567890', '+972501234567', 'ברוך הבא! אנחנו שמחים שאתה איתנו'],
                ['inbound', '+972502345678', '+1234567890', 'מתי השיעור הבא?'],
                ['outbound', '+1234567890', '+972502345678', 'השיעור הבא יתקיים מחר בשעה 9:00']
            ];

            for (const [direction, from_phone, to_phone, content] of sampleMessages) {
                await this.connection.execute(`
                    INSERT INTO virtual_messages (direction, from_phone, to_phone, message_content, status)
                    VALUES (?, ?, ?, ?, 'delivered')
                `, [direction, from_phone, to_phone, content]);
            }

            console.log('✓ Seeded sample virtual messages');
        }
    }

    async close() {
        if (this.connection) {
            await this.connection.end();
            console.log('Seeding connection closed');
        }
    }
}

// Main execution functions
async function runMigrations() {
    const migrator = new DatabaseMigrator();
    
    try {
        await migrator.connect();
        await migrator.createDatabase();
        await migrator.runMigrations();
        console.log('\n🎉 Database migration completed successfully!');
    } catch (error) {
        console.error('\n❌ Migration failed:', error);
        process.exit(1);
    } finally {
        await migrator.close();
    }
}

async function runSeeding() {
    const seeder = new DatabaseSeeder();
    
    try {
        await seeder.connect();
        await seeder.seedDatabase();
        console.log('\n🌱 Database seeding completed successfully!');
    } catch (error) {
        console.error('\n❌ Seeding failed:', error);
        process.exit(1);
    } finally {
        await seeder.close();
    }
}

// Export for use as modules
module.exports = {
    DatabaseMigrator,
    DatabaseSeeder,
    runMigrations,
    runSeeding
};

// Run if called directly
if (require.main === module) {
    const command = process.argv[2];
    
    if (command === 'migrate') {
        runMigrations();
    } else if (command === 'seed') {
        runSeeding();
    } else if (command === 'reset') {
        runMigrations().then(() => runSeeding());
    } else {
        console.log('Usage: node migrate.js [migrate|seed|reset]');
        console.log('  migrate - Run database migrations');
        console.log('  seed    - Seed database with sample data');
        console.log('  reset   - Run migrations and seeding');
    }
}
