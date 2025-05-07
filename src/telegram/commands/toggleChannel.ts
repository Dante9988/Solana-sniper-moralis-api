import { Context } from 'telegraf';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// In-memory storage as a fallback
let inMemoryChannelId: string | null = null;
let inMemoryChannelEnabled: boolean = false;

export async function toggleChannel(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    const chatType = ctx.chat?.type;
    
    // Debug info
    console.log("Toggle channel command called:");
    console.log("User ID:", userId);
    console.log("Chat ID:", chatId);
    console.log("Chat Type:", chatType);
    console.log("Admin IDs from env:", process.env.TELEGRAM_ADMIN_IDS);
    
    // First respond to show the command was received
    await ctx.reply('🔄 Processing toggle channel command...');
    
    // In channels, the userId might be missing. In this case, just use the chatId
    if (chatType === 'channel') {
      // Channel post, proceed directly
      console.log("Channel post detected, proceeding without user ID check");
    } else if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    } else {
      // Check if this is an admin for non-channel chats
      const admins = process.env.TELEGRAM_ADMIN_IDS?.split(',') || [];
      console.log("Parsed admin IDs:", admins);
      
      if (!admins.includes(userId)) {
        await ctx.reply(`❌ Only admins can use this command. Your ID: ${userId} is not in the admin list.`);
        return;
      }
    }
    
    // If called from a channel/group, use that ID
    if (chatId && (ctx.chat?.type === 'supergroup' || ctx.chat?.type === 'channel' || ctx.chat?.type === 'group')) {
      let envFileUpdated = false;
      
      // Try to update .env file
      try {
        const envPath = path.resolve(process.cwd(), '.env');
        console.log("Looking for .env file at:", envPath);
        
        let envConfig = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
        console.log(".env file exists:", fs.existsSync(envPath));
        
        // Update TELEGRAM_CHANNEL_ID
        if (envConfig.includes('TELEGRAM_CHANNEL_ID=')) {
          envConfig = envConfig.replace(
            /TELEGRAM_CHANNEL_ID=.*/,
            `TELEGRAM_CHANNEL_ID=${chatId}`
          );
        } else {
          envConfig += `\nTELEGRAM_CHANNEL_ID=${chatId}`;
        }
        
        // Toggle TELEGRAM_CHANNEL_ALERTS_ENABLED
        const currentStatus = process.env.TELEGRAM_CHANNEL_ALERTS_ENABLED === 'true';
        const newStatus = !currentStatus;
        console.log("Current alert status:", currentStatus);
        console.log("New alert status:", newStatus);
        
        if (envConfig.includes('TELEGRAM_CHANNEL_ALERTS_ENABLED=')) {
          envConfig = envConfig.replace(
            /TELEGRAM_CHANNEL_ALERTS_ENABLED=.*/,
            `TELEGRAM_CHANNEL_ALERTS_ENABLED=${newStatus}`
          );
        } else {
          envConfig += `\nTELEGRAM_CHANNEL_ALERTS_ENABLED=${newStatus}`;
        }
        
        // Save changes
        fs.writeFileSync(envPath, envConfig);
        console.log("Updated .env file successfully");
        
        // Update environment variables in memory
        process.env.TELEGRAM_CHANNEL_ID = chatId;
        process.env.TELEGRAM_CHANNEL_ALERTS_ENABLED = String(newStatus);
        
        // Reload dotenv
        dotenv.config();
        envFileUpdated = true;
      } catch (error: any) {
        console.error('Error updating .env file:', error);
        await ctx.reply(`⚠️ Could not update .env file: ${error.message}. Using in-memory storage instead.`);
      }
      
      // If .env file update failed, use in-memory storage
      if (!envFileUpdated) {
        inMemoryChannelId = chatId;
        inMemoryChannelEnabled = !inMemoryChannelEnabled;
        
        console.log("Using in-memory channel storage:");
        console.log("Channel ID:", inMemoryChannelId);
        console.log("Enabled:", inMemoryChannelEnabled);
      }
      
      // Get the current status - either from env or memory
      const isEnabled = envFileUpdated 
        ? process.env.TELEGRAM_CHANNEL_ALERTS_ENABLED === 'true'
        : inMemoryChannelEnabled;
      
      await ctx.reply(`✅ Channel alerts ${isEnabled ? 'enabled' : 'disabled'} for this channel (ID: ${chatId}).`);
    } else {
      await ctx.reply(`❌ This command must be used in a channel or group. Current chat type: ${chatType}`);
    }
  } catch (error: any) {
    console.error('Toggle channel command error:', error);
    await ctx.reply(`❌ An error occurred: ${error.message}`);
  }
}

// Export the in-memory values for use in other files
export function getChannelConfig() {
  // First try to use env variables
  if (process.env.TELEGRAM_CHANNEL_ID && process.env.TELEGRAM_CHANNEL_ALERTS_ENABLED) {
    return {
      channelId: process.env.TELEGRAM_CHANNEL_ID,
      enabled: process.env.TELEGRAM_CHANNEL_ALERTS_ENABLED === 'true'
    };
  }
  
  // Fall back to in-memory storage
  return {
    channelId: inMemoryChannelId,
    enabled: inMemoryChannelEnabled
  };
} 