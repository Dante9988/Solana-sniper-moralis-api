/**
 * Standalone API server script
 * 
 * This script runs only the API server without the bot.
 * It's useful when you want to run the API server independently.
 * 
 * Usage:
 *   - Basic: yarn api:server
 *   - Custom port: API_PORT=3001 yarn api:server
 *   - Custom port via argument: yarn api:server 3001
 */
import dotenv from 'dotenv';
import { initStandaloneApiServer } from './api/standalone';

// Load environment variables
dotenv.config();

// Get port from command line argument if provided
if (process.argv.length > 2) {
  const portArg = process.argv[2];
  if (portArg && !isNaN(parseInt(portArg))) {
    process.env.API_PORT = portArg;
    console.log(`Setting API port to ${portArg} from command line argument`);
  }
}

// Display startup banner
console.log(`
🚀 Starting Solana Sniper Bot API Server (Standalone)
===========================================
API_PORT: ${process.env.API_PORT || '3001 (default)'}
API_HOST: ${process.env.API_HOST || '0.0.0.0 (default)'}
===========================================

This is the standalone API server for the Solana Sniper Bot.
- The bot itself is NOT running with this command
- Only WebSocket and basic API endpoints are available
- Full functionality requires running the bot with API: API_ENABLED=true yarn dev
`);

// Initialize API server
try {
  initStandaloneApiServer();
  console.log('\n✅ API server initialization completed');
  console.log(`
API Server is now running:
- Root endpoint: http://localhost:${process.env.API_PORT || '3001'}
- Health check: http://localhost:${process.env.API_PORT || '3001'}/health
- API documentation: http://localhost:${process.env.API_PORT || '3001'}/api-docs
- WebSocket: ws://localhost:${process.env.API_PORT || '3001'}

You can test the connection using:
- yarn check:api ${process.env.API_PORT || '3001'}
- Opening websocket-test.html in your browser
`);
  console.log('Press Ctrl+C to stop the server');
} catch (error) {
  console.error('❌ Failed to initialize API server:', error);
  process.exit(1);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down API server...');
  setTimeout(() => {
    console.log('👋 Goodbye!');
    process.exit(0);
  }, 500);
}); 