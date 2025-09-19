// server/systems/broadcastSystem.js - Mass Messaging Broadcast System
class BroadcastSystem {
    constructor(db, smsService, rateLimitManager) {
        this.db = db;
        this.smsService = smsService;
        this.rateLimitManager = rateLimitManager;
        this.activeBroadcasts = new Map();
        this.sendingQueue = [];
        this.isProcessing = false;
        
        this.startBroadcastProcessor();
    }

    // Create a new broadcast
    async createBroadcast(name, messageContent, targetGroups = [], targetContacts = [], scheduledAt = null, createdBy = 'system') {
        try {
            // Calculate recipients
            const recipients = await this.calculateRecipients(targetGroups, targetContacts);
            
            if (recipients.length === 0) {
                throw new Error('No recipients found for broadcast');
            }

            if (recipients.length > 1000) { // Max broadcast limit
                throw new Error('Broadcast exceeds maximum recipient limit (1000)');
            }

            // Create broadcast record
            const [result] = await this.db.execute(`
                INSERT INTO broadcasts (name, message_content, scheduled_at, total_recipients, created_by, status)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [
                name, 
                messageContent, 
                scheduledAt, 
                recipients.length, 
                createdBy,
                scheduledAt ? 'scheduled' : 'draft'
            ]);

            const broadcastId = result.insertId;

            // Create recipient records
            for (const recipient of recipients) {
                await this.db.execute(`
                    INSERT INTO broadcast_recipients (broadcast_id, contact_id, group_id, phone)
                    VALUES (?, ?, ?, ?)
                `, [broadcastId, recipient.contact_id, recipient.group_id, recipient.phone]);
            }

            // If not scheduled, start sending immediately
            if (!scheduledAt) {
                await this.startBroadcast(broadcastId);
            }

            return {
                broadcastId,
                recipients: recipients.length,
                status: scheduledAt ? 'scheduled' : 'sending'
            };

        } catch (error) {
            console.error('Error creating broadcast:', error);
            throw error;
        }
    }

    // Calculate recipients from groups and contacts
    async calculateRecipients(groupIds, contactIds) {
        const recipients = new Map(); // Use Map to avoid duplicates

        // Add contacts from groups
        if (groupIds && groupIds.length > 0) {
            const [groupContacts] = await this.db.execute(`
                SELECT DISTINCT c.id as contact_id, c.phone, cg.group_id
                FROM contacts c
                JOIN contact_groups cg ON c.id = cg.contact_id
                WHERE cg.group_id IN (${groupIds.map(() => '?').join(',')}) AND c.is_active = TRUE
            `, groupIds);

            groupContacts.forEach(contact => {
                recipients.set(contact.phone, {
                    contact_id: contact.contact_id,
                    group_id: contact.group_id,
                    phone: contact.phone
                });
            });
        }

        // Add specific contacts
        if (contactIds && contactIds.length > 0) {
            const [specificContacts] = await this.db.execute(`
                SELECT id as contact_id, phone
                FROM contacts
                WHERE id IN (${contactIds.map(() => '?').join(',')}) AND is_active = TRUE
            `, contactIds);

            specificContacts.forEach(contact => {
                recipients.set(contact.phone, {
                    contact_id: contact.contact_id,
                    group_id: null,
                    phone: contact.phone
                });
            });
        }

        return Array.from(recipients.values());
    }

    // Start sending a broadcast
    async startBroadcast(broadcastId) {
        try {
            await this.db.execute(`
                UPDATE broadcasts SET status = 'sending' WHERE id = ?
            `, [broadcastId]);

            // Add to processing queue
            this.sendingQueue.push(broadcastId);
            
            if (!this.isProcessing) {
                this.processBroadcastQueue();
            }

            console.log(`Broadcast ${broadcastId} started`);
            
        } catch (error) {
            console.error(`Error starting broadcast ${broadcastId}:`, error);
            await this.markBroadcastFailed(broadcastId, error.message);
        }
    }

    // Process broadcast sending queue
    async processBroadcastQueue() {
        if (this.isProcessing || this.sendingQueue.length === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.sendingQueue.length > 0) {
            const broadcastId = this.sendingQueue.shift();
            await this.processBroadcast(broadcastId);
            
            // Rate limiting: pause between broadcasts
            await this.delay(1000);
        }

        this.isProcessing = false;
    }

    // Process individual broadcast
    async processBroadcast(broadcastId) {
        try {
            // Get broadcast details
            const [broadcasts] = await this.db.execute(`
                SELECT * FROM broadcasts WHERE id = ?
            `, [broadcastId]);

            if (broadcasts.length === 0) {
                console.error(`Broadcast ${broadcastId} not found`);
                return;
            }

            const broadcast = broadcasts[0];
            this.activeBroadcasts.set(broadcastId, broadcast);

            // Get pending recipients
            const [recipients] = await this.db.execute(`
                SELECT * FROM broadcast_recipients 
                WHERE broadcast_id = ? AND status = 'pending'
                ORDER BY id
            `, [broadcastId]);

            console.log(`Processing broadcast ${broadcastId} with ${recipients.length} recipients`);

            let sentCount = 0;
            let failedCount = 0;

            for (const recipient of recipients) {
                try {
                    // Check global rate limits
                    const globalCheck = await this.rateLimitManager.checkGlobalRateLimit();
                    if (!globalCheck.allowed) {
                        console.log('Global rate limit reached, pausing broadcast');
                        await this.delay(60000); // Wait 1 minute
                        continue;
                    }

                    // Check phone rate limits
                    const phoneCheck = await this.rateLimitManager.checkPhoneRateLimit(recipient.phone);
                    if (!phoneCheck.allowed) {
                        await this.markRecipientFailed(recipient.id, 'Rate limit exceeded');
                        failedCount++;
                        continue;
                    }

                    // Send message
                    await this.smsService.sendMessage(
                        recipient.phone,
                        broadcast.message_content,
                        'broadcast',
                        { broadcast_id: broadcastId, recipient_id: recipient.id }
                    );

                    // Update rate limits
                    await this.rateLimitManager.updateRateLimit(recipient.phone);

                    // Mark as sent
                    await this.markRecipientSent(recipient.id);
                    sentCount++;

                    // Rate limiting: pause between messages
                    await this.delay(200); // 200ms between messages = 5 msgs/second

                } catch (error) {
                    console.error(`Failed to send to ${recipient.phone}:`, error);
                    await this.markRecipientFailed(recipient.id, error.message);
                    failedCount++;
                }
            }

            // Update broadcast status
            await this.updateBroadcastCounts(broadcastId, sentCount, failedCount);
            
            // Mark broadcast as completed
            await this.db.execute(`
                UPDATE broadcasts 
                SET status = 'sent', sent_at = NOW()
                WHERE id = ?
            `, [broadcastId]);

            this.activeBroadcasts.delete(broadcastId);
            
            console.log(`Broadcast ${broadcastId} completed: ${sentCount} sent, ${failedCount} failed`);

        } catch (error) {
            console.error(`Error processing broadcast ${broadcastId}:`, error);
            await this.markBroadcastFailed(broadcastId, error.message);
        }
    }

    async markRecipientSent(recipientId) {
        await this.db.execute(`
            UPDATE broadcast_recipients 
            SET status = 'sent', sent_at = NOW()
            WHERE id = ?
        `, [recipientId]);
    }

    async markRecipientFailed(recipientId, error) {
        await this.db.execute(`
            UPDATE broadcast_recipients 
            SET status = 'failed', error_message = ?
            WHERE id = ?
        `, [error, recipientId]);
    }

    async updateBroadcastCounts(broadcastId, sentCount, failedCount) {
        await this.db.execute(`
            UPDATE broadcasts 
            SET sent_count = sent_count + ?, failed_count = failed_count + ?
            WHERE id = ?
        `, [sentCount, failedCount, broadcastId]);
    }

    async markBroadcastFailed(broadcastId, error) {
        await this.db.execute(`
            UPDATE broadcasts 
            SET status = 'failed', error_message = ?
            WHERE id = ?
        `, [error, broadcastId]);
        
        this.activeBroadcasts.delete(broadcastId);
    }

    // Start processing scheduled broadcasts
    startBroadcastProcessor() {
        setInterval(async () => {
            await this.processScheduledBroadcasts();
        }, 60000); // Check every minute
    }

    async processScheduledBroadcasts() {
        try {
            const [scheduled] = await this.db.execute(`
                SELECT id FROM broadcasts 
                WHERE status = 'scheduled' AND scheduled_at <= NOW()
            `);

            for (const broadcast of scheduled) {
                await this.startBroadcast(broadcast.id);
            }
        } catch (error) {
            console.error('Error processing scheduled broadcasts:', error);
        }
    }

    // Get broadcast statistics
    async getBroadcastStats(broadcastId) {
        const [stats] = await this.db.execute(`
            SELECT 
                b.*,
                COUNT(br.id) as total_recipients,
                COUNT(CASE WHEN br.status = 'sent' THEN 1 END) as sent_count,
                COUNT(CASE WHEN br.status = 'delivered' THEN 1 END) as delivered_count,
                COUNT(CASE WHEN br.status = 'failed' THEN 1 END) as failed_count,
                COUNT(CASE WHEN br.status = 'pending' THEN 1 END) as pending_count
            FROM broadcasts b
            LEFT JOIN broadcast_recipients br ON b.id = br.broadcast_id
            WHERE b.id = ?
            GROUP BY b.id
        `, [broadcastId]);

        return stats[0] || null;
    }

    // Cancel a broadcast
    async cancelBroadcast(broadcastId) {
        try {
            // Remove from queue if pending
            const queueIndex = this.sendingQueue.indexOf(broadcastId);
            if (queueIndex > -1) {
                this.sendingQueue.splice(queueIndex, 1);
            }

            // Update database
            await this.db.execute(`
                UPDATE broadcasts SET status = 'cancelled' WHERE id = ? AND status IN ('scheduled', 'sending')
            `, [broadcastId]);

            // Remove from active if currently processing
            this.activeBroadcasts.delete(broadcastId);

            return true;
        } catch (error) {
            console.error(`Error cancelling broadcast ${broadcastId}:`, error);
            return false;
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// server/index.js - Complete Server Implementation with All Systems
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

// Import our custom systems
const ProgramEngine = require('./engines/programEngine');
const AgentSystem = require('./systems/agentSystem');
const BroadcastSystem = require('./systems/broadcastSystem');
const { RateLimitManager, CSVManager } = require('./middleware/rateLimiting');

class CompleteSMSServer {
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
        
        this.setupMiddleware();
        this.setupDatabase();
    }

    async setupDatabase() {
        try {
            this.db = await mysql.createConnection({
                host: process.env.DB_HOST || 'localhost',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: process.env.DB_NAME || 'sms_system',
                timezone: '+00:00'
            });
            
            console.log('✅ Database connected');
            
            // Initialize all systems
            await this.initializeSystems();
            await this.setupRoutes();
            await this.setupWebSocket();
            
        } catch (error) {
            console.error('❌ Database connection failed:', error);
            process.exit(1);
        }
    }

    async initializeSystems() {
        // Rate limiting system
        this.rateLimitManager = new RateLimitManager(this.db);
        
        // CSV import/export system
        this.csvManager = new CSVManager(this.db);
        
        // SMS service wrapper
        this.smsService = {
            sendMessage: async (to, message, type = 'sms', metadata = {}) => {
                return await this.sendMessage(to, message, type, metadata);
            }
        };
        
        // Program engine for automated sequences
        this.programEngine = new ProgramEngine(this.db, this.smsService);
        
        // Agent system for live chat
        this.agentSystem = new AgentSystem(this.db, this.smsService);
        
        // Broadcast system for mass messaging
        this.broadcastSystem = new BroadcastSystem(this.db, this.smsService, this.rateLimitManager);
        
        console.log('✅ All systems initialized');
    }

    setupMiddleware() {
        // Security and optimization
        this.app.use(helmet());
        this.app.use(compression());
        this.app.use(morgan('combined'));
        this.app.use(cors());
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
        
        // Serve static files
        this.app.use(express.static(path.join(__dirname, '../admin/build')));
        
        // Global rate limiting middleware
        this.app.use('/api', (req, res, next) => {
            if (this.rateLimitManager) {
                return this.rateLimitManager.createAPIRateLimit()(req, res, next);
            }
            next();
        });
    }

    async setupRoutes() {
        // Existing routes from previous implementation...
        this.setupSystemRoutes();
        this.setupContactRoutes();
        this.setupGroupRoutes();
        this.setupMessageRoutes();
        this.setupProgramRoutes();
        this.setupAgentRoutes();
        this.setupBroadcastRoutes();
        this.setupCSVRoutes();
        
        // Serve admin panel
        this.app.get('*', (req, res) => {
            res.sendFile(path.join(__dirname, '../admin/build/index.html'));
        });
    }

    setupBroadcastRoutes() {
        // Create broadcast
        this.app.post('/api/broadcasts', async (req, res) => {
            try {
                const { name, message_content, target_groups, target_contacts, scheduled_at } = req.body;
                
                const result = await this.broadcastSystem.createBroadcast(
                    name,
                    message_content,
                    target_groups || [],
                    target_contacts || [],
                    scheduled_at,
                    'admin'
                );
                
                res.json(result);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Get broadcast stats
        this.app.get('/api/broadcasts/:id/stats', async (req, res) => {
            try {
                const stats = await this.broadcastSystem.getBroadcastStats(req.params.id);
                res.json(stats);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Cancel broadcast
        this.app.delete('/api/broadcasts/:id', async (req, res) => {
            try {
                const success = await this.broadcastSystem.cancelBroadcast(req.params.id);
                res.json({ success });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }

    setupCSVRoutes() {
        const multer = require('multer');
        const upload = multer({ storage: multer.memoryStorage() });

        // CSV Import
        this.app.post('/api/contacts/import', upload.single('csvFile'), async (req, res) => {
            try {
                if (!req.file) {
                    return res.status(400).json({ error: 'No CSV file provided' });
                }

                const csvData = req.file.buffer.toString();
                const columnMapping = JSON.parse(req.body.columnMapping);
                const options = {
                    updateExisting: req.body.updateExisting === 'true',
                    defaultGroups: req.body.defaultGroups ? JSON.parse(req.body.defaultGroups) : []
                };

                const parseResult = this.csvManager.parseContactsCSV(csvData, columnMapping);
                
                if (parseResult.contacts.length === 0) {
                    return res.status(400).json({ 
                        error: 'No valid contacts found',
                        parseErrors: parseResult.errors
                    });
                }

                const importResult = await this.csvManager.importContacts(parseResult.contacts, options);
                
                res.json({
                    ...importResult,
                    parseErrors: parseResult.errors,
                    total: parseResult.total
                });

            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // CSV Export
        this.app.get('/api/contacts/export', async (req, res) => {
            try {
                const { groups, format = 'google' } = req.query;
                const groupIds = groups ? groups.split(',').map(Number) : [];
                
                const csvData = await this.csvManager.exportContacts({
                    groupIds,
                    format
                });

                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
                res.send(csvData);

            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }

    async processIncomingMessage(messageData) {
        const { from, to, message } = messageData;
        
        try {
            // Save to database
            const [result] = await this.db.execute(`
                INSERT INTO messages (direction, from_phone, to_phone, message_content, status, message_type)
                VALUES ('inbound', ?, ?, ?, 'received', 'sms')
            `, [from, to, message]);

            // Find contact
            const [contacts] = await this.db.execute(
                'SELECT * FROM contacts WHERE phone = ?',
                [from]
            );

            const contact = contacts[0];
            if (contact) {
                await this.db.execute(
                    'UPDATE messages SET contact_id = ? WHERE id = ?',
                    [contact.id, result.insertId]
                );
            }

            // Try to forward to active chat session first
            const wasForwarded = await this.agentSystem.forwardUserMessage(from, message, contact);
            
            if (!wasForwarded) {
                // Process through agent system for commands
                const wasAgentCommand = await this.agentSystem.processAgentMessage(from, message, contact);
                
                if (!wasAgentCommand) {
                    // Process through program engine
                    await this.programEngine.processMessage(from, message, contact);
                }
            }

            // Broadcast to admin clients
            this.broadcastToAdmin({
                type: 'incoming_message',
                data: {
                    id: result.insertId,
                    from,
                    to,
                    message,
                    contact: contact || null,
                    timestamp: new Date().toISOString()
                }
            });

        } catch (error) {
            console.error('Error processing incoming message:', error);
        }
    }

    async sendMessage(to, message, type = 'sms', metadata = {}) {
        // Check rate limits
        const rateLimitCheck = await this.rateLimitManager.checkPhoneRateLimit(to);
        if (!rateLimitCheck.allowed) {
            throw new Error(`Rate limit exceeded for ${to}: ${rateLimitCheck.window} limit reached`);
        }

        // Save to database
        const [result] = await this.db.execute(`
            INSERT INTO messages (direction, from_phone, to_phone, message_content, message_type, status)
            VALUES ('outbound', ?, ?, ?, ?, 'pending')
        `, [process.env.SYSTEM_PHONE || '+1234567890', to, message, type]);

        const messageId = result.insertId;

        // Update rate limit
        await this.rateLimitManager.updateRateLimit(to);

        if (process.env.NODE_ENV === 'development') {
            // Virtual phone mode
            await this.db.execute(`
                INSERT INTO virtual_messages (direction, from_phone, to_phone, message_content, status)
                VALUES ('outbound', ?, ?, ?, 'sent')
            `, [process.env.VIRTUAL_PHONE || '+1234567890', to, message]);

            // Simulate delivery
            setTimeout(async () => {
                await this.updateMessageStatus(messageId, 'delivered');
            }, 1000);

            this.broadcastToAdmin({
                type: 'virtual_message_sent',
                data: { messageId, to, message, timestamp: new Date().toISOString() }
            });
        } else {
            // Production mode - send via bridge
            if (this.bridgeWs && this.bridgeWs.readyState === WebSocket.OPEN) {
                this.bridgeWs.send(JSON.stringify({
                    type: 'send_sms',
                    message_id: messageId,
                    to,
                    message
                }));
            } else {
                await this.updateMessageStatus(messageId, 'failed', 'Bridge not connected');
            }
        }

        return messageId;
    }

    // ... (other route methods would be similar to previous implementation)

    setupWebSocket() {
        this.wss = new WebSocket.Server({ port: 3001 });
        
        this.wss.on('connection', (ws, req) => {
            console.log('WebSocket connection established');
            
            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    await this.handleWebSocketMessage(ws, data);
                } catch (error) {
                    console.error('WebSocket message error:', error);
                    ws.send(JSON.stringify({ error: error.message }));
                }
            });

            ws.on('close', () => {
                this.adminClients.delete(ws);
                console.log('WebSocket connection closed');
            });

            ws.send(JSON.stringify({ type: 'connection_established' }));
        });
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
        this.app.listen(port, () => {
            console.log(`\n🚀 SMS AT Command System Server running on port ${port}`);
            console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🌐 Admin Panel: http://localhost:${port}`);
            console.log(`📡 WebSocket: ws://localhost:3001`);
            console.log('\n📋 Available APIs:');
            console.log('   • Contacts: /api/contacts');
            console.log('   • Groups: /api/groups');
            console.log('   • Messages: /api/messages');
            console.log('   • Programs: /api/programs');
            console.log('   • Agents: /api/agents');
            console.log('   • Broadcasts: /api/broadcasts');
            console.log('   • CSV Import/Export: /api/contacts/import|export');
            console.log('\n✅ System ready!');
        });
    }
}

// Start the complete server
const server = new CompleteSMSServer();
server.start();

module.exports = CompleteSMSServer;
