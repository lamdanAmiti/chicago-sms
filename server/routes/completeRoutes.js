// server/routes/completeRoutes.js - All Missing Route Implementations

class CompleteRoutes {
    constructor(db, smsService, rateLimitManager, programEngine, agentSystem, broadcastSystem, csvManager) {
        this.db = db;
        this.smsService = smsService;
        this.rateLimitManager = rateLimitManager;
        this.programEngine = programEngine;
        this.agentSystem = agentSystem;
        this.broadcastSystem = broadcastSystem;
        this.csvManager = csvManager;
    }

    setupSystemRoutes(app) {
        // System Configuration
        app.get('/api/config', async (req, res) => {
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
                res.json(config);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.put('/api/config/:key', async (req, res) => {
            try {
                const { key } = req.params;
                const { value } = req.body;
                
                await this.db.execute(
                    'UPDATE system_config SET config_value = ? WHERE config_key = ?',
                    [value.toString(), key]
                );
                
                if (key.startsWith('rate_limit_')) {
                    await this.rateLimitManager.loadConfig();
                }
                
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // System stats
        app.get('/api/stats', async (req, res) => {
            try {
                const [contactStats] = await this.db.execute(`
                    SELECT 
                        COUNT(*) as total_contacts,
                        COUNT(CASE WHEN is_active = TRUE THEN 1 END) as active_contacts
                    FROM contacts
                `);

                const [messageStats] = await this.db.execute(`
                    SELECT 
                        COUNT(*) as total_messages,
                        COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) as messages_today,
                        COUNT(CASE WHEN direction = 'inbound' THEN 1 END) as inbound_messages,
                        COUNT(CASE WHEN direction = 'outbound' THEN 1 END) as outbound_messages
                    FROM messages
                `);

                const chatStats = await this.agentSystem.getSystemChatStats();
                
                const [programStats] = await this.db.execute(`
                    SELECT 
                        COUNT(*) as total_programs,
                        COUNT(CASE WHEN is_active = TRUE THEN 1 END) as active_programs
                    FROM programs
                `);

                res.json({
                    contacts: contactStats[0],
                    messages: messageStats[0],
                    chats: chatStats,
                    programs: programStats[0]
                });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }

    setupContactRoutes(app) {
        // Get contacts with filtering and pagination
        app.get('/api/contacts', async (req, res) => {
            try {
                const { search, group_id, page = 1, limit = 50 } = req.query;
                let query = `
                    SELECT c.*, GROUP_CONCAT(g.name) as group_names
                    FROM contacts c
                    LEFT JOIN contact_groups cg ON c.id = cg.contact_id
                    LEFT JOIN groups g ON cg.group_id = g.id
                    WHERE c.is_active = TRUE
                `;
                const params = [];

                if (search) {
                    query += ' AND (c.name LIKE ? OR c.phone LIKE ?)';
                    params.push(`%${search}%`, `%${search}%`);
                }

                if (group_id) {
                    query += ' AND cg.group_id = ?';
                    params.push(group_id);
                }

                query += ' GROUP BY c.id ORDER BY c.name LIMIT ? OFFSET ?';
                params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

                const [rows] = await this.db.execute(query, params);
                res.json(rows);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Create contact
        app.post('/api/contacts', async (req, res) => {
            try {
                const { name, phone, email, notes, group_ids } = req.body;
                
                const [result] = await this.db.execute(
                    'INSERT INTO contacts (name, phone, email, notes) VALUES (?, ?, ?, ?)',
                    [name, phone, email, notes]
                );
                
                const contactId = result.insertId;
                
                if (group_ids && group_ids.length > 0) {
                    for (const groupId of group_ids) {
                        await this.db.execute(
                            'INSERT INTO contact_groups (contact_id, group_id) VALUES (?, ?)',
                            [contactId, groupId]
                        );
                    }
                }
                
                res.json({ id: contactId, success: true });
            } catch (error) {
                if (error.code === 'ER_DUP_ENTRY') {
                    res.status(400).json({ error: 'Phone number already exists' });
                } else {
                    res.status(500).json({ error: error.message });
                }
            }
        });

        // Update contact
        app.put('/api/contacts/:id', async (req, res) => {
            try {
                const { id } = req.params;
                const { name, phone, email, notes, group_ids } = req.body;
                
                await this.db.execute(
                    'UPDATE contacts SET name = ?, phone = ?, email = ?, notes = ? WHERE id = ?',
                    [name, phone, email, notes, id]
                );
                
                // Update groups
                await this.db.execute('DELETE FROM contact_groups WHERE contact_id = ?', [id]);
                
                if (group_ids && group_ids.length > 0) {
                    for (const groupId of group_ids) {
                        await this.db.execute(
                            'INSERT INTO contact_groups (contact_id, group_id) VALUES (?, ?)',
                            [id, groupId]
                        );
                    }
                }
                
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Delete contact
        app.delete('/api/contacts/:id', async (req, res) => {
            try {
                const { id } = req.params;
                await this.db.execute('UPDATE contacts SET is_active = FALSE WHERE id = ?', [id]);
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Send message to contact
        app.post('/api/contacts/:id/message', async (req, res) => {
            try {
                const { id } = req.params;
                const { message } = req.body;
                
                const [contacts] = await this.db.execute('SELECT phone FROM contacts WHERE id = ?', [id]);
                if (contacts.length === 0) {
                    return res.status(404).json({ error: 'Contact not found' });
                }
                
                const messageId = await this.smsService.sendMessage(contacts[0].phone, message);
                res.json({ messageId, success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }

    setupGroupRoutes(app) {
        // Get all groups
        app.get('/api/groups', async (req, res) => {
            try {
                const [rows] = await this.db.execute(`
                    SELECT g.*, COUNT(cg.contact_id) as contact_count
                    FROM groups g
                    LEFT JOIN contact_groups cg ON g.id = cg.group_id
                    GROUP BY g.id ORDER BY g.name
                `);
                res.json(rows);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Create group
        app.post('/api/groups', async (req, res) => {
            try {
                const { name, description } = req.body;
                const [result] = await this.db.execute(
                    'INSERT INTO groups (name, description) VALUES (?, ?)',
                    [name, description]
                );
                res.json({ id: result.insertId, success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Update group
        app.put('/api/groups/:id', async (req, res) => {
            try {
                const { id } = req.params;
                const { name, description } = req.body;
                
                await this.db.execute(
                    'UPDATE groups SET name = ?, description = ? WHERE id = ?',
                    [name, description, id]
                );
                
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Delete group
        app.delete('/api/groups/:id', async (req, res) => {
            try {
                const { id } = req.params;
                
                // Check if it's a default group
                const [groups] = await this.db.execute('SELECT is_default FROM groups WHERE id = ?', [id]);
                if (groups.length > 0 && groups[0].is_default) {
                    return res.status(400).json({ error: 'Cannot delete default group' });
                }
                
                await this.db.execute('DELETE FROM groups WHERE id = ?', [id]);
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Send message to group
        app.post('/api/groups/:id/message', async (req, res) => {
            try {
                const { id } = req.params;
                const { message } = req.body;
                
                const result = await this.broadcastSystem.createBroadcast(
                    `Group Message - ${new Date().toLocaleString()}`,
                    message,
                    [id],
                    [],
                    null,
                    'admin'
                );
                
                res.json(result);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }

    setupMessageRoutes(app) {
        // Get messages with filtering
        app.get('/api/messages', async (req, res) => {
            try {
                const { phone, contact_id, type, limit = 100, page = 1 } = req.query;
                
                let query = 'SELECT m.*, c.name as contact_name FROM messages m LEFT JOIN contacts c ON m.contact_id = c.id WHERE 1=1';
                const params = [];
                
                if (phone) {
                    query += ' AND (m.from_phone = ? OR m.to_phone = ?)';
                    params.push(phone, phone);
                }
                
                if (contact_id) {
                    query += ' AND m.contact_id = ?';
                    params.push(contact_id);
                }
                
                if (type) {
                    query += ' AND m.message_type = ?';
                    params.push(type);
                }
                
                query += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
                params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

                const [rows] = await this.db.execute(query, params);
                res.json(rows);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Virtual phone routes for development
        app.post('/api/virtual/send', async (req, res) => {
            if (process.env.NODE_ENV !== 'development') {
                return res.status(403).json({ error: 'Virtual phone only available in development' });
            }

            try {
                const { from_phone, to_phone, message_content } = req.body;
                
                const rateLimitCheck = await this.rateLimitManager.checkPhoneRateLimit(from_phone);
                if (!rateLimitCheck.allowed) {
                    return res.status(429).json({ 
                        error: 'Rate limit exceeded', 
                        details: rateLimitCheck 
                    });
                }

                await this.db.execute(`
                    INSERT INTO virtual_messages (direction, from_phone, to_phone, message_content, status)
                    VALUES ('outbound', ?, ?, ?, 'sent')
                `, [from_phone, to_phone, message_content]);

                await this.rateLimitManager.updateRateLimit(from_phone);

                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.post('/api/virtual/receive', async (req, res) => {
            if (process.env.NODE_ENV !== 'development') {
                return res.status(403).json({ error: 'Virtual phone only available in development' });
            }

            try {
                const { from_phone, to_phone, message_content } = req.body;
                
                await this.db.execute(`
                    INSERT INTO virtual_messages (direction, from_phone, to_phone, message_content, status)
                    VALUES ('inbound', ?, ?, ?, 'received')
                `, [from_phone, to_phone, message_content]);

                // This would be handled by the main server's processIncomingMessage method
                
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Rate limit status
        app.get('/api/rate-limit/:phone', async (req, res) => {
            try {
                const { phone } = req.params;
                const status = await this.rateLimitManager.getRateLimitStatus(phone);
                res.json(status);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }

    setupProgramRoutes(app) {
        // Get all programs
        app.get('/api/programs', async (req, res) => {
            try {
                const [rows] = await this.db.execute(`
                    SELECT p.*, COUNT(ps.id) as active_states
                    FROM programs p
                    LEFT JOIN program_states ps ON p.id = ps.program_id AND ps.is_paused = FALSE
                    GROUP BY p.id
                    ORDER BY p.name
                `);
                res.json(rows);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Create program
        app.post('/api/programs', async (req, res) => {
            try {
                const { name, description, program_data, is_base_program } = req.body;
                
                const [result] = await this.db.execute(`
                    INSERT INTO programs (name, description, program_data, is_base_program)
                    VALUES (?, ?, ?, ?)
                `, [name, description, JSON.stringify(program_data), is_base_program || false]);
                
                res.json({ id: result.insertId, success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Update program
        app.put('/api/programs/:id', async (req, res) => {
            try {
                const { id } = req.params;
                const { name, description, program_data, is_active } = req.body;
                
                await this.db.execute(`
                    UPDATE programs 
                    SET name = ?, description = ?, program_data = ?, is_active = ?
                    WHERE id = ?
                `, [name, description, JSON.stringify(program_data), is_active, id]);
                
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Assign program to contacts/groups
        app.post('/api/programs/:id/assign', async (req, res) => {
            try {
                const { id } = req.params;
                const { contact_ids = [], group_ids = [] } = req.body;
                
                await this.programEngine.assignProgram(parseInt(id), contact_ids, group_ids);
                
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Pause/Resume program
        app.post('/api/programs/:id/pause', async (req, res) => {
            try {
                const { id } = req.params;
                const { contact_id } = req.body;
                
                await this.programEngine.pauseProgram(parseInt(id), contact_id);
                
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        app.post('/api/programs/:id/resume', async (req, res) => {
            try {
                const { id } = req.params;
                const { contact_id } = req.body;
                
                await this.programEngine.resumeProgram(parseInt(id), contact_id);
                
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Get program statistics
        app.get('/api/programs/:id/stats', async (req, res) => {
            try {
                const { id } = req.params;
                const stats = await this.programEngine.getProgramStats(parseInt(id));
                res.json(stats);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }

    setupAgentRoutes(app) {
        // Get all agents
        app.get('/api/agents', async (req, res) => {
            try {
                const [rows] = await this.db.execute(`
                    SELECT a.*, COUNT(cs.id) as active_sessions
                    FROM agents a
                    LEFT JOIN chat_sessions cs ON a.id = cs.agent_id AND cs.status = 'active'
                    GROUP BY a.id
                    ORDER BY a.name
                `);
                res.json(rows);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Create agent
        app.post('/api/agents', async (req, res) => {
            try {
                const { name, phone, trigger_words, max_concurrent_chats } = req.body;
                
                const agentId = await this.agentSystem.addAgent(
                    name, 
                    phone, 
                    trigger_words || [],
                    max_concurrent_chats || 3
                );
                
                res.json({ id: agentId, success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Update agent availability
        app.put('/api/agents/:id/availability', async (req, res) => {
            try {
                const { id } = req.params;
                const { is_available } = req.body;
                
                await this.agentSystem.updateAgentAvailability(parseInt(id), is_available);
                
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Get agent statistics
        app.get('/api/agents/:id/stats', async (req, res) => {
            try {
                const { id } = req.params;
                const stats = await this.agentSystem.getAgentStats(parseInt(id));
                res.json(stats);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Get active chat sessions
        app.get('/api/chats', async (req, res) => {
            try {
                const [rows] = await this.db.execute(`
                    SELECT cs.*, c.name as contact_name, c.phone as contact_phone, 
                           a.name as agent_name, a.phone as agent_phone
                    FROM chat_sessions cs
                    JOIN contacts c ON cs.contact_id = c.id
                    JOIN agents a ON cs.agent_id = a.id
                    WHERE cs.status = 'active'
                    ORDER BY cs.started_at DESC
                `);
                res.json(rows);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // End chat session
        app.post('/api/chats/:sessionKey/end', async (req, res) => {
            try {
                const { sessionKey } = req.params;
                await this.agentSystem.endChatSession(sessionKey, 'ended_by_admin');
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }

    setupBroadcastRoutes(app) {
        // Get all broadcasts
        app.get('/api/broadcasts', async (req, res) => {
            try {
                const { status, page = 1, limit = 20 } = req.query;
                
                let query = 'SELECT * FROM broadcasts WHERE 1=1';
                const params = [];
                
                if (status) {
                    query += ' AND status = ?';
                    params.push(status);
                }
                
                query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
                params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
                
                const [rows] = await this.db.execute(query, params);
                res.json(rows);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Create broadcast
        app.post('/api/broadcasts', async (req, res) => {
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

        // Get broadcast details and stats
        app.get('/api/broadcasts/:id', async (req, res) => {
            try {
                const { id } = req.params;
                const stats = await this.broadcastSystem.getBroadcastStats(parseInt(id));
                
                if (!stats) {
                    return res.status(404).json({ error: 'Broadcast not found' });
                }
                
                res.json(stats);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Cancel broadcast
        app.delete('/api/broadcasts/:id', async (req, res) => {
            try {
                const { id } = req.params;
                const success = await this.broadcastSystem.cancelBroadcast(parseInt(id));
                res.json({ success });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Get broadcast recipients
        app.get('/api/broadcasts/:id/recipients', async (req, res) => {
            try {
                const { id } = req.params;
                const { status, page = 1, limit = 50 } = req.query;
                
                let query = `
                    SELECT br.*, c.name as contact_name, g.name as group_name
                    FROM broadcast_recipients br
                    LEFT JOIN contacts c ON br.contact_id = c.id
                    LEFT JOIN groups g ON br.group_id = g.id
                    WHERE br.broadcast_id = ?
                `;
                const params = [id];
                
                if (status) {
                    query += ' AND br.status = ?';
                    params.push(status);
                }
                
                query += ' ORDER BY br.id LIMIT ? OFFSET ?';
                params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
                
                const [rows] = await this.db.execute(query, params);
                res.json(rows);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }
}

module.exports = CompleteRoutes;
