import { Client, GatewayIntentBits } from 'discord.js';
import { triggerDailySummary } from './services/tokenTrackingService';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ]
  });

  try {
    await client.login(process.env.DISCORD_BOT_TOKEN);
    console.log('✅ Discord bot logged in successfully');
    
    // Trigger daily summary
    await triggerDailySummary(client);
    
    // Wait a bit to ensure the message is sent
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Log out
    await client.destroy();
    console.log('✅ Discord bot logged out');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main(); 