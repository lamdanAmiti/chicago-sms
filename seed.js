// scripts/seed.js - Database seeding for Railway
const PostgreSQLAdapter = require('../server/database/postgresAdapter');
require('dotenv').config();

async function seedDatabase() {
    const db = new PostgreSQLAdapter();
    
    try {
        console.log('🌱 Seeding database...');
        
        // Insert system configuration
        await db.execute(`
            INSERT INTO system_config (config_key, config_value, config_type, description) VALUES
            ('environment', $1, 'string', 'Environment mode: development or production'),
            ('rate_limit_per_phone_per_minute', '10', 'number', 'Maximum messages per phone number per minute'),
            ('rate_limit_per_phone_per_hour', '100', 'number', 'Maximum messages per phone number per hour'),
            ('rate_limit_per_phone_per_day', '500', 'number', 'Maximum messages per phone number per day'),
            ('virtual_phone_number', $2, 'string', 'Virtual phone number for development'),
            ('system_timezone', 'America/New_York', 'string', 'System timezone'),
            ('default_country_code', '+1', 'string', 'Default country code for phone numbers'),
            ('enable_agent_system', 'true', 'boolean', 'Enable live agent chat system'),
            ('enable_programs', 'true', 'boolean', 'Enable automated program system'),
            ('max_message_length', '1600', 'number', 'Maximum SMS message length')
            ON CONFLICT (config_key) DO UPDATE SET 
                config_value = EXCLUDED.config_value,
                updated_at = CURRENT_TIMESTAMP
        `, [process.env.NODE_ENV || 'production', process.env.VIRTUAL_PHONE || '+1234567890']);

        // Insert default groups
        await db.execute(`
            INSERT INTO groups (name, description, is_default) VALUES
            ('Shiur Alef', 'First study group', TRUE),
            ('Shiur Beis', 'Second study group', TRUE), 
            ('Shiur Gimmel', 'Third study group', TRUE),
            ('Yeshiva', 'General Yeshiva group', TRUE),
            ('Staff', 'Staff and administrators', FALSE),
            ('Alumni', 'Alumni group', FALSE)
            ON CONFLICT (name) DO NOTHING
        `);

        // Insert sample contacts
        await db.execute(`
            INSERT INTO contacts (name, phone, email, notes) VALUES
            ('Demo User 1', '+12125551001', 'demo1@example.com', 'Demo contact for testing'),
            ('Demo User 2', '+12125551002', 'demo2@example.com', 'Demo contact for testing'),
            ('Test Agent', '+12125551000', 'agent@example.com', 'Demo agent for testing')
            ON CONFLICT (phone) DO NOTHING
        `);

        // Get group and contact IDs for relationships
        const [groups] = await db.execute('SELECT id, name FROM groups WHERE is_default = TRUE');
        const [contacts] = await db.execute('SELECT id, name FROM contacts LIMIT 2');
        
        // Assign contacts to groups
        if (groups.length > 0 && contacts.length > 0) {
            for (let i = 0; i < contacts.length; i++) {
                const groupIndex = i % groups.length;
                await db.execute(`
                    INSERT INTO contact_groups (contact_id, group_id) VALUES ($1, $2)
                    ON CONFLICT (contact_id, group_id) DO NOTHING
                `, [contacts[i].id, groups[groupIndex].id]);
            }
        }

        // Insert sample agent
        await db.execute(`
            INSERT INTO agents (name, phone, trigger_words, max_concurrent_chats, is_available, is_active) VALUES
            ('Demo Agent', '+12125551000', $1, 3, TRUE, TRUE)
            ON CONFLICT (phone) DO UPDATE SET
                name = EXCLUDED.name,
                trigger_words = EXCLUDED.trigger_words,
                is_active = TRUE
        `, [JSON.stringify(['help', 'agent', 'support', 'שליח'])]);

        // Insert base program
        const baseProgramData = {
            name: "Base System Program",
            steps: [
                {
                    id: 0,
                    type: "condition",
                    conditions: [
                        {
                            type: "contains",
                            value: "help",
                            next_step_id: 1
                        },
                        {
                            type: "contains", 
                            value: "שליח",
                            next_step_id: 2
                        }
                    ],
                    default_next_step_id: null
                },
                {
                    id: 1,
                    type: "message",
                    content: "How can I help you? Type 'agent' to connect to a live representative.",
                    next_step_id: null
                },
                {
                    id: 2,
                    type: "agent_connect",
                    message: "User requested agent connection",
                    next_step_id: null
                }
            ]
        };

        await db.execute(`
            INSERT INTO programs (name, description, program_data, is_active, is_base_program) VALUES
            ('Base System Program', 'Always-running base program for system commands', $1, TRUE, TRUE)
            ON CONFLICT DO NOTHING
        `, [JSON.stringify(baseProgramData)]);

        // Insert welcome program
        const welcomeProgramData = {
            name: "Welcome Program",
            steps: [
                {
                    id: 0,
                    type: "message",
                    content: "Welcome to our SMS system! We're glad to have you here.",
                    next_step_id: 1
                },
                {
                    id: 1,
                    type: "delay",
                    delay: 300,
                    next_step_id: 2
                },
                {
                    id: 2,
                    type: "message", 
                    content: "You can reply 'help' at any time for assistance, or 'agent' to speak with someone directly.",
                    next_step_id: null
                }
            ]
        };

        await db.execute(`
            INSERT INTO programs (name, description, program_data, is_active, is_base_program) VALUES
            ('Welcome Program', 'Welcome sequence for new contacts', $1, TRUE, FALSE)
        `, [JSON.stringify(welcomeProgramData)]);

        console.log('✅ Database seeded successfully');
        console.log('📊 Sample data created:');
        console.log('   - System configuration');
        console.log('   - Default groups (Shiur Alef, Beis, Gimmel, Yeshiva)');
        console.log('   - Sample contacts and agent');
        console.log('   - Base system program');
        console.log('   - Welcome program');
        
    } catch (error) {
        console.error('❌ Seeding failed:', error);
        process.exit(1);
    } finally {
        await db.close();
    }
}

if (require.main === module) {
    seedDatabase();
}

module.exports = seedDatabase;
