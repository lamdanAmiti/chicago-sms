// Railway-optimized SMS Server
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const path = require('path');
const PostgreSQLAdapter = require('./database/postgresAdapter');
require('dotenv').config();

class RailwaySMSServer {
    constructor() {
        this.app = express();
        this.db = null;
        this.wss = null;
        this.bridgeWs = null;
        this.adminClients = new Set();
        this.virtualMessages = new Map();
        
        this.setupDatabase();
        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
    }

    async setupDatabase() {
        try {
            this.db = new PostgreSQLAdapter();
            console.log('✅ PostgreSQL connected (Railway)');
        } catch (error) {
            console.error('❌ Database connection failed:', error);
            process.exit(1);
        }
    }

    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.static(path.join(__dirname, 'public')));
    }

    setupRoutes() {
        // Health check for Railway
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'healthy', 
                environment: process.env.NODE_ENV,
                timestamp: new Date().toISOString() 
            });
        });

        // System configuration
        this.app.get('/api/config', async (req, res) => {
            res.json({
                environment: process.env.NODE_ENV || 'development',
                virtual_phone_number: process.env.VIRTUAL_PHONE || '+1234567890',
                enable_virtual_phone: process.env.ENABLE_VIRTUAL_PHONE === 'true'
            });
        });

        // Virtual phone for development (Railway-friendly)
        this.app.post('/api/virtual/send', async (req, res) => {
            try {
                const { from_phone, to_phone, message_content } = req.body;
                
                // Store in memory for Railway deployment
                const messageId = Date.now().toString();
                this.virtualMessages.set(messageId, {
                    id: messageId,
                    direction: 'outbound',
                    from_phone,
                    to_phone,
                    message_content,
                    timestamp: new Date().toISOString(),
                    status: 'sent'
                });

                // Broadcast to admin clients
                this.broadcastToAdmin({
                    type: 'virtual_message_sent',
                    data: this.virtualMessages.get(messageId)
                });

                res.json({ success: true, messageId });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.post('/api/virtual/receive', async (req, res) => {
            try {
                const { from_phone, to_phone, message_content } = req.body;
                
                const messageId = Date.now().toString();
                this.virtualMessages.set(messageId, {
                    id: messageId,
                    direction: 'inbound',
                    from_phone,
                    to_phone,
                    message_content,
                    timestamp: new Date().toISOString(),
                    status: 'received'
                });

                this.broadcastToAdmin({
                    type: 'virtual_message_received',
                    data: this.virtualMessages.get(messageId)
                });

                res.json({ success: true, messageId });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Get virtual messages
        this.app.get('/api/messages', (req, res) => {
            const { phone } = req.query;
            let messages = Array.from(this.virtualMessages.values());
            
            if (phone) {
                messages = messages.filter(m => 
                    m.from_phone === phone || m.to_phone === phone
                );
            }
            
            res.json(messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
        });

        // Serve admin panel
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
            
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.handleWebSocketMessage(ws, data);
                } catch (error) {
                    console.error('WebSocket message error:', error);
                }
            });

            ws.on('close', () => {
                this.adminClients.delete(ws);
            });

            ws.send(JSON.stringify({ type: 'connection_established' }));
        });
    }

    handleWebSocketMessage(ws, data) {
        switch (data.type) {
            case 'register_admin':
                this.adminClients.add(ws);
                ws.send(JSON.stringify({ type: 'admin_registered' }));
                break;
        }
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
            console.log(`🚀 SMS Server running on Railway`);
            console.log(`📡 Port: ${port}`);
            console.log(`🌐 WebSocket: ${process.env.WS_PORT || 3001}`);
            console.log(`🎯 Environment: ${process.env.NODE_ENV}`);
        });
    }
}

const server = new RailwaySMSServer();
server.start();

module.exports = RailwaySMSServer;
