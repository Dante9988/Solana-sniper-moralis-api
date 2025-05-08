/**
 * Test script to simulate a token alert broadcast via WebSocket
 */
import { TokenAlertData, broadcastTokenAlert } from './api';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize API server
import { initApiServer } from './api';

console.log('Starting WebSocket test...');

// Initialize API server (which includes WebSocket server)
initApiServer();

// Wait 2 seconds for server to start
setTimeout(() => {
  console.log('Simulating token alert broadcast...');
  
  // Create a sample token alert
  const sampleTokenAlert: TokenAlertData = {
    tokenAddress: 'TokenAddressExample123456789ABCDEF',
    tokenName: 'Test Token',
    tokenSymbol: 'TEST',
    price: 0.00001234,
    marketCap: '$50,000',
    liquidityInSol: 10.5,
    volume24h: '$2,500',
    rugCheckPassed: true,
    timestamp: Date.now(),
    transactionSignature: 'SimulatedTestTransactionSignature123456789ABCDEF',
    buyLink: 'https://jup.ag/swap/SOL-TokenAddressExample123456789ABCDEF',
    isMigrationToken: false,
    bundles: '24/63',
    percentage: '27.52%',
    solSpent: '◎169.62'
  };
  
  // Broadcast the token alert
  const result = broadcastTokenAlert(sampleTokenAlert);
  
  console.log(`Test token alert broadcast ${result ? 'successful' : 'failed'} (no connected clients)`);
  console.log('Use the WebSocket client to connect to ws://localhost:3001');
  console.log('Then run this test again to see a token alert in your client');
  
  // Do not exit, keep server running
  console.log('Press Ctrl+C to exit');
}, 2000);

// Create a function to send a simulated token alert on demand
function sendSimulatedAlert() {
  // Generate randomized token data for testing
  const randomId = Math.floor(Math.random() * 1000000);
  const randomPrice = Math.random() * 0.0001;
  const randomLiquidity = 5 + Math.random() * 20;
  
  const randomTokenAlert: TokenAlertData = {
    tokenAddress: `TestToken${randomId}`,
    tokenName: `Test Token ${randomId}`,
    tokenSymbol: `TEST${randomId}`,
    price: randomPrice,
    marketCap: `$${(randomPrice * 1000000000).toFixed(2)}`,
    liquidityInSol: randomLiquidity,
    volume24h: `$${(randomLiquidity * 100).toFixed(2)}`,
    rugCheckPassed: Math.random() > 0.2, // 80% chance of passing
    timestamp: Date.now(),
    transactionSignature: `SimTx${randomId}`,
    buyLink: `https://jup.ag/swap/SOL-TestToken${randomId}`,
    isMigrationToken: Math.random() > 0.5,
    bundles: `${Math.floor(Math.random() * 50)}/${Math.floor(50 + Math.random() * 50)}`,
    percentage: `${(Math.random() * 100).toFixed(2)}%`,
    solSpent: `◎${(Math.random() * 200).toFixed(2)}`
  };
  
  const result = broadcastTokenAlert(randomTokenAlert);
  console.log(`Simulated token alert broadcast: ${result ? 'Sent' : 'No clients connected'}`);
}

// Send a new random token alert every 10 seconds
const intervalId = setInterval(() => {
  sendSimulatedAlert();
}, 10000);

// Handle graceful shutdown
process.on('SIGINT', () => {
  clearInterval(intervalId);
  console.log('Stopping test...');
  setTimeout(() => {
    process.exit(0);
  }, 500);
}); 