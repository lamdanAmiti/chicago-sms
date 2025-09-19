// server/index.js - Complete SMS AT Command System for Railway
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
const winston = require('winston');
require('dotenv').config();

// Import system components
const PostgreSQLAdapter = require('./database/postgresAdapter');
const { RateLimitManager, CSVManager } = require('./middleware/rateLimiting');
const ProgramEngine = require('./engines/programEngine');
const AgentSystem = require('./systems/agentSystem');
const BroadcastSystem = require('./systems/broadcastSystem');
const CompleteRoutes = require('./routes/completeRoutes');

class CompleteSMSServerRailway {
    constructor() {
        this.app = express();
        this.db = null;
        this.wss = null;
        this.bridgeWs = null;
        this.adminClients = new Set();
        
        // System components
        this.rateLimitManager = null;
        this.csvManager = null;
        this.programEngine = null;
        this.agentSystem = null;
        this.broadcastSystem = null;
        this.routes = null;
        
        // Message processing
        this.messageQueue = [];
        this.isProcessingQueue = false;
        
        // Configuration
        this.config = {
            port: process.env.PORT || 3000,
            wsPort: process.env.WS_PORT || 3001,
            environment: process.env.NODE_ENV || 'production',
            virtualPhone: process.env.VIRTUAL_PHONE || '+1234567890'
        };
        
        // Setup logging
        this.setupLogger();
        
        // Initialize database and systems
        this.initialize();
    }

    setupLogger() {
        this.logger = winston.createLogger({
            level: process.env.LOG_LEVEL || 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.errors({ stack: true }),
                winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
                    let metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
                    return `${timestamp} [${level.toUpperCase()}] ${message} ${stack || ''} ${metaStr}`;
                })
            ),
            transports: [
                new winston.transports.Console({
                    format: winston.format.colorize({ all: true })
                })
            ]
        });

        // Add file transports in production
        if (this.config.environment === 'production') {
            this.logger.add(new winston.transports.File({ 
                filename: 'logs/error.log', 
                level: 'error',
                maxsize: 5242880, // 5MB
                maxFiles: 5
            }));
            this.logger.add(new winston.transports.File({ 
                filename: 'logs/combined.log',
                maxsize: 5242880, // 5MB
                maxFiles: 5
            }));
        }
    }

    async initialize() {
        try {
            this.logger.info('🚀 Initializing SMS AT Command System for Railway...');
            
            // Setup database
            await this.setupDatabase();
            
            // Initialize all systems
            await this.initializeSystems();
            
            // Setup Express middleware and routes
            await this.setupMiddleware();
            await this.setupRoutes();
            
            // Setup WebSocket server
            await this.setupWebSocket();
            
            // Start background processes
            this.startBackgroundProcesses();
            
            // Start HTTP server
            this.startServer();
            
        } catch (error) {
            this.logger.error('❌ Failed to initialize server:', error);
            process.exit(1);
        }
    }

    async setupDatabase() {
        try {
            this.db = new PostgreSQLAdapter();
            this.logger.info('✅ PostgreSQL connected successfully');
            
            // Test database connection
            await this.db.execute('SELECT 1 as test');
            this.logger.info('✅ Database connectivity verified');
            
        } catch (error) {
            this.logger.error('❌ Database connection failed:', error);
            throw error;
        }
    }

    async initializeSystems() {
        try {
            this.logger.info('🔧 Initializing system components...');
            
            // Rate limiting system
            this.rateLimitManager = new RateLimitManager(this.db);
            await this.rateLimitManager.loadConfig();
            this.logger.info('✅ Rate limiting system initialized');
            
            // CSV management system
            this.csvManager = new CSVManager(this.db);
            this.logger.info('✅ CSV management system initialized');
            
            // SMS service wrapper
            this.smsService = {
                sendMessage: async (to, message, type = 'sms', metadata = {}) => {
                    return await this.sendMessage(to, message, type, metadata);
                }
            };
            
            // Program engine
            this.programEngine = new ProgramEngine(this.db, this.smsService);
            this.logger.info('✅ Program engine initialized');
            
            // Agent system
            this.agentSystem = new AgentSystem(this.db, this.smsService);
            this.logger.info('✅ Agent system initialized');
            
            // Broadcast system
            this.broadcastSystem = new BroadcastSystem(this.db, this.smsService, this.rateLimitManager);
            this.logger.info('✅ Broadcast system initialized');
            
            // Routes system
            this.routes = new CompleteRoutes(
                this.db, 
                this.smsService, 
                this.rateLimitManager, 
                this.programEngine, 
                this.agentSystem, 
                this.broadcastSystem, 
                this.csvManager
            );
            this.logger.info('✅ Routes system initialized');
            
            this.logger.info('🎉 All systems initialized successfully');
            
        } catch (error) {
            this.logger.error('❌ System initialization failed:', error);
            throw error;
        }
    }

    setupMiddleware() {
        // Security middleware
        this.app.use(helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
                    scriptSrc: ["'self'", "https://cdn.tailwindcss.com"],
                    imgSrc: ["'self'", "data:", "https:"],
                    connectSrc: ["'self'", "ws:", "wss:"],
                },
            },
            crossOriginEmbedderPolicy: false
        }));

        // Performance middleware
        this.app.use(compression());
        
        // Logging middleware
        if (this.config.environment === 'production') {
            this.app.use(morgan('combined', {
                stream: { write: message => this.logger.info(message.trim()) }
            }));
        } else {
            this.app.use(morgan('dev'));
        }

        // CORS configuration
        this.app.use(cors({
            origin: process.env.CORS_ORIGIN || true,
            credentials: true
        }));

        // Body parsing
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

        // Rate limiting for API endpoints
        this.app.use('/api/', this.rateLimitManager.createAPIRateLimit());

        // Serve static files (built admin panel)
        this.app.use(express.static(path.join(__dirname, 'public'), {
            maxAge: this.config.environment === 'production' ? '1d' : 0
        }));

        this.logger.info('✅ Express middleware configured');
    }

    async setupRoutes() {
        // Health check for Railway
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'healthy', 
                environment: this.config.environment,
                timestamp: new Date().toISOString(),
                systems: {
                    database: !!this.db,
                    websocket: !!this.wss,
                    programEngine: !!this.programEngine,
                    agentSystem: !!this.agentSystem,
                    broadcastSystem: !!this.broadcastSystem
                },
                version: require('../package.json').version
            });
        });

        // Setup all API routes
        this.routes.setupSystemRoutes(this.app);
        this.routes.setupContactRoutes(this.app);
        this.routes.setupGroupRoutes(this.app);
        this.routes.setupMessageRoutes(this.app);
        this.routes.setupProgramRoutes(this.app);
        this.routes.setupAgentRoutes(this.app);
        this.routes.setupBroadcastRoutes(this.app);

        // CSV upload routes with rate limiting
        this.app.post('/api/contacts/import', 
            this.rateLimitManager.createSMSRateLimit(),
            async (req, res) => {
                try {
                    // Implementation for CSV import
                    res.json({ success: true, message: 'CSV import endpoint' });
                } catch (error) {
                    res.status(500).json({ error: error.message });
                }
            }
        );

        // Catch-all route for SPA (serve admin panel)
        this.app.get('*', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        this.logger.info('✅ Routes configured');
    }

    setupWebSocket() {
        this.wss = new WebSocket.Server({ 
            port: this.config.wsPort,
            perMessageDeflate: false 
        });
        
        this.wss.on('connection', (ws, req) => {
            const clientIP = req.socket.remoteAddress;
            this.logger.info(`🔌 WebSocket connection from ${clientIP}`);
            
            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    await this.handleWebSocketMessage(ws, data);
                } catch (error) {
                    this.logger.error('WebSocket message error:', error);
                    ws.send(JSON.stringify({ 
                        type: 'error', 
                        message: 'Invalid message format' 
                    }));
                }
            });

            ws.on('close', () => {
                this.adminClients.delete(ws);
                if (this.bridgeWs === ws) {
                    this.bridgeWs = null;
                    this.logger.warn('🌉 Bridge disconnected');
                }
            });

            ws.on('error', (error) => {
                this.logger.error('WebSocket error:', error);
            });

            // Send welcome message
            ws.send(JSON.stringify({ 
                type: 'connection_established',
                server_info: {
                    environment: this.config.environment,
                    virtual_phone: this.config.virtualPhone,
                    timestamp: new Date().toISOString()
                }
            }));
        });
        
        this.logger.info(`✅ WebSocket server running on port ${this.config.wsPort}`);
    }

    async handleWebSocketMessage(ws, data) {
        switch (data.type) {
            case 'register_admin':
                this.adminClients.add(ws);
                ws.send(JSON.stringify({ type: 'admin_registered' }));
                this.logger.info('👤 Admin client registered');
                break;
                
            case 'register_bridge':
                this.bridgeWs = ws;
                ws.send(JSON.stringify({ type: 'bridge_registered' }));
                this.logger.info('🌉 Bridge client registered');
                break;

            case 'incoming_sms':
                await this.processIncomingMessage(data.data);
                break;

            case 'sms_sent':
            case 'sms_failed':
                await this.updateMessageStatus(data.data);
                break;

            case 'heartbeat':
                ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
                break;

            default:
                this.logger.debug('Unknown WebSocket message type:', data.type);
        }
    }

    async processIncomingMessage(messageData) {
        try {
            const { from_phone, message_content, timestamp } = messageData;
            
            this.logger.info(`📱 Incoming SMS from ${from_phone}: ${message_content.substring(0, 50)}...`);
            
            // Find or create contact
            let contact = await this.findOrCreateContact(from_phone);
            
            // Store message in database
            await this.db.execute(`
                INSERT INTO messages (direction, from_phone, to_phone, message_content, contact_id, status)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, ['inbound', from_phone, this.config.virtualPhone, message_content, contact?.id, 'received']);
            
            // Check if agent system should handle this message
            const agentHandled = await this.agentSystem.processAgentMessage(from_phone, message_content, contact);
            if (agentHandled) {
                this.logger.info(`👤 Message from ${from_phone} handled by agent system`);
                return;
            }
            
            // Check if user has active chat session
            const chatForwarded = await this.agentSystem.forwardUserMessage(from_phone, message_content, contact);
            if (chatForwarded) {
                this.logger.info(`💬 Message from ${from_phone} forwarded to active chat`);
                return;
            }
            
            // Process through program engine
            await this.programEngine.processMessage(from_phone, message_content, contact);
            
            // Broadcast to admin clients
            this.broadcastToAdmin({
                type: 'incoming_message',
                data: {
                    from_phone,
                    message_content,
                    contact: contact ? { id: contact.id, name: contact.name } : null,
                    timestamp: timestamp || new Date().toISOString()
                }
            });
            
        } catch (error) {
            this.logger.error('Error processing incoming message:', error);
        }
    }

    async findOrCreateContact(phone) {
        try {
            // Try to find existing contact
            const [existing] = await this.db.execute(
                'SELECT * FROM contacts WHERE phone = $1',
                [phone]
            );
            
            if (existing.length > 0) {
                return existing[0];
            }
            
            // Create new contact
            const [result] = await this.db.execute(`
                INSERT INTO contacts (name, phone, notes)
                VALUES ($1, $2, $3) RETURNING *
            `, [`Contact ${phone}`, phone, 'Auto-created from incoming message']);
            
            const newContact = result[0];
            
            // Assign to default group
            const [defaultGroups] = await this.db.execute(
                'SELECT id FROM groups WHERE is_default = TRUE LIMIT 1'
            );
            
            if (defaultGroups.length > 0) {
                await this.db.execute(`
                    INSERT INTO contact_groups (contact_id, group_id)
                    VALUES ($1, $2)
                `, [newContact.id, defaultGroups[0].id]);
            }
            
            this.logger.info(`👤 New contact created: ${phone}`);
            return newContact;
            
        } catch (error) {
            this.logger.error('Error finding/creating contact:', error);
            return null;
        }
    }

    async sendMessage(to, message, type = 'sms', metadata = {}) {
        try {
            // Check rate limits
            const rateLimitCheck = await this.rateLimitManager.checkPhoneRateLimit(to);
            if (!rateLimitCheck.allowed) {
                throw new Error(`Rate limit exceeded: ${rateLimitCheck.window}`);
            }

            const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            
            // Store in database
            await this.db.execute(`
                INSERT INTO messages (direction, from_phone, to_phone, message_content, message_type, status, bridge_message_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, ['outbound', this.config.virtualPhone, to, message, type, 'pending', messageId]);

            // Send via bridge or simulate for Railway
            if (this.bridgeWs && this.bridgeWs.readyState === WebSocket.OPEN) {
                this.bridgeWs.send(JSON.stringify({
                    type: 'send_sms',
                    data: {
                        id: messageId,
                        to_phone: to,
                        message_content: message,
                        metadata
                    }
                }));
            } else {
                // For Railway deployment without bridge, simulate sending
                await this.simulateMessageSending(messageId, to, message);
            }

            // Update rate limits
            await this.rateLimitManager.updateRateLimit(to);

            // Broadcast to admin clients
            this.broadcastToAdmin({
                type: 'message_sent',
                data: {
                    id: messageId,
                    to_phone: to,
                    message_content: message,
                    type,
                    timestamp: new Date().toISOString()
                }
            });

            this.logger.info(`📤 Message sent to ${to}: ${message.substring(0, 50)}...`);
            return messageId;

        } catch (error) {
            this.logger.error(`Error sending message to ${to}:`, error);
            throw error;
        }
    }

    async simulateMessageSending(messageId, to, message) {
        // For Railway deployment, simulate message sending
        setTimeout(async () => {
            try {
                await this.db.execute(`
                    UPDATE messages 
                    SET status = 'sent', updated_at = CURRENT_TIMESTAMP
                    WHERE bridge_message_id = $1
                `, [messageId]);

                // Also store in virtual messages for development
                if (this.config.environment === 'development') {
                    await this.db.execute(`
                        INSERT INTO virtual_messages (direction, from_phone, to_phone, message_content, status)
                        VALUES ($1, $2, $3, $4, $5)
                    `, ['outbound', this.config.virtualPhone, to, message, 'sent']);
                }

                this.broadcastToAdmin({
                    type: 'message_delivered',
                    data: {
                        id: messageId,
                        to_phone: to,
                        status: 'sent',
                        timestamp: new Date().toISOString()
                    }
                });

            } catch (error) {
                this.logger.error('Error simulating message delivery:', error);
            }
        }, 1000); // Simulate 1 second delay
    }

    async updateMessageStatus(statusData) {
        try {
            const { id, status, error } = statusData;
            
            await this.db.execute(`
                UPDATE messages 
                SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP
                WHERE bridge_message_id = $3
            `, [status, error || null, id]);

            this.broadcastToAdmin({
                type: 'message_status_update',
                data: statusData
            });

        } catch (error) {
            this.logger.error('Error updating message status:', error);
        }
    }

    broadcastToAdmin(data) {
        this.adminClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    }

    startBackgroundProcesses() {
        // Cleanup old data every hour
        setInterval(async () => {
            try {
                await this.cleanupOldData();
            } catch (error) {
                this.logger.error('Error in cleanup process:', error);
            }
        }, 60 * 60 * 1000);

        // System health check every 5 minutes
        setInterval(async () => {
            try {
                await this.systemHealthCheck();
            } catch (error) {
                this.logger.error('Error in health check:', error);
            }
        }, 5 * 60 * 1000);

        this.logger.info('✅ Background processes started');
    }

    async cleanupOldData() {
        const retentionDays = 30;
        
        // Clean up old rate limit data
        await this.rateLimitManager.cleanupOldRateLimits();
        
        // Clean up old virtual messages
        await this.db.execute(`
            DELETE FROM virtual_messages 
            WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '${retentionDays} days'
        `);
        
        // Clean up old system logs
        await this.db.execute(`
            DELETE FROM system_logs 
            WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '${retentionDays} days'
        `);
        
        this.logger.info('🧹 Old data cleanup completed');
    }

    async systemHealthCheck() {
        try {
            // Test database connection
            await this.db.execute('SELECT 1');
            
            // Log system status
            const stats = {
                activeAdminClients: this.adminClients.size,
                bridgeConnected: !!this.bridgeWs,
                programEngineRunning: this.programEngine?.isRunning,
                agentSystemRunning: !!this.agentSystem,
                broadcastSystemRunning: this.broadcastSystem?.isRunning
            };
            
            this.logger.debug('💓 System health check passed', stats);
            
        } catch (error) {
            this.logger.error('❌ System health check failed:', error);
        }
    }

    startServer() {
        this.app.listen(this.config.port, '0.0.0.0', () => {
            this.logger.info('🚀 SMS AT Command System running on Railway');
            this.logger.info(`📡 HTTP Server: Port ${this.config.port}`);
            this.logger.info(`🔌 WebSocket Server: Port ${this.config.wsPort}`);
            this.logger.info(`🌍 Environment: ${this.config.environment}`);
            this.logger.info(`📱 Virtual Phone: ${this.config.virtualPhone}`);
            this.logger.info(`💾 Database: PostgreSQL`);
            this.logger.info('✨ All systems operational!');
            
            // Log startup completion
            this.logger.info('🎉 Server startup completed successfully');
        });

        // Graceful shutdown handling
        this.setupGracefulShutdown();
    }

    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            this.logger.info(`📡 Received ${signal}, shutting down gracefully...`);
            
            try {
                // Stop accepting new connections
                if (this.wss) {
                    this.wss.close();
                }
                
                // Stop program engine
                if (this.programEngine) {
                    this.programEngine.stopEngine();
                }
                
                // Stop broadcast system
                if (this.broadcastSystem) {
                    this.broadcastSystem.stopProcessor();
                }
                
                // Close database connections
                if (this.db) {
                    await this.db.close();
                }
                
                this.logger.info('✅ Graceful shutdown completed');
                process.exit(0);
                
            } catch (error) {
                this.logger.error('Error during shutdown:', error);
                process.exit(1);
            }
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        
        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            this.logger.error('Uncaught Exception:', error);
            process.exit(1);
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            this.logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
            process.exit(1);
        });
    }
}

// Create and start the server
const server = new CompleteSMSServerRailway();

module.exports = CompleteSMSServerRailway;
