# Telegram Bot Setup Instructions

This document explains how to set up and configure the Telegram bot for your Solana Sniper application.

## Prerequisites

1. You need a Telegram account
2. Access to BotFather on Telegram to create a new bot

## Step 1: Create a Telegram Bot

1. Open Telegram and search for "BotFather"
2. Start a chat with BotFather and send the command `/newbot`
3. Follow the instructions to create a new bot:
   - Provide a name for your bot (e.g., "Solana Sniper Bot")
   - Provide a username for your bot (must end with "bot", e.g., "SolanaSniper_bot")
4. BotFather will provide you with a token. This is your `TELEGRAM_BOT_TOKEN`

## Step 2: Update Environment Variables

Add the following to your `.env` file:

```
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
```

## Step 3: Run Database Migrations

After adding the new UserPreference model to your Prisma schema, run the following commands:

```bash
npx prisma generate
npx prisma migrate dev --name add_telegram_preferences
```

## Step 4: Start the Bot

1. Start your application as usual
2. The Telegram bot will automatically initialize if enabled in config
3. Open Telegram and search for your bot's username
4. Start a chat and send the `/start` command to begin

## Available Commands

- `/start` - Welcome message and command list
- `/wallet create <name>` - Create a new wallet
- `/wallet import <private_key>` - Import an existing wallet
- `/buy <token_address>` - Buy a token
- `/sell <token_address> <percentage>` - Sell a token
- `/config view` - View your current configuration
- `/config set <autobuy> <amount> <takeprofit> <stoploss> <autosell>` - Set your configuration
- `/togglepumpswap` - Toggle PumpSwap notifications

## Example Configuration

```
/config set true 0.1 50 15 true
```

This sets:
- Auto buy: Enabled
- Buy amount: 0.1 SOL
- Take profit: 50%
- Stop loss: 15%
- Auto sell: Enabled

## Troubleshooting

If the bot doesn't respond:
1. Make sure your `.env` file has the correct `TELEGRAM_BOT_TOKEN`
2. Check that you've run the database migrations
3. Verify in the logs that the bot initialized successfully
4. Ensure the `telegram.enabled` setting is `true` in your config 