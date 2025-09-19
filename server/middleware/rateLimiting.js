// server/middleware/rateLimiting.js - Advanced Rate Limiting System
const rateLimit = require('express-rate-limit');

class RateLimitManager {
    constructor(db) {
        this.db = db;
        this.config = {
            perMinute: 10,
            perHour: 100,
            perDay: 500,
            globalPerMinute: 100,
            globalPerHour: 1000,
            globalPerDay: 5000
        };
        
        this.loadConfig();
    }

    async loadConfig() {
        try {
            const [rows] = await this.db.execute(`
                SELECT config_key, config_value 
                FROM system_config 
                WHERE config_key LIKE 'rate_limit_%' OR config_key LIKE 'global_rate_limit_%'
            `);
            
            rows.forEach(row => {
                switch (row.config_key) {
                    case 'rate_limit_per_phone_per_minute':
                        this.config.perMinute = parseInt(row.config_value);
                        break;
                    case 'rate_limit_per_phone_per_hour':
                        this.config.perHour = parseInt(row.config_value);
                        break;
                    case 'rate_limit_per_phone_per_day':
                        this.config.perDay = parseInt(row.config_value);
                        break;
                    case 'global_rate_limit_per_minute':
                        this.config.globalPerMinute = parseInt(row.config_value);
                        break;
                    case 'global_rate_limit_per_hour':
                        this.config.globalPerHour = parseInt(row.config_value);
                        break;
                    case 'global_rate_limit_per_day':
                        this.config.globalPerDay = parseInt(row.config_value);
                        break;
                }
            });
            
            console.log('Rate limit configuration loaded:', this.config);
        } catch (error) {
            console.error('Failed to load rate limit config:', error);
        }
    }

    // Check if phone number can send message
    async checkPhoneRateLimit(phone) {
        const now = new Date();
        const checks = [
            { window: 'minute', duration: 60000, limit: this.config.perMinute },
            { window: 'hour', duration: 3600000, limit: this.config.perHour },
            { window: 'day', duration: 86400000, limit: this.config.perDay }
        ];

        for (const { window, duration, limit } of checks) {
            const windowStart = new Date(Math.floor(now.getTime() / duration) * duration);
            
            const [rows] = await this.db.execute(`
                SELECT COALESCE(SUM(message_count), 0) as total
                FROM rate_limits 
                WHERE phone = ? AND time_window = ? AND window_start = ?
            `, [phone, window, windowStart]);

            const currentCount = rows[0].total;
            if (currentCount >= limit) {
                return {
                    allowed: false,
                    window,
                    current: currentCount,
                    limit,
                    resetAt: new Date(windowStart.getTime() + duration),
                    retryAfter: Math.ceil((windowStart.getTime() + duration - now.getTime()) / 1000)
                };
            }
        }

        return { allowed: true };
    }

    // Check global system rate limits
    async checkGlobalRateLimit() {
        const now = new Date();
        const checks = [
            { window: 'minute', duration: 60000, limit: this.config.globalPerMinute },
            { window: 'hour', duration: 3600000, limit: this.config.globalPerHour },
            { window: 'day', duration: 86400000, limit: this.config.globalPerDay }
        ];

        for (const { window, duration, limit } of checks) {
            const windowStart = new Date(Math.floor(now.getTime() / duration) * duration);
            
            const [rows] = await this.db.execute(`
                SELECT COALESCE(SUM(message_count), 0) as total
                FROM rate_limits 
                WHERE time_window = ? AND window_start = ?
            `, [window, windowStart]);

            const currentCount = rows[0].total;
            if (currentCount >= limit) {
                return {
                    allowed: false,
                    window: `global_${window}`,
                    current: currentCount,
                    limit,
                    resetAt: new Date(windowStart.getTime() + duration)
                };
            }
        }

        return { allowed: true };
    }

    // Update rate limit counters
    async updateRateLimit(phone) {
        const now = new Date();
        const windows = [
            { window: 'minute', duration: 60000 },
            { window: 'hour', duration: 3600000 },
            { window: 'day', duration: 86400000 }
        ];

        for (const { window, duration } of windows) {
            const windowStart = new Date(Math.floor(now.getTime() / duration) * duration);
            
            await this.db.execute(`
                INSERT INTO rate_limits (phone, time_window, window_start, message_count)
                VALUES (?, ?, ?, 1)
                ON DUPLICATE KEY UPDATE 
                message_count = message_count + 1,
                updated_at = CURRENT_TIMESTAMP
            `, [phone, window, windowStart]);
        }
    }

    // Get current rate limit status for a phone
    async getRateLimitStatus(phone) {
        const [rows] = await this.db.execute(`
            SELECT time_window, SUM(message_count) as count, MAX(window_start) as latest_window
            FROM rate_limits 
            WHERE phone = ? AND window_start >= DATE_SUB(NOW(), INTERVAL 1 DAY)
            GROUP BY time_window
        `, [phone]);

        const status = {
            phone,
            limits: this.config,
            current: { minute: 0, hour: 0, day: 0 },
            remaining: {
                minute: this.config.perMinute,
                hour: this.config.perHour,
                day: this.config.perDay
            }
        };

        rows.forEach(row => {
            status.current[row.time_window] = row.count;
            status.remaining[row.time_window] = Math.max(0, this.config[`per${row.time_window.charAt(0).toUpperCase() + row.time_window.slice(1)}`] - row.count);
        });

        return status;
    }

    // Clean up old rate limit data
    async cleanupOldRateLimits() {
        try {
            await this.db.execute(`
                DELETE FROM rate_limits 
                WHERE window_start < DATE_SUB(NOW(), INTERVAL 7 DAY)
            `);
            console.log('Old rate limit data cleaned up');
        } catch (error) {
            console.error('Error cleaning up rate limits:', error);
        }
    }

    // Express middleware for API rate limiting
    createAPIRateLimit() {
        return rateLimit({
            windowMs: 15 * 60 * 1000, // 15 minutes
            max: 100, // Limit each IP to 100 requests per windowMs
            message: {
                error: 'Too many requests from this IP, please try again later.',
                retryAfter: '15 minutes'
            },
            standardHeaders: true,
            legacyHeaders: false,
            handler: (req, res) => {
                res.status(429).json({
                    error: 'Rate limit exceeded',
                    retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
                });
            }
        });
    }

    // Middleware for SMS sending rate limits
    createSMSRateLimit() {
        return async (req, res, next) => {
            try {
                const { to_phone, from_phone } = req.body;
                const phone = to_phone || from_phone;
                
                if (!phone) {
                    return res.status(400).json({ error: 'Phone number required' });
                }

                // Check phone-specific rate limit
                const phoneCheck = await this.checkPhoneRateLimit(phone);
                if (!phoneCheck.allowed) {
                    return res.status(429).json({
                        error: 'Phone rate limit exceeded',
                        details: phoneCheck
                    });
                }

                // Check global rate limit
                const globalCheck = await this.checkGlobalRateLimit();
                if (!globalCheck.allowed) {
                    return res.status(503).json({
                        error: 'System rate limit exceeded',
                        details: globalCheck
                    });
                }

                next();
            } catch (error) {
                console.error('Rate limit middleware error:', error);
                res.status(500).json({ error: 'Rate limit check failed' });
            }
        };
    }
}

// CSV Import/Export Utilities
class CSVManager {
    constructor(db) {
        this.db = db;
    }

    // Parse CSV data and return contacts with validation
    parseContactsCSV(csvData, columnMapping) {
        const Papa = require('papaparse');
        
        const results = Papa.parse(csvData, {
            header: true,
            skipEmptyLines: true,
            dynamicTyping: false,
            transform: (value) => value.trim()
        });

        if (results.errors.length > 0) {
            throw new Error(`CSV parse errors: ${JSON.stringify(results.errors)}`);
        }

        const contacts = [];
        const errors = [];

        results.data.forEach((row, index) => {
            try {
                const contact = this.mapCSVRowToContact(row, columnMapping);
                const validation = this.validateContact(contact);
                
                if (validation.isValid) {
                    contacts.push(contact);
                } else {
                    errors.push({
                        row: index + 1,
                        errors: validation.errors,
                        data: row
                    });
                }
            } catch (error) {
                errors.push({
                    row: index + 1,
                    errors: [error.message],
                    data: row
                });
            }
        });

        return { contacts, errors, total: results.data.length };
    }

    mapCSVRowToContact(row, columnMapping) {
        const contact = {};
        
        // Required mappings
        contact.name = row[columnMapping.name] || '';
        contact.phone = this.normalizePhoneNumber(row[columnMapping.phone] || '');
        
        // Optional mappings
        if (columnMapping.email && row[columnMapping.email]) {
            contact.email = row[columnMapping.email];
        }
        
        if (columnMapping.notes && row[columnMapping.notes]) {
            contact.notes = row[columnMapping.notes];
        }

        // Group mappings
        contact.groups = [];
        if (columnMapping.groups) {
            const groupsText = row[columnMapping.groups] || '';
            if (groupsText) {
                contact.groups = groupsText.split(',').map(g => g.trim()).filter(g => g);
            }
        }

        return contact;
    }

    normalizePhoneNumber(phone) {
        // Remove all non-numeric characters except +
        let normalized = phone.replace(/[^\d+]/g, '');
        
        // Add + if not present and starts with country code
        if (!normalized.startsWith('+') && normalized.length > 10) {
            normalized = '+' + normalized;
        }
        
        // Add default country code if local number
        if (!normalized.startsWith('+') && normalized.length === 10) {
            normalized = '+1' + normalized; // Default to US
        }
        
        return normalized;
    }

    validateContact(contact) {
        const errors = [];
        
        // Validate name
        if (!contact.name || contact.name.length < 1) {
            errors.push('Name is required');
        }
        
        // Validate phone
        if (!contact.phone) {
            errors.push('Phone number is required');
        } else if (!/^\+\d{10,15}$/.test(contact.phone)) {
            errors.push('Invalid phone number format');
        }
        
        // Validate email if provided
        if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
            errors.push('Invalid email format');
        }
        
        return {
            isValid: errors.length === 0,
            errors
        };
    }

    // Import contacts to database
    async importContacts(contacts, options = {}) {
        const { updateExisting = false, defaultGroups = [] } = options;
        const results = {
            imported: 0,
            updated: 0,
            skipped: 0,
            errors: []
        };

        for (const contact of contacts) {
            try {
                // Check if contact exists
                const [existing] = await this.db.execute(
                    'SELECT id FROM contacts WHERE phone = ?',
                    [contact.phone]
                );

                if (existing.length > 0) {
                    if (updateExisting) {
                        await this.updateContact(existing[0].id, contact);
                        results.updated++;
                    } else {
                        results.skipped++;
                    }
                } else {
                    const contactId = await this.createContact(contact, defaultGroups);
                    results.imported++;
                }
            } catch (error) {
                results.errors.push({
                    contact: contact.name,
                    phone: contact.phone,
                    error: error.message
                });
            }
        }

        return results;
    }

    async createContact(contact, defaultGroups = []) {
        const [result] = await this.db.execute(`
            INSERT INTO contacts (name, phone, email, notes)
            VALUES (?, ?, ?, ?)
        `, [contact.name, contact.phone, contact.email || null, contact.notes || null]);

        const contactId = result.insertId;

        // Add to groups
        const allGroups = [...new Set([...contact.groups, ...defaultGroups])];
        for (const groupName of allGroups) {
            const groupId = await this.getOrCreateGroup(groupName);
            await this.db.execute(`
                INSERT IGNORE INTO contact_groups (contact_id, group_id)
                VALUES (?, ?)
            `, [contactId, groupId]);
        }

        return contactId;
    }

    async updateContact(contactId, contact) {
        await this.db.execute(`
            UPDATE contacts 
            SET name = ?, email = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [contact.name, contact.email || null, contact.notes || null, contactId]);

        // Update groups
        if (contact.groups && contact.groups.length > 0) {
            // Remove existing group associations
            await this.db.execute('DELETE FROM contact_groups WHERE contact_id = ?', [contactId]);
            
            // Add new groups
            for (const groupName of contact.groups) {
                const groupId = await this.getOrCreateGroup(groupName);
                await this.db.execute(`
                    INSERT INTO contact_groups (contact_id, group_id)
                    VALUES (?, ?)
                `, [contactId, groupId]);
            }
        }
    }

    async getOrCreateGroup(groupName) {
        const [existing] = await this.db.execute(
            'SELECT id FROM groups WHERE name = ?',
            [groupName]
        );

        if (existing.length > 0) {
            return existing[0].id;
        }

        const [result] = await this.db.execute(
            'INSERT INTO groups (name) VALUES (?)',
            [groupName]
        );

        return result.insertId;
    }

    // Export contacts to CSV
    async exportContacts(options = {}) {
        const Papa = require('papaparse');
        const { groupIds = [], includeGroups = true, format = 'google' } = options;
        
        let query = `
            SELECT c.*, GROUP_CONCAT(g.name) as group_names
            FROM contacts c
            LEFT JOIN contact_groups cg ON c.id = cg.contact_id
            LEFT JOIN groups g ON cg.group_id = g.id
            WHERE c.is_active = TRUE
        `;
        
        const params = [];
        
        if (groupIds.length > 0) {
            query += ` AND cg.group_id IN (${groupIds.map(() => '?').join(',')})`;
            params.push(...groupIds);
        }
        
        query += ' GROUP BY c.id ORDER BY c.name';
        
        const [contacts] = await this.db.execute(query, params);
        
        // Format for different CSV types
        let csvData;
        if (format === 'google') {
            csvData = this.formatForGoogleContacts(contacts);
        } else {
            csvData = this.formatForGenericCSV(contacts, includeGroups);
        }
        
        return Papa.unparse(csvData);
    }

    formatForGoogleContacts(contacts) {
        return contacts.map(contact => ({
            'Name': contact.name,
            'Phone 1 - Value': contact.phone,
            'E-mail 1 - Value': contact.email || '',
            'Notes': contact.notes || '',
            'Group Membership': contact.group_names || ''
        }));
    }

    formatForGenericCSV(contacts, includeGroups) {
        const data = contacts.map(contact => {
            const row = {
                'Name': contact.name,
                'Phone': contact.phone,
                'Email': contact.email || '',
                'Notes': contact.notes || ''
            };
            
            if (includeGroups) {
                row['Groups'] = contact.group_names || '';
            }
            
            return row;
        });
        
        return data;
    }
}

// Utility functions for rate limiting
const rateLimitUtils = {
    // Get human-readable time remaining
    getTimeRemaining: (resetTime) => {
        const now = new Date();
        const diff = resetTime - now;
        
        if (diff <= 0) return 'now';
        
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);
        
        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    },

    // Format rate limit status for display
    formatRateLimitStatus: (status) => {
        return {
            phone: status.phone,
            limits: {
                minute: `${status.current.minute}/${status.limits.perMinute}`,
                hour: `${status.current.hour}/${status.limits.perHour}`,
                day: `${status.current.day}/${status.limits.perDay}`
            },
            remaining: status.remaining,
            status: {
                minute: status.current.minute >= status.limits.perMinute ? 'exceeded' : 'ok',
                hour: status.current.hour >= status.limits.perHour ? 'exceeded' : 'ok',
                day: status.current.day >= status.limits.perDay ? 'exceeded' : 'ok'
            }
        };
    }
};

module.exports = {
    RateLimitManager,
    CSVManager,
    rateLimitUtils
};
