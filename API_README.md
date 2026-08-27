# Solana Sniper Bot API

This document explains how to use the API server included with the Solana Sniper Bot.

## Running Options

The API server can be run in several different ways depending on your needs:

### Option 1: Run API Server Standalone (Recommended)

This option runs only the API server without the bot:

```bash
# Run API server only (no bot)
yarn api:server

# Or with a custom port
yarn api:server 3002
# OR
API_PORT=3002 yarn api:server
```

### Option 2: Run Bot with API Server

This option runs both the bot and the API server together:

```bash
# Development mode with API server
yarn dev:all
# OR
API_ENABLED=true yarn dev

# Production mode with API server (after building)
API_ENABLED=true yarn start
```

### Option 3: Run Bot Without API Server (Default)

This is the default behavior when running the bot:

```bash
# Development mode without API server
yarn dev

# Production mode without API server
yarn start
```

## Checking API Status

You can check if the API server is running properly:

```bash
# Check default port (3030 in main app, 3001 in standalone)
yarn check:api

# Check specific port
yarn check:api 3002
```

## WebSocket Connections

Use the included HTML test client to connect to the WebSocket:

1. Start the API server
2. Open `websocket-test.html` in your browser
3. Select the correct port (3001 for standalone, 3030 if running with main app)
4. Click "Connect" and then "Subscribe to Token Alerts"

## API Endpoints

The API server provides several endpoints:

### Base Endpoints

- `GET /` - API root with basic information
- `GET /health` - Health check endpoint
- `GET /api-docs` - Swagger API documentation

### Token PNL Endpoints

- `POST /api/pnl/check` - Trigger PNL check
- `POST /api/pnl/daily-summary` - Trigger daily summary
- `GET /api/pnl/top-performers` - Get top performing tokens
- `POST /api/pnl/top-calls-report` - Trigger top calls report

### Wallet Management

- `POST /api/wallet/create` - Create a new wallet
- `POST /api/wallet/import` - Import an existing wallet
- `GET /api/wallet/:userId` - Get user wallet

### Transaction Operations

- `POST /api/transaction/buy` - Buy a token
- `POST /api/transaction/sell` - Sell a token

### Utility Endpoints

- `GET /api/utils/sol-price` - Get current SOL price
- `GET /api/config` - Get bot configuration
- `PUT /api/config` - Update bot configuration

## Integration with React Frontend

To integrate with a React frontend, you should:

1. Run the API server using one of the methods above
2. Connect to the API endpoints from your React application
3. Use WebSocket connection for real-time token alerts

For WebSocket connection in React, use the provided `TokenAlertsComponent.jsx` as a reference. 