import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Phone, Users, Settings, BarChart3, MessageSquare, AlertTriangle, CheckCircle } from 'lucide-react';

const AdminPanel = () => {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [config, setConfig] = useState({});
  const [contacts, setContacts] = useState([]);
  const [virtualMessages, setVirtualMessages] = useState([]);
  const [rateLimitStatus, setRateLimitStatus] = useState({});
  const [wsConnection, setWsConnection] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [virtualPhone, setVirtualPhone] = useState('+1234567890');
  const [currentContact, setCurrentContact] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const messagesEndRef = useRef(null);

  // NEW: keep the live socket in a ref so cleanup doesn't depend on state
  const wsRef = useRef(null);

  const handleWebSocketMessage = (data) => {
    switch (data.type) {
      case 'virtual_message':
      case 'virtual_message_sent':
        setVirtualMessages((prev) => [...prev, data.data]);
        break;
      case 'incoming_message':
        // Handle real incoming messages
        break;
      case 'rate_limit_update':
        setRateLimitStatus((prev) => ({ ...prev, [data.phone]: data.status }));
        break;
      default:
        // eslint-disable-next-line no-console
        console.log('Unhandled message type:', data.type);
    }
  };

  // NEW: memoize to satisfy ESLint + allow safe reconnection from onclose
  const connectWebSocket = useCallback(() => {
    // close any existing connection before opening a new one
    if (wsRef.current) {
      try { wsRef.current.close(); } catch (_) {}
    }

    const url = process.env.REACT_APP_WS_URL || 'ws://localhost:3001';
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      // eslint-disable-next-line no-console
      console.log('WebSocket connected');
      setIsConnected(true);
      ws.send(JSON.stringify({ type: 'register_admin' }));
      setWsConnection(ws); // keep if you still use this elsewhere
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      handleWebSocketMessage(data);
    };

    ws.onclose = () => {
      // eslint-disable-next-line no-console
      console.log('WebSocket disconnected');
      setIsConnected(false);
      // attempt reconnect
      setTimeout(() => connectWebSocket(), 3000);
    };

    ws.onerror = (error) => {
      // eslint-disable-next-line no-console
      console.error('WebSocket error:', error);
    };
  }, []);

  useEffect(() => {
    fetchConfig();
    fetchContacts();
    connectWebSocket();

    return () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try { wsRef.current.close(); } catch (_) {}
      }
    };
  }, [connectWebSocket]);

  useEffect(() => {
    scrollToBottom();
  }, [virtualMessages]);

  const fetchConfig = async () => {
    try {
      const response = await fetch('/api/config');
      const data = await response.json();
      setConfig(data);
      setVirtualPhone(data.virtual_phone_number || '+1234567890');
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to fetch config:', error);
    }
  };

  const fetchContacts = async () => {
    try {
      const response = await fetch('/api/contacts');
      const data = await response.json();
      setContacts(data);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to fetch contacts:', error);
    }
  };

  const fetchRateLimitStatus = async (phone) => {
    try {
      const response = await fetch(`/api/rate-limit/${phone}`);
      const data = await response.json();
      setRateLimitStatus((prev) => ({ ...prev, [phone]: data }));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to fetch rate limit status:', error);
    }
  };

  const sendVirtualMessage = async () => {
    if (!messageInput.trim() || !currentContact) return;

    try {
      const response = await fetch('/api/virtual/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_phone: virtualPhone,
          to_phone: currentContact,
          message_content: messageInput,
        }),
      });

      if (response.ok) {
        setMessageInput('');
        await fetchRateLimitStatus(currentContact);
      } else {
        const error = await response.json();
        alert(`Failed to send message: ${error.error}`);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to send virtual message:', error);
      alert('Failed to send message');
    }
  };

  const simulateIncomingMessage = async () => {
    if (!messageInput.trim() || !currentContact) return;

    try {
      await fetch('/api/virtual/receive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_phone: currentContact,
          to_phone: virtualPhone,
          message_content: messageInput,
        }),
      });

      setMessageInput('');
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to simulate incoming message:', error);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const RateLimitIndicator = ({ phone }) => {
    const status = rateLimitStatus[phone];
    if (!status) return null;

    const getStatusColor = (current, limit) => {
      const percentage = (current / limit) * 100;
      if (percentage >= 90) return 'text-red-500';
      if (percentage >= 70) return 'text-yellow-500';
      return 'text-green-500';
    };

    return (
      <div className="text-xs space-y-1">
        <div className={getStatusColor(status.current.minute, status.limits.perMinute)}>
          Minute: {status.current.minute}/{status.limits.perMinute}
        </div>
        <div className={getStatusColor(status.current.hour, status.limits.perHour)}>
          Hour: {status.current.hour}/{status.limits.perHour}
        </div>
        <div className={getStatusColor(status.current.day, status.limits.perDay)}>
          Day: {status.current.day}/{status.limits.perDay}
        </div>
      </div>
    );
  };

  const VirtualPhone = () => (
    <div className="bg-white rounded-lg shadow-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold flex items-center">
          <Phone className="mr-2" />
          Virtual Phone ({config.environment})
        </h2>
        <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Contact Selection */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Virtual Phone Number</label>
            <input
              type="text"
              value={virtualPhone}
              onChange={(e) => setVirtualPhone(e.target.value)}
              className="w-full px-3 py-2 border rounded-md"
              disabled
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Current Contact</label>
            <select
              value={currentContact}
              onChange={(e) => {
                setCurrentContact(e.target.value);
                if (e.target.value) fetchRateLimitStatus(e.target.value);
              }}
              className="w-full px-3 py-2 border rounded-md"
            >
              <option value="">Select contact...</option>
              {contacts.map(contact => (
                <option key={contact.id} value={contact.phone}>
                  {contact.name} ({contact.phone})
                </option>
              ))}
            </select>
          </div>

          {currentContact && (
            <div className="p-3 bg-gray-50 rounded-md">
              <h4 className="font-medium mb-2">Rate Limit Status</h4>
              <RateLimitIndicator phone={currentContact} />
            </div>
          )}
        </div>

        {/* Message Composition */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Message</label>
            <textarea
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              placeholder="Type your message..."
              className="w-full px-3 py-2 border rounded-md h-24 resize-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendVirtualMessage();
                }
              }}
            />
          </div>

          <div className="flex space-x-2">
            <button
              onClick={sendVirtualMessage}
              disabled={!currentContact || !messageInput.trim()}
              className="flex-1 bg-blue-500 text-white px-4 py-2 rounded-md hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
            >
              <Send className="w-4 h-4 mr-2" />
              Send Outbound
            </button>
            <button
              onClick={simulateIncomingMessage}
              disabled={!currentContact || !messageInput.trim()}
              className="flex-1 bg-green-500 text-white px-4 py-2 rounded-md hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Simulate Inbound
            </button>
          </div>
        </div>

        {/* Message History */}
        <div className="space-y-4">
          <h4 className="font-medium">Recent Messages</h4>
          <div className="border rounded-md h-64 overflow-y-auto p-3 space-y-2">
            {virtualMessages
              .filter(msg => 
                (msg.from_phone === currentContact && msg.to_phone === virtualPhone) ||
                (msg.from_phone === virtualPhone && msg.to_phone === currentContact)
              )
              .slice(-20)
              .map((msg, index) => (
                <div
                  key={index}
                  className={`p-2 rounded-md text-sm ${
                    msg.direction === 'outbound'
                      ? 'bg-blue-100 ml-4'
                      : 'bg-gray-100 mr-4'
                  }`}
                >
                  <div className="font-medium text-xs mb-1">
                    {msg.direction === 'outbound' ? 'You' : 'Contact'} •{' '}
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </div>
                  <div>{msg.message_content}</div>
                </div>
              ))}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>
    </div>
  );

  const Dashboard = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="flex items-center">
            <Users className="h-8 w-8 text-blue-500" />
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">Total Contacts</p>
              <p className="text-2xl font-semibold text-gray-900">{contacts.length}</p>
            </div>
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <div className="flex items-center">
            <MessageSquare className="h-8 w-8 text-green-500" />
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">Messages Today</p>
              <p className="text-2xl font-semibold text-gray-900">{virtualMessages.length}</p>
            </div>
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <div className="flex items-center">
            <BarChart3 className="h-8 w-8 text-purple-500" />
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">Active Programs</p>
              <p className="text-2xl font-semibold text-gray-900">0</p>
            </div>
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <div className="flex items-center">
            {isConnected ? (
              <CheckCircle className="h-8 w-8 text-green-500" />
            ) : (
              <AlertTriangle className="h-8 w-8 text-red-500" />
            )}
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">System Status</p>
              <p className="text-2xl font-semibold text-gray-900">
                {isConnected ? 'Online' : 'Offline'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {config.environment === 'development' && <VirtualPhone />}
    </div>
  );

  const ContactsTab = () => (
    <div className="bg-white rounded-lg shadow-lg p-6">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-semibold">Contacts Management</h2>
        <button className="bg-blue-500 text-white px-4 py-2 rounded-md hover:bg-blue-600">
          Add Contact
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Phone
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Groups
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Rate Limit
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {contacts.map((contact) => (
              <tr key={contact.id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                  {contact.name}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {contact.phone}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {contact.group_names || 'None'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  <RateLimitIndicator phone={contact.phone} />
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                  <button
                    onClick={() => {
                      setCurrentContact(contact.phone);
                      fetchRateLimitStatus(contact.phone);
                      setActiveTab('dashboard');
                    }}
                    className="text-blue-600 hover:text-blue-900 mr-3"
                  >
                    Message
                  </button>
                  <button className="text-gray-600 hover:text-gray-900">
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const SettingsTab = () => (
    <div className="bg-white rounded-lg shadow-lg p-6">
      <h2 className="text-xl font-semibold mb-6">System Settings</h2>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h3 className="text-lg font-medium mb-4">Environment</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Current Environment</label>
              <div className={`px-3 py-2 rounded-md ${
                config.environment === 'development' 
                  ? 'bg-yellow-100 text-yellow-800' 
                  : 'bg-green-100 text-green-800'
              }`}>
                {config.environment || 'development'}
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">Virtual Phone Number</label>
              <input
                type="text"
                value={config.virtual_phone_number || ''}
                className="w-full px-3 py-2 border rounded-md"
                disabled
              />
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-lg font-medium mb-4">Rate Limits</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Per Minute</label>
              <input
                type="number"
                value={config.rate_limit_per_phone_per_minute || 10}
                className="w-full px-3 py-2 border rounded-md"
                disabled
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">Per Hour</label>
              <input
                type="number"
                value={config.rate_limit_per_phone_per_hour || 100}
                className="w-full px-3 py-2 border rounded-md"
                disabled
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">Per Day</label>
              <input
                type="number"
                value={config.rate_limit_per_phone_per_day || 500}
                className="w-full px-3 py-2 border rounded-md"
                disabled
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const tabs = [
    { id: 'dashboard', name: 'Dashboard', icon: BarChart3 },
    { id: 'contacts', name: 'Contacts', icon: Users },
    { id: 'settings', name: 'Settings', icon: Settings }
  ];

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <h1 className="text-3xl font-bold text-gray-900">SMS AT Command System</h1>
            <div className="flex items-center space-x-4">
              <div className={`flex items-center space-x-2 px-3 py-1 rounded-md ${
                isConnected ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
              }`}>
                <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-sm">{isConnected ? 'Connected' : 'Disconnected'}</span>
              </div>
              <div className="px-3 py-1 bg-blue-100 text-blue-800 rounded-md text-sm">
                {config.environment || 'development'}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex space-x-8">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center px-3 py-4 text-sm font-medium border-b-2 ${
                    activeTab === tab.id
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <Icon className="w-4 h-4 mr-2" />
                  {tab.name}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          {activeTab === 'dashboard' && <Dashboard />}
          {activeTab === 'contacts' && <ContactsTab />}
          {activeTab === 'settings' && <SettingsTab />}
        </div>
      </main>
    </div>
  );
};

export default AdminPanel;
