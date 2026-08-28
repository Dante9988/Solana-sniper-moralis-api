/**
 * ⚠️ DEPRECATED / INTERNAL (phase7b1.txt §4): this is the legacy `main2`
 * trading surface — unversioned `/api/*`, off by default, bearer-token
 * gated (§8.3). The canonical, versioned gateway for the OnlyPump web and
 * mobile apps is `src/researchApi/server.ts`'s `/api/v1/*` (Supabase-
 * authenticated, OpenAPI-documented — see ARCHITECTURE.md §16). This file
 * is kept running, unmodified in this phase, purely for backward
 * compatibility with the existing Telegram/Discord non-custodial trading
 * flow (§8.2) that already depends on its `/api/wallet/connect` and
 * `/api/transaction/{buy,sell}` routes plus the public `/pay/*` Solana Pay
 * callbacks. Do not point new frontend work at this file — build against
 * `/api/v1` instead. Its Phase 7A security behavior (fail-closed auth,
 * non-custodial trading, no wallet-create/import routes) is unchanged and
 * still covered by src/api/__tests__/index.test.ts.
 */
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
import { Connection, PublicKey } from '@solana/web3.js';
import { PrismaClient } from '@prisma/client';
import { jupiterService } from '../services/jupiterService';
import {
  buildTransactionForAccount,
  createBuyIntent,
  createSellIntent,
  getIntent,
  labelForIntent,
  SolanaPayConfigError,
} from '../services/solanaPayService';
import axios from 'axios';
import { createRateLimiter } from './rateLimit';

const prisma = new PrismaClient();
export const app = express();

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

// Bearer-key auth for everything under /api/* (wallet, transaction-request
// creation, config, pnl). Fails CLOSED: with no API_AUTH_TOKEN configured,
// every /api/* request is rejected rather than silently left open — this
// server has no other access control and is bound to 0.0.0.0 by default
// (see ARCHITECTURE.md §8.3). /health, /, and the Solana Pay /pay/* routes
// are intentionally exempt: /pay/* must stay unauthenticated per the Solana
// Pay Transaction Request spec (a wallet app calls them directly, and
// building a transaction for a caller-declared account cannot move that
// account's funds without its own signature).
app.use('/api', (req, res, next) => {
  const configuredToken = process.env.API_AUTH_TOKEN?.trim();
  if (!configuredToken) {
    res.status(503).json({ success: false, error: 'This API is not configured (API_AUTH_TOKEN is unset) — refusing all /api/* requests.' });
    return;
  }
  const header = req.header('authorization');
  const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
  if (provided !== configuredToken) {
    res.status(401).json({ success: false, error: 'missing or invalid API token' });
    return;
  }
  next();
});

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
export function setupRoutes() {
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
  //
  // The former /api/wallet/create and /api/wallet/import routes generated or
  // accepted a raw private key over an UNAUTHENTICATED HTTP endpoint bound to
  // 0.0.0.0 and stored it in plaintext in Postgres. Removed entirely — see
  // ARCHITECTURE.md §8. Only a "connect a public address" route remains,
  // which cannot grant signing access to anything.

  /**
   * @swagger
   * /api/wallet/connect:
   *   post:
   *     summary: Record a user's wallet PUBLIC address (never a private key)
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - userId
   *               - address
   *             properties:
   *               userId:
   *                 type: string
   *               address:
   *                 type: string
   *     responses:
   *       200:
   *         description: Wallet connected successfully
   */
  app.post('/api/wallet/connect', async (req, res) => {
    try {
      const { userId, address } = req.body;

      if (!userId || !address) {
        return res.status(400).json({ success: false, error: 'userId and address are required' });
      }

      const result = await jupiterService.connectWallet(userId, address);
      if ('error' in result) {
        return res.status(400).json({ success: false, error: result.error });
      }

      res.json({ success: true, data: { userId, walletAddress: result.walletAddress } });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to connect wallet'
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
   *     summary: Create a Solana Pay buy request. Returns a link/QR for the caller's own wallet to sign and submit — this endpoint never executes a trade itself.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - tokenAddress
   *               - solAmount
   *             properties:
   *               tokenAddress:
   *                 type: string
   *               solAmount:
   *                 type: number
   *     responses:
   *       200:
   *         description: Solana Pay buy request created
   */
  app.post('/api/transaction/buy', async (req, res) => {
    try {
      const { tokenAddress, solAmount } = req.body;

      if (!tokenAddress || !solAmount) {
        return res.status(400).json({
          success: false,
          error: 'tokenAddress and solAmount are required'
        });
      }

      const { intentId, url } = createBuyIntent(tokenAddress, solAmount);
      res.json({ success: true, data: { intentId, url } });
    } catch (error: any) {
      res.status(error instanceof SolanaPayConfigError ? 500 : 400).json({
        success: false,
        error: error.message || 'Failed to create buy request'
      });
    }
  });

  /**
   * @swagger
   * /api/transaction/sell:
   *   post:
   *     summary: Create a Solana Pay sell request. Returns a link/QR for the caller's own wallet to sign and submit — this endpoint never executes a trade itself.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - tokenAddress
   *               - percentage
   *             properties:
   *               tokenAddress:
   *                 type: string
   *               percentage:
   *                 type: number
   *     responses:
   *       200:
   *         description: Solana Pay sell request created
   */
  app.post('/api/transaction/sell', async (req, res) => {
    try {
      const { tokenAddress, percentage } = req.body;

      if (!tokenAddress || percentage === undefined) {
        return res.status(400).json({
          success: false,
          error: 'tokenAddress and percentage are required'
        });
      }

      const { intentId, url } = createSellIntent(tokenAddress, percentage);
      res.json({ success: true, data: { intentId, url } });
    } catch (error: any) {
      res.status(error instanceof SolanaPayConfigError ? 500 : 400).json({
        success: false,
        error: error.message || 'Failed to create sell request'
      });
    }
  });

  // ----- Solana Pay Transaction Request Endpoints -----
  //
  // Implements https://docs.solanapay.com/spec#transaction-request. These are
  // deliberately UNAUTHENTICATED per spec — a wallet app calls them directly.
  // GET returns display metadata; POST receives the CALLER's own public key
  // and returns an unsigned transaction for that specific account. Building a
  // transaction here cannot move anyone's funds — only the account owner's
  // own wallet, by signing it, can do that.

  // Unauthenticated by design (see the comment above) — rate-limited per IP
  // instead, so a single caller can't hammer Jupiter's quote/swap API for
  // free (phase7.txt §3 "rate limiting ... for public payment intents").
  const payRateLimit = createRateLimiter({ windowMs: 60_000, max: 30 });

  app.get('/pay/:kind(buy|sell)/:intentId', payRateLimit, async (req, res) => {
    const intent = getIntent(req.params.intentId);
    if (!intent) return res.status(404).json({ error: 'Unknown or expired request' });
    res.json(labelForIntent(intent));
  });

  app.post('/pay/:kind(buy|sell)/:intentId', payRateLimit, async (req, res) => {
    try {
      const { account } = req.body;
      if (!account) return res.status(400).json({ error: 'account is required' });
      const built = await buildTransactionForAccount(req.params.intentId, account);
      res.json(built);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to build transaction' });
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