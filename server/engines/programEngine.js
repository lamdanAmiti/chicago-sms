// server/engines/programEngine.js - Automated Message Program Engine
const EventEmitter = require('events');

class ProgramEngine extends EventEmitter {
    constructor(db, smsService) {
        super();
        this.db = db;
        this.smsService = smsService;
        this.activePrograms = new Map();
        this.executionInterval = null;
        this.isRunning = false;
        
        this.startEngine();
    }

    startEngine() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        console.log('Program Engine started');
        
        // Execute programs every 10 seconds
        this.executionInterval = setInterval(() => {
            this.executeScheduledPrograms();
        }, 10000);
        
        // Load active programs on startup
        this.loadActivePrograms();
    }

    stopEngine() {
        if (!this.isRunning) return;
        
        this.isRunning = false;
        if (this.executionInterval) {
            clearInterval(this.executionInterval);
        }
        console.log('Program Engine stopped');
    }

    async loadActivePrograms() {
        try {
            const [programs] = await this.db.execute(`
                SELECT p.*, COUNT(ps.id) as active_states
                FROM programs p
                LEFT JOIN program_states ps ON p.id = ps.program_id AND ps.is_paused = FALSE
                WHERE p.is_active = TRUE
                GROUP BY p.id
            `);
            
            console.log(`Loaded ${programs.length} active programs`);
            
            for (const program of programs) {
                this.activePrograms.set(program.id, {
                    ...program,
                    program_data: JSON.parse(program.program_data)
                });
            }
        } catch (error) {
            console.error('Error loading active programs:', error);
        }
    }

    async processMessage(fromPhone, message, contact) {
        try {
            // Process through base program first (always-running system)
            await this.processBaseProgram(fromPhone, message, contact);
            
            // Process through user-specific programs
            if (contact) {
                await this.processContactPrograms(contact.id, fromPhone, message);
            }
            
            // Check for agent triggers
            await this.checkAgentTriggers(fromPhone, message, contact);
            
        } catch (error) {
            console.error('Error processing message through programs:', error);
        }
    }

    async processBaseProgram(fromPhone, message, contact) {
        const [basePrograms] = await this.db.execute(`
            SELECT * FROM programs WHERE is_base_program = TRUE AND is_active = TRUE
        `);
        
        for (const program of basePrograms) {
            const programData = JSON.parse(program.program_data);
            await this.executeProgram(program.id, contact?.id, fromPhone, message, programData);
        }
    }

    async processContactPrograms(contactId, fromPhone, message) {
        const [activeStates] = await this.db.execute(`
            SELECT ps.*, p.program_data 
            FROM program_states ps
            JOIN programs p ON ps.program_id = p.id
            WHERE ps.contact_id = ? AND ps.is_paused = FALSE AND p.is_active = TRUE
        `, [contactId]);
        
        for (const state of activeStates) {
            const programData = JSON.parse(state.program_data);
            await this.processUserResponse(state, fromPhone, message, programData);
        }
    }

    async executeProgram(programId, contactId, phone, userMessage, programData) {
        try {
            // Get or create program state
            let programState = await this.getProgramState(programId, contactId);
            
            if (!programState) {
                programState = await this.createProgramState(programId, contactId);
            }
            
            const currentStep = programData.steps[programState.current_step] || programData.steps[0];
            
            if (!currentStep) {
                console.log(`No current step found for program ${programId}`);
                return;
            }
            
            await this.executeStep(programState, currentStep, phone, userMessage, programData);
            
        } catch (error) {
            console.error(`Error executing program ${programId}:`, error);
        }
    }

    async executeStep(programState, step, phone, userMessage, programData) {
        switch (step.type) {
            case 'message':
                await this.executeMessageStep(programState, step, phone);
                break;
                
            case 'delay':
                await this.executeDelayStep(programState, step);
                break;
                
            case 'condition':
                await this.executeConditionStep(programState, step, userMessage, programData);
                break;
                
            case 'input':
                await this.executeInputStep(programState, step, userMessage);
                break;
                
            case 'agent_connect':
                await this.executeAgentConnectStep(programState, step, phone);
                break;
                
            default:
                console.log(`Unknown step type: ${step.type}`);
        }
    }

    async executeMessageStep(programState, step, phone) {
        try {
            // Replace variables in message content
            const messageContent = this.replaceVariables(step.content, programState.step_data || {});
            
            // Send message
            await this.smsService.sendMessage(phone, messageContent, 'program', {
                program_id: programState.program_id,
                step_id: step.id
            });
            
            // Move to next step
            await this.advanceToNextStep(programState, step);
            
        } catch (error) {
            console.error('Error executing message step:', error);
        }
    }

    async executeDelayStep(programState, step) {
        const delayMs = step.delay * 1000; // Convert seconds to milliseconds
        const nextActionTime = new Date(Date.now() + delayMs);
        
        await this.db.execute(`
            UPDATE program_states 
            SET next_action_at = ?, step_data = ?
            WHERE id = ?
        `, [nextActionTime, JSON.stringify({ waiting_for_delay: true }), programState.id]);
    }

    async executeConditionStep(programState, step, userMessage, programData) {
        const conditions = step.conditions || [];
        let matchedCondition = null;
        
        for (const condition of conditions) {
            if (this.evaluateCondition(condition, userMessage, programState.step_data)) {
                matchedCondition = condition;
                break;
            }
        }
        
        if (matchedCondition) {
            // Jump to specified step
            await this.jumpToStep(programState, matchedCondition.next_step_id);
        } else if (step.default_next_step_id) {
            // Jump to default step
            await this.jumpToStep(programState, step.default_next_step_id);
        } else {
            // Continue to next step
            await this.advanceToNextStep(programState, step);
        }
    }

    async executeInputStep(programState, step, userMessage) {
        if (!userMessage) return; // Waiting for user input
        
        // Validate input if validators are specified
        if (step.validators) {
            const isValid = this.validateInput(userMessage, step.validators);
            if (!isValid) {
                // Send error message and stay on current step
                if (step.error_message) {
                    await this.smsService.sendMessage(
                        phone, 
                        step.error_message, 
                        'program'
                    );
                }
                return;
            }
        }
        
        // Store input data
        const stepData = { ...programState.step_data };
        stepData[step.variable_name || 'user_input'] = userMessage;
        
        await this.db.execute(`
            UPDATE program_states 
            SET step_data = ?
            WHERE id = ?
        `, [JSON.stringify(stepData), programState.id]);
        
        // Move to next step
        await this.advanceToNextStep(programState, step);
    }

    async executeAgentConnectStep(programState, step, phone) {
        try {
            // Trigger agent connection
            await this.requestAgentConnection(phone, step.message || 'User requesting agent assistance');
            
            // Pause program execution
            await this.db.execute(`
                UPDATE program_states 
                SET is_paused = TRUE, step_data = ?
                WHERE id = ?
            `, [JSON.stringify({ waiting_for_agent: true }), programState.id]);
            
        } catch (error) {
            console.error('Error executing agent connect step:', error);
        }
    }

    evaluateCondition(condition, userMessage, stepData) {
        switch (condition.type) {
            case 'equals':
                return userMessage.toLowerCase().trim() === condition.value.toLowerCase();
                
            case 'contains':
                return userMessage.toLowerCase().includes(condition.value.toLowerCase());
                
            case 'starts_with':
                return userMessage.toLowerCase().startsWith(condition.value.toLowerCase());
                
            case 'regex':
                const regex = new RegExp(condition.value, 'i');
                return regex.test(userMessage);
                
            case 'number_range':
                const num = parseFloat(userMessage);
                return !isNaN(num) && num >= condition.min && num <= condition.max;
                
            default:
                return false;
        }
    }

    validateInput(input, validators) {
        for (const validator of validators) {
            switch (validator.type) {
                case 'required':
                    if (!input || input.trim().length === 0) return false;
                    break;
                    
                case 'min_length':
                    if (input.length < validator.value) return false;
                    break;
                    
                case 'max_length':
                    if (input.length > validator.value) return false;
                    break;
                    
                case 'numeric':
                    if (isNaN(parseFloat(input))) return false;
                    break;
                    
                case 'email':
                    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    if (!emailRegex.test(input)) return false;
                    break;
                    
                case 'phone':
                    const phoneRegex = /^\+?[\d\s\-\(\)]+$/;
                    if (!phoneRegex.test(input)) return false;
                    break;
            }
        }
        return true;
    }

    replaceVariables(content, stepData) {
        let result = content;
        
        // Replace step data variables
        for (const [key, value] of Object.entries(stepData)) {
            result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
        }
        
        // Replace system variables
        result = result.replace(/{{current_time}}/g, new Date().toLocaleTimeString());
        result = result.replace(/{{current_date}}/g, new Date().toLocaleDateString());
        result = result.replace(/{{system_name}}/g, 'SMS System');
        
        return result;
    }

    async advanceToNextStep(programState, currentStep) {
        const nextStepIndex = programState.current_step + 1;
        
        await this.db.execute(`
            UPDATE program_states 
            SET current_step = ?, next_action_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [nextStepIndex, programState.id]);
    }

    async jumpToStep(programState, stepId) {
        await this.db.execute(`
            UPDATE program_states 
            SET current_step = ?, next_action_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [stepId, programState.id]);
    }

    async getProgramState(programId, contactId) {
        if (!contactId) return null;
        
        const [rows] = await this.db.execute(`
            SELECT * FROM program_states 
            WHERE program_id = ? AND contact_id = ?
        `, [programId, contactId]);
        
        if (rows.length > 0) {
            const state = rows[0];
            state.step_data = state.step_data ? JSON.parse(state.step_data) : {};
            return state;
        }
        
        return null;
    }

    async createProgramState(programId, contactId) {
        if (!contactId) return null;
        
        const [result] = await this.db.execute(`
            INSERT INTO program_states (program_id, contact_id, current_step, step_data)
            VALUES (?, ?, 0, '{}')
        `, [programId, contactId]);
        
        return {
            id: result.insertId,
            program_id: programId,
            contact_id: contactId,
            current_step: 0,
            step_data: {}
        };
    }

    async executeScheduledPrograms() {
        try {
            // Find program states that need to be executed
            const [pendingStates] = await this.db.execute(`
                SELECT ps.*, p.program_data, c.phone
                FROM program_states ps
                JOIN programs p ON ps.program_id = p.id
                JOIN contacts c ON ps.contact_id = c.id
                WHERE ps.next_action_at IS NOT NULL 
                AND ps.next_action_at <= NOW()
                AND ps.is_paused = FALSE
                AND p.is_active = TRUE
            `);
            
            for (const state of pendingStates) {
                const programData = JSON.parse(state.program_data);
                const currentStep = programData.steps[state.current_step];
                
                if (currentStep) {
                    await this.executeStep(state, currentStep, state.phone, null, programData);
                }
            }
            
        } catch (error) {
            console.error('Error executing scheduled programs:', error);
        }
    }

    async checkAgentTriggers(fromPhone, message, contact) {
        const [agents] = await this.db.execute(`
            SELECT * FROM agents 
            WHERE is_active = TRUE AND is_available = TRUE
        `);
        
        for (const agent of agents) {
            const triggerWords = agent.trigger_words ? JSON.parse(agent.trigger_words) : [];
            
            for (const trigger of triggerWords) {
                if (message.toLowerCase().includes(trigger.toLowerCase())) {
                    await this.requestAgentConnection(fromPhone, message);
                    return;
                }
            }
        }
        
        // Check for universal agent triggers
        const universalTriggers = ['help', 'agent', 'support', 'שליח'];
        for (const trigger of universalTriggers) {
            if (message.toLowerCase().includes(trigger)) {
                await this.requestAgentConnection(fromPhone, message);
                return;
            }
        }
    }

    async requestAgentConnection(userPhone, message) {
        try {
            // Find available agents
            const [availableAgents] = await this.db.execute(`
                SELECT a.*, COUNT(cs.id) as active_chats
                FROM agents a
                LEFT JOIN chat_sessions cs ON a.id = cs.agent_id AND cs.status = 'active'
                WHERE a.is_active = TRUE AND a.is_available = TRUE
                GROUP BY a.id
                HAVING active_chats < a.max_concurrent_chats
                ORDER BY active_chats ASC
            `);
            
            if (availableAgents.length === 0) {
                await this.smsService.sendMessage(
                    userPhone, 
                    'כל הסוכנים שלנו עסוקים כרגע. אנא נסה שוב מאוחר יותר או שלח הודעה והן יגיבו בהקדם.',
                    'system'
                );
                return;
            }
            
            // Send connection request to agents
            const connectionMessage = `חיבור שליח חדש מ: ${userPhone}\nהודעה: ${message}\nהשב "ACCEPT" כדי לקבל את החיבור.`;
            
            for (const agent of availableAgents) {
                await this.smsService.sendMessage(agent.phone, connectionMessage, 'agent_request');
            }
            
            // Notify user
            await this.smsService.sendMessage(
                userPhone,
                'מחבר אותך לשליח... אנא המתן.',
                'system'
            );
            
        } catch (error) {
            console.error('Error requesting agent connection:', error);
        }
    }

    async assignProgram(programId, contactIds = [], groupIds = []) {
        try {
            // Assign to specific contacts
            for (const contactId of contactIds) {
                await this.db.execute(`
                    INSERT INTO program_assignments (program_id, contact_id)
                    VALUES (?, ?)
                    ON DUPLICATE KEY UPDATE is_active = TRUE
                `, [programId, contactId]);
                
                // Create initial program state
                await this.createProgramState(programId, contactId);
            }
            
            // Assign to groups (will create states for all contacts in groups)
            for (const groupId of groupIds) {
                await this.db.execute(`
                    INSERT INTO program_assignments (program_id, group_id)
                    VALUES (?, ?)
                    ON DUPLICATE KEY UPDATE is_active = TRUE
                `, [programId, groupId]);
                
                // Get all contacts in group and create states
                const [groupContacts] = await this.db.execute(`
                    SELECT contact_id FROM contact_groups WHERE group_id = ?
                `, [groupId]);
                
                for (const contact of groupContacts) {
                    await this.createProgramState(programId, contact.contact_id);
                }
            }
            
            console.log(`Program ${programId} assigned to ${contactIds.length} contacts and ${groupIds.length} groups`);
            
        } catch (error) {
            console.error('Error assigning program:', error);
            throw error;
        }
    }

    async pauseProgram(programId, contactId = null) {
        let query = 'UPDATE program_states SET is_paused = TRUE WHERE program_id = ?';
        let params = [programId];
        
        if (contactId) {
            query += ' AND contact_id = ?';
            params.push(contactId);
        }
        
        await this.db.execute(query, params);
    }

    async resumeProgram(programId, contactId = null) {
        let query = 'UPDATE program_states SET is_paused = FALSE WHERE program_id = ?';
        let params = [programId];
        
        if (contactId) {
            query += ' AND contact_id = ?';
            params.push(contactId);
        }
        
        await this.db.execute(query, params);
    }

    async resetProgramState(programId, contactId) {
        await this.db.execute(`
            UPDATE program_states 
            SET current_step = 0, step_data = '{}', next_action_at = NULL, is_paused = FALSE
            WHERE program_id = ? AND contact_id = ?
        `, [programId, contactId]);
    }

    async getProgramStats(programId) {
        const [stats] = await this.db.execute(`
            SELECT 
                COUNT(*) as total_states,
                COUNT(CASE WHEN is_paused = FALSE THEN 1 END) as active_states,
                COUNT(CASE WHEN is_paused = TRUE THEN 1 END) as paused_states,
                AVG(current_step) as avg_step
            FROM program_states 
            WHERE program_id = ?
        `, [programId]);
        
        return stats[0];
    }
}

module.exports = ProgramEngine;
