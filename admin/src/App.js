// admin/src/App.js - Main Application Component
import React, { useState, useEffect } from 'react';
import AdminPanel from './components/AdminPanel';

// Configuration constants
const CONFIG = {
  serverUrl: process.env.REACT_APP_SERVER_URL || window.location.origin,
  wsUrl: process.env.REACT_APP_WS_URL || `ws://${window.location.hostname}:3001`,
  retryInterval: 3000,
  maxRetries: 10
};

// Global notification context
const NotificationContext = React.createContext();

export const useNotifications = () => {
  const context = React.useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return context;
};

// Notification Provider Component
function NotificationProvider({ children }) {
  const [notifications, setNotifications] = useState([]);

  const addNotification = (message, type = 'info', duration = 5000) => {
    const id = Date.now() + Math.random();
    const notification = { id, message, type, duration };
    
    setNotifications(prev => [...prev, notification]);
    
    if (duration > 0) {
      setTimeout(() => {
        removeNotification(id);
      }, duration);
    }
    
    return id;
  };

  const removeNotification = (id) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  const clearAll = () => {
    setNotifications([]);
  };

  return (
    <NotificationContext.Provider value={{ 
      notifications, 
      addNotification, 
      removeNotification, 
      clearAll 
    }}>
      {children}
      <NotificationContainer notifications={notifications} onRemove={removeNotification} />
    </NotificationContext.Provider>
  );
}

// Notification Container Component
function NotificationContainer({ notifications, onRemove }) {
  if (notifications.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2">
      {notifications.map(notification => (
        <NotificationItem 
          key={notification.id} 
          notification={notification} 
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

// Individual Notification Component
function NotificationItem({ notification, onRemove }) {
  const getNotificationClass = (type) => {
    const baseClass = "max-w-sm w-full bg-white shadow-lg rounded-lg pointer-events-auto overflow-hidden";
    switch (type) {
      case 'success':
        return `${baseClass} border-l-4 border-green-500`;
      case 'error':
        return `${baseClass} border-l-4 border-red-500`;
      case 'warning':
        return `${baseClass} border-l-4 border-yellow-500`;
      default:
        return `${baseClass} border-l-4 border-blue-500`;
    }
  };

  const getIcon = (type) => {
    switch (type) {
      case 'success':
        return (
          <svg className="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
        );
      case 'error':
        return (
          <svg className="w-5 h-5 text-red-500" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
        );
      case 'warning':
        return (
          <svg className="w-5 h-5 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        );
      default:
        return (
          <svg className="w-5 h-5 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
        );
    }
  };

  return (
    <div className={`${getNotificationClass(notification.type)} slide-in`}>
      <div className="p-4">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            {getIcon(notification.type)}
          </div>
          <div className="ml-3 w-0 flex-1">
            <p className="text-sm font-medium text-gray-900">
              {notification.message}
            </p>
          </div>
          <div className="ml-4 flex-shrink-0 flex">
            <button
              className="bg-white rounded-md inline-flex text-gray-400 hover:text-gray-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              onClick={() => onRemove(notification.id)}
            >
              <span className="sr-only">Close</span>
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Connection Status Component
function ConnectionStatus({ isConnected, connectionError }) {
  if (isConnected) return null;

  return (
    <div className="fixed top-0 left-0 right-0 bg-red-600 text-white text-center py-2 z-50">
      <div className="flex items-center justify-center space-x-2">
        <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span className="text-sm font-medium">
          {connectionError ? `Connection Error: ${connectionError}` : 'Connecting to server...'}
        </span>
      </div>
    </div>
  );
}

// Main App Component
function App() {
  const [isLoading, setIsLoading] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState({
    isConnected: false,
    error: null,
    retryCount: 0
  });

  // Server health check
  useEffect(() => {
    let retryCount = 0;
    
    const checkServerHealth = async () => {
      try {
        const response = await fetch(`${CONFIG.serverUrl}/health`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
          // Add timeout
          signal: AbortSignal.timeout(5000)
        });
        
        if (response.ok) {
          const data = await response.json();
          setConnectionStatus({
            isConnected: true,
            error: null,
            retryCount: 0
          });
          setIsLoading(false);
          console.log('✅ Server health check passed:', data);
        } else {
          throw new Error(`Server returned ${response.status}`);
        }
      } catch (error) {
        console.error('❌ Server health check failed:', error);
        
        retryCount++;
        setConnectionStatus({
          isConnected: false,
          error: error.message,
          retryCount
        });
        
        if (retryCount < CONFIG.maxRetries) {
          console.log(`🔄 Retrying connection in ${CONFIG.retryInterval/1000} seconds... (${retryCount}/${CONFIG.maxRetries})`);
          setTimeout(checkServerHealth, CONFIG.retryInterval);
        } else {
          setIsLoading(false);
          console.error('❌ Max retry attempts reached. Server appears to be offline.');
        }
      }
    };

    checkServerHealth();
  }, []);

  // Loading screen
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="loading-spinner"></div>
          <p className="text-gray-600 mt-4">
            {connectionStatus.retryCount > 0 
              ? `Connecting to server... (Attempt ${connectionStatus.retryCount}/${CONFIG.maxRetries})`
              : 'Loading SMS AT Command System...'
            }
          </p>
          {connectionStatus.error && (
            <p className="text-red-500 text-sm mt-2">
              {connectionStatus.error}
            </p>
          )}
        </div>
      </div>
    );
  }

  // Server offline screen
  if (!connectionStatus.isConnected) {
    return (
      <div className="min-h-screen bg-red-50 flex items-center justify-center">
        <div className="max-w-md mx-auto text-center p-8">
          <div className="mb-4">
            <svg className="mx-auto h-12 w-12 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          
          <h1 className="text-xl font-semibold text-red-800 mb-2">
            Server Unavailable
          </h1>
          
          <p className="text-red-600 mb-4">
            Unable to connect to the SMS AT Command System server.
          </p>
          
          <p className="text-red-500 text-sm mb-6">
            {connectionStatus.error}
          </p>
          
          <button
            onClick={() => window.location.reload()}
            className="bg-red-600 text-white px-6 py-2 rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
          >
            Retry Connection
          </button>
          
          <div className="mt-6 text-xs text-gray-500">
            <p>Server URL: {CONFIG.serverUrl}</p>
            <p>WebSocket URL: {CONFIG.wsUrl}</p>
          </div>
        </div>
      </div>
    );
  }

  // Main application
  return (
    <NotificationProvider>
      <div className="App">
        <ConnectionStatus 
          isConnected={connectionStatus.isConnected} 
          connectionError={connectionStatus.error}
        />
        <AdminPanel />
      </div>
    </NotificationProvider>
  );
}

export default App;
