import dotenv from 'dotenv';
import { client } from './discord/discord';
import { telegramBot } from './telegram/telegramBot';
import { generateCustomTimeRangeReport } from './services/dailyTopTokensService';

// Load environment variables
dotenv.config();

// Get the number of tokens from command line args (default to 5)
const args = process.argv.slice(2);
const limit = args.length > 0 ? parseInt(args[0], 10) : 5;

// Validate limit
if (isNaN(limit) || limit < 1) {
  console.error('Invalid limit argument. Please provide a positive number.');
  process.exit(1);
}

console.log(`
🏆 Top Calls Generator
━━━━━━━━━━━━━━━━━━━━━━
Generating top ${limit} tokens report from yesterday 12 AM EST until now.
`);

// Initialize bots and then generate the report
async function run() {
  try {
    // Wait for Discord client to be ready
    if (!client.isReady()) {
      console.log('Waiting for Discord client to be ready...');
      await new Promise<void>(resolve => {
        client.once('ready', () => {
          console.log('Discord client ready');
          resolve();
        });
      });
    }

    // Initialize Telegram bot if needed
    if (!(telegramBot as any).isInitialized) {
      console.log('Initializing Telegram bot...');
      await telegramBot.initialize();
    }

    // Generate the report
    console.log('Generating custom time range report...');
    await generateCustomTimeRangeReport(client, telegramBot, limit);
    
    console.log('✅ Report generation completed');
    
    // Give some time for requests to finish
    setTimeout(() => {
      console.log('Exiting process...');
      process.exit(0);
    }, 3000);
  } catch (error) {
    console.error('Error generating top calls report:', error);
    process.exit(1);
  }
}

// Run the main function
run(); 