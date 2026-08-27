import React, { useState, useEffect, useRef } from 'react';

const TokenAlertsComponent = () => {
  const [connected, setConnected] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [error, setError] = useState(null);
  const socketRef = useRef(null);
  
  // Connect to WebSocket
  const connectWebSocket = () => {
    try {
      // Close existing connection if any
      if (socketRef.current && socketRef.current.readyState <= 1) {
        socketRef.current.close();
      }
      
      // Create new WebSocket connection
      const socket = new WebSocket('ws://localhost:3001');
      socketRef.current = socket;
      
      // Connection opened
      socket.onopen = () => {
        console.log('Connected to Solana Sniper Bot WebSocket');
        setConnected(true);
        setError(null);
        
        // Subscribe to token alerts
        socket.send(JSON.stringify({
          type: 'subscribe',
          topic: 'token-alerts'
        }));
      };
      
      // Listen for messages
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('Received WebSocket message:', data);
          
          if (data.type === 'token-alert') {
            // Add new alert to the beginning of the array
            setAlerts(prev => [data.data, ...prev].slice(0, 10)); // Keep last 10 alerts
          } else if (data.type === 'connection') {
            // Connection confirmation message
            console.log('Connection confirmed:', data.message);
          } else if (data.type === 'subscription') {
            // Subscription status message
            console.log('Subscription status:', data.status);
          }
        } catch (err) {
          console.error('Error parsing WebSocket message:', err);
        }
      };
      
      // Handle errors
      socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        setError('Connection error. Please try again.');
      };
      
      // Handle disconnection
      socket.onclose = () => {
        console.log('Disconnected from WebSocket server');
        setConnected(false);
      };
    } catch (err) {
      console.error('Error creating WebSocket connection:', err);
      setError('Failed to connect to WebSocket server. Please try again.');
      setConnected(false);
    }
  };
  
  // Disconnect from WebSocket
  const disconnectWebSocket = () => {
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
  };
  
  // Connect on component mount and disconnect on unmount
  useEffect(() => {
    connectWebSocket();
    
    return () => {
      disconnectWebSocket();
    };
  }, []);
  
  // Format timestamp to human-readable date
  const formatTimestamp = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };
  
  return (
    <div className="token-alerts-container">
      <div className="connection-status">
        <h2>Token Alerts</h2>
        <div className={`status-indicator ${connected ? 'connected' : 'disconnected'}`}>
          {connected ? 'Connected' : 'Disconnected'}
        </div>
        
        {error && <div className="error-message">{error}</div>}
        
        <div className="connection-controls">
          <button onClick={connectWebSocket} disabled={connected}>
            Connect
          </button>
          <button onClick={disconnectWebSocket} disabled={!connected}>
            Disconnect
          </button>
        </div>
      </div>
      
      <div className="alerts-list">
        {alerts.length === 0 ? (
          <div className="no-alerts">No token alerts received yet. Waiting for new tokens...</div>
        ) : (
          alerts.map((alert, index) => (
            <div key={`${alert.tokenAddress}-${index}`} className="alert-card">
              <div className="alert-header">
                <h3>{alert.tokenName} ({alert.tokenSymbol})</h3>
                <span className="timestamp">{formatTimestamp(alert.timestamp)}</span>
              </div>
              
              <div className="alert-details">
                <div className="info-row">
                  <span className="label">Address:</span>
                  <span className="value">{alert.tokenAddress}</span>
                </div>
                
                <div className="info-row">
                  <span className="label">Price:</span>
                  <span className="value">${typeof alert.price === 'number' ? alert.price.toFixed(8) : alert.price}</span>
                </div>
                
                <div className="info-row">
                  <span className="label">Market Cap:</span>
                  <span className="value">{alert.marketCap}</span>
                </div>
                
                <div className="info-row">
                  <span className="label">Liquidity:</span>
                  <span className="value">{alert.liquidityInSol?.toFixed(2) || '?'} SOL</span>
                </div>
                
                <div className="info-row">
                  <span className="label">Volume 24h:</span>
                  <span className="value">{alert.volume24h}</span>
                </div>
                
                <div className="info-row">
                  <span className="label">Rug Check:</span>
                  <span className={`value ${alert.rugCheckPassed ? 'passed' : 'failed'}`}>
                    {alert.rugCheckPassed ? 'Passed' : 'Failed'}
                  </span>
                </div>
                
                {alert.bundles && (
                  <div className="info-row">
                    <span className="label">Bundles:</span>
                    <span className="value">{alert.bundles}</span>
                  </div>
                )}
                
                {alert.percentage && (
                  <div className="info-row">
                    <span className="label">Percentage:</span>
                    <span className="value">{alert.percentage}</span>
                  </div>
                )}
                
                {alert.solSpent && (
                  <div className="info-row">
                    <span className="label">SOL Spent:</span>
                    <span className="value">{alert.solSpent}</span>
                  </div>
                )}
              </div>
              
              <div className="alert-actions">
                <a 
                  href={alert.buyLink} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="buy-button"
                >
                  Buy Token
                </a>
                
                {alert.transactionSignature && (
                  <a 
                    href={`https://solscan.io/tx/${alert.transactionSignature}`} 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    className="view-tx-button"
                  >
                    View Transaction
                  </a>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      
      <style jsx>{`
        .token-alerts-container {
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
          font-family: Arial, sans-serif;
        }
        
        .connection-status {
          display: flex;
          align-items: center;
          margin-bottom: 20px;
          flex-wrap: wrap;
        }
        
        .connection-status h2 {
          margin-right: 20px;
        }
        
        .status-indicator {
          padding: 5px 10px;
          border-radius: 4px;
          font-weight: bold;
        }
        
        .connected {
          background-color: #d4edda;
          color: #155724;
        }
        
        .disconnected {
          background-color: #f8d7da;
          color: #721c24;
        }
        
        .error-message {
          color: #721c24;
          background-color: #f8d7da;
          padding: 10px;
          border-radius: 4px;
          margin: 10px 0;
          width: 100%;
        }
        
        .connection-controls {
          margin-left: auto;
        }
        
        .connection-controls button {
          padding: 8px 16px;
          margin-left: 10px;
          border-radius: 4px;
          cursor: pointer;
          background-color: #007bff;
          color: white;
          border: none;
        }
        
        .connection-controls button:disabled {
          background-color: #6c757d;
          cursor: not-allowed;
        }
        
        .alerts-list {
          margin-top: 20px;
        }
        
        .no-alerts {
          padding: 20px;
          text-align: center;
          background-color: #f8f9fa;
          border-radius: 4px;
          color: #6c757d;
        }
        
        .alert-card {
          background-color: #f8f9fa;
          border-radius: 8px;
          padding: 16px;
          margin-bottom: 16px;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        
        .alert-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
          border-bottom: 1px solid #dee2e6;
          padding-bottom: 10px;
        }
        
        .alert-header h3 {
          margin: 0;
          color: #0366d6;
        }
        
        .timestamp {
          color: #6c757d;
          font-size: 0.8rem;
        }
        
        .alert-details {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 10px;
          margin-bottom: 16px;
        }
        
        .info-row {
          display: flex;
        }
        
        .label {
          font-weight: bold;
          min-width: 120px;
          color: #495057;
        }
        
        .value {
          word-break: break-all;
        }
        
        .value.passed {
          color: #28a745;
        }
        
        .value.failed {
          color: #dc3545;
        }
        
        .alert-actions {
          display: flex;
          gap: 10px;
        }
        
        .alert-actions a {
          display: inline-block;
          padding: 8px 16px;
          border-radius: 4px;
          text-decoration: none;
          text-align: center;
        }
        
        .buy-button {
          background-color: #28a745;
          color: white;
        }
        
        .view-tx-button {
          background-color: #6c757d;
          color: white;
        }
      `}</style>
    </div>
  );
};

export default TokenAlertsComponent; 