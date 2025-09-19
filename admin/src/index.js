// admin/src/index.js - React Application Entry Point
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Create root element
const root = ReactDOM.createRoot(document.getElementById('root'));

// Error boundary for React errors
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({
      error: error,
      errorInfo: errorInfo
    });
    
    // Log to console for debugging
    console.error('React Error Boundary caught an error:', error, errorInfo);
    
    // In production, you might want to send this to an error reporting service
    if (process.env.NODE_ENV === 'production') {
      // Example: Send to error tracking service
      // trackError(error, errorInfo);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-red-50 flex items-center justify-center">
          <div className="max-w-md mx-auto text-center p-8">
            <div className="mb-4">
              <svg className="mx-auto h-12 w-12 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            
            <h1 className="text-xl font-semibold text-red-800 mb-2">
              Something went wrong
            </h1>
            
            <p className="text-red-600 mb-4">
              The application encountered an unexpected error.
            </p>
            
            <button
              onClick={() => window.location.reload()}
              className="bg-red-600 text-white px-4 py-2 rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
            >
              Reload Page
            </button>
            
            {process.env.NODE_ENV === 'development' && this.state.error && (
              <details className="mt-6 text-left">
                <summary className="cursor-pointer text-red-700 font-medium">
                  Error Details (Development Only)
                </summary>
                <div className="mt-2 p-4 bg-red-100 rounded border text-sm">
                  <h3 className="font-semibold text-red-800">Error:</h3>
                  <pre className="text-red-700 whitespace-pre-wrap">{this.state.error && this.state.error.toString()}</pre>
                  
                  <h3 className="font-semibold text-red-800 mt-4">Stack Trace:</h3>
                  <pre className="text-red-700 whitespace-pre-wrap">{this.state.errorInfo.componentStack}</pre>
                </div>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Service Worker registration for offline capabilities (optional)
function registerServiceWorker() {
  if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then((registration) => {
          console.log('Service Worker registered successfully:', registration.scope);
        })
        .catch((error) => {
          console.log('Service Worker registration failed:', error);
        });
    });
  }
}

// Development helpers
if (process.env.NODE_ENV === 'development') {
  // Enable React DevTools profiler
  if (typeof window !== 'undefined') {
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || {};
  }
  
  // Log app startup
  console.log('🚀 SMS AT Command System Admin Panel - Development Mode');
  console.log('📡 Server URL:', process.env.REACT_APP_SERVER_URL || 'http://localhost:3000');
  console.log('🔌 WebSocket URL:', process.env.REACT_APP_WS_URL || 'ws://localhost:3001');
}

// Connection status monitoring
function ConnectionMonitor() {
  React.useEffect(() => {
    function handleOnline() {
      console.log('🌐 Connection restored');
      // You could show a notification here
    }
    
    function handleOffline() {
      console.warn('📡 Connection lost');
      // You could show a notification here
    }
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);
  
  return null;
}

// Render the application
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <ConnectionMonitor />
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

// Register service worker
registerServiceWorker();

// Performance monitoring (development only)
if (process.env.NODE_ENV === 'development') {
  // Report web vitals
  import('web-vitals').then(({ getCLS, getFID, getFCP, getLCP, getTTFB }) => {
    getCLS(console.log);
    getFID(console.log);
    getFCP(console.log);
    getLCP(console.log);
    getTTFB(console.log);
  }).catch(() => {
    // web-vitals not available, continue without it
  });
}
