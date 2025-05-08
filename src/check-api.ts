/**
 * Check if the API server is running
 * 
 * Usage:
 *   yarn check:api        # Checks port 3001 (standalone default)
 *   yarn check:api 3030   # Checks specified port
 */
import axios from 'axios';

// Get port from command line or use default
const port = process.argv[2] || '3001';

// URLs to check
const urls = [
  `http://localhost:${port}`,
  `http://localhost:${port}/health`,
  `http://localhost:${port}/api-docs`,
  `http://localhost:${port}/api/status`
];

console.log(`Checking API server on port ${port}...`);

// Check each URL
async function checkUrls() {
  for (const url of urls) {
    try {
      console.log(`Trying ${url}...`);
      const response = await axios.get(url, { timeout: 2000 });
      console.log(`✅ ${url} - Status: ${response.status}`);
      if (response.data) {
        console.log('   Response:', JSON.stringify(response.data).substring(0, 100) + (JSON.stringify(response.data).length > 100 ? '...' : ''));
      }
    } catch (error: any) {
      console.log(`❌ ${url} - Error: ${error.message}`);
      if (error.response) {
        console.log(`   Status: ${error.response.status} ${error.response.statusText}`);
      }
    }
  }
}

// Check if the API is in standalone or full mode
async function checkApiMode() {
  try {
    const response = await axios.get(`http://localhost:${port}/api/status`, { timeout: 2000 });
    if (response.data && response.data.mode === 'standalone') {
      console.log('\n⚠️ API is running in STANDALONE mode with limited functionality');
      console.log('   To access all API features, run the bot with: API_ENABLED=true yarn dev');
    } else {
      console.log('\n✅ API is running in FULL mode with all features available');
    }
  } catch (error) {
    console.log('\n⚠️ Could not determine API mode');
  }
}

// WebSocket check is commented out in Node.js environment
// In browsers, you would use:
/*
function checkWebSocket() {
  try {
    console.log(`Trying WebSocket ws://localhost:${port}...`);
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    ws.onopen = () => {
      console.log(`✅ WebSocket connected on port ${port}`);
      setTimeout(() => {
        ws.close();
        console.log('WebSocket connection closed');
      }, 1000);
    };
    
    ws.onerror = (error) => {
      console.log(`❌ WebSocket connection failed: ${error}`);
    };
  } catch (error: any) {
    console.log(`❌ WebSocket error: ${error.message}`);
  }
}
*/

// Run the checks
(async () => {
  await checkUrls();
  await checkApiMode();
  
  console.log('\nNote: WebSocket check requires browser environment');
  console.log('\nTo check WebSocket connection, use the websocket-test.html file');
  
  console.log('\nAPI Server Check Complete');
})(); 