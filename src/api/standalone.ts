/**
 * Standalone version of the API server
 * This version doesn't load or initialize Discord/Telegram bots
 */
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import swaggerJsdoc from 'swagger-jsdoc';
const swaggerUi = require('swagger-ui-express');
import { Server } from 'http';
import { WebSocketServer } from 'ws';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();
const app = express();

// API server configuration
const HOST = process.env.API_HOST || '0.0.0.0';
const PORT = parseInt(process.env.API_PORT || '3001');

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Solana Sniper Bot API',
      version: '1.0.0',
      description: 'API for Solana Sniper Bot',
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
        description: 'Development server',
      },
    ],
  },
  apis: ['./src/api/**/*.ts'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
// Using swagger-ui-express with require approach
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Create WebSocket server
let httpServer: Server;
let wss: WebSocketServer;

// Store active WebSocket connections
const activeConnections = new Map();

// Token alert data interface
export interface TokenAlertData {
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  price?: number;
  marketCap?: string | number;
  liquidityInSol?: number;
  volume24h?: string;
  rugCheckPassed: boolean;
  timestamp: number;
  transactionSignature?: string;
  buyLink?: string;
  isMigrationToken?: boolean;
  bundles?: string;
  percentage?: string;
  solSpent?: string;
}

/**
 * Initialize the standalone API server
 */
export function initStandaloneApiServer() {
  console.log('📡 Starting standalone API server initialization...');
  console.log(`📡 Server will listen on ${HOST}:${PORT} (standalone mode)`);
  
  try {
    // Start HTTP server with proper error handling
    httpServer = app.listen(PORT, HOST, () => {
      console.log(`🚀 API server running on http://${HOST}:${PORT}`);
      console.log(`📝 API Documentation available at http://${HOST}:${PORT}/api-docs`);
    }).on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ ERROR: Port ${PORT} is already in use! API server could not start.`);
        console.error(`   Try a different port by setting the API_PORT environment variable.`);
        console.error(`   Or find and stop the process using port ${PORT}:`);
        console.error(`   Linux/Mac: lsof -i :${PORT} | grep LISTEN`);
        console.error(`   Windows: netstat -ano | findstr :${PORT}`);
      } else {
        console.error(`❌ ERROR starting API server:`, err);
      }
      throw err; // Re-throw to be caught by the outer try-catch
    });

    // Initialize WebSocket server
    console.log('🔌 Initializing WebSocket server for API...');
    wss = new WebSocketServer({ server: httpServer });

    // WebSocket connection handling
    wss.on('connection', (ws) => {
      console.log('New WebSocket client connected');
      
      // Generate a unique client ID
      const clientId = Date.now().toString();
      activeConnections.set(clientId, {
        ws,
        subscriptions: {} // Initialize empty subscriptions
      });
      
      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connection',
        message: 'Connected to Solana Sniper Bot WebSocket server',
        clientId
      }));
      
      // Handle messages from clients
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message.toString());
          console.log('Received WebSocket message:', data);
          
          // Handle subscription requests
          if (data.type === 'subscribe' && data.topic) {
            handleSubscription(ws, clientId, data.topic);
          }
        } catch (error) {
          console.error('Error processing WebSocket message:', error);
        }
      });
      
      // Handle disconnection
      ws.on('close', () => {
        console.log(`WebSocket client ${clientId} disconnected`);
        activeConnections.delete(clientId);
      });
    });
    
    console.log('📡 Setting up API routes...');
    setupStandaloneRoutes();
    console.log('✅ API server initialization completed successfully');
  } catch (error) {
    console.error('❌ API server initialization failed:', error);
    throw error;
  }
}

/**
 * Handle WebSocket subscription requests
 */
function handleSubscription(ws: any, clientId: string, topic: string) {
  console.log(`Client ${clientId} subscribing to ${topic}`);
  
  // Get the client connection
  const connection = activeConnections.get(clientId);
  if (!connection) {
    console.error(`Client ${clientId} not found in active connections`);
    return;
  }
  
  switch (topic) {
    case 'token-alerts':
      // Update subscription info
      connection.subscriptions = {
        ...connection.subscriptions,
        tokenAlerts: true
      };
      
      activeConnections.set(clientId, connection);
      
      ws.send(JSON.stringify({
        type: 'subscription',
        status: 'success',
        topic: 'token-alerts',
        message: 'Subscribed to token alerts'
      }));
      
      console.log(`Client ${clientId} successfully subscribed to token alerts`);
      break;
      
    default:
      ws.send(JSON.stringify({
        type: 'subscription',
        status: 'error',
        message: `Unknown subscription topic: ${topic}`
      }));
      
      console.error(`Client ${clientId} attempted to subscribe to unknown topic: ${topic}`);
  }
}

/**
 * Broadcast token alert to all subscribed clients
 */
export function broadcastTokenAlert(data: TokenAlertData) {
  console.log(`📢 Broadcasting token alert for ${data.tokenSymbol} (${data.tokenAddress})`);
  
  const alertData = {
    ...data,
    timestamp: data.timestamp || Date.now(),
    buyLink: data.buyLink || `https://jup.ag/swap/SOL-${data.tokenAddress}`
  };
  
  let connectedClients = 0;
  let sentAlerts = 0;
  let failedAlerts = 0;
  
  activeConnections.forEach((connection: any, clientId: string) => {
    connectedClients++;
    
    // Check if client is subscribed to token alerts and the connection is open
    if (connection.subscriptions?.tokenAlerts && connection.ws && connection.ws.readyState === 1) {
      try {
        connection.ws.send(JSON.stringify({
          type: 'token-alert',
          data: alertData
        }));
        sentAlerts++;
        console.log(`Successfully sent token alert to client ${clientId}`);
      } catch (err) {
        failedAlerts++;
        console.error(`Error sending alert to client ${clientId}:`, err);
        
        // Try to clean up broken connections
        if (connection.ws.readyState > 1) { // CLOSING or CLOSED
          activeConnections.delete(clientId);
          console.log(`Removed disconnected client ${clientId}`);
        }
      }
    } else if (connection.ws) {
      console.log(`Client ${clientId} is connected but not subscribed to token alerts`);
    } else {
      // Client connection object exists but has no websocket
      activeConnections.delete(clientId);
      console.log(`Removed invalid client ${clientId}`);
    }
  });
  
  console.log(`📊 WebSocket Stats: ${sentAlerts}/${connectedClients} clients received the alert, ${failedAlerts} failed`);
  
  if (connectedClients === 0) {
    console.log('⚠️ No WebSocket clients are currently connected');
  }
  
  return sentAlerts > 0;
}

/**
 * Get the current price of SOL in USD
 */
async function getSolPrice(): Promise<number> {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeout: 5000 }
    );
    
    if (response.data && response.data.solana && response.data.solana.usd) {
      console.log(`Current SOL price: $${response.data.solana.usd}`);
      return response.data.solana.usd;
    }
    
    // Fallback to a reasonable default if API fails
    console.warn('Could not get SOL price from CoinGecko, using fallback price');
    return 170; // Default fallback price
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    return 170; // Default fallback price
  }
}

/**
 * Setup standalone API routes
 * This version has limited functionality but doesn't require bot components
 */
function setupStandaloneRoutes() {
  console.log('📡 Setting up API routes for standalone server (limited functionality)...');
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    console.log('Health check request received');
    res.status(200).json({ status: 'ok' });
  });
  
  // API Root endpoint
  app.get('/', (req, res) => {
    res.status(200).json({ 
      name: 'Solana Sniper Bot API (Standalone Mode)',
      version: '1.0.0',
      documentation: `/api-docs`,
      status: 'running',
      mode: 'standalone'
    });
  });
  
  // ----- Utility Endpoints -----
  
  /**
   * @swagger
   * /api/utils/sol-price:
   *   get:
   *     summary: Get current SOL price
   *     responses:
   *       200:
   *         description: SOL price retrieved successfully
   */
  app.get('/api/utils/sol-price', async (req, res) => {
    try {
      const solPrice = await getSolPrice();
      res.json({
        success: true,
        data: {
          price: solPrice
        }
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to get SOL price' 
      });
    }
  });
  
  // Status endpoints
  app.get('/api/status', (req, res) => {
    res.json({
      success: true,
      mode: 'standalone',
      isFullBot: false,
      message: 'Running in standalone mode with limited functionality. To access all features, run the bot with API_ENABLED=true yarn dev'
    });
  });
  
  // ----- For other endpoints, return "Not implemented in standalone mode" error -----
  
  // Example for token-related endpoints
  app.all('/api/pnl/*', (req, res) => {
    res.status(501).json({
      success: false,
      error: 'Not implemented in standalone mode',
      message: 'This endpoint requires the full bot. Run with: API_ENABLED=true yarn dev'
    });
  });
  
  // Example for wallet-related endpoints
  app.all('/api/wallet/*', (req, res) => {
    res.status(501).json({
      success: false,
      error: 'Not implemented in standalone mode',
      message: 'This endpoint requires the full bot. Run with: API_ENABLED=true yarn dev'
    });
  });
  
  // Example for transaction-related endpoints
  app.all('/api/transaction/*', (req, res) => {
    res.status(501).json({
      success: false,
      error: 'Not implemented in standalone mode',
      message: 'This endpoint requires the full bot. Run with: API_ENABLED=true yarn dev'
    });
  });
  
  // Catch-all for any other endpoints
  app.all('/api/*', (req, res) => {
    res.status(501).json({
      success: false,
      error: 'Not implemented in standalone mode',
      message: 'This endpoint requires the full bot. Run with: API_ENABLED=true yarn dev'
    });
  });
} 