import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import swaggerJsdoc from 'swagger-jsdoc';
// Import swagger-ui-express using require to avoid TypeScript issues
const swaggerUi = require('swagger-ui-express');
import { Server } from 'http';
import { WebSocketServer } from 'ws';
import { config } from '../config';
import { client } from '../discord/discord';
import { telegramBot } from '../telegram/telegramBot';
import { 
  checkTokenPnL, 
  getTopPerformingTokens, 
  triggerDailySummary 
} from '../services/tokenTrackingService';
import { generateCustomTimeRangeReport } from '../services/dailyTopTokensService';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { PrismaClient } from '@prisma/client';
import { pumpSwapService } from '../services/pumpswapService';
import axios from 'axios';

const prisma = new PrismaClient();
const app = express();

// API server configuration
const HOST = process.env.API_HOST || '0.0.0.0';
const PORT = parseInt(process.env.API_PORT || '3001');

// Check if we're running from the main application or standalone
const isMainApp = require.main?.filename?.includes('index.ts') || 
                  require.main?.filename?.includes('index.js');

// If we're running from the main app, use a different port to avoid conflicts
const EFFECTIVE_PORT = isMainApp ? 
                      parseInt(process.env.API_PORT_MAIN || '3030') : 
                      PORT;

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

// Add type definition for token alert data
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
 * Initialize the API server and WebSocket server
 */
export function initApiServer() {
  console.log('📡 Starting API server initialization...');
  console.log(`📡 Server will listen on ${HOST}:${EFFECTIVE_PORT}${isMainApp ? ' (main app mode)' : ''}`);
  
  try {
    // Start HTTP server with proper error handling
    httpServer = app.listen(EFFECTIVE_PORT, HOST, () => {
      console.log(`🚀 API server running on http://${HOST}:${EFFECTIVE_PORT}`);
      console.log(`📝 API Documentation available at http://${HOST}:${EFFECTIVE_PORT}/api-docs`);
    }).on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ ERROR: Port ${EFFECTIVE_PORT} is already in use! API server could not start.`);
        console.error(`   Try a different port by setting the ${isMainApp ? 'API_PORT_MAIN' : 'API_PORT'} environment variable.`);
        console.error(`   Or find and stop the process using port ${EFFECTIVE_PORT}:`);
        console.error(`   Linux/Mac: lsof -i :${EFFECTIVE_PORT} | grep LISTEN`);
        console.error(`   Windows: netstat -ano | findstr :${EFFECTIVE_PORT}`);
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
    setupRoutes();
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
 * Setup all API routes
 */
function setupRoutes() {
  console.log('📡 Setting up API routes for Solana Sniper Bot...');
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    console.log('Health check request received');
    res.status(200).json({ status: 'ok' });
  });
  
  // API Root endpoint
  app.get('/', (req, res) => {
    res.status(200).json({ 
      name: 'Solana Sniper Bot API',
      version: '1.0.0',
      documentation: `/api-docs`,
      status: 'running'
    });
  });
  
  // ----- PNL Endpoints -----
  
  /**
   * @swagger
   * /api/pnl/check:
   *   post:
   *     summary: Manually trigger PNL check
   *     responses:
   *       200:
   *         description: PNL check successfully triggered
   */
  app.post('/api/pnl/check', async (req, res) => {
    try {
      await checkTokenPnL(client);
      res.json({ 
        success: true, 
        message: 'PNL check successfully triggered' 
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to trigger PNL check' 
      });
    }
  });
  
  /**
   * @swagger
   * /api/pnl/daily-summary:
   *   post:
   *     summary: Trigger daily PNL summary
   *     responses:
   *       200:
   *         description: Daily summary successfully triggered
   */
  app.post('/api/pnl/daily-summary', async (req, res) => {
    try {
      await triggerDailySummary(client);
      res.json({ 
        success: true, 
        message: 'Daily summary successfully triggered' 
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to trigger daily summary' 
      });
    }
  });
  
  /**
   * @swagger
   * /api/pnl/top-performers:
   *   get:
   *     summary: Get top performing tokens
   *     parameters:
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *         description: Number of top tokens to return
   *     responses:
   *       200:
   *         description: Top performing tokens retrieved
   */
  app.get('/api/pnl/top-performers', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const topTokens = await getTopPerformingTokens(limit);
      res.json({ 
        success: true, 
        data: topTokens
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to get top performing tokens' 
      });
    }
  });
  
  /**
   * @swagger
   * /api/pnl/top-calls-report:
   *   post:
   *     summary: Trigger top calls report
   *     parameters:
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *         description: Number of top tokens to include in report
   *     responses:
   *       200:
   *         description: Top calls report successfully triggered
   */
  app.post('/api/pnl/top-calls-report', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 5;
      await generateCustomTimeRangeReport(client, telegramBot, limit);
      res.json({ 
        success: true, 
        message: 'Top calls report successfully triggered' 
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to trigger top calls report' 
      });
    }
  });
  
  // ----- Wallet Management Endpoints -----
  
  /**
   * @swagger
   * /api/wallet/create:
   *   post:
   *     summary: Create a new wallet
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - userId
   *               - name
   *             properties:
   *               userId:
   *                 type: string
   *               name:
   *                 type: string
   *     responses:
   *       201:
   *         description: Wallet created successfully
   */
  app.post('/api/wallet/create', async (req, res) => {
    try {
      const { userId, name } = req.body;
      
      if (!userId || !name) {
        return res.status(400).json({
          success: false,
          error: 'userId and name are required'
        });
      }
      
      // Generate a new Solana keypair
      const keypair = Keypair.generate();
      const walletAddress = keypair.publicKey.toString();
      const walletPk = bs58.encode(keypair.secretKey);
      
      // Store in database
      await prisma.wallet.create({
        data: {
          userId,
          walletAddress,
          walletPk,
          createdAt: new Date()
        }
      });
      
      res.status(201).json({
        success: true,
        data: {
          userId,
          walletAddress,
          walletPk,
          createdAt: new Date()
        }
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to create wallet' 
      });
    }
  });
  
  /**
   * @swagger
   * /api/wallet/import:
   *   post:
   *     summary: Import an existing wallet
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - userId
   *               - privateKey
   *             properties:
   *               userId:
   *                 type: string
   *               privateKey:
   *                 type: string
   *     responses:
   *       200:
   *         description: Wallet imported successfully
   */
  app.post('/api/wallet/import', async (req, res) => {
    try {
      const { userId, privateKey } = req.body;
      
      if (!userId || !privateKey) {
        return res.status(400).json({
          success: false,
          error: 'userId and privateKey are required'
        });
      }
      
      // Validate private key
      if (!privateKey || privateKey.length < 64) {
        return res.status(400).json({
          success: false,
          error: 'Invalid private key format'
        });
      }
      
      // Convert private key to keypair
      let secretKey: Uint8Array;
      try {
        secretKey = bs58.decode(privateKey);
        if (secretKey.length !== 64) {
          throw new Error('Invalid key length');
        }
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: 'Invalid private key format'
        });
      }
      
      const keypair = Keypair.fromSecretKey(secretKey);
      const walletAddress = keypair.publicKey.toString();
      
      // Store in database
      await prisma.wallet.upsert({
        where: { userId },
        update: {
          walletAddress,
          walletPk: privateKey,
        },
        create: {
          userId,
          walletAddress,
          walletPk: privateKey,
          createdAt: new Date()
        }
      });
      
      res.json({
        success: true,
        data: {
          userId,
          walletAddress,
          walletPk: privateKey,
          createdAt: new Date()
        }
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to import wallet' 
      });
    }
  });
  
  /**
   * @swagger
   * /api/wallet/{userId}:
   *   get:
   *     summary: Get user wallet
   *     parameters:
   *       - in: path
   *         name: userId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Wallet retrieved successfully
   */
  app.get('/api/wallet/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      
      const wallet = await prisma.wallet.findUnique({
        where: { userId }
      });
      
      if (!wallet) {
        return res.status(404).json({
          success: false,
          error: 'Wallet not found'
        });
      }
      
      const connection = new Connection(process.env.HELIUS_HTTPS_URI || "");
      
      // Get SOL balance
      const solBalance = await connection.getBalance(new PublicKey(wallet.walletAddress)) / 10**9;
      
      res.json({
        success: true,
        data: {
          userId: wallet.userId,
          walletAddress: wallet.walletAddress,
          createdAt: wallet.createdAt,
          solBalance
        }
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to get wallet' 
      });
    }
  });
  
  // ----- Transaction Endpoints -----
  
  /**
   * @swagger
   * /api/transaction/buy:
   *   post:
   *     summary: Buy a token
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - userId
   *               - tokenAddress
   *             properties:
   *               userId:
   *                 type: string
   *               tokenAddress:
   *                 type: string
   *               customSettings:
   *                 type: object
   *     responses:
   *       200:
   *         description: Buy transaction executed successfully
   */
  app.post('/api/transaction/buy', async (req, res) => {
    try {
      const { userId, tokenAddress, customSettings } = req.body;
      
      if (!userId || !tokenAddress) {
        return res.status(400).json({
          success: false,
          error: 'userId and tokenAddress are required'
        });
      }
      
      const result = await pumpSwapService.buyToken(tokenAddress, userId, customSettings);
      
      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: result.error
        });
      }
      
      res.json({
        success: true,
        data: {
          txId: result.txId
        }
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to execute buy transaction' 
      });
    }
  });
  
  /**
   * @swagger
   * /api/transaction/sell:
   *   post:
   *     summary: Sell a token
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - userId
   *               - tokenAddress
   *               - percentage
   *             properties:
   *               userId:
   *                 type: string
   *               tokenAddress:
   *                 type: string
   *               percentage:
   *                 type: number
   *               customSettings:
   *                 type: object
   *     responses:
   *       200:
   *         description: Sell transaction executed successfully
   */
  app.post('/api/transaction/sell', async (req, res) => {
    try {
      const { userId, tokenAddress, percentage, customSettings } = req.body;
      
      if (!userId || !tokenAddress || percentage === undefined) {
        return res.status(400).json({
          success: false,
          error: 'userId, tokenAddress, and percentage are required'
        });
      }
      
      const result = await pumpSwapService.sellToken(tokenAddress, percentage, userId, customSettings);
      
      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: result.error
        });
      }
      
      res.json({
        success: true,
        data: {
          txId: result.txId
        }
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to execute sell transaction' 
      });
    }
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
  
  /**
   * @swagger
   * /api/config:
   *   get:
   *     summary: Get bot configuration
   *     responses:
   *       200:
   *         description: Configuration retrieved successfully
   */
  app.get('/api/config', (req, res) => {
    try {
      // Return safe configuration values (exclude sensitive data)
      const safeConfig = {
        liquidity_pool: config.liquidity_pool.map(pool => {
          if ('id' in pool) {
            return {
              id: pool.id,
              name: pool.name,
              enabled: pool.enabled
            };
          }
          return null;
        }).filter(Boolean),
        rug_check: {
          simulation_mode: config.rug_check.simulation_mode,
          allow_mint_authority: config.rug_check.allow_mint_authority,
          allow_freeze_authority: config.rug_check.allow_freeze_authority
        },
        tx: {
          concurrent_transactions: config.tx.concurrent_transactions,
          get_timeout: config.tx.get_timeout
        },
        swap: {
          slippageBps: config.swap.slippageBps
        },
        sell: {
          auto_sell: config.sell.auto_sell,
          stop_loss_percent: config.sell.stop_loss_percent,
          take_profit_percent: config.sell.take_profit_percent
        },
        notifiers: {
          discord: !!process.env.DISCORD_BOT_TOKEN,
          telegram: !!process.env.TELEGRAM_BOT_TOKEN
        }
      };
      
      res.json({
        success: true,
        data: safeConfig
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to get configuration' 
      });
    }
  });
  
  /**
   * @swagger
   * /api/config:
   *   put:
   *     summary: Update bot configuration
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: Configuration updated successfully
   */
  app.put('/api/config', (req, res) => {
    try {
      const newConfig = req.body;
      
      // Update configuration
      if (newConfig.rug_check?.simulation_mode !== undefined) {
        config.rug_check.simulation_mode = newConfig.rug_check.simulation_mode;
      }
      
      if (newConfig.swap?.slippageBps !== undefined) {
        config.swap.slippageBps = newConfig.swap.slippageBps;
      }
      
      if (newConfig.sell?.auto_sell !== undefined) {
        config.sell.auto_sell = newConfig.sell.auto_sell;
      }
      
      if (newConfig.sell?.stop_loss_percent !== undefined) {
        config.sell.stop_loss_percent = newConfig.sell.stop_loss_percent;
      }
      
      if (newConfig.sell?.take_profit_percent !== undefined) {
        config.sell.take_profit_percent = newConfig.sell.take_profit_percent;
      }
      
      // Update liquidity pool settings if provided
      if (newConfig.liquidity_pool && Array.isArray(newConfig.liquidity_pool)) {
        newConfig.liquidity_pool.forEach((pool: any) => {
          if (pool.id !== undefined && pool.enabled !== undefined) {
            const existingPool = config.liquidity_pool.find((p: any) => 'id' in p && p.id === pool.id);
            if (existingPool && 'enabled' in existingPool) {
              existingPool.enabled = pool.enabled;
            }
          }
        });
      }
      
      res.json({
        success: true,
        message: 'Configuration updated successfully',
        data: {
          rug_check: {
            simulation_mode: config.rug_check.simulation_mode
          },
          swap: {
            slippageBps: config.swap.slippageBps
          },
          sell: {
            auto_sell: config.sell.auto_sell,
            stop_loss_percent: config.sell.stop_loss_percent,
            take_profit_percent: config.sell.take_profit_percent
          }
        }
      });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to update configuration' 
      });
    }
  });
} 