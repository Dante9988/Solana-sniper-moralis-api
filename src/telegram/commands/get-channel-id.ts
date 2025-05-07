import { Context } from 'telegraf';
import fs from 'fs';
import path from 'path';

// Define our own interface for the message structure
interface ForwardedMessage {
  message_id: number;
  forward_from_chat?: {
    id: number;
    title?: string;
    type?: string;
  };
  // Add other fields as needed
}

export async function getChannelId(ctx: Context): Promise<void> {
  try {
    // Check if this is a forwarded message
    const message = ctx.message as ForwardedMessage;
    if (!message || !message.forward_from_chat) {
      await ctx.reply(
        '❌ This is not a forwarded message from a channel.\n\n' +
        'Please forward any message from your channel to me to get the channel ID.'
      );
      return;
    }
    
    const forwardedChat = message.forward_from_chat;
    const chatId = forwardedChat.id.toString();
    const chatTitle = forwardedChat.title || 'Unknown';
    const chatType = forwardedChat.type || 'Unknown';
    
    console.log("Detected channel:", {
      id: chatId,
      title: chatTitle,
      type: chatType
    });
    
    // Attempt to update .env file
    try {
      const envPath = path.resolve(process.cwd(), '.env');
      let envConfig = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      
      // Update TELEGRAM_CHANNEL_ID
      if (envConfig.includes('TELEGRAM_CHANNEL_ID=')) {
        envConfig = envConfig.replace(
          /TELEGRAM_CHANNEL_ID=.*/,
          `TELEGRAM_CHANNEL_ID=${chatId}`
        );
      } else {
        envConfig += `\nTELEGRAM_CHANNEL_ID=${chatId}`;
      }
      
      // Enable channel alerts
      if (envConfig.includes('TELEGRAM_CHANNEL_ALERTS_ENABLED=')) {
        envConfig = envConfig.replace(
          /TELEGRAM_CHANNEL_ALERTS_ENABLED=.*/,
          `TELEGRAM_CHANNEL_ALERTS_ENABLED=true`
        );
      } else {
        envConfig += `\nTELEGRAM_CHANNEL_ALERTS_ENABLED=true`;
      }
      
      // Save changes
      fs.writeFileSync(envPath, envConfig);
      
      // Update environment variables in memory
      process.env.TELEGRAM_CHANNEL_ID = chatId;
      process.env.TELEGRAM_CHANNEL_ALERTS_ENABLED = 'true';
      
      await ctx.reply(
        `✅ Channel ID detected and configured!\n\n` +
        `Channel: ${chatTitle}\n` +
        `ID: ${chatId}\n` +
        `Type: ${chatType}\n\n` +
        `Channel alerts have been enabled. Your bot will now forward alerts to this channel.`
      );
    } catch (error: any) {
      console.error('Error updating .env file:', error);
      
      // Even if file update failed, still show the ID
      await ctx.reply(
        `✅ Channel ID detected!\n\n` +
        `Channel: ${chatTitle}\n` +
        `ID: ${chatId}\n` +
        `Type: ${chatType}\n\n` +
        `⚠️ Could not update .env file: ${error.message}\n\n` +
        `Manually add these lines to your .env file:\n` +
        `TELEGRAM_CHANNEL_ID=${chatId}\n` +
        `TELEGRAM_CHANNEL_ALERTS_ENABLED=true`
      );
    }
  } catch (error: any) {
    console.error('Get channel ID command error:', error);
    await ctx.reply(`❌ An error occurred: ${error.message}`);
  }
} 