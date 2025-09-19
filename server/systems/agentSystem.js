// server/systems/agentSystem.js - Live Chat Agent Management
const crypto = require('crypto');

class AgentSystem {
    constructor(db, smsService) {
        this.db = db;
        this.smsService = smsService;
        this.activeSessions = new Map(); // sessionKey -> session data
        this.pendingConnections = new Map(); // userPhone -> connection request
        this.sessionTimeouts = new Map(); // sessionKey -> timeout
        
        this.startSessionCleanup();
    }

    // Process incoming agent responses (ACCEPT, END, etc.)
    async processAgentMessage(agentPhone, message, contact) {
        const trimmedMessage = message.trim().toUpperCase();
        
        // Handle ACCEPT command
        if (trimmedMessage === 'ACCEPT') {
            await this.handleAcceptCommand(agentPhone);
            return true;
        }
        
        // Handle END command
        if (trimmedMessage === 'END') {
            await this.handleEndCommand(agentPhone);
            return true;
        }
        
        // Handle chat messages
        const activeSession = await this.getActiveSessionByAgent(agentPhone);
        if (activeSession) {
            await this.forwardAgentMessage(activeSession, message);
            return true;
        }
        
        return false; // Not an agent command
    }

    // Handle agent accepting a connection request
    async handleAcceptCommand(agentPhone) {
        try {
            // Find agent
            const [agents] = await this.db.execute(
                'SELECT * FROM agents WHERE phone = ? AND is_active = TRUE',
                [agentPhone]
            );
            
            if (agents.length === 0) {
                await this.smsService.sendMessage(
                    agentPhone,
                    'אתה לא רשום כסוכן במערכת.',
                    'system'
                );
                return;
            }
            
            const agent = agents[0];
            
            // Check if agent has capacity
            const [activeSessions] = await this.db.execute(`
                SELECT COUNT(*) as count 
                FROM chat_sessions 
                WHERE agent_id = ? AND status = 'active'
            `, [agent.id]);
            
            if (activeSessions[0].count >= agent.max_concurrent_chats) {
                await this.smsService.sendMessage(
                    agentPhone,
                    'אתה כבר מנהל את מספר השיחות המקסימלי.',
                    'system'
                );
                return;
            }
            
            // Find pending connection request
            const pendingRequest = this.findPendingConnectionForAgent(agentPhone);
            if (!pendingRequest) {
                await this.smsService.sendMessage(
                    agentPhone,
                    'אין בקשות חיבור ממתינות.',
                    'system'
                );
                return;
            }
            
            // Create chat session
            const sessionKey = this.generateSessionKey();
            const [result] = await this.db.execute(`
                INSERT INTO chat_sessions (contact_id, agent_id, session_key, status)
                VALUES (?, ?, ?, 'active')
            `, [pendingRequest.contactId, agent.id, sessionKey]);
            
            const sessionId = result.insertId;
            
            // Store active session
            this.activeSessions.set(sessionKey, {
                sessionId,
                contactId: pendingRequest.contactId,
                agentId: agent.id,
                userPhone: pendingRequest.userPhone,
                agentPhone: agentPhone,
                startTime: new Date()
            });
            
            // Remove pending request
            this.pendingConnections.delete(pendingRequest.userPhone);
            
            // Start session timeout
            this.startSessionTimeout(sessionKey);
            
            // Notify both parties
            await this.smsService.sendMessage(
                agentPhone,
                `שיחה התחילה עם ${pendingRequest.userPhone}. שלח "END" לסיים את השיחה.`,
                'system'
            );
            
            await this.smsService.sendMessage(
                pendingRequest.userPhone,
                'התחברת לסוכן. כעת אתה יכול לשלוח הודעות ישירות.',
                'system'
            );
            
            console.log(`Chat session created: ${sessionKey} between ${pendingRequest.userPhone} and ${agentPhone}`);
            
        } catch (error) {
            console.error('Error handling ACCEPT command:', error);
            await this.smsService.sendMessage(
                agentPhone,
                'שגיאה ביצירת חיבור. אנא נסה שוב.',
                'system'
            );
        }
    }

    // Handle agent ending a chat session
    async handleEndCommand(agentPhone) {
        try {
            const activeSession = await this.getActiveSessionByAgent(agentPhone);
            if (!activeSession) {
                await this.smsService.sendMessage(
                    agentPhone,
                    'אין לך שיחה פעילה כרגע.',
                    'system'
                );
                return;
            }
            
            await this.endChatSession(activeSession.sessionKey, 'ended_by_agent');
            
        } catch (error) {
            console.error('Error handling END command:', error);
        }
    }

    // Forward message from agent to user
    async forwardAgentMessage(session, message) {
        try {
            // Add agent prefix
            const formattedMessage = `סוכן: ${message}`;
            
            await this.smsService.sendMessage(
                session.userPhone,
                formattedMessage,
                'chat',
                { chat_session_id: session.sessionId }
            );
            
            // Log message
            await this.db.execute(`
                INSERT INTO messages (direction, from_phone, to_phone, message_content, message_type, chat_session_id, contact_id)
                VALUES ('outbound', ?, ?, ?, 'chat', ?, ?)
            `, [session.agentPhone, session.userPhone, formattedMessage, session.sessionId, session.contactId]);
            
            // Reset session timeout
            this.resetSessionTimeout(session.sessionKey);
            
        } catch (error) {
            console.error('Error forwarding agent message:', error);
        }
    }

    // Forward message from user to agent
    async forwardUserMessage(userPhone, message, contact) {
        try {
            const activeSession = await this.getActiveSessionByUser(userPhone);
            if (!activeSession) {
                return false; // No active session
            }
            
            // Add user prefix with name if available
            const userName = contact ? contact.name : userPhone;
            const formattedMessage = `${userName}: ${message}`;
            
            await this.smsService.sendMessage(
                activeSession.agentPhone,
                formattedMessage,
                'chat',
                { chat_session_id: activeSession.sessionId }
            );
            
            // Log message
            await this.db.execute(`
                INSERT INTO messages (direction, from_phone, to_phone, message_content, message_type, chat_session_id, contact_id)
                VALUES ('inbound', ?, ?, ?, 'chat', ?, ?)
            `, [userPhone, activeSession.agentPhone, message, activeSession.sessionId, activeSession.contactId]);
            
            // Reset session timeout
            this.resetSessionTimeout(activeSession.sessionKey);
            
            return true; // Message was forwarded
            
        } catch (error) {
            console.error('Error forwarding user message:', error);
            return false;
        }
    }

    // Request agent connection
    async requestAgentConnection(userPhone, initialMessage, contact) {
        try {
            // Check if user already has an active session
            const existingSession = await this.getActiveSessionByUser(userPhone);
            if (existingSession) {
                await this.smsService.sendMessage(
                    userPhone,
                    'יש לך כבר שיחה פעילה עם סוכן.',
                    'system'
                );
                return;
            }
            
            // Check if there's already a pending request
            if (this.pendingConnections.has(userPhone)) {
                await this.smsService.sendMessage(
                    userPhone,
                    'בקשת החיבור שלך כבר נשלחה. אנא המתן.',
                    'system'
                );
                return;
            }
            
            // Find available agents
            const availableAgents = await this.getAvailableAgents();
            if (availableAgents.length === 0) {
                await this.smsService.sendMessage(
                    userPhone,
                    'כל הסוכנים עסוקים כרגע. אנא נסה שוב מאוחר יותר.',
                    'system'
                );
                return;
            }
            
            // Store pending connection
            this.pendingConnections.set(userPhone, {
                userPhone,
                contactId: contact?.id,
                initialMessage,
                requestTime: new Date(),
                notifiedAgents: []
            });
            
            // Send connection request to available agents
            const userName = contact ? contact.name : userPhone;
            const connectionMessage = `🔔 בקשת חיבור חדשה מ: ${userName} (${userPhone})\n\nהודעה ראשונה: ${initialMessage}\n\nשלח "ACCEPT" כדי לקבל את השיחה.`;
            
            for (const agent of availableAgents) {
                await this.smsService.sendMessage(
                    agent.phone,
                    connectionMessage,
                    'agent_request'
                );
                
                this.pendingConnections.get(userPhone).notifiedAgents.push(agent.id);
            }
            
            // Notify user
            await this.smsService.sendMessage(
                userPhone,
                'בקשת החיבור נשלחה לסוכנים. אנא המתן לחיבור.',
                'system'
            );
            
            // Set timeout for pending request (5 minutes)
            setTimeout(() => {
                this.handleConnectionTimeout(userPhone);
            }, 5 * 60 * 1000);
            
        } catch (error) {
            console.error('Error requesting agent connection:', error);
        }
    }

    async getAvailableAgents() {
        const [agents] = await this.db.execute(`
            SELECT a.*, COUNT(cs.id) as active_chats
            FROM agents a
            LEFT JOIN chat_sessions cs ON a.id = cs.agent_id AND cs.status = 'active'
            WHERE a.is_active = TRUE AND a.is_available = TRUE
            GROUP BY a.id
            HAVING active_chats < a.max_concurrent_chats
            ORDER BY active_chats ASC, RAND()
        `);
        
        return agents;
    }

    async getActiveSessionByUser(userPhone) {
        for (const [sessionKey, session] of this.activeSessions) {
            if (session.userPhone === userPhone) {
                return { sessionKey, ...session };
            }
        }
        return null;
    }

    async getActiveSessionByAgent(agentPhone) {
        for (const [sessionKey, session] of this.activeSessions) {
            if (session.agentPhone === agentPhone) {
                return { sessionKey, ...session };
            }
        }
        return null;
    }

    findPendingConnectionForAgent(agentPhone) {
        // Find the oldest pending request that this agent can handle
        let oldestRequest = null;
        let oldestTime = null;
        
        for (const [userPhone, request] of this.pendingConnections) {
            if (!oldestTime || request.requestTime < oldestTime) {
                oldestTime = request.requestTime;
                oldestRequest = request;
            }
        }
        
        return oldestRequest;
    }

    async endChatSession(sessionKey, reason = 'ended') {
        const session = this.activeSessions.get(sessionKey);
        if (!session) return;
        
        try {
            // Update database
            await this.db.execute(`
                UPDATE chat_sessions 
                SET status = ?, ended_at = NOW()
                WHERE id = ?
            `, [reason, session.sessionId]);
            
            // Notify both parties
            await this.smsService.sendMessage(
                session.userPhone,
                'השיחה עם הסוכן הסתיימה. תודה!',
                'system'
            );
            
            await this.smsService.sendMessage(
                session.agentPhone,
                `השיחה עם ${session.userPhone} הסתיימה.`,
                'system'
            );
            
            // Clean up
            this.activeSessions.delete(sessionKey);
            this.clearSessionTimeout(sessionKey);
            
            console.log(`Chat session ended: ${sessionKey} (${reason})`);
            
        } catch (error) {
            console.error('Error ending chat session:', error);
        }
    }

    handleConnectionTimeout(userPhone) {
        const pendingRequest = this.pendingConnections.get(userPhone);
        if (!pendingRequest) return;
        
        this.pendingConnections.delete(userPhone);
        
        this.smsService.sendMessage(
            userPhone,
            'בקשת החיבור פגה. כל הסוכנים עסוקים. אנא נסה שוב מאוחר יותר.',
            'system'
        );
    }

    generateSessionKey() {
        return crypto.randomBytes(16).toString('hex');
    }

    startSessionTimeout(sessionKey) {
        const timeout = setTimeout(() => {
            this.endChatSession(sessionKey, 'timeout');
        }, 30 * 60 * 1000); // 30 minutes
        
        this.sessionTimeouts.set(sessionKey, timeout);
    }

    resetSessionTimeout(sessionKey) {
        this.clearSessionTimeout(sessionKey);
        this.startSessionTimeout(sessionKey);
    }

    clearSessionTimeout(sessionKey) {
        const timeout = this.sessionTimeouts.get(sessionKey);
        if (timeout) {
            clearTimeout(timeout);
            this.sessionTimeouts.delete(sessionKey);
        }
    }

    startSessionCleanup() {
        // Clean up old sessions every hour
        setInterval(async () => {
            await this.cleanupOldSessions();
        }, 60 * 60 * 1000);
    }

    async cleanupOldSessions() {
        try {
            // End sessions that have been inactive for too long
            const [oldSessions] = await this.db.execute(`
                SELECT cs.*, MAX(m.created_at) as last_activity
                FROM chat_sessions cs
                LEFT JOIN messages m ON cs.id = m.chat_session_id
                WHERE cs.status = 'active'
                GROUP BY cs.id
                HAVING last_activity < DATE_SUB(NOW(), INTERVAL 1 HOUR) OR last_activity IS NULL
            `);
            
            for (const session of oldSessions) {
                await this.endChatSession(session.session_key, 'abandoned');
            }
            
            // Clean up old pending connections
            const now = new Date();
            for (const [userPhone, request] of this.pendingConnections) {
                if (now - request.requestTime > 10 * 60 * 1000) { // 10 minutes
                    this.handleConnectionTimeout(userPhone);
                }
            }
            
        } catch (error) {
            console.error('Error cleaning up sessions:', error);
        }
    }

    // Agent management methods
    async addAgent(name, phone, triggerWords = [], maxChats = 3) {
        try {
            const [result] = await this.db.execute(`
                INSERT INTO agents (name, phone, trigger_words, max_concurrent_chats)
                VALUES (?, ?, ?, ?)
            `, [name, phone, JSON.stringify(triggerWords), maxChats]);
            
            return result.insertId;
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                throw new Error('Agent with this phone number already exists');
            }
            throw error;
        }
    }

    async updateAgentAvailability(agentId, isAvailable) {
        await this.db.execute(
            'UPDATE agents SET is_available = ? WHERE id = ?',
            [isAvailable, agentId]
        );
        
        // If agent goes offline, end their active sessions
        if (!isAvailable) {
            const [activeSessions] = await this.db.execute(`
                SELECT session_key FROM chat_sessions WHERE agent_id = ? AND status = 'active'
            `, [agentId]);
            
            for (const session of activeSessions) {
                await this.endChatSession(session.session_key, 'agent_offline');
            }
        }
    }

    async getAgentStats(agentId) {
        const [stats] = await this.db.execute(`
            SELECT 
                COUNT(*) as total_sessions,
                COUNT(CASE WHEN status = 'active' THEN 1 END) as active_sessions,
                COUNT(CASE WHEN status = 'ended' THEN 1 END) as completed_sessions,
                AVG(TIMESTAMPDIFF(MINUTE, started_at, ended_at)) as avg_session_duration
            FROM chat_sessions 
            WHERE agent_id = ?
        `, [agentId]);
        
        return stats[0];
    }

    // Get system-wide chat statistics
    async getSystemChatStats() {
        const [stats] = await this.db.execute(`
            SELECT 
                COUNT(*) as total_sessions,
                COUNT(CASE WHEN status = 'active' THEN 1 END) as active_sessions,
                COUNT(CASE WHEN DATE(started_at) = CURDATE() THEN 1 END) as sessions_today,
                AVG(TIMESTAMPDIFF(MINUTE, started_at, ended_at)) as avg_duration
            FROM chat_sessions
        `);
        
        const [agentStats] = await this.db.execute(`
            SELECT 
                COUNT(*) as total_agents,
                COUNT(CASE WHEN is_available = TRUE THEN 1 END) as available_agents,
                COUNT(CASE WHEN is_active = TRUE THEN 1 END) as active_agents
            FROM agents
        `);
        
        return {
            sessions: stats[0],
            agents: agentStats[0],
            pending_connections: this.pendingConnections.size,
            active_sessions: this.activeSessions.size
        };
    }
}

module.exports = AgentSystem;
