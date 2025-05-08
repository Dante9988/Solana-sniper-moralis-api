/**
 * Simple test script to verify API server functionality
 */
import { initApiServer } from './api';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

console.log('Starting API server test...');

try {
  // Initialize API server
  initApiServer();
  
  console.log('API server test initialized successfully');
  console.log('You can test the API server by visiting:');
  console.log('- Health check: http://localhost:3001/health');
  console.log('- API documentation: http://localhost:3001/api-docs');
  
  // Keep the process running
  console.log('Press Ctrl+C to stop the server');
} catch (error) {
  console.error('API server test failed:', error);
} 