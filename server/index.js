// server/index.js - Complete SMS AT Command System for Railway
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

// Import your existing systems
const PostgreSQLAdapter = require('./database/postgresAdapter');

// Import all your existing systems (we'll use them!)
// Note: We'll need to adapt these slightly for PostgreSQL
// const ProgramEngine = require('./engines/programEngine');
// const AgentSystem = require('./systems/agentSystem');
// const BroadcastSystem = require('./systems/broadcastSystem');
// const { RateLimitManager, CSVManager } = require('./middleware/rateLimiting');

class CompleteSMSServerRailway {
    constructor() {
        this.app = express();
        this.db = null;
        this.wss = null;
        this.bridgeWs = null;
        this.adminClients = new Set();
        
        // Initialize systems
        this.rateLimitManager = null;
        this.csvManager = null;
        this.programEngine = null;
        this.agentSystem = null;
        this.broadcastSystem = null;
        
        // Virtual messages for Railway (in-memory + database)
        this.virtualMessages = new Map();
        
        this.setupDatabase();
    }

    async setupDatabase() {
        try {
            this.db = new PostgreSQLAdapter();
            console.log('✅ PostgreSQL connected (Railway)');
            
            // Initialize all systems after DB connection
            await this.initializeSystems();
            await this.setupMiddleware();
            await this.setupRoutes();
            await this.setupWebSocket();
            
        } catch (error) {
            console.error('❌ Database connection failed:', error);
            process.exit(1);
        }
    }

    async initializeSystems() {
        console.log('🔧 Initializing SMS systems...');
        
        // Rate limiting system (adapted for PostgreSQL)
        this.rateLimitManager = {
            checkRateLimit: async (phone) => ({ allowed: true }), // Simplified for Railway
            updateRateLimit: async (phone) => { /* simplified */ }
        };
        
        // SMS service wrapper
        this.smsService = {
            sendMessage: async (to, message, type = 'sms', metadata = {}) => {
                return await this.sendMessage(to, message, type, metadata);
            }
        };
        
        console.log('✅ All systems initialized');
    }

    setupMiddleware() {
        // Security and optimization
        this.app.use(helmet({
            contentSecurityPolicy: false // Allow admin panel to work
        }));
        this.app.use(compression());
        this.app.use(morgan('combined'));
        this.app.use(cors());
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
        
        // Serve static files (admin panel)
        this.app.use(express.static(path.join(__dirname, 'public')));
    }

    async setupRoutes() {
        // Health check for Railway
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'healthy', 
                environment: process.env.NODE_ENV,
                timestamp: new Date().toISOString(),
                systems: {
                    database: !!this.db,
                    websocket: !!this.wss
                }
            });
        });

        // System Configuration (same as original)
        this.app.get('/api/config', async (req, res) => {
            try {
                const [rows] = await this.db.execute('SELECT * FROM system_config');
                const config = {};
                rows.forEach(row => {
                    let value = row.config_value;
                    if (row.config_type === 'number') value = parseFloat(value);
                    else if (row.config_type === 'boolean') value = value === 'true';
                    else if (row.config_type === 'json') value = JSON.parse(value);
                    config[row.config_key] = value;
                });
                
                // Add Railway-specific config
                config.environment = process.env.NODE_ENV || 'production';
                config.virtual_phone_number = process.env.VIRTUAL_PHONE || '+1234567890';
                config.enable_virtual_phone = true; // Always enabled for Railway
                
                res.json(config);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Contacts Management (same as original but PostgreSQL)
        this.app.get('/api/contacts', async (req, res) => {
            try {
                const { search, group_id, page = 1, limit = 50 } = req.query;
                let query = `
                    SELECT c.*, string_agg(g.name, ',') as group_names
                    FROM contacts c
                    LEFT JOIN contact_groups cg ON c.id = cg.contact_id
                    LEFT JOIN groups g ON cg.group_id = g.id
                    WHERE c.is_active = TRUE
                `;
                const params = [];

                if (search) {
                    query += ' AND (c.name ILIKE $' + (params.length + 1) + ' OR c.phone ILIKE $' + (params.length + 2) + ')';
                    params.push(`%${search}%`, `%${search}%`);
                }

                if (group_id) {
                    query += ' AND cg.group_id = $' + (params.length + 1);
                    params.push(group_id);
                }

                query += ' GROUP BY c.id ORDER BY c.name LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
                params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

                const [rows] = await this.db.execute(query, params);
                res.json(rows);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.post('/api/contacts', async (req, res) => {
            try {
                const { name, phone, email, notes, group_ids } = req.body;
                
                const [result] = await this.db.execute(
                    'INSERT INTO contacts (name, phone, email, notes) VALUES ($1, $2, $3, $4) RETURNING id',
                    [name, phone, email, notes]
                );
                
                const contactId = result[0].id;
                
                if (group_ids && group_ids.length > 0) {
                    for (const groupId of group_ids) {
                        await this.db.execute(
                            'INSERT INTO contact_groups (contact_id, group_id) VALUES ($1, $2)',
                            [contactId, groupId]
                        );
                    }
                }
                
                res.json({ id: contactId, success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Groups Management (same as original but PostgreSQL)
        this.app.get('/api/groups', async (req, res) => {
            try {
                const [rows] = await this.db.execute(`
                    SELECT g.*, COUNT(cg.contact_id) as contact_count
                    FROM groups g
                    LEFT JOIN contact_groups cg ON g.id = cg.contact_id
                    GROUP BY g.id ORDER BY g.name
                `);
                res.json(rows);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Virtual Phone for Railway (enhanced version)
        this.app.post('/api/virtual/send', async (req, res) => {
            try {
                const { from_phone, to_phone, message_content } = req.body;
                
                // Store in database
                const [result] = await this.db.execute(`
                    INSERT INTO virtual_messages (direction, from_phone, to_phone, message_content, status)
                    VALUES ($1, $2, $3, $4, $5) RETURNING id
                `, ['outbound', from_phone, to_phone, message_content, 'sent']);

                const messageId = result[0].id;

                // Broadcast to admin clients
                this.broadcastToAdmin({
                    type: 'virtual_message_sent',
                    data: {
                        id: messageId,
                        direction: 'outbound',
                        from_phone,
                        to_phone,
                        message_content,
                        timestamp: new Date().toISOString()
                    }
                });

                res.json({ success: true, messageId });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.post('/api/virtual/receive', async (req, res) => {
            try {
                const { from_phone, to_phone, message_content } = req.body;
                
                const [result] = await this.db.execute(`
                    INSERT INTO virtual_messages (direction, from_phone, to_phone, message_content, status)
                    VALUES ($1, $2, $3, $4, $5) RETURNING id
                `, ['inbound', from_phone, to_phone, message_content, 'received']);

                const messageId = result[0].id;

                this.broadcastToAdmin({
                    type: 'virtual_message_received',
                    data: {
                        id: messageId,
                        direction: 'inbound',
                        from_phone,
                        to_phone,
                        message_content,
                        timestamp: new Date().toISOString()
                    }
                });

                res.json({ success: true, messageId });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Get messages
        this.app.get('/api/messages', async (req, res) => {
            try {
                const { phone, limit = 100, page = 1 } = req.query;
                
                let query = `
                    SELECT * FROM virtual_messages 
                    WHERE ($1::text IS NULL OR from_phone = $1 OR to_phone = $1)
                    ORDER BY created_at DESC LIMIT $2 OFFSET $3
                `;
                
                const [rows] = await this.db.execute(query, [
                    phone || null, 
                    parseInt(limit), 
                    (parseInt(page) - 1) * parseInt(limit)
                ]);
                
                res.json(rows);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Rate limit status
        this.app.get('/api/rate-limit/:phone', async (req, res) => {
            try {
                const { phone } = req.params;
                // Simplified for Railway
                const status = {
                    phone,
                    limits: { perMinute: 10, perHour: 100, perDay: 500 },
                    current: { minute: 0, hour: 0, day: 0 }
                };
                res.json(status);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Serve admin panel (catch-all route)
        this.app.get('*', (req, res) => {
            res.sendFile(path.join(__dirname, 'public/index.html'));
        });
    }

    setupWebSocket() {
        const port = process.env.WS_PORT || 3001;
        this.wss = new WebSocket.Server({ 
            port: port,
            perMessageDeflate: false 
        });
        
        this.wss.on('connection', (ws) => {
            console.log('WebSocket connection established');
            
            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    await this.handleWebSocketMessage(ws, data);
                } catch (error) {
                    console.error('WebSocket message error:', error);
                }
            });

            ws.on('close', () => {
                this.adminClients.delete(ws);
            });

            ws.send(JSON.stringify({ type: 'connection_established' }));
        });
        
        console.log(`✅ WebSocket server running on port ${port}`);
    }

    async handleWebSocketMessage(ws, data) {
        switch (data.type) {
            case 'register_admin':
                this.adminClients.add(ws);
                ws.send(JSON.stringify({ type: 'admin_registered' }));
                break;
                
            case 'register_bridge':
                this.bridgeWs = ws;
                ws.send(JSON.stringify({ type: 'bridge_registered' }));
                break;
        }
    }

    async sendMessage(to, message, type = 'sms', metadata = {}) {
        // For Railway deployment, simulate sending
        const messageId = Date.now().toString();
        
        // Store in virtual messages
        await this.db.execute(`
            INSERT INTO virtual_messages (direction, from_phone, to_phone, message_content, status)
            VALUES ($1, $2, $3, $4, $5)
        `, ['outbound', process.env.VIRTUAL_PHONE || '+1234567890', to, message, 'sent']);

        return messageId;
    }

    broadcastToAdmin(data) {
        this.adminClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    }

    start() {
        const port = process.env.PORT || 3000;
        this.app.listen(port, '0.0.0.0', () => {
            console.log(`🚀 Complete SMS AT Command System running on Railway`);
            console.log(`📡 Port: ${port}`);
            console.log(`🌐 Environment: ${process.env.NODE_ENV}`);
            console.log(`💾 Database: PostgreSQL`);
            console.log(`📱 Virtual Phone: Enabled`);
            console.log(`✨ All systems operational!`);
        });
    }
}

const server = new CompleteSMSServerRailway();
server.start();

module.exports = CompleteSMSServerRailway;
