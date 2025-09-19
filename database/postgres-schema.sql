-- SMS AT Command System Database Schema (PostgreSQL)
-- Converted from MySQL for Railway deployment

-- Environment and system configuration
CREATE TABLE IF NOT EXISTS system_config (
    id SERIAL PRIMARY KEY,
    config_key VARCHAR(100) UNIQUE NOT NULL,
    config_value TEXT,
    config_type VARCHAR(20) DEFAULT 'string' CHECK (config_type IN ('string', 'number', 'boolean', 'json')),
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Groups management
CREATE TABLE IF NOT EXISTS groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Contacts management
CREATE TABLE IF NOT EXISTS contacts (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) UNIQUE NOT NULL,
    email VARCHAR(255),
    notes TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Contact group memberships
CREATE TABLE IF NOT EXISTS contact_groups (
    id SERIAL PRIMARY KEY,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contact_id, group_id)
);

-- Agents (staff members who can take chats)
CREATE TABLE IF NOT EXISTS agents (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) UNIQUE NOT NULL,
    is_available BOOLEAN DEFAULT TRUE,
    is_active BOOLEAN DEFAULT TRUE,
    trigger_words JSONB,
    max_concurrent_chats INTEGER DEFAULT 3,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Programs (automated message sequences)
CREATE TABLE IF NOT EXISTS programs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    program_data JSONB NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    is_base_program BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- All messages (sent and received)
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    from_phone VARCHAR(20) NOT NULL,
    to_phone VARCHAR(20) NOT NULL,
    message_content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'sms' CHECK (message_type IN ('sms', 'system', 'broadcast', 'program', 'chat')),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'received')),
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
    bridge_message_id VARCHAR(100),
    delivery_attempts INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Rate limiting tracking
CREATE TABLE IF NOT EXISTS rate_limits (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    time_window VARCHAR(10) NOT NULL CHECK (time_window IN ('minute', 'hour', 'day')),
    window_start TIMESTAMP NOT NULL,
    message_count INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone, time_window, window_start)
);

-- Virtual messages for development environment
CREATE TABLE IF NOT EXISTS virtual_messages (
    id SERIAL PRIMARY KEY,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    from_phone VARCHAR(20) NOT NULL,
    to_phone VARCHAR(20) NOT NULL,
    message_content TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'read')),
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default configuration
INSERT INTO system_config (config_key, config_value, config_type, description) VALUES
('environment', 'production', 'string', 'Environment mode: development or production'),
('rate_limit_per_phone_per_minute', '10', 'number', 'Maximum messages per phone number per minute'),
('rate_limit_per_phone_per_hour', '100', 'number', 'Maximum messages per phone number per hour'),
('rate_limit_per_phone_per_day', '500', 'number', 'Maximum messages per phone number per day'),
('virtual_phone_number', '+1234567890', 'string', 'Virtual phone number for development')
ON CONFLICT (config_key) DO NOTHING;

-- Insert default groups
INSERT INTO groups (name, description, is_default) VALUES
('Shiur Alef', 'First study group', TRUE),
('Shiur Beis', 'Second study group', TRUE),
('Shiur Gimmel', 'Third study group', TRUE),
('Yeshiva', 'General Yeshiva group', TRUE)
ON CONFLICT DO NOTHING;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_phone ON rate_limits(phone);
