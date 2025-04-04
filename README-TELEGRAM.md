# Telegram Bot Integration

## Overview

This update adds a Telegram bot to the Solana Sniper Bot application, mirroring the existing Discord functionality. The Telegram bot allows users to interact with the trading system using commands similar to the Discord slash commands, enabling token buying, selling, wallet management, and configuration directly from Telegram.

## Features

- **Command-based Interface**: Simple and intuitive commands for all bot functions
- **Wallet Management**: Create or import wallets directly from Telegram
- **Trading Functions**: Buy and sell tokens using Jupiter Swap integration
- **User Configurations**: Set auto-buy/sell and customize trading parameters
- **PumpSwap Notifications**: Receive and toggle token alerts for new PumpSwap pools
- **Mirrored Alerts**: All Discord alerts are also sent to Telegram users with auto-buy enabled
- **Security**: Private key handling with secure messaging

## Commands

| Command | Description | Usage |
|---------|-------------|-------|
| `/start` | Welcome message and command overview | `/start` |
| `/wallet create` | Create a new wallet | `/wallet create <name>` |
| `/wallet import` | Import an existing wallet | `/wallet import <private_key>` |
| `/buy` | Buy a token | `/buy <token_address>` |
| `/sell` | Sell a token | `/sell <token_address> <percentage>` |
| `/config view` | View your current config | `/config view` |
| `/config set` | Set your trading parameters | `/config set <autobuy> <amount> <takeprofit> <stoploss> <autosell>` |
| `/togglepumpswap` | Toggle PumpSwap notifications | `/togglepumpswap` |

## Implementation Details

### Architecture

The Telegram bot implementation uses:

- **Telegraf.js**: Modern Telegram bot framework for Node.js
- **Singleton Pattern**: For the bot instance to ensure only one connection
- **Command Pattern**: For handling different user commands
- **Database Integration**: User preferences stored in PostgreSQL via Prisma

### Files Structure

```
src/
└── telegram/
    ├── telegramBot.ts           # Main bot initialization and core logic
    ├── alerts.ts                # Token alert handling and notifications
    ├── commands/
    │   ├── index.ts             # Command registration
    │   ├── start.ts             # Welcome command
    │   ├── buy.ts               # Token purchase
    │   ├── sell.ts              # Token selling
    │   ├── wallet.ts            # Wallet management
    │   ├── config.ts            # User configuration
    │   └── togglePumpSwap.ts    # Notification preferences
```

### Database Changes

Added a new model to the Prisma schema:

```prisma
model UserPreference {
  id              String   @id @default(uuid())
  userId          String   @unique
  pumpSwapEnabled Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

## Configuration

Configuration is handled through:

1. Environment variables (`TELEGRAM_BOT_TOKEN`)
2. Application config in `config.ts`:
```typescript
telegram: {
  enabled: true,               // Enable/disable the bot
  token: process.env.TELEGRAM_BOT_TOKEN || "",
  pumpSwapCallsEnabled: true,  // Default setting for new users
}
```

## Setup Instructions

1. Create a Telegram bot with BotFather and get a token
2. Add the token to your `.env` file as `TELEGRAM_BOT_TOKEN`
3. Run Prisma migrations:
   ```
   npx prisma generate
   npx prisma migrate dev --name add_telegram_preferences
   ```
4. Install dependencies:
   ```
   npm install telegraf
   ```
5. Start the application as usual

## Security Notes

- Private keys are sent as separate messages in Telegram for users to save and delete
- User preferences for notifications are stored in the database
- All commands support user-specific configurations
- Telegram user IDs are used for authentication and linking to user accounts

## Future Improvements

- Add inline keyboards for better UI/UX
- Implement token search functionality
- Add portfolio tracking commands
- Support for multiple wallets per user
- Real-time price alerts and portfolio value tracking 